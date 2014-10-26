"use strict";

var
	IDClient = require('../lib/id').Client,
	client = new IDClient({host: "127.0.0.1"});

client.last("x",function(err,id){
	if ( err ) {
		console.log("Error getting last id: ",err);
		throw err;
	}

	console.log("ID: ",id);
});

