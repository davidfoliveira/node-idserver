# idserver: A sequential ID generation server

`idserver` is a node.js centralized sequential ID server for helping distributed applications getting unique and sequential IDs for their entities.

## Installing

    npm install idserver

## Running a server

Running an idserver daemon:

    node node_modules/idserver/bin/server.js

Server options:

The default server (bin/server.js) shipped with idserver has no configurations - everything is on default.


`Server()` constructor supports the following options:

- `port` : TCP port number where the server should listen on; Defaults to `1970`;
- `address` : The network address where the server should listen on; Defaults to `127.0.0.1`;

- `journaling` : Enables or disables the journaling supports; Defaults to `true`;
- `journalFile` : File path for storing the journaling data; Defaults to `/tmp/idserver.journal`;

- `dataFile` : File path to be used for storing data (when using the internal storage system); Defaults to `/tmp/idserver.data`;

- `commitInterval` : The interval of time between commits (or sets); Defaults to `1000` ms;

- `getter` : Function to be used for getting the last ID for a key. The function arguments are `(key,callback)`. Defaults to an internal dumb method. If a `getter` and a `setter` or a `getter` and a `committer` are specified, the internal storage system is disabled;
- `setter` : Function to be used for storing the last ID for a key. The function arguments are `(key,value,callback)`. Defaults to an internal dumb method; If a `getter` and a `setter` or a `getter` and a `committer` are specified, the internal storage system is disabled;
- `committer` : The same as `setter` but for storing a set of keys and values at the same time. If a `committer` function is specified, `setter` is not used. Defaults to an internal commit function; If a `getter` and a `setter` or a `getter` and a `committer` are specified, the internal storage system is disabled;

- `idPattern` : The pattern for the resulting IDs or `null`. Something like 'CLIENT-%%%-###' where '#' means a digit and '%' a letter between 'A' and 'Z'; Defaults to `null` - meaning a regular integer (between 1 and the biggest supported integer);

- `keyOptions` : An object containing the options to be used for a specific key; The supported options are: `idPattern`;

- `DEBUG` : Activates or deactivates the debugging mode; Defaults to `false`.


## Running a client and asking for ids:

    var
        IDClient = require('../lib/id').Client,
        client = new IDClient({host: "127.0.0.1"});

    client.ask("x",10,function(err,ids){
        if ( err ) {
            console.log("Error getting IDs: ",err);
            throw err;
        }

        console.log("Got IDs: ",ids);
    });


`Client()` constructor supports the following options:

- `host` : The network address of the server; Defaults to `127.0.0.1`;
- `port` : The TCP port number of the server; Defaults to `1970`;
- `MAXRETRIES` : Maximum number of connect retries; Defaults to `null` - meaning infinite number of retries;

- `DEBUG` : Activates or deactivates de debugging mode; Defaults to `false`.

A `Client` instance supports the following methods:

- `ask('KEY',NUMBER_OF_IDS,callback)` - Ask for a specific number of IDs (optional - defaults to 1) for a key (required).
- `last('KEY',callback)` - Get the last ID for a key (required).


## Bugs and stuff

Mail me or make a Github issue request.
