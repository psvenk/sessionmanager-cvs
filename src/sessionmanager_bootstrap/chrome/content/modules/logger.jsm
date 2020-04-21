"use strict";

// Exported functions
this.EXPORTED_SYMBOLS = ["log", "logError", "deleteLogFile", "openLogFile", "isLogFile", "isLoggingState"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
const report = Components.utils.reportError;

// Get lazy getter functions from XPCOMUtils and Services
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://sessionmanager/content/modules/shared_data/addonInfo.jsm");

// Configuration Constant Settings - addon specific
const LOG_ENABLE_PREFERENCE_NAME = AddonInfo.prefBranch + "logging";
const FILE_NAME = "sessionmanager_log.txt";

// Lazily define services
XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");

const global_scope = this;
var _exportCallDone = false;
var _logEnabled = false;		// Set to true if logging is enabled

// Utility to create an error message in the log without throwing an error.
this.logError = function(e) {
	if (_logEnabled) {
		logger.logError(e);
	}
	else
		report(e);
}

// Log info messages - Need to check for logger because logger changed a preference which triggers logging
// * Note this will throw when logging is turned on since it will be called to log that logging is enabled
// * prior to logging actually being enabled.  It doesn't hurt anything and checking for this case for all
// * log call adds unnecessary overhead, so just let it throw.
this.log = function(aMessage, level) {
	if (_logEnabled) {
		logger.log(aMessage, level);
	}
}

// Delete Log File
this.deleteLogFile = function() {
	backgroundLoadAndExecute("deleteLogFile", true);
}

// Open Log File
function openLogFile() {
	backgroundLoadAndExecute("openLogFile");
}

// Does Log File exist? - Called from option window
function isLogFile() {
	var exists = false;
	try {
		// Get Profile folder and append log file name
		var logfile = FileUtils.getFile("ProfD", [FILE_NAME]);
		exists = logfile.exists();
	}
	catch (ex) {}
		
	return exists;
}

// Called to check if logging of state data is enabled.  
// This is done so the program doesn't needlessly pass a gigantic string to the module unnecessarily
// State's logging level is 1. Use that here so we don't need to import logger_backend.jsm or use lazy getter defined earlier.
function isLoggingState() {
	return (_logEnabled && (Services.prefs.getIntPref("extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_level") & 1));
}

Object.freeze( logError );
Object.freeze( log );
Object.freeze( deleteLogFile );
Object.freeze( openLogFile );
Object.freeze( isLogFile );
Object.freeze( isLoggingState );

// Load logger_background.jsm, execute function and unload if not needed
function backgroundLoadAndExecute(aFunction) {
	// Load backend
	let scope = {}
	Cu.import("chrome://sessionmanager/content/modules/logger_backend.jsm",scope);
	
	// Execute
  let params = Array.prototype.slice.call(arguments, 1);
  let result = scope.logger[aFunction](params);
	scope = null;
	
	// Unload backend if not logging
	if (!_logEnabled) {
		Cu.unload("chrome://sessionmanager/content/modules/logger_backend.jsm");
	}
	
	return result;
}

function startup() {
	// Send unload function to bootstrap.js
	let subject = { wrappedJSObject: shutdown};
	Services.obs.notifyObservers(subject, "session-manager-unload", "LAST");

	// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
	Services.prefs.addObserver(LOG_ENABLE_PREFERENCE_NAME, observer, true);
	
	_logEnabled = Services.prefs.prefHasUserValue(LOG_ENABLE_PREFERENCE_NAME) && 
	    Services.prefs.getBoolPref(LOG_ENABLE_PREFERENCE_NAME);
	
	// If enabled, import logger object
	if (_logEnabled) {
		Cu.import("chrome://sessionmanager/content/modules/logger_backend.jsm");
	}
}

function shutdown() {
	Services.prefs.removeObserver(LOG_ENABLE_PREFERENCE_NAME, observer);

	// Logging, shutdown and delete log file if uninstalling
	if (_logEnabled) {
		_logEnabled = false;
		logger.shutdown();
	}
}

// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
var observer = {
	observe: function(aSubject, aTopic, aData) {
		switch (aTopic)
		{
		case "nsPref:changed":
			switch(aData) 
			{
				case LOG_ENABLE_PREFERENCE_NAME:
					// get temporary copy
					let logEnabled = Services.prefs.prefHasUserValue(LOG_ENABLE_PREFERENCE_NAME) &&
					    Services.prefs.getBoolPref(LOG_ENABLE_PREFERENCE_NAME);
					
					// If logging is turned off, shut down and unload logger_backend.jsm module
					if (!logEnabled) {
						// save globally
						_logEnabled = logEnabled;
						logger.shutdown();
						logger = null;
						
						Cu.unload("chrome://sessionmanager/content/modules/logger_backend.jsm");
					}
					else {
						Cu.import("chrome://sessionmanager/content/modules/logger_backend.jsm");
						
						// save globally
						_logEnabled = logEnabled;
					}
					break;
			}
			break;
		}
	},
	
  QueryInterface: XPCOMUtils.generateQI([
    "nsISupportsWeakReference",
    "nsIObserver"
  ])
}

startup();
