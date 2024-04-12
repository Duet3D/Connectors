# Connectors

TypeScript implementation of the Duet3D HTTP connectors.

## Installation

Install via `npm install @duet3d/connectors`.

## Bug reports

Please use the [forum](https://forum.duet3d.com) for support requests or the [DuetWebControl](https://github.com/Duet3D/DuetWebControl) GitHub repository for feature requests and bug reports.

## Usage

The connector works for both Duets in SBC and standalone mode. Usage is as simple as:

```
import { connect, BaseConnector, Callbacks, DefaultSettings } from "@duet3d/connectors";
import ObjectModel from "@duet3d/objectmodel";

const model = new ObjectModel();

const callbacks: Callbacks = {
    onConnectProgress: function (connector: BaseConnector, progress: number): void {
        if (progress === -1) {
            console.log("Connection attempt complete");
        } else {
            console.log("Connection progress: " + progress + "%");
        }
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
    ...DefaultSettings,
    // your custom settings
};

try {
    const connector = connect(location.hostname, settings);
    // load machine settings
    connector.setCallbacks(callbacks);
    // do whatever you want to do with the session, see BaseConnector API
} catch (e) {
    console.error("Failed to establish connection: " + e);
}
```
