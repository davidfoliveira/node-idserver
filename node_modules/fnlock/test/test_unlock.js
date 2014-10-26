var
	fnlock = require('../fnlock');

function x() {

	fnlock.lock('fnx',function (handler){
		setTimeout(function(){
			console.log("YEEEY!!");
			return handler();
		},1000);
	});

}

fnlock.lock('fnx');
x();

setTimeout(function(){
	console.log("Unlocked");
	fnlock.unlock('fnx');
},1000);
