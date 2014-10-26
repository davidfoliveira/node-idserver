"use strict";

var
	Client = require('../lib/id').Client,
	client = new Client({host: "127.0.0.1"});

setInterval(function(){
	client.ask("x",10,{},function(err,ids){
		if ( err ) {
			console.log("Error getting id's: ",err);
			throw err;
		}

		console.log("IDS: ",ids);
	});
},0);
