"use strict";

var
	IDClient = require('../lib/id').Client,
	client = new IDClient({host: "127.0.0.1"});

client.ask("x",10,function(err,ids){
	if ( err ) {
		console.log("Error getting IDs: ",err);
		throw err;
	}

	console.log("IDs: ",ids);
});

