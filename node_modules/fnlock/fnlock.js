"use strict";

var
	locks = {},
	waits = {};

exports.lock = function(cb){

	var
		args = Array.prototype.slice.call(arguments,0,4),
		callback = null,
		k = null;

	if ( args.length >= 2 ) {
		k = args[0];
		callback = args[1];
	}
	else if ( typeof(args[0]) == "string" )
		k = args[0];
	else if ( typeof(args[0]) == "function" ) {
		callback = args[0];
		k = callback.toString();
	}
	else
		throw new Error("Unexpected arguments");

	// Only using key (setting locking state of other place)

	if ( callback == null ) {
		if ( locks[k] )
			return false;
		locks[k] = true;
		return true;
	}

	// Has a callback, so... try to run it.
	// If is locked, queue

	if ( locks[k] ) {
		if ( waits[k] == null )
			waits[k] = [callback];
		else
			waits[k].push(callback);
		return true;
	}
	locks[k] = true;

	// Run and then.. release

	callback(function(){ return exports.unlock(k); });
	return false;

};

exports.unlock = function(arg) {

	var
		k = (typeof(arg) == "string") ? arg : arg.toString();

	if ( !waits[k] || waits[k].length == 0 ) {
		delete locks[k];
		return;
	}
	var cb = waits[k].shift();
	return cb(function(){ return exports.unlock(k); });

};

exports.isLocked = function(callback) {

	var
		k = callback.toString();

	return(locks[k] ? true : false);

};
