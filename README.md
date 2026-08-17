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

// use initial settings
const settings = {
    ...DefaultSettings,
    // your custom settings
};

// try to establish a connection
let connector: BaseConnector;
try {
    const connector = connect(location.hostname, settings);
} catch (e) {
    console.error("Failed to establish connection: " + e);
    return;
}

// load settings from the machine - you can then update "settings" from your loaded settings again

// set up object model instance and stay updated via callbacks
const model = new ObjectModel();
connector.setCallbacks({
    onConnectProgress: function (connector: BaseConnector, progress: number): void {
        if (progress === -1) {
            console.log("Connection attempt complete");
        } else {
            console.log("Connection progress: " + progress + "%");
        }
    },
    onConnectionError: function (connector: BaseConnector, reason: Error): void {
        console.log("Connection error: " + reason);
        // TODO call connector.reconnect in given intervals
    },
    onReconnected: function (connector: BaseConnector): void {
        console.log("Connection established again");
    },
    onUpdate: function (connector: BaseConnector, data: any, authoritative?: boolean): void {
        // Note that this is called before the final connector instance is returned!
        // authoritative is set when the data is a complete snapshot rather than a patch, so that
        // properties missing from it are reset to null
        model.update(data, authoritative);
    },
    onVolumeChanged: function (connector: BaseConnector, volumeIndex: number): void {
        // TODO reload file browser lists of the given volume
    }
});

// do whatever you want to do with the session, see BaseConnector API
```

## Verbose and obsolete fields

Object model fields flagged as verbose or obsolete are not kept up to date by default. They are read
once when the connection is established and then left alone, because querying them on every update
costs bandwidth for values that nothing displays. A consumer that does display them, such as an
object model browser, sets the matching property while it is visible:

```
connector.verboseQueries = true;
connector.obsoleteQueries = true;
```

Enabling either one refreshes the object model so the fields are fetched again - sequence numbers do
not change just because the client changed its mind. Turning them off again refreshes nothing, so the
values that were read last stay in the model and go stale from then on.

In SBC mode both are properties of the subscription socket rather than of a single request, so
changing them reopens it. Apart from a fresh full model arriving through `onUpdate` that is
transparent to the caller.
