"use strict";

var
    events          = require('events'),
    util            = require('util'),
    net             = require('net'),
    Stream          = require('./stream').Stream,

    CON_RETRYTIME   = 2000,
    DEBUG           = false,
    first           = null;



// A client instance
function Client(opts){

    if ( !opts ) 
        opts = {};
    this._opts = opts;

    // Variable properties
    this.host                   = opts.host         || "127.0.0.1";
    this.port                   = opts.port         || 1970;
    this.MAXRETRIES             = opts.MAXRETRIES   || null;

    // Fixed properties
    this.connected              = false;
    this.retries                = 0;
    this.waitingConnect         = [];
    this._s                     = null;
    this._requests              = {};

    // Methods
    this.ask                    = clientAsk;
    this._newRequestID          = _newRequestID;
    this._clientConnect         = _clientConnect;
    this._clientWaitConnection  = _clientWaitConnection;
    this._clientOnMessage       = _clientOnMessage;
    this._clientOnError         = _clientOnError;
    this._clientOnDisconnect    = _clientOnDisconnect;
    this._send                  = _send;
    this._command               = _command;


    // Debug
    DEBUG = opts.DEBUG || false;

    // Connect please!
    this._clientConnect();

}
util.inherits(Client, events.EventEmitter);


// Push data

function clientAsk(key,n,opts,handler) {

    var
        self = this;

    // Register lock locally
    var
        rid = self._newRequestID();

    _debug("INFO:\tAsking for "+n+" IDs for '"+key+"'...");

    self._requests[rid] = { key: key, n: n, opts: opts, handler: handler };

    // Wait for connection and send it
    return self._clientWaitConnection(function(err){
        if ( err )
            return handler(err,null);

        _debug("INFO:\tSending 'ask' request for key '"+key+"' and "+n+" ids ("+rid+")");
        return self._command("ask",{mid: rid, key: key, n: n});
    });

}

// Generate data package ID
function _newRequestID() {

    var
        d = new Date(),
        id;

    do {
        id = "r"+d.getTime().toString() + "." + Math.floor(Math.random()*1001);
    } while ( this._requests[id] != null );

    return id;

}


// Connect
function _clientConnect() {

    var
        self = this;

    this.connected = false;
    self.s = net.connect({host: self.host, port: self.port}, function(){
        _debug("[client] Connected to idserver");
        self.connected = true;
        self.retries = 0;
        self.stream = new Stream("string",self.s);
        self.stream.on('message',function(m){ self._clientOnMessage(m)   });
        self.stream.on('error',function(err){ self._clientOnError(err)   });
        self.stream.on('close',function(){    self._clientOnDisconnect() });
        self.stream.on('end',function(){      self._clientOnDisconnect() });
        self.emit('connect',null);
    });
    self.s.on('connect',function(){
        while ( self.waitingConnect.length > 0 ) {
            var
                handler = self.waitingConnect.shift();

            handler();
        }
    });
    self.s.on('error',function(err){
        _debug("Connecting error: ",err);
        if ( err.code ) {
            if ( err.code == "ECONNREFUSED" ) {
                _debug("Could not connect to idserver. Retrying (#"+self.retries+") in "+CON_RETRYTIME+"ms...");

                self.retries++;
                if ( self.MAXRETRIES == null || self.retries <= self.MAXRETRIES ) {
                    return setTimeout(function(){
                        return self._clientConnect();
                    }, CON_RETRYTIME);
                }
                else {
                    _debug("Reached connection retry limit ("+self.MAXRETRIES+"). Giving up...");
                    self.emit('connect',err);
                }
            }
        }
        else {
            _debug("[client] No error code, ignoring by logging: "+err.toString());
        }
    })

}

// Wait for a connection
function _clientWaitConnection(handler) {

    if ( this.connected )
        return handler();

    return this.waitingConnect.push(handler);

}

// On message
function _clientOnMessage(msg) {

    var
        self = this,
        m;

    try {
        m = JSON.parse(msg.toString('utf8'));
    }
    catch(ex) {
        _debug("ERROR:\tServer sent something that is not a valid JSON: ",msg.toString('utf8'));
        _debug("ERROR:\tParsing error: ",ex);
        return;
    }

    // Answer to my requests

    if ( m.command == "answer" ) {
        if ( m.to == "ask" ) {
            if ( m.mid == null || !self._requests[m.mid] ) {
                _debug("ERROR:\tServer sent an answer without an ID");
                return;
            }
            var
                req = self._requests[m.mid];

            if ( m.error ) {
                _debug("ERROR:\tServer told that ask request failed: ",m.error);
                return req.handler(m.error,null);
            }
            if ( !m.ids || !(m.ids instanceof Array) ) {
                _debug("ERROR:\tServer didn't send a list of ID's");
                return req.handler(new Error("Server didn't send a list of ID's"),null);
            }

            _debug("INFO:\tServer sent the "+m.ids.length+" ids");

            return req.handler(null,m.ids);

        }
        else if ( m.to == "last" ) {
            if ( m.mid == null || !self._requests[m.mid] ) {
                _debug("ERROR:\tServer sent an answer without an ID");
                return;
            }
            var
                req = self._requests[m.mid];

            if ( m.error ) {
                _debug("ERROR:\tServer told that ask request failed: ",m.error);
                return req.handler(m.error,null);
            }

            _debug("INFO:\tServer sent the last ID for key '"+m.key+"': "+m.id);
            req.handler(null,m.id);
        }
        return self._send({error: { code: "EUNKNANS", description: "Answer to an unknown command", command: m.to } });
    }

    _debug("[client] Error:\t",{ code: "EUNKNCMD", description: "Unknown command", command: m.command });
//  return self._send({error: { code: "EUNKNCMD", description: "Unknown command", command: m.command } });

}



// On client error
function _clientOnError() { }

// On cleint disconnect
function _clientOnDisconnect() {

    if ( !this.connected )
        return;

    _debug("INFO:\tConnection reset by server");
    this.connected = false;

    return this._clientConnect();

}


// Tell things to the server
function _send(obj,handler) {
    if ( !this.connected )
        return;
    return this.stream.sendMessage(JSON.stringify(obj),handler);
}
function _command(command,args,handler) {
    var
        o = args || { };

    o.command = command;
    this._send(o,handler);
}


// Debug
function _debug() {
    if ( !DEBUG )
        return;
    var
        moment = _nsec(first).toString(),
        args = [];
    for ( var x = moment.length ; x < 15 ; x++ )
        moment += " ";
    args.push("@"+moment);
    for ( var x = 0 ; x < arguments.length ; x++ )
        args.push(arguments[x]);

    console.log.apply(console,args);
}
function _nsec(start) {
    if ( first == null )
        start = first = process.hrtime();
    var
        diff = process.hrtime(start);

    return (diff[0] * 1e9 + diff[1]) / 1000000;
}


// Myself exported

module.exports = Client;
