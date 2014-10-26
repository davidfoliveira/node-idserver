"use strict";

var
    fs              = require('fs'),
    net             = require('net'),
    fnlock          = require('fnlock'),
    async           = require('async'),
    Stream          = require('./stream').Stream,

    DEBUG           = true,
    MAXREQUESTIDS   = 1000,
    first           = null;


// A server instance
function Server(opts) {

	if ( !opts ) 
		opts = {};
	this._opts = opts;

	// Check basic options
	if ( !this._opts.port )
		this._opts.port = 1970;
    if ( this._opts.journaling == null )
        this._opts.journaling = true;
    if ( this._opts.journaling && !this._opts.journalFile )
        this._opts.journalFile = "/tmp/idserver.journal";
    if ( this._opts.journaling && !this._opts.commitInterval )
        this._opts.commitInterval = 1000;

    // Getter and setter
    if ( !this._opts.getter || (!this._opts.setter && !this._opts.committer) ) {
        this.get    = this._opts.getter   = bizDefaultGetter;
        this.set    = this._opts.setter   = bizDefaultSetter;
        this.commit = this._opts.commiter = bizDefaultCommitter;
        this.dataInterface = "default";
        if ( !this._opts.dataFile )
            this._opts.dataFile = "/tmp/idserver.data";
    }
    else
        this.dataInterface = "custom";

	// Internal variables
	this._s                     = null;    // Socket
    this._j                     = null;    // Journal
    this._jPos                  = 0;       // Journal position
    this._idMap                 = {};
    this._changed               = {};
    this.clients                = {};


    // Methods
    this.start                  = start;
    this._journalOpen           = _journalOpen;
    this._journalWrite          = _journalWrite;
    this._journalCleanup        = _journalCleanup;
    this._journalProcessFile    = _journalProcessFile;
    this._serverSocketStart     = _serverSocketStart;
    this._clientInit            = _clientInit;
    this._clientNewClientID     = _clientNewClientID;
    this._clientNewPingTime     = _clientNewPingTime;
    this._clientMessage         = _clientMessage;
    this._clientDestroy         = _clientDestroy;
    this._bizFirstID            = _bizFirstID;
    this._bizFirstIDByPattern   = _bizFirstIDByPattern;
    this.bizCurrentID           = bizCurrentID;
    this.bizAskIDs              = bizAskIDs;
    this.bizLoadData            = bizLoadData;
    this.bizCommit              = bizCommit;
    this._bizAskIDs             = _bizAskIDs;

    this._command               = _command;
    this._answer                = _answer;
    this._send                  = _send;
    this._error                 = _error;


    // Debug
    if ( opts.DEBUG )
        DEBUG = true;

};

// Server start
function start(handler) {

    var
        self = this;

    _debug("INFO:\tStarting...");

    if ( !handler )
        handler = function(){};

    // Run tasks in sequence
    async.series(
        [

            // Load data from disk (for default data interface)
            function(next){
                if ( self.dataInterface != "default" )
                    return next(null,false);

                // Read data
                return self.bizLoadData(function(err){
                    if ( err ) {
                        _debug("ERROR:\tError loading data file '"+self._opts.dataFile+"': ",err);
                        throw err;
                    }
                    return next(null,true);
                });
            },

            // Process the journal file
            function(next){
                if ( !self._opts.journaling )
                    return next(null,false);

                return self._journalProcessFile(function(err){
                    if ( err ) {
                        _debug("ERROR:\tError processing journal file '"+self._opts.journalFile+"': ",err);
                        throw err;
                    }

                    return next(null,true);
                });
            },

            // Open journal file
            function(next){
                if ( !self._opts.journaling )
                    return next(null,false);

                return self._journalOpen(function(err,ok){
                    if ( err ) {
                        _debug("ERROR:\tError openning journal file '"+self._opts.journalFile+"': ",err);
                        throw err;
                    }

                    return next(null,true);
                });

            },

            // Schedule commits
            function(next){

                // Schedule periodic commit
                setInterval(function(){
                    self.bizCommit();
                }, self._opts.commitInterval);

                return next(null,true);
            },

            // Start server
            function(next){

                self._serverSocketStart(next);

            }
        ],
        handler
    );

}


/*
 Journal
 */

// Open journal file
function _journalOpen(handler) {

    var
        self = this;

    _debug("INFO:\tOpenning journal file '"+self._opts.journalFile+"'...");
    return fs.open(self._opts.journalFile,'wx',self._opts.journalMode || 384,function(err,fd){
        if ( err ) {
            _debug("ERROR:\tError openning journal file '"+self._opts.journalFile+"': ",err);
            return handler(err,null);
        }

        self._j = fd;
        _debug("INFO:\tJournal file succesfully openned (fd: "+fd+")");
        return handler(null,true);
    });

}

// Write to the journal file
function _journalWrite(str,handler) {

    var
        self = this,
        b = new Buffer(str+"\n\0");

    return fnlock.lock('journalWrite',function(release){
        return fs.write(self._j,b,0,b.length,self._jPos,function(err){
            if ( err ) {
                _debug("ERROR:\tError writting to the journal file: ",err);
                return handler(err,null);
            }

            // Seek to the right position
            self._jPos += b.length-1;

            // Sync with the disk
            return fs.fsync(self._j,function(err){
                if ( err ) {
                    _debug("ERROR:\tError syncing journal to the disk: ",err);
                    return handler(err,null);
                }

                // Release the lock
                release();

                // Done
                return handler(null,true);
            });

        });
    });

}

// Cleanup the journal file
function _journalCleanup(handler) {

    var
        self = this;

    if ( self._j == null )
        return handler(null,false);

    // Truncate the file
    return fs.ftruncate(self._j,0,function(err){
        if ( err ) {
            _debug("ERROR:\tError truncating journal file: ",err);
            return;
        }

        // Seek to the start of journal file
        self._jPos = 0;
        return handler(null,true);
    });

}


// Process and "import" the journal file
function _journalProcessFile(handler) {

    var
        self    = this,
        end     = 0,
        rows    = 0,
        warns   = 0;

    _debug("INFO:\tTrying to load the journal file...");

    // Read the file
    return fs.readFile(self._opts.journalFile,function(err,data){
        if ( err ) {
            if ( err.code != "ENOENT" ) {
                _debug("ERROR:\tError openning journal file '"+self._opts.journalFile+"': ",err);
                return handler(err,null);
            }
            else {
                _debug("INFO:\tJournal file not found, keep going...");
                return handler(null,true);
            }
        }
        if ( data.length > 0 ) {

            _debug("INFO:\tProcessing journal file...");

            // Locate the zero char and take just the useful part
            for ( var x = 0 ; x < data.length ; x++ ) {
                if ( data[x] == 0 )
                    end = x;
            }
            data = data.slice(0,end-1).toString();

            // Split in lines
            data.toString().split("\n").forEach(function(line){
                var
                    sep = line.indexOf("\r"),
                    key,
                    value,
                    opts;

                if ( sep == -1 )
                    return;
                key = line.substr(0,sep);
                opts = (self._opts.keyOptions && typeof self._opts.keyOptions[key] == "object") ? self._opts.keyOptions[key] : self._opts;
                value = line.substr(sep+1,line.length-sep-1);
                rows++;

                // Set on the map
                if ( self._idMap[key] != null && self._idMap[key] >= value ) {
                    _debug("WARN:\tSome problem on the journal file. Found '"+value+"' as value for key '"+key+"' when we have '"+self._idMap[key]+"'. Ignoring...");
                    warns++;
                }
                else
                    self._idMap[key] = opts.idPattern ? value : parseInt(value);
            });

            _debug("INFO:\tJournal file successfully processed ("+rows+" rows/"+warns+" warnings).");
        }
        else {
            _debug("INFO:\tJournal file is empty. Doing nothing.");
        }

        // Commit the loaded data
        return self.bizCommit(function(err,ok){
            if ( err ) {
                _debug("ERROR:\tError committing data after reading the journal file. Keeping the journal for trying again...");
                return handler(err,null);
            }

            // Remove the journal file
            return fs.unlink(self._opts.journalFile,function(err){
                if ( err ) {
                    _debug("ERROR:\tError deleting the already processed journal file '"+self._opts.journalFile+"': ",err);
                    return handler(err,null);
                }

                // Done
                return handler(null,true);
            });

        });

    });

}

/*
  Server
 */

// Start socket server
function _serverSocketStart(handler) {

    var
        self = this;

    self._s = net.createServer(function(con){ self._clientInit(con) });
    self._s.listen(self._opts.port,self._opts.address || "127.0.0.1", function(err){
        if ( err ) {
            _debug("ERROR:\tError binding on port "+self._opts.port+": ",err);
        }
        _debug("INFO:\tListening on port "+self._opts.port+"\n");

        // Watch ping times
//        self._pingCheckInterval = setInterval(function(){ self._pingCheck() },10000);

        return handler();
    });

}


/*
 * Client
 */

// Client initialization
function _clientInit(con) {

    var
        self = this,
        c;

    con._id = this._clientNewClientID();
    c = this.clients[con._id] = {
        // Low level stuff
        id:             con._id,
        con:            con,
        connectTime:    new Date(),
        pingTime:       self._clientNewPingTime(),

        // Stream
        stream:         new Stream("string",con),

        // High level stuff
        status:         "new"
    };
    con.on('error',function(err){
        _debug("ERROR:\tClient "+c.id+" connection error: ",err);
        if ( err.code == 'EPIPE' )
            return self._clientDestroy(c);
    });
    c.stream.on('message',function(msg){
        self._clientMessage(c,msg);
    });
    c.stream.on('close',function(){
        self._clientDestroy(c);
    });
    c.stream.on('end',function(){
        self._clientDestroy(c);
    });
    c.stream.on('error',function(err,cantRecover){
        _error(c,err);
        if ( cantRecover )
            self._clientDestroy(c);
    });

    _debug("INFO:\tClient "+c.id+" connected");

}

// Generate new clint ID
function _clientNewClientID() {

    var
        d = new Date(),
        id;

    do {
        id = "C"+d.getTime().toString() + "." + Math.floor(Math.random()*1001);
    } while ( this.clients[id] != null );

    return id;

}

// New ping time
function _clientNewPingTime() {

    return new Date((new Date()).getTime()+30000);

}

// Handle client message (highlevel stuff)
function _clientMessage(c,msg) {

    var
        self = this,
        m;

    try {
        m = JSON.parse(msg.toString('utf8'));
//      _debug(c.id+" > ",JSON.stringify(m));
    }
    catch(ex) {
        _debug("ERROR:\tClient "+c.id+" sent invalid JSON. Parsing exception: ",ex);
        _debug("ERROR:\tOriginal was: ",msg.toString('utf8'));
        return;
    }

    // Update ping time
    c.pingTime = self._clientNewPingTime();


    // "Ask" command
    if ( m.command == "ask" ) {

        // Validation
        if ( !m.mid || typeof m.mid != "string" )
            return self._answer(c,"ask",{error: { code: "EINVMID", description: "Invalid message ID" }});
        if ( !m.key || typeof m.key != "string" || m.key.match(/\r/) )
            return self._answer(c,"ask",{mid: m.mid, error: {code: "EINVKEY", description: "Invalid key" }});
        if ( !m.n || typeof m.n != "number" || m.n < 0 || m.n > MAXREQUESTIDS )
            return self._answer(c,"ask",{mid: m.mid, error: {code: "ENONUM", description: "Not present or invalid number of required id's" }});

        // Request the id's
        return self.bizAskIDs(m.key,m.n,function(err,ids){
            if ( err ) {
                _debug("ERROR:\tError asking for "+m.n+" ids: ",err);
                return self._answer(c,"ask",{mid: m.mid, error: err});
            }
            return self._answer(c,"ask",{mid: m.mid, ids: ids});
        });

    }

    // "Last" command
    else if ( m.command == "last" ) {

        // Validation
        if ( !m.key || typeof m.key != "string" || m.key.match(/\r/) )
            return self._answer(c,"last",{error: { code: "EINVKEY", description: "Invalid key" }});

        // Get the current ID
        return self.bizCurrentID(m.key,function(err,id){
            if ( err ) {
                _debug("ERROR:\tError getting last ID for "+m.key+": ",err);
                return self._answer(c,"last",{mid: m.mid, error: error});
            }
            return self._answer(c,"last",{mid: m.mid, id: id});
        });

    }

    // "Dump" command
    else if ( m.command == "dump" ) {
        console.log(util.inspect({clients: self.clients, idmap: self._idMap},{depth:2}));
        return self._answer(c,"dump",{ok: true});
    }
    else {
        _debug("WARN:\tUnknown command on: ",m);
        return self._error(c,{ code: "EUNKNCMD", description: "Unknown command", command: m.command });
    }

}

// Destroy a client
function _clientDestroy(c) {

    var
        self = this;

    // Status
    if ( c.status == "dead" )
        return;
    c.status = "dead";

    _debug("INFO:\tClient "+c.id+" has disconnected");

    // Destroy connection
    c.con.destroy();

    // Destroy client
    delete self.clients[c.id];

}


/*
 Biz
 */

function bizDefaultGetter(key,handler) {

    return handler(null,null);

}

function bizDefaultSetter(key,value,handler) {

    return handler(null,true);

}

function bizDefaultCommitter(map,handler) {

    var
        self = this;

    _debug("INFO:\tStoring data... ",JSON.stringify(self._idMap));

    // Write to the data file
    return fs.writeFile(self._opts.dataFile,JSON.stringify(self._idMap),{encoding: 'utf8', mode: 384},function(err){
        if ( err ) {
            _debug("ERROR:\tError writting data file '"+self._opts.dataFile+"': ",err);
            return handler(err,null);
        }

        // OK
        _debug("INFO:\tData succesfully stored.");
        return handler(null,true);
    });

}

// Load data
function bizLoadData(handler) {

    var
        self = this;

    _debug("INFO:\tLoading data file...");

    // Load the data file
    return fs.readFile(self._opts.dataFile,function(err,data){
        if ( err ) {
            if ( err.code == "ENOENT" ) {
                _debug("WARN:\tData file does not exist, initializing with a new data file...");
                return handler(null,true);
            }
            else {
                _debug("ERROR:\tError loading data file '"+self._opts.dataFile+"': ",err);
                return handler(err,null);
            }
        }

        // Parse the JSON and set it as out id map
        try {
            self._idMap = JSON.parse(data.toString());
        }
        catch(ex){
            _debug("ERROR:\tError parsing data file's JSON: ",ex);
            return handler(ex,null);
        }

        _debug("INFO:\tData file successfully loaded ("+Object.keys(self._idMap)+" keys)");
        return handler(null,true);

    });

}

// Commit data
function bizCommit(handler) {

    var
        self        = this,
        toCommit    = {},
        committing  = false,
        cStart      = new Date();

    if ( committing )
        return;
    committing = true;

    if ( !handler )
        handler = function(){};

    // Nothing to do?
    if ( Object.keys(self._changed).length == 0 )
        return handler(null,false);

    _debug("INFO:\tCommitting data...");

    // Find the changed keys
    Object.keys(self._changed).forEach(function(k){
        toCommit[k] = self._idMap[k];
        delete self._changed[k];
    });

    var
        revert = function(){
            Object.keys(toCommit).forEach(function(k){
                self._changed[k] = true;
            });
        };

    // Has a commit function? Commit everything at the same time
    if ( self.commit ) {
        return self.commit(toCommit,function(err,ok){
            if ( err ) {
                _debug("ERROR:\tError committing data: ",err);
                revert();
                committing = false;
                return handler(err,null);
            }

            // Cleanup the journal
            return self._journalCleanup(function(err,ok){
                if ( err ) {
                    _debug("ERROR:\tError cleaning up journal file: ",err);
                    revert();
                }
                else
                    _debug("INFO:\tData succesfully committed (took "+(new Date()-cStart)+" ms)");

                committing = false;
                return handler(err,ok);
            });
        });
    }
    else if ( self.setter ) {
        return async.map(Object.keys(toCommit),
            function(key,next){
                return self.setter(key,toCommit[key],function(err,ok){
                    if ( err ) {
                        _debug("ERROR:\tError setting key '"+key+"' values to '"+toCommit[key]+"': ",err);
                        return next(err,null);
                    }
                });
            },
            function(err,res){
                if ( err ) {
                    revert();
                    committing = false;
                    return handler(err,null);
                }

                // Cleanup the journal
                return self._journalCleanup(function(err,ok){
                    if ( err ) {
                        _debug("ERROR:\tError cleaning up journal file: ",err);
                        revert();
                    }
                    else
                        _debug("Data succesfully committed (took "+(new Date()-cStart)+" ms)");

                    committing = false;
                    return handler(err,true);
                });
            }
        );

    }
    else {
        _debug("ERROR:\tNo way to commit data. No setter OR comitter");
        return revert();
    }

}

// Get current ID for a key
function bizCurrentID(key,handler) {

    var
        self = this;

    if ( self._idMap[key] != null )
        return handler(null,self._idMap[key]);

    // Get
    return self.get(key,function(err,value){
        if ( err ) {
            _debug("ERROR:\tError getting value for key '"+key+"': ",err);
            return handler({code: "EGET", description: "Error getting value for key '"+key+"'.", details: err.toString()});
        }

        // Nothing
        if ( value == null ) {
            self._idMap[key] = self._bizFirstID(key);
            self._changed[key] = true;
        }
        else
            self._idMap[key] = value;

        return handler(null,self._idMap[key]);
    });

}

// For for N id's for a specific key
function bizAskIDs(key,n,handler) {

    var
        self = this,
        opts = (self._opts.keyOptions && typeof self._opts.keyOptions[key] == "object") ? self._opts.keyOptions[key] : self._opts,
        lastID;

    // Lock
    return fnlock.lock("ask_"+key,function(release){

        // Do we need to GET the key ?
        return _if ( !self._idMap[key],
            function(next){
                self.get(key,function(err,value){
                    if ( err ) {
                        _debug("ERROR:\tError getting value for key '"+key+"': ",err);
                        release();
                        return handler({code: "EGET", description: "Error getting value for key '"+key+"'.", details: err.toString()});
                    }
                    self._idMap[key] = value;
                    return next();
                });
            },
            function() {

                // No value ?
                if ( !self._idMap[key] ) {
                    self._idMap[key] = self._bizFirstID(key);
                    self._changed[key] = true;
                }

                // Generate the id's
                return self._bizAskIDs(key,n,opts,function(err,ids){
                    if ( err ) {
                        _debug("ERROR:\tError asking for "+n+" ids for '"+key+"': ",err);
                        release();
                        return handler(err,null);
                    }
                    lastID = ids[ids.length-1];

                    // Store
                    return self._journalWrite(key+"\r"+lastID,function(err,ok){
                        if ( err ) {
                            _debug("ERROR\tError writting to journal file: ",err);
                            release();
                            return handler({code: "EJOUWR", description: "Error writting to the journal file", detail: err.toString() });
                        }

                        // Replace on the id map
                        if ( ids.length > 0 ) {
                            self._idMap[key] = ids[ids.length-1];
                            self._changed[key] = true;
                        }

                        // Release
                        release();

                        // Sent to user
                        return handler(null,ids);
                    });
                });

            }
        );

    });

}

function _bizAskIDs(key,n,opts,handler) {

    var
        self    = this,
        ids     = [],
        baseID  = self._idMap[key];

    // Take many id's as requested
    for ( var x = 0 ; x < n ; x++ ) {
        if ( opts.idPattern ) {
            var newID = _bizAddValueByPattern(opts.idPattern,baseID,1);
            if ( newID == null ) {
                _debug("ERROR:\tCan't get more ID's. Nothing that I can do here. Returning error");
                return handler({code:"EUNGENIDS",description: "Unable to generate more id's for pattern '"+opts.idPattern+"' and value '"+self._idMap[key]+"'"},null);
            }
            baseID = newID;
            ids.push(newID);
        }
        else
            ids.push(++baseID);
    }

    // Store the last ID
    return handler(null,ids);

}

function _bizFirstID(key,start) {

    var
        self = this,
        opts = (self._opts.keyOptions && typeof self._opts.keyOptions[key] == "object") ? self._opts.keyOptions[key] : self._opts;

    if ( opts.idPattern )
        return self._bizFirstIDByPattern(opts.idPattern);

    return 0;

}

function _bizIsValidPattern(pattern) {

    return (pattern && pattern.match(/[%#]/));

}

function _bizFirstIDByPattern(pattern) {
    var
        val;

    // %#%# (% = letter, # = digit)
    return pattern.replace(/%/g,"a").replace(/#/g,"0");
}

function _bizAddValueByPattern(pattern,value,add) {

    var
        _v   = value,
        _add = add;

    if ( _add == 0 )
        return value;

    for ( var x = pattern.length-1 ; x >= 0 && _add > 0 ; x-- ) {
        var
            patChar = pattern[x],
            valChar = _v[x];

        if ( patChar == '#' ) {
            if ( valChar >= '0' && valChar <= '9' ) {
                var valNum = parseInt(valChar) + _add;
                _add = parseInt(valNum / 10);
                if ( valNum >= 10 )
                    valNum = valNum % 10;
                _v = replaceChar(_v,x,valNum.toString());
            }
            else {
                _debug("ERROR:\tFound invalid value '"+value+"' according to pattern '"+pattern+"'. Expecting a number and found '"+valChar+"'. Cannot generate an ID.");
                return null;
            }
        }
        if ( patChar == '%' ) {
            if ( valChar >= 'A' && valChar <= 'Z' ) {
                var valNum = valChar.charCodeAt(0)-65 + _add;
                _add = parseInt(valNum / 26);
                if ( valNum >= 26 )
                    valNum = valNum % 26;
                _v = replaceChar(_v,x,String.fromCharCode(valNum+65));
            }
            else {
                console.log("ERROR:\tFound invalid value '"+value+"' according to pattern '"+pattern+"'. Expecting a letter and found '"+valChar+"'. Cannot generate an ID.");
                return null;
            }
        }
    }
    if ( _add > 0 ) {
        console.log("ERROR:\tCannot add "+add+" to the value '"+value+"' of pattern '"+pattern+"'. The pattern is too short!");
        return null;
    }

    return _v;

}


/*
 Useful stuff
 */

function replaceChar(str, index, character) {
    return str.substr(0, index) + character + str.substr(index+character.length);
}
function _if(cond,a,b) {
    return cond ? a(b) : b();
}


/*
  Sockets
 */

function _send(c,obj) {
//  console.log(c.id+" < ",JSON.stringify(obj));
    return c.stream.sendMessage(JSON.stringify(obj));
}
function _command(c,command,args) {
    var
        o = args || { };

    this.lastCommand = command;
    o.command = command;
    this._send(c,o);
}
function _answer(c,to,args) {
    args.to = to;
    return this._command(c,"answer",args);
}
function _error(c,error) {
    return this._send(c,{ error: error });
}



/*
 Debug
 */

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



// Export myself
module.exports = Server;
