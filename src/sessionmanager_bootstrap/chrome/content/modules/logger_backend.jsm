"use strict";

// Exported functions
this.EXPORTED_SYMBOLS = ["logger"];

// Configuration Constant Settings - addon specific
const ADDON_NAME = "Session Manager";
const FILE_NAME = "sessionmanager_log.txt";
const LOG_ENABLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging";
const BACKUP_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.backup_error_console_settings";
const LOG_CONSOLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_to_console";
const LOG_LEVEL_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_level";
const BUNDLE_URI = "chrome://sessionmanager/locale/sessionmanager.properties";
const ERROR_STRING_NAME = "file_not_found";
const PREFERENCE_ROOT = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const report = Components.utils.reportError;

// Get lazy getter functions from XPCOMUtils and Services
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");

// EOL Character - dependent on operating system.
XPCOMUtils.defineLazyGetter(this, "_EOL", function() {
		return /win|os[\/_]?2/i.test(Services.appinfo.OS)?"\r\n":"\n";
}); 

// logging level 
const logging_level = { STATE: 1, TRACE: 2, DATA: 4, INFO: 8, EXTRA: 16, ERROR: 32 };

this.logger = {

	logging_level: {},

	logError: function(e) {
		logError(e);
	},
	
	log: function(aMessage, level) {
		log(aMessage, level);
	},
	
	deleteLogFile: function(aForce) {
		deleteLogFile(aForce);
	},
	
	openLogFile: function() {
		openLogFile();
	},
	
	shutdown: function() {
		shutdown();
	}
}

// Copy logging level into logger object
let keys = Object.keys(logging_level);
for (let i in keys)
	logger.logging_level[keys[i]] = logging_level[keys[i]];

Object.freeze( this.logger );

// private variables
var _logFile = null;           // Current log file
var _need_log_Addons = false;  // Set to true, when call to log current enabled add-ons has  (once per browsing session)
var _done_log_Addons = false;  // Set to true after the current enabled add-ons have been logged (once per browsing session)
var _logToConsole = false;     // Set to true if also logging to console when logging is enabled
var _logLevel = 0;             // Set to the current logging level (see above)
var _printedHeader = false;    // Printed header to log file
var write_in_progress = false; // Set to true when an asynchronous write is in progress.  Used to prevent multiple writes at the same time
var _file_error_count = 0;     // Used to keep track of file write errors
var _delete_log_file = false;  // Set to true if log file was locked because of write when trying to delete.  Delete file when write done
var _component_active = true;  // Set to false when shutting down.  If component is unloaded this will be undefined (which is good)

// Message buffer to store logged events prior to logging extensions and preferences since we want those to log first (not used after flushed)
var startup_buffer = "";

// Message buffer to store logged events that need to be written (allows async log file writing to disk)
var disk_buffer = "";

//
// For exceptions with a location, generate the call stack
//
function getCallStack(aLocation) {
	let stack = aLocation;
	let text = stack.toString();
	// If there is a call stack, log that as well
	while (stack = stack.caller) {
		text += "\n" + stack.toString();
	}
	return text;
}

//
// Utility to create an error message in the log without throwing an error.
//
function logError(e) {
	// If not an exception, just log it.
	if (!e.message) {
		log(e, "ERROR");
		return;
	}
	
	// Log Addons if haven't already
	if (!_need_log_Addons) logAddons();
		
	let location = e.stack || getCallStack(e.location) || (e.fileName + ":" + e.lineNumber);
	try { 
		let msg = (new Date).toGMTString() + ": EXCEPTION - {" + e.message + "} \n" + location + "\n"
		if (!_done_log_Addons) 
			startup_buffer += msg;
		else {
			Services.console.logStringMessage(ADDON_NAME + ": " + msg);
			write_log(msg);
		}
	}
	catch (ex) {
		report(ex);
	}
}

//
// Log info messages
//
function log(aMessage, level) {
	// Log Addons if haven't already
	if (!_need_log_Addons) logAddons();

	if (!level) level = "INFO";
	try {
		if (logging_level[level] & _logLevel) {
			let msg = (new Date).toGMTString() + ": " + aMessage + "\n"
			if (!_done_log_Addons)
				startup_buffer += msg;
			else {
				if (_logToConsole) Services.console.logStringMessage(ADDON_NAME + ": " + msg);
				write_log(msg);
			}
		}
	}
	catch (ex) { 
		report(ex); 
	}
}

// 
// Delete Log File if it exists and not logging or it's too large (> 10 MB)
//
function deleteLogFile(aForce) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return false;
	}
	
	try { 
		if (_logFile.exists() && (aForce || _logFile.fileSize > 10485760)) {
			_logFile.remove(false);
			return true;
		}
	}
	catch (ex) { 
		// if file is locked and writing to log file, flag it for deletion 
		if ((ex.result == Components.results.NS_ERROR_FILE_IS_LOCKED) && write_in_progress)
			_delete_log_file = true;
		else 
			report(ex); 
	}
	return true;
}

//
// Open Log File
//
function openLogFile() {
	setLogFile();
	// Report error if log file not found
	if (!_logFile || !_logFile.exists() || !(_logFile instanceof Ci.nsILocalFile)) {  // In Gecko 14 and up check for nsIFile
		try {
			let bundle = Services.strings.createBundle(BUNDLE_URI);
			let errorString = bundle.GetStringFromName(ERROR_STRING_NAME);	
			Services.prompt.alert(null, ADDON_NAME, errorString);
		}
		catch (ex) {
			report(ex);
		}
		return;
	}
		
	try {
		// "Double click" the log file to open it
		_logFile.launch();
	} catch (e) {
		try {
			// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
			let mimeInfoService = Cc["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Ci.nsIMIMEService);
			let mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(_logFile), "txt");
			mimeInfo.preferredAction = mimeInfo.useSystemDefault;
			mimeInfo.launchWithFile(_logFile);      
		}
		catch (ex)
		{
			Services.prompt.alert(null, ADDON_NAME, ex);
		}
	}
}
	

//
// Private Functions
//


//
// Set the Log File - This will throw if profile isn't loaded yet
//
function setLogFile() {
	if (!_logFile) {
		try {
			// Get Profile folder and append log file name
			_logFile = FileUtils.getFile("ProfD", [FILE_NAME]);
		}
		catch (ex) { 
			_logFile = null;
			return false;
		}
	}
	return true;
}

//
// Write to Log File
// 
function write_log(aMessage, aForce) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return;
	}
	
	let aData = "";
	if (!_printedHeader) {
		aData += "*************************************************\n";
		aData += "********** A D D O N   E N A B L E D ************\n";
		aData += "*************************************************\n";
		_printedHeader = true;
	}
	aData += aMessage;
	
	// This is used to buffer logging, otherwise log file gets corrupted when doing multiple asynchronous writes at the same time
	if (write_in_progress && !aForce) {
		disk_buffer += aData;
	}
	else {
		aData = aData.replace(/\n/g, _EOL);  // Change EOL for OS
	
		try {
			let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
			converter.charset = "UTF-8";
			
			// Asynchronously copy the data to the file.
			let istream = converter.convertToInputStream(aData);
			let ostream = FileUtils.openFileOutputStream(_logFile, FileUtils.MODE_WRONLY | FileUtils.MODE_CREATE | FileUtils.MODE_APPEND);
			write_in_progress = true;
			// Note: if logging is disable, this will throw because the module will be unloaded before the callback function calls.
			// It shows up in the error console, but there's really nothing that can be done about it without checking each log
			// message to make sure we aren't logging when the logging preference change which would add overhead so just let it throw.
			NetUtil.asyncCopy(istream, ostream, write_log_done);
		}
		catch (ex) { 
			report(ex); 
		}
	}
}
	
//
// Callback for when asynchronous write is complete - kick off next write if anything in buffer
//
function write_log_done(aResults) {
	// Don't continue if compomnent isn't active (meaning it's been unloaded)
	if (!_component_active) 
		return;

	// Log any errors.  Stop logging after 3 errors in a row
	if (!Components.isSuccessCode(aResults)) {
		_file_error_count++;
		let exception = new Components.Exception(FILE_NAME, aResults, Components.stack.caller);
		if (_file_error_count < 3)
			logError(exception);
		else
			report(exception);
	}
	else {
		_file_error_count = 0;
		
		// Tried to delete log file, but it was locked because of write so delete it now and clear log buffer
		if (_delete_log_file) {
			_delete_log_file = false;
			this.delete(true);
			_logFile = null;
			disk_buffer = "";
			write_in_progress = false;
		}
	
		// If anything else to write to disk, log it other wise mark writing done
		if (disk_buffer && disk_buffer.length) {
			let buffer = disk_buffer;
			disk_buffer = "";
			write_log(buffer, true);
		}
		else
			write_in_progress = false;
	}
}	
	
//
// Log Addons - Also log browser version
//
function logAddons(aAddons) {
	_need_log_Addons = true;

	// Use this function as the callback function and check the parameter since it will be set if called back or null if called internally.
	if (!aAddons) {
		AddonManager.getAllAddons(logAddons);
		return false;
	}
	let addons = aAddons;
	
	// to get rid of bogus Mozilla validation warning
	var localString = "unknown";
	try {
		localString = Services.prefs.getComplexValue("general.useragent.locale",Ci.nsISupportsString).data
	} catch(ex) {}

	// Log OS, browser version and locale
	let logString = "\n\tOS = " + Services.appinfo.OS + "\n\tBrowser = " + Services.appinfo.ID + " - " + Services.appinfo.name + " " + Services.appinfo.version;
	logString += "\n\tLocale = " + localString;
	
	// Log Addons 
	if (addons.length) {
		logString += "\n\taddons installed and enabled:\n\t   ";
		let addonString = [];
		for (let i=0; i<addons.length; i++) {
			if (addons[i].isActive) {
				addonString.push(addons[i].name + " " + addons[i].version);
			}
		}
		logString += addonString.sort().join("\n\t   ");
	}
	
	// Log related Firefox prefences
	logString += "\n\tBrowser preferences:";
	logString += "\n\t   browser.privatebrowsing.autostart = " + getPrefValue("browser.privatebrowsing.autostart","");
	logString += "\n\t   browser.startup.page = " + getPrefValue("browser.startup.page","");
	let sessionStorePrefs = Services.prefs.getBranch("browser.sessionstore.").getChildList("",{});
	for (let i=0; i < sessionStorePrefs.length; i++) {
		logString += "\n\t   browser.sessionstore." + sessionStorePrefs[i] + " = " + getPrefValue("browser.sessionstore." + sessionStorePrefs[i],"");
	}
	logString += "\n\t   browser.tabs.warnOnClose = " + getPrefValue("browser.tabs.warnOnClose","");
	logString += "\n\t   browser.warnOnQuit = " + getPrefValue("browser.warnOnQuit","");
	logString += "\n\t   privacy.clearOnShutdown.history = " + getPrefValue("privacy.clearOnShutdown.history","");
	logString += "\n\t   privacy.sanitize.sanitizeOnShutdown = " + getPrefValue("privacy.sanitize.sanitizeOnShutdown","");
  
	// Log preferences
	let count = {}, prefStrings = [];
	let children = Services.prefs.getBranch(PREFERENCE_ROOT).QueryInterface(Ci.nsIPrefBranch).getChildList("",count);
	if (children.length) {
		logString += "\n\tAdd-on preferences:\n\t   ";
		for (let i=0; i < children.length; i++) 
			prefStrings.push(children[i] + " = " + getPrefValue(PREFERENCE_ROOT + children[i]));
		logString += prefStrings.sort().join("\n\t   ");
	}

	// Set this now so don't buffer the logging of logString
	_done_log_Addons = true;
	
	// Log start up buffer too (strip off last "\n")
	logString += "\n" + startup_buffer.substring(0,startup_buffer.length-1);
	startup_buffer = "";
	
	// Actually log the logString.  This speeds up logging by a few 1000%.
	log(logString, "INFO");
}

function enableDisableErrorConsole(aEnable) {
	// Enable the error console and chrome logging when logging to console is enabled so user can
	// see any chrome errors that are generated (which might be caused by Session Manager)
	if (aEnable) {
		// Save old values
		let old_prefs = { "devtools.errorconsole.enabled" : getPrefValue("devtools.errorconsole.enabled", false), 
		                  "javascript.options.showInConsole" : getPrefValue("javascript.options.showInConsole", false) };
		
		setPrefValue(BACKUP_PREFERENCE_NAME, JSON.stringify(old_prefs));
			
		setPrefValue("devtools.errorconsole.enabled", true);
		setPrefValue("javascript.options.showInConsole", true);
	}
	else {
		let old_prefs = JSON.parse(getPrefValue(BACKUP_PREFERENCE_NAME, "{}"));
	
		// Restore old values if they existed
		if (!old_prefs["devtools.errorconsole.enabled"])
			try {
				Services.prefs.clearUserPref("devtools.errorconsole.enabled");
			} catch(ex) { }
			
		if (!old_prefs["javascript.options.showInConsole"])
			try {
				Services.prefs.clearUserPref("javascript.options.showInConsole");
			} catch(ex) { }
		
		try {
			Services.prefs.clearUserPref(BACKUP_PREFERENCE_NAME);
		} catch(ex) { }
	}
}

function startup() {
	// If we aren't logging don't do anything
	if (getPrefValue(LOG_ENABLE_PREFERENCE_NAME, false)) {

		// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
		Services.prefs.addObserver(LOG_CONSOLE_PREFERENCE_NAME, observer, false);
		Services.prefs.addObserver(LOG_LEVEL_PREFERENCE_NAME, observer, false);
		
		_logToConsole = getPrefValue(LOG_CONSOLE_PREFERENCE_NAME);
		_logLevel = getPrefValue(LOG_LEVEL_PREFERENCE_NAME);
		
		// Enable error console if logging to console
		enableDisableErrorConsole(_logToConsole);
		
		// Do a conditional delete of the log file each time the application starts
		deleteLogFile();
	}
}

function shutdown() {
	_component_active = false;
	Services.prefs.removeObserver(LOG_CONSOLE_PREFERENCE_NAME, observer);
	Services.prefs.removeObserver(LOG_LEVEL_PREFERENCE_NAME, observer);

	// revert changes made for error console
	enableDisableErrorConsole(false);
}

function getPrefValue(aName, aDefault) {
	let value = (typeof aDefault == "undefined") ? "" : aDefault;

	try	{
		let pb = Services.prefs;
		switch (pb.getPrefType(aName)) {
			case pb.PREF_STRING:
				// handle unicode values
				value = pb.getComplexValue(aName,Ci.nsISupportsString).data
				break;
			case pb.PREF_BOOL:
				value = pb.getBoolPref(aName);
				break;
			case pb.PREF_INT:
				value = pb.getIntPref(aName);
				break;
		}
	}
	catch (ex) { }
	return value;
}

function setPrefValue(aName, aValue) {
	try {
		let pb = Services.prefs;
		switch (typeof aValue)
		{
			case "string":
				// handle unicode values
				var str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
				str.data = aValue;
				pb.setComplexValue(aName,Ci.nsISupportsString, str);
				break;
			case "boolean":
				pb.setBoolPref(aName, aValue);
				break;
			case "number":
				pb.setIntPref(aName, Math.floor(aValue));
				break;
		}
	} 
	catch(ex) { logError(ex); }
}

// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
var observer = {
	observe: function(aSubject, aTopic, aData) {
		switch (aTopic)
		{
		case "nsPref:changed":
			switch(aData) 
			{
				case LOG_CONSOLE_PREFERENCE_NAME:
					_logToConsole = getPrefValue(LOG_CONSOLE_PREFERENCE_NAME);
					enableDisableErrorConsole(_logToConsole);
					break;
				case LOG_LEVEL_PREFERENCE_NAME:
					_logLevel = getPrefValue(LOG_LEVEL_PREFERENCE_NAME);
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
