#!/usr/bin/env node

"use strict";

var
	IDServer = require('../lib/id').Server,
	server = new IDServer(/*{idPattern: "ID-%%-##"}*/);

// Defaults to port 1970
server.start(function(){

});
