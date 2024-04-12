import ObjectModel from "@duet3d/objectmodel";

import { connect, BaseConnector, ConnectorCallbacks, DefaultConnectorSettings } from ".";

const model = new ObjectModel();

const callbacks: ConnectorCallbacks = {
    onConnectProgress: function (connector: BaseConnector, progress: number): void {
        if (progress === -1) {
            console.log("Connection attempt complete");
        } else {
            console.log("Connection progress: " + progress + "%");
        }
    },
    onLoadSettings: async function (connector: BaseConnector): Promise<void> {
        // TODO download settings via connector
    },
    onConnectionError: function (connector: BaseConnector, reason: unknown): void {
        console.log("Connection error: " + reason);
        // TODO call connector.reconnect in given intervals
    },
    onReconnected: function (connector: BaseConnector): void {
        console.log("Connection established again");
    },
    onUpdate: function (connector: BaseConnector, data: any): void {
        // Note that this is called before the final connector instance is returned!
        model.update(data);
    },
    onVolumeChanged: function (connector: BaseConnector, volumeIndex: number): void {
        // TODO reload file browser lists of the given volume
    }
};

const settings = {
    ...DefaultConnectorSettings,
    // your custom settings
};

try {
    const connector = connect(location.hostname, settings, callbacks);
    // do whatever you want to do with the session, see BaseConnector reference
} catch (e) {
    console.error("Failed to establish connection: " + e);
}