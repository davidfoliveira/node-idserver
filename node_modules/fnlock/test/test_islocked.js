var
	fnlock = require('../fnlock'),
	lock = fnlock.lock;

function run(arg){
	lock(_reallyRun);
}
function _reallyRun(release){
	console.log("Enter ");
	setTimeout(release,1000);
}

run();
console.log("Locked ?",fnlock.isLocked(_reallyRun));
setTimeout(function(){
console.log("Locked ?",fnlock.isLocked(_reallyRun));
},1100);
