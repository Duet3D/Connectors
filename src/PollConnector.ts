import ObjectModel, { AxisLetter, GCodeFileInfo, Job, Layer, MachineStatus, Message, Plugin, PluginManifest, initObject } from "@duet3d/objectmodel";
import JSZip from "jszip";
import crc32 from "turbo-crc32/crc32";

import BaseConnector, { CancellationToken, FileListItem, OnProgressCallback } from "./BaseConnector";
import ConnectorSettings from "./ConnectorSettings";
import ConnectorCallbacks from "./ConnectorCallbacks";

import {
	NetworkError, DisconnectedError, TimeoutError, OperationCancelledError, OperationFailedError,
	DirectoryNotFoundError, FileNotFoundError, DriveUnmountedError,
	LoginError, BadVersionError, InvalidPasswordError, NoFreeSessionError,
	CodeResponseError, CodeBufferError
} from "./errors";
import { combinePath, isPaused, isPrinting, strToTime, timeToStr } from "./utils";

/**
 * Keys in the object model to skip when performing a query
 */
const keysToIgnore: Array<keyof ObjectModel> = ["messages", "plugins", "sbc"];

/*
 * Actual object model keys to query
 */
const keysToQuery = Object.keys(new ObjectModel()).filter(key => keysToIgnore.indexOf(key as keyof ObjectModel) === -1);

/**
 * JSON response for rr_connect requests
 */
interface ConnectResponse {
	err: number;
	isEmulated?: boolean;
	apiLevel?: number;
	sessionTimeout: number;
	sessionKey?: number;
}

/**
 * Pending G/M/T-code wrapping an awaitable promise
 */
interface PendingCode {
	seq: number;
	resolve: (result: string) => void,
	reject: (error: any) => void
}

/**
 * Class for communication with RRF
 */
export class PollConnector extends BaseConnector {
	/**
	 * Try to establish a connection to the given machine
	 * @param hostname Hostname to connect to
	 * @param settings Connector settings
	 * @param callbacks Callbacks invoked by the connector
	 * @throws {NetworkError} Failed to establish a connection
	 * @throws {InvalidPasswordError} Invalid password
	 * @throws {NoFreeSessionError} No more free sessions available
	 * @throws {BadVersionError} Incompatible firmware version (no object model?)
	 */
	static override async connect(hostname: string, settings: ConnectorSettings, callbacks: ConnectorCallbacks): Promise<BaseConnector> {
		const response = await BaseConnector.request("GET", `${location.protocol}//${hostname}${settings.baseURL}rr_connect`, {
			password: settings.password,
			time: timeToStr(new Date()),
			sessionKey: "yes"
		}) as ConnectResponse;

		switch (response.err) {
			case 0:
				if (response.isEmulated) {
					throw new OperationFailedError("Cancelling connection attempt because the remote endpoint is emulated");
				}
				if (response.apiLevel === undefined || response.apiLevel === 0) {
					// rr_status requests are no longer supported
					throw new BadVersionError();
				}

				const connector = new PollConnector(hostname, settings, callbacks, response);
				callbacks.onConnectProgress(connector, 0); // Don't hide the connection dialog while the full model is being loaded...

				// Let the callee load settings from the machine being connected
				await callbacks.onLoadSettings(connector);

				// Ideally we should be using a ServiceWorker here which would allow us to send push
				// notifications even while the UI is running in the background. However, we cannot do
				// this because ServiceWorkers require secured HTTP connections, which are no option
				// for standard end-users. That is also the reason why they are disabled in the build
				// script, which by default is used for improved caching
				connector.doUpdate();

				return connector;
			case 1: throw new InvalidPasswordError();
			case 2: throw new NoFreeSessionError();
			default: throw new LoginError(`Unknown err value: ${response.err}`)
		}
	}

	/**
	 * Maximum time between HTTP requests before the session times out (in ms)
	 */
	sessionTimeout = 8000;

	/**
	 * Indicates if the connection maintained by this particular instance is live
	 */
	isConnected = true;

	/**
	 * Indicates if a connection was just established
	 */
	justConnected = true;

	/**
	 * API level of the remote HTTP server
	 */
	apiLevel = 0;

	/**
	 * Optional session key in case the remote server supports it
	 */
	sessionKey: number | null = null;

	/**
	 * List of HTTP requests being executed
	 */
	requests: Array<XMLHttpRequest> = []

	/**
	 * Make an arbitrary HTTP request to the machine
	 * @param method HTTP method
	 * @param path Path to request
	 * @param params Optional record of URL-encoded parameters
	 * @param responseType Optional type of the received data (defaults to JSON)
	 * @param body Optional body content to send as part of this request
	 * @param timeout Optional request timeout
	 * @param filename Optional filename for file/directory requests
	 * @param cancellationToken Optional cancellation token that may be triggered to cancel this operation
	 * @param onProgress Optional callback for progress reports
	 * @param retry Current retry number (only used internally)
	 * @returns Promise to be resolved when the request finishes
	 * @throws {InvalidPasswordError} Invalid password
	 * @throws {FileNotFoundError} File not found
	 * @throws {OperationFailedError} HTTP operation failed
	 * @throws {OperationCancelledError} Operation has been cancelled
	 * @throws {NetworkError} Failed to establish a connection
	 * @throws {TimeoutError} A timeout has occurred
	 */
	override async request(method: string, path: string, params: Record<string, string | number | boolean> | null = null, responseType: XMLHttpRequestResponseType = "json", body: any = null, timeout?: number, filename?: string, cancellationToken?: CancellationToken, onProgress?: OnProgressCallback, retry = 0): Promise<any> {
		let internalURL = this.requestBase + path;
		if (params !== null) {
			let hadParam = false;
			for (const key in params) {
				internalURL += (hadParam ? '&' : '?') + key + '=' + encodeURIComponent(params[key]);
				hadParam = true;
			}
		}

		const xhr = new XMLHttpRequest();
		xhr.open(method, internalURL);
		xhr.responseType = (responseType === "json") ? "text" : responseType;
		if (this.sessionKey !== null) {
			xhr.setRequestHeader("X-Session-Key", this.sessionKey.toString());
		}
		if (onProgress) {
			xhr.onprogress = function (e) {
				if (e.loaded && e.total) {
					onProgress(e.loaded, e.total, retry);
				}
			}
			xhr.upload.onprogress = xhr.onprogress;
		}
		xhr.timeout = timeout ?? this.sessionTimeout / (this.settings.maxRetries + 1);
		if (cancellationToken) {
			cancellationToken.cancel = () => xhr.abort();
		}
		this.requests.push(xhr);

		const maxRetries = this.settings.maxRetries, that = this;
		return new Promise((resolve, reject) => {
			xhr.onload = function () {
				that.requests = that.requests.filter(request => request !== xhr);
				if (xhr.status >= 200 && xhr.status < 300) {
					if (responseType === "json") {
						try {
							if (!xhr.responseText) {
								resolve(null);
							} else {
								resolve(JSON.parse(xhr.responseText));
							}
						} catch (e) {
							console.warn(`Failed to parse response from request ${method} ${path}:\n${xhr.responseText}`);
							reject(e);
						}
					} else {
						resolve(xhr.response);
					}
				} else if (xhr.status === 401 || xhr.status === 403) {
					// User might have closed another tab or the firmware restarted, which can cause
					// the current session to be terminated. Try to send another rr_connect request
					// with the last-known password and retry the pending request if that succeeds
					BaseConnector
						.request("GET", `${that.requestBase}rr_connect`, {
							password: that.settings.password,
							time: timeToStr(new Date()),
							sessionKey: "yes"
						})
						.then(function (result: ConnectResponse | null) {
							if (result instanceof Object && result.err === 0) {
								that.sessionKey = result.sessionKey ?? null;
								that.request(method, path, params, responseType, body, timeout, filename, cancellationToken, onProgress)
									.then(result => resolve(result))
									.catch(error => reject(error));
							} else {
								reject(new InvalidPasswordError());
							}
						})
						.catch(error => reject(error));
				} else if (xhr.status === 404) {
					reject(new FileNotFoundError(filename));
				} else if (xhr.status === 503) {
					if (retry < maxRetries) {
						// RRF may have run out of output buffers. We usually get here when a code reply is blocking
						if (retry === 0) {
							that.lastSeqs.reply++;	// increase the seq number to resolve potentially blocking codes
							that.getGCodeReply()
								.then(function () {
									// Retry the original request when the code reply has been received
									that.request(method, path, params, responseType, body, timeout, filename, cancellationToken, onProgress, retry + 1)
										.then(result => resolve(result))
										.catch(error => reject(error));
								})
								.catch(error => reject(error));
						} else {
							// Retry the original request after a while
							setTimeout(function () {
								that.request(method, path, params, responseType, body, timeout, filename, cancellationToken, onProgress, retry + 1)
									.then(result => resolve(result))
									.catch(error => reject(error));
							}, 2000);
						}
					} else {
						reject(new OperationFailedError(xhr.responseText || xhr.statusText));
					}
				} else if (xhr.status >= 500) {
					reject(new OperationFailedError(xhr.responseText || xhr.statusText));
				} else if (xhr.status !== 0) {
					reject(new OperationFailedError(`bad status code ${xhr.status}`));
				}
			};
			xhr.onabort = function () {
				that.requests = that.requests.filter(request => request !== xhr);
				reject(that.isConnected ? new OperationCancelledError() : new DisconnectedError());
			}
			xhr.onerror = function () {
				that.requests = that.requests.filter(request => request !== xhr);
				if (retry < maxRetries) {
					// Unreliable connection, retry if possible
					that.request(method, path, params, responseType, body, timeout, filename, cancellationToken, onProgress, retry + 1)
						.then(result => resolve(result))
						.catch(error => reject(error));
				} else {
					reject(new NetworkError());
				}
			};
			xhr.ontimeout = function () {
				that.requests = that.requests.filter(request => request !== xhr);
				if (retry < maxRetries) {
					// Request has timed out, retry if possible
					that.request(method, path, params, responseType, body, timeout, filename, cancellationToken, onProgress, retry + 1)
						.then(result => resolve(result))
						.catch(error => reject(error));
				} else {
					reject(new TimeoutError());
				}
			};
			xhr.send(body);
		});
	}

	/**
	 * Cancel all pending HTTP requests
	 */
	cancelRequests() {
		this.pendingCodes.forEach(code => code.reject(new DisconnectedError()));
		this.pendingCodes = [];
		this.requests.forEach(request => request.abort());
		this.requests = [];
	}

	/**
	 * Constructor of this connector class
	 * @param hostname Hostname to connect to
	 * @param settings Connector settings
	 * @param callbacks Callbacks invoked by the connector
	 * @param responseData Response to the rr_connect request
	 */
	constructor(hostname: string, settings: ConnectorSettings, callbacks: ConnectorCallbacks, responseData: ConnectResponse) {
		super(hostname, settings, callbacks);
		this.requestBase = `${settings.protocol}//${hostname}${settings.baseURL}`;
		this.sessionTimeout = responseData.sessionTimeout;
		this.sessionKey = responseData.sessionKey ?? null;
		this.apiLevel = responseData.apiLevel || 0;
	}

	/**
	 * Load enumeration of installed plugins
	 */
	async loadPluginList() {
		if (this.settings.pluginsFile === null) {
			return;
		}

		try {
			const plugins = await this.download(this.settings.pluginsFile);
			if ((plugins instanceof Object) && !(plugins instanceof Array)) {
				for (let id in plugins) {
					if (!plugins[id].dwcFiles) {
						plugins[id].dwcFiles = [];
					}
					if (!plugins[id].sdFiles) {
						plugins[id].sdFiles = [];
					}

					if (plugins[id].sbcPermissions instanceof Object) {
						// Fix format of stored SBC permissions (not applicable in standalone mode anyway)
						plugins[id].sbcPermissions = [];
					}
				}
				this.partialModel.plugins.update(plugins);
				this.callbacks.onUpdate(this, { plugins });
			}
		} catch (e) {
			if (!(e instanceof FileNotFoundError)) {
				throw e;
			}
		}
	}

	/**
	 * Try to reconnect to the remote machine
	 */
	async reconnect() {
		// Cancel pending requests and reset the sequence numbers
		this.isConnected = false;
		this.cancelRequests();
		this.lastJobFile = null;
		this.lastSeqs = {};
		this.lastStatus = null;
		this.wasSimulating = false;
		// don't reset lastUpTime in order to be able to detect resets

		// Attempt to reconnect
		const response = await BaseConnector.request("GET", `${this.settings.protocol}//${this.hostname}${this.settings.baseURL}rr_connect`, {
			password: this.settings.password,
			time: timeToStr(new Date()),
			sessionKey: "yes"
		}) as ConnectResponse;
		
		switch (response.err) {
			case 0:
				this.justConnected = true;
				this.sessionTimeout = response.sessionTimeout;
				this.sessionKey = response.sessionKey ?? null;
				this.apiLevel = response.apiLevel || 0;
				if (this.apiLevel > 0) {
					// Don't hide the connection dialog while the full model is being loaded...
					this.callbacks.onConnectProgress(this, 0);
				}
				this.doUpdate();
				break;
			case 1:
				// Bad password
				throw new InvalidPasswordError();
			case 2:
				// No free session available
				throw new NoFreeSessionError();
			default:
				// Generic login error
				throw new LoginError(`Unknown err value: ${response.err}`);
		}
	}

	/**
	 * Disconnect gracefully from the remote machine
	 */
	async disconnect() {
		await this.request("GET", "rr_disconnect");

		this.isConnected = false;
		if (this.cancelUpdateDelay !== null) {
			this.cancelUpdateDelay(new DisconnectedError());
			this.cancelUpdateDelay = null;
		}
		this.cancelRequests();
	}

	/**
	 * Last-known job file (used for fetching thumbnails)
	 */
	lastJobFile: string | null = null

	/**
	 * Collection of the last sequence numbers
	 */
	lastSeqs: Record<string, number> = {}

	/**
	 * Collection of the last volume sequence numbers
	 */
	lastVolSeqs: Array<number> = []

	/**
	 * Last-known machine status
	 */
	lastStatus: MachineStatus | null = null;

	/**
	 * Indicates if a simulation was being done
	 */
	wasSimulating: boolean = false;

	/**
	 * Last-known uptime
	 */
	lastUptime = 0

	/**
	 * Partial object model used to populate the layers
	 */
	partialModel: ObjectModel = new ObjectModel();

	/**
	 * Update parts of the internal object model copy
	 * @param key Key to update or null if it is a live response
	 * @param data Model update data
	 */
	maintainPartialModel(key: string | null, data: any) {
		if (key === null) {
			this.partialModel.update(data);
		} else if (["directories", "job", "move", "state"].includes(key)) {
			this.partialModel.update({ key: data });
		}
	}

	/**
	 * List of pending codes to be resolved
	 */
	pendingCodes: Array<PendingCode> = []

	/**
	 * Optional method to cancel the currnet update loop
	 */
	cancelUpdateDelay: ((reason?: any) => void) | null = null;

	/*
	 * Method to maintin the current session
	 */
	async doUpdate() {
		try {
			do {
				if (this.justConnected) {
					this.justConnected = false;

					// Query the seqs field and the G-code reply initially if applicable
					const seqs = (await this.request("GET", "rr_model", { key: "seqs" })).result;
					this.lastSeqs = seqs;
					if (this.lastSeqs.reply > 0) {
						await this.getGCodeReply();
					}
					if (seqs.volChanges instanceof Array) {
						this.lastVolSeqs = seqs.volChanges;
					}

					// Query the full object model initially
					try {
						let keyIndex = 1;
						for (let i = 0; i < keysToQuery.length; i++) {
							const key = keysToQuery[i];
							let keyResult = null, next = 0;
							do {
								const keyResponse = await this.request("GET", "rr_model", {
									key,
									flags: (next === 0) ? "d99vn" : `d99vna${next}`
								});

								next = keyResponse.next ? keyResponse.next : 0;
								if (keyResult === null || !(keyResult instanceof Array)) {
									keyResult = keyResponse.result;
								} else {
									keyResult = keyResult.concat(keyResponse.result);
								}
							} while (next !== 0);

							try {
								this.callbacks.onUpdate(this, { [key]: keyResult });
							} catch (e) {
								console.warn(e);
							}

							this.callbacks.onConnectProgress(this, (keyIndex++ / keysToQuery.length) * 100);

							// Need this to keep track of the layers
							this.maintainPartialModel(key, keyResult);

							// Keep track of the last uptime to detect firmware resets
							if (key === "state") {
								this.lastUptime = keyResult.upTime;
							}
						}
					} finally {
						this.callbacks.onConnectProgress(this, -1);
					}
				} else {
					// Query live values
					const response = await this.request("GET", "rr_model", { flags: "d99fn" });
					this.partialModel.update(response.result);

					// Remove seqs key, it is only maintained by the connector
					const seqs = response.result.seqs;
					delete response.result.seqs;

					// Update fields that are not part of RRF yet
					if (!isPrinting(this.partialModel.state.status) && this.lastStatus !== null && isPrinting(this.lastStatus)) {
						response.result.job.lastFileCancelled = isPaused(this.lastStatus);
						response.result.job.lastFileSimulated = this.wasSimulating;
					}

					if (status === MachineStatus.simulating) {
						this.wasSimulating = true;
					} else if (!isPrinting(this.partialModel.state.status)) {
						this.wasSimulating = false;
					}

					// Try to apply new values
					try {
						this.callbacks.onUpdate(this, response.result);
					} catch (e) {
						console.error(e);
					}

					// Check if any of the non-live fields have changed and query them if so
					for (let key of keysToQuery) {
						if (this.lastSeqs[key] !== seqs[key]) {
							let keyResult = null, next = 0;
							do {
								const keyResponse = await this.request("GET", "rr_model", {
									key,
									flags: (next === 0) ? "d99vn" : `d99vna${next}`
								});

								next = keyResponse.next ? keyResponse.next : 0;
								if (keyResult === null || !(keyResult instanceof Array)) {
									keyResult = keyResponse.result;
								} else {
									keyResult = keyResult.concat(keyResponse.result);
								}
							} while (next !== 0);

							try {
								this.callbacks.onUpdate(this, { [key]: keyResult });
							} catch (e) {
								console.warn(e);
							}

							// Need this to keep track of the layers
							this.maintainPartialModel(key, keyResult);
						}
					}

					// Reload file lists automatically when files are changed on the SD card
					if (seqs.volChanges instanceof Array) {
						for (let i = 0; i < Math.min(seqs.volChanges.length, this.lastVolSeqs.length); i++) {
							if (seqs.volChanges[i] !== this.lastVolSeqs[i]) {
								this.callbacks.onVolumeChanged(this, i);
							}
						}
						this.lastVolSeqs = seqs.volChanges;
					}

					// Check if the firmware has rebooted
					if (response.result.state.upTime < this.lastUptime) {
						this.justConnected = true;

						// Resolve pending codes
						this.pendingCodes.forEach(code => code.reject(new OperationCancelledError()));
						this.pendingCodes = [];

						// Send the rr_connect request and datetime again after a firmware reset
						await this.request("GET", "rr_connect", {
							password: this.settings.password,
							time: timeToStr(new Date())
						});
					}
					this.lastUptime = response.result.state.upTime;

					// Finally, check if there is a new G-code reply available
					const fetchGCodeReply = (this.lastSeqs.reply !== seqs.reply);
					this.lastSeqs = seqs;
					if (fetchGCodeReply) {
						await this.getGCodeReply();
					}
				}

				// See if we need to record more layer stats
				if (this.updateLayersModel()) {
					this.callbacks.onUpdate(this, {
						job: {
							layers: this.partialModel.job.layers
						}
					});
				}

				// Check for updated thumbnails
				if (this.partialModel.job.file !== null && this.partialModel.job.file.fileName !== "" &&
					this.partialModel.job.file.thumbnails.length > 0 && this.lastJobFile !== this.partialModel.job.file.fileName)
				{
					await this.getThumbnails(this.partialModel.job.file);
					this.callbacks.onUpdate(this, {
						job: {
							file: {
								thumbnails: this.partialModel.job.file.thumbnails
							}
						}
					});
					this.lastJobFile = this.partialModel.job.file.fileName;
				}

				// Save the last status for next time
				this.lastStatus = this.partialModel.state.status;

				// Wait for the next model update
				await new Promise((resolve, reject) => {
					this.cancelUpdateDelay = reject;
					setTimeout(resolve, this.settings.updateInterval);
				});
				this.cancelUpdateDelay = null;
			} while (this.isConnected);
		} catch (e) {
			if (!(e instanceof DisconnectedError)) {
				this.isConnected = false;
				this.callbacks.onConnectionError(this, e);
			}
		}
	}

	/**
	 * Last layer number
	 */
	lastLayer = -1;

	/**
	 * Last print duration
	 */
	lastDuration = 0;

	/**
	 * Last filament usage per extruder (in mm)
	 */
	lastFilamentUsage: Array<number> = [];

	/**
	 * Last file position (in bytes)
	 */
	lastFilePosition = 0;

	/**
	 * Last print height
	 */
	lastHeight = 0;

	/**
	 * Update the layers, RRF does not keep track of them
	 * @returns Whether any layers could be updated
	 */
	updateLayersModel() {
		// Are we printing?
		if (this.partialModel.job.duration === null || this.partialModel.job.file === null) {
			if (this.lastLayer !== -1) {
				this.lastLayer = -1;
				this.lastDuration = this.lastFilePosition = this.lastHeight = 0;
				this.lastFilamentUsage = [];
			}
			return false;
		}

		// Reset the layers when a new print is started
		if (this.lastLayer === -1) {
			this.lastLayer = 0;
			this.partialModel.job.layers.splice(0);
			return true;
		}

		// Don't continue from here unless the layer number is known and valid
		if (this.partialModel.job.layer === null || this.partialModel.job.layer < 0) {
			return false;
		}

		if (this.partialModel.job.layer > 0 && this.partialModel.job.layer !== this.lastLayer) {
			// Compute layer usage stats first
			const numChangedLayers = (this.partialModel.job.layer > this.lastLayer) ? Math.abs(this.partialModel.job.layer - this.lastLayer) : 1;
			const printDuration = this.partialModel.job.duration - (this.partialModel.job.warmUpDuration !== null ? this.partialModel.job.warmUpDuration : 0);
			const avgLayerDuration = (printDuration - this.lastDuration) / numChangedLayers;
			const totalFilamentUsage: Array<number> = [], avgFilamentUsage: Array<number> = [];
			const bytesPrinted = (this.partialModel.job.filePosition !== null) ? (this.partialModel.job.filePosition as number - this.lastFilePosition) : 0;
			const avgFractionPrinted = (this.partialModel.job.file.size > 0) ? bytesPrinted / (this.partialModel.job.file.size as number * numChangedLayers) : 0;
			this.partialModel.move.extruders.forEach((extruder, index) => {
				if (extruder !== null) {
					const lastFilamentUsage = (index < this.lastFilamentUsage.length) ? this.lastFilamentUsage[index] : 0;
					totalFilamentUsage.push(extruder.rawPosition);
					avgFilamentUsage.push((extruder.rawPosition - lastFilamentUsage) / numChangedLayers);
				}
			});

			// Get layer height
			const currentHeight = this.partialModel.move.axes.find(axis => axis.letter === AxisLetter.Z)?.userPosition ?? 0;
			const avgLayerHeight = Math.abs(currentHeight - this.lastHeight) / Math.abs(this.partialModel.job.layer - this.lastLayer);

			if (this.partialModel.job.layer > this.lastLayer) {
				// Add new layers
				for (let i = this.partialModel.job.layers.length; i < this.partialModel.job.layer - 1; i++) {
					const newLayer = new Layer();
					newLayer.duration = avgLayerDuration;
					avgFilamentUsage.forEach(function (filamentUsage) {
						newLayer.filament.push(filamentUsage);
					});
					newLayer.fractionPrinted = avgFractionPrinted;
					newLayer.height = avgLayerHeight;
					for (const sensor of this.partialModel.sensors.analog) {
						if (sensor != null) {
							newLayer.temperatures.push(sensor.lastReading ?? -273.15);
						}
					}
					this.partialModel.job.layers.push(newLayer);
				}
			} else if (this.partialModel.job.layer < this.lastLayer) {
				// Layer count went down (probably printing sequentially), update the last layer
				let lastLayer;
				if (this.partialModel.job.layers.length < this.lastLayer) {
					lastLayer = new Layer();
					lastLayer.height = avgLayerHeight;
					for (const sensor of this.partialModel.sensors.analog) {
						if (sensor != null) {
							lastLayer.temperatures.push(sensor.lastReading ?? -273.15);
						}
					}
					this.partialModel.job.layers.push(lastLayer);
				} else {
					lastLayer = this.partialModel.job.layers[this.lastLayer - 1];
				}

				lastLayer.duration += avgLayerDuration;
				for (let i = 0; i < avgFilamentUsage.length; i++) {
					if (i >= lastLayer.filament.length) {
						lastLayer.filament.push(avgFilamentUsage[i]);
					} else {
						lastLayer.filament[i] += avgFilamentUsage[i];
					}
				}
				lastLayer.fractionPrinted += avgFractionPrinted;
			}

			// Record values for the next layer change
			this.lastDuration = printDuration;
			this.lastFilamentUsage = totalFilamentUsage;
			this.lastFilePosition = (this.partialModel.job.filePosition != null) ? this.partialModel.job.filePosition as number : 0;
			this.lastHeight = currentHeight;
			this.lastLayer = this.partialModel.job.layer;
			return true;
		}
		return false;
	}

	/**
	 * Send a G/M/T-code to the machine
	 * @param code Code to execute
	 * @param noWait Whether the call may return as soon as the code has been enqueued for execution
	 * @returns Code reply unless noWait is true
	 */
	async sendCode<B extends boolean>(code: string, noWait: B): Promise<B extends true ? void : string> {
		let inBraces = false, inQuotes = false, strippedCode = "";
		for (let i = 0; i < code.length; i++) {
			if (inQuotes) {
				inQuotes = (code[i] !== '"');
			} else if (inBraces) {
				inBraces = (code[i] !== ')');
			} else if (code[i] === '(') {
				inBraces = true;
			} else {
				if (code[i] === ';') {
					break;
				}
				if (code[i] === '"') {
					inQuotes = true;
				} else if (code[i] !== ' ' && code[i] !== '\t' && code[i] !== '\r' && code !== '\n') {
					strippedCode += code[i];
				}
			}
		}

		// Send the code to RRF
		const seq = this.lastSeqs.reply, response = await this.request("GET", "rr_gcode", { gcode: code });
		if (!(response instanceof Object)) {
			console.warn(`Received bad response for rr_gcode: ${JSON.stringify(response)}`);
			throw new CodeResponseError();
		}
		if (response.buff === 0) {
			throw new CodeBufferError();
		}
		if (response.err !== undefined && response.err !== 0) {
			console.warn(`Received error ${response.err} from rr_gcode`);
			throw new CodeResponseError();
		}

		// Check if a response can be expected
		if (!noWait && seq === this.lastSeqs.reply && strippedCode !== "" && strippedCode.toUpperCase().indexOf("M997") === -1 && strippedCode.toUpperCase().indexOf("M999") === -1) {
			const pendingCodes = this.pendingCodes;
			return new Promise<string>((resolve, reject) => pendingCodes.push({ seq, resolve, reject })) as Promise<B extends true ? void : string>;
		}
		return (noWait ? undefined : "") as B extends true ? void : string;
	}

	/**
	 * Query the latest G-code reply
	 */
	async getGCodeReply() {
		const response = await this.request("GET", "rr_reply", null, "text");
		const reply = response.trim();
		if (this.pendingCodes.length > 0) {
			// Resolve pending code promises
			const seq = this.lastSeqs.reply;
			this.pendingCodes.forEach(function (code) {
				if (seq === null || code.seq < seq) {
					code.resolve(reply);
				}
			}, this);
			this.pendingCodes = this.pendingCodes.filter(code => (seq !== null) && (code.seq >= seq));
		} else if (reply !== "") {
			// Forward generic messages to the machine module
			this.callbacks.onUpdate(this, { messages: [initObject(Message, { content: reply })] });
		}
	}

	/**
	 * Upload a file
	 * @param filename Destination path of the file to upload
	 * @param content Content of the target file
	 * @param cancellationToken Optional cancellation token that may be triggered to cancel this operation
	 * @param onProgress Optional callback for progress reports
	 */
	async upload(filename: string, content: string | Blob | File, cancellationToken?: CancellationToken, onProgress?: OnProgressCallback): Promise<void> {
		// Create upload options
		const payload = (content instanceof Blob) ? content : new Blob([content]);
		const params: Record<string, any> = {
			name: filename,
			time: timeToStr((!this.settings.ignoreFileTimestamps && content instanceof File) ? new Date(content.lastModified) : new Date())
		};

		// Check if the CRC32 checksum is required
		if (this.settings.crcUploads) {
			const checksum = await new Promise<number>((resolve, reject) => {
				const fileReader = new FileReader();
				fileReader.onload = (e) => {
					if (e.target !== null && e.target.result !== null) {
						const result = crc32(e.target.result);
						resolve(result);
					} else {
						reject(new OperationFailedError("failed to read file for CRC checksum calculation"));
					}
				}
				fileReader.readAsArrayBuffer(payload);
			});

			params.crc32 = checksum.toString(16);
		}

		// Perform actual upload in the background. It might fail due to CRC errors, so keep retrying
		let response: any;
		for (let retry = 0; retry < this.settings.maxRetries; retry++) {
			response = await this.request("POST", "rr_upload", params, "json", payload, 0, filename, cancellationToken, onProgress, retry);
			if (response.err === 0) {
				// Upload successful
				return;
			}

			if (payload.size > this.settings.fileTransferRetryThreshold) {
				// Don't retry if the payload is too big
				break;
			}
		}
		throw new OperationFailedError(response ? `err ${response.err}` : "n/a");
	}

	/**
	 * Delete a file or directory
	 * @param filename Path of the file or directory to delete
	 * @param recursive Delete directories recursively
	 */
	async delete(filename: string, recursive?: boolean): Promise<void> {
		const response = await this.request("GET", "rr_delete", (recursive !== undefined) ? { name: filename, recursive: recursive ? "yes" : "no" } : { name: filename }, "json", null, undefined, filename);
		if (response.err !== 0) {
			throw new OperationFailedError(`err ${response.err}`);
		}
	}

	/**
	 * Move a file or directory
	 * @param from Source file
	 * @param to Destination file
	 * @param force Overwrite file if it already exists (defaults to false)
	 */
	 async move(from: string, to: string, force?: boolean): Promise<void> {
		const response = await this.request("GET", "rr_move", {
			old: from,
			new: to,
			deleteexisting: force ? "yes" : "no"
		}, "json", null, undefined, from);

		if (response.err !== 0) {
			throw new OperationFailedError(`err ${response.err}`);
		}
	}

	/**
	 * Make a new directory
	 * @param directory Path of the directory to create
	 */
	 async makeDirectory(directory: string): Promise<void> {
		const response = await this.request("GET", "rr_mkdir", { dir: directory });
		if (response.err !== 0) {
			throw new OperationFailedError(`err ${response.err}`);
		}
	}

	/**
	 * Download a file
	 * @param filename Path of the file to download
	 * @param type Optional type of the received data (defaults to JSON)
	 * @param cancellationToken Optional cancellation token that may be triggered to cancel this operation
	 * @param onProgress Optional callback for progress reports
	 */
	async download(filename: string, type?: XMLHttpRequestResponseType, cancellationToken?: CancellationToken, onProgress?: OnProgressCallback): Promise<any> {
		return await this.request("GET", "rr_download", { name: filename }, type, null, 0, filename, cancellationToken, onProgress);
	}

	/**
	 * List the files and directories from a given directory
	 * @param directory Directory to query
	 */
	async getFileList(directory: string): Promise<Array<FileListItem>> {
		let fileList: Array<{
			type: 'd' | 'f',
			name: string,
			size: bigint | number,
			date: string
		}> = [], next = 0;
		do {
			const response = await this.request("GET", "rr_filelist", { dir: directory, first: next });
			if (response.err === 1) {
				throw new DriveUnmountedError();
			} else if (response.err === 2) {
				throw new DirectoryNotFoundError(directory);
			}

			fileList = fileList.concat(response.files);
			next = response.next;
		} while (next !== 0);

		return fileList.map(item => ({
			isDirectory: item.type === 'd',
			name: item.name,
			size: (item.type === 'd') ? 0 : item.size,
			lastModified: strToTime(item.date)
		}));
	}

	/**
	 * Parse a G-code file and return the retrieved information
	 * @param filename Path of the file to parse
	 * @param readThumbnailContent Retrieve thumbnail contents (defaults to false)
	 */
	async getFileInfo(filename: string, readThumbnailContent?: boolean): Promise<GCodeFileInfo> {
		const response = await this.request("GET", "rr_fileinfo", filename ? { name: filename } : {}, "json", null, this.sessionTimeout, filename);
		if (response.err) {
			throw new OperationFailedError(`err ${response.err}`);
		}

		if (!response.thumbnails) { response.thumbnails = []; }
		if (readThumbnailContent) { await this.getThumbnails(response); }

		delete response.err;
		return initObject(GCodeFileInfo, response);
	}

	/**
	 * Query all the thumbnails from a given fileinfo instance
	 * @param fileinfo Fileinfo instance to query thumbnails from
	 */
	async getThumbnails(fileinfo: GCodeFileInfo) {
		for (let thumbnail of fileinfo.thumbnails.filter(thumbnail => thumbnail.offset > 0)) {
			try {
				let offset = thumbnail.offset, thumbnailData = "";
				do {
					const response = await this.request("GET", "rr_thumbnail", {
						name: fileinfo.fileName,
						offset
					});

					if (response.err !== 0) {
						throw new OperationFailedError(`err ${response.err}`);
					}

					const base64Regex = /^[A-Za-z0-9+/=]+$/;
					if (!base64Regex.test(response.data)) {
						console.log(response.data);
						throw new OperationFailedError("invalid base64 content");
					}

					offset = response.next;
					thumbnailData += response.data;
				} while (offset !== 0);
				thumbnail.data = thumbnailData;
			} catch (e) {
				console.warn(e);
				thumbnail.data = null;
			}
		}
	}

	/**
	 * Install a third-party plugin
	 * @param zipFilename Filename of the ZIP container
	 * @param zipBlob ZIP container data to upload (if applicable)
	 * @param zipFile ZIP container to extract (if applicable)
	 * @param pluginManifest Plugin manifest
	 * @param start Whether to start the plugin upon installation
	 */
	async installPlugin(zipFilename: string, zipBlob: Blob, zipFile: JSZip, pluginManifest: PluginManifest, start: boolean, onProgress?: OnProgressCallback): Promise<void> {
		if (this.settings.pluginsFile === null) {
			throw new Error("Plugin support is not enabled in the connector settings");
		}

		// Verify the name
		if (!pluginManifest.id || pluginManifest.id.trim() === "" || pluginManifest.id.length > 32) {
			throw new Error("Invalid plugin identifier");
		}

		if (pluginManifest.id.split("").some(c => !/[a-zA-Z0-9 .\-_]/.test(c))) {
			throw new Error("Illegal plugin identifier");
		}

		// Check if it requires a SBC
		if (pluginManifest.sbcRequired) {
			throw new Error(`Plugin ${pluginManifest.id} cannot be loaded because the current machine does not have an SBC attached`);
		}

		// Uninstall the previous version if required
		if (this.partialModel.plugins.has(pluginManifest.id)) {
			await this.uninstallPlugin(this.partialModel.plugins.get(pluginManifest.id)!, true);
		}

		// Initialize actual plugin instance
		const plugin = initObject(Plugin, pluginManifest);
		plugin.dsfFiles = [];
		plugin.dwcFiles = [];
		plugin.sdFiles = [];
		plugin.pid = -1;

		// Install the files
		const numFiles = Object.keys(zipFile.files).length;
		let filesUploaded = 0;
		for (let file in zipFile.files) {
			if (file.endsWith('/')) {
				continue;
			}

			let targetFilename = null;
			if (file.startsWith("dwc/")) {
				const filename = file.substring(4);
				targetFilename = combinePath(this.partialModel.directories.web , filename);
				plugin.dwcFiles.push(filename);
			} else if (file.startsWith("sd/")) {
				const filename = file.substring(3);
				targetFilename = `0:/${filename}`;
				plugin.sdFiles.push(filename);
			} else {
				console.warn(`Skipping file ${file}`);
				continue;
			}

			if (targetFilename) {
				const extractedFile = await zipFile.file(file)!.async("blob");
				await this.upload(targetFilename, extractedFile);

				if (onProgress !== undefined) {
					onProgress(++filesUploaded, numFiles + 1, 0);
				}
			}
		}

		// Update the object model and plugins file
		try {
			const plugins = await this.download(this.settings.pluginsFile);
			if (!(plugins instanceof Array)) {
				this.partialModel.plugins.update(plugins);
			}
		} catch (e) {
			if (!(e instanceof FileNotFoundError)) {
				console.warn(`Failed to load DWC plugins file: ${e}`);
			}
		}
		this.partialModel.plugins.set(plugin.id, plugin);
		this.callbacks.onUpdate(this, { plugins: this.partialModel.plugins });
		await this.upload(this.settings.pluginsFile, JSON.stringify(this.partialModel.plugins));

		if (onProgress !== undefined) {
			onProgress(numFiles + 1, numFiles + 1, 0);
		}
	}

	/**
	 * Uninstall a third-party plugin
	 * @param plugin Plugin instance to uninstall
	 * @param forUpgrade Uninstall this plugin only temporarily because it is being updated
	 */
	async uninstallPlugin(plugin: Plugin, forUpgrade?: boolean) {
		if (this.settings.pluginsFile === null) {
			throw new Error("Plugin support is not enabled in the connector settings");
		}

		// Make sure uninstalling this plugin does not break any dependencies
		if (!forUpgrade) {
			for (let id of this.partialModel.plugins.keys()) {
				if (id !== plugin.id && this.partialModel.plugins.get(id)!.dwcDependencies.indexOf(plugin.id) !== -1) {
					throw new Error(`Cannot uninstall plugin because plugin ${id} depends on it`);
				}
			}
		}

		// Uninstall the plugin manifest
		this.partialModel.plugins.delete(plugin.id);
		this.callbacks.onUpdate(this, { plugins: this.partialModel.plugins });

		// Delete DWC files
		for (const dwcFile of plugin.dwcFiles) {
			try {
				await this.delete(combinePath(this.partialModel.directories.web, dwcFile));
			} catch (e) {
				if (e instanceof OperationFailedError) {
					console.warn(e);
				} else {
					throw e;
				}
			}
		}

		// Delete SD files
		for (let i = 0; i < plugin.sdFiles.length; i++) {
			try {
				if (plugin.sdFiles[i].endsWith("/daemon.g")) {
					// daemon.g may be still open at the time it is uninstalled
					await this.move(`0:/${plugin.sdFiles[i]}`, `0:/${plugin.sdFiles[i]}.bak`, true);
				} else {
					await this.delete(`0:/${plugin.sdFiles[i]}`);
				}
			} catch (e) {
				if (e instanceof OperationFailedError) {
					console.warn(e);
				} else {
					throw e;
				}
			}
		}

		// Update the plugins file
		try {
			const plugins = await this.download(this.settings.pluginsFile);
			if (!(plugins instanceof Array)) {
				this.partialModel.plugins.update(plugins);
			}
		} catch (e) {
			if (!(e instanceof FileNotFoundError)) {
				console.warn(`Failed to load DWC plugins file: ${e}`);
			}
		}
		this.partialModel.plugins.delete(plugin.id);
		await this.upload(this.settings.pluginsFile, JSON.stringify(this.partialModel.plugins));
	}
}
export default PollConnector
