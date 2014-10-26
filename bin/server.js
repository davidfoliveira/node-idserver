#!/usr/bin/env node

"use strict";

var
	IDServer = require('../lib/id').Server,
	server = new IDServer(/*{idPattern: "ID-%%-##"}*/);

// Defaults to port 1970
server.start(function(){

/*    setInterval(function(){
        server.bizAskIDs('x',10,function(err,ids){
            if ( err ) {
                console.log("Can't get id's: ",err);
                return process.exit(-1);
            }

            console.log("ids: ",ids);
        });
    },0);
*/

});
