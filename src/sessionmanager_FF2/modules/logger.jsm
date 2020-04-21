"use strict";

// Exported functions
this.EXPORTED_SYMBOLS = ["log", "logError", "deleteLogFile", "openLogFile", "logging_level"];

// Configuration Constant Settings - addon specific
const ADDON_NAME = "Session Manager";
const FILE_NAME = "sessionmanager_log.txt";
const LOG_ENABLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging";
const LOG_CONSOLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_to_console";
const LOG_LEVEL_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_level";
const BUNDLE_URI = "chrome://sessionmanager/locale/sessionmanager.properties";
const ERROR_STRING_NAME = "file_not_found";
const UUID = "{1280606b-2510-4fe0-97ef-9b5a22eafe30}";

const Cc = Components.classes;
const Ci = Components.interfaces
const Cu = Components.utils;
const report = Components.utils.reportError;

// Get lazy getter functions from XPCOMUtils and Services
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Lazily define services
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}

// EOL Character - dependent on operating system.
XPCOMUtils.defineLazyGetter(this, "_EOL", function() {
		return /mac|darwin/i.test(Services.appinfo.OS)?"\n":/win|os[\/_]?2/i.test(Services.appinfo.OS)?"\r\n":"\r";
}); 

  
// logging level
this.logging_level = { STATE: 1, TRACE: 2, DATA: 4, INFO: 8, EXTRA: 16, ERROR: 32 };
Object.freeze( this.logging_level );

// private variables
var _initialized = false;		// Logger module initialized
var _logFile = null;			// Current log file
var _logged_Addons = false;		// Set to true, when the current enabled add-ons have been logged (once per browsing session)
var _logEnabled = false;		// Set to true if logging is enabled
var _logToConsole = false;  // Set to true if also logging to console when logging is enabled
var _logLevel = 0;				// Set to the current logging level (see above)
var _printedHeader = false;		// Printed header to log file

// Message buffer to store logged events prior to initialization
var buffer = [];

// 
// Public Logging functions
//

//
// Utility to create an error message in the log without throwing an error.
//
function logError(e, force, time) {
	if (_initialized && !_logEnabled && !force)
		return

	// If not an exception, just log it.
	if (!e.message) {
		log(e, "ERROR", force);
		return;
	}
	
	// Log Addons if haven't already
	if (!_logged_Addons) logExtensions();
		
	let location = e.stack || e.location || (e.fileName + ":" + e.lineNumber);
	try { 
		if (!_initialized) {
			arguments[2] =(new Date).toGMTString();
			arguments.length = 3;
			buffer.push({ functionName: "logError", args: arguments});
		}
		else if (force || _logEnabled) {
			Services.console.logStringMessage(ADDON_NAME + " - EXCEPTION (" + (time ? time : (new Date).toGMTString()) + "): {" + e.message + "} {" + location + "}");
			if (_logEnabled) write_log((time ? time : (new Date).toGMTString()) + ": EXCEPTION - {" + e.message + "} {" + location + "}" + "\n");
		}
	}
	catch (ex) {
		report(ex);
	}
}

//
// Log info messages
//
function log(aMessage, level, force, time) {
	if (_initialized && !_logEnabled && !force)
		return
		
	// Log Addons if haven't already
	if (!_logged_Addons) logExtensions();

	if (!level) level = "INFO";
	try {
		if (!_initialized) {
			arguments[3] =(new Date).toGMTString();
			arguments.length = 4;
			buffer.push({ functionName: "log", args: arguments});
		}
		else if (force || (_logEnabled && (logging_level[level] & _logLevel))) {
			if (force || _logToConsole) Services.console.logStringMessage(ADDON_NAME + " (" + (time ? time : (new Date).toGMTString()) + "): " + aMessage);
			if (_logEnabled) write_log((time ? time : (new Date).toGMTString()) + ": " + aMessage + "\n");
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
		if (_logFile.exists() && (aForce || !_logEnabled || _logFile.fileSize > 10485760)) {
			_logFile.remove(false);
			return true;
		}
	}
	catch (ex) { 
		report(ex); 
	}
	return true;
}

//
// Open Log File
//
function openLogFile() {
	// Report error if log file not found
	if (!_logFile || !_logFile.exists() || !(_logFile instanceof Ci.nsILocalFile)) {
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
// Set the Log File - This will throw if profile isn't lodaed yet
//
function setLogFile() {
	if (!_logFile) {
		try {
			// Get Profile folder and append log file name
			_logFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
			_logFile.append(FILE_NAME);
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
function write_log(aMessage) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return;
	}
	
	try {
		let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		// ioFlags: write only, create file, append;	Permission: read/write owner
		stream.init(_logFile, 0x02 | 0x08 | 0x10, 384, 0);
		let cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

		if (!_printedHeader) {
			cvstream.writeString(_EOL + "*************************************************" + _EOL);
			cvstream.writeString("******** B R O W S E R   S T A R T U P **********" + _EOL);
			cvstream.writeString("*************************************************" + _EOL);
			_printedHeader = true;
		}
		cvstream.writeString(aMessage.replace(/[\n$]/g, _EOL));
		cvstream.flush();
		cvstream.close();
	}
	catch (ex) { 
		report(ex); 
	}
}
	
//
// Log Extensions - Also log browser version
//
function logExtensions(aExtensions) {
	if (!_logEnabled) return;
	_logged_Addons = true;

	// Quit if Application doesn't exist or called from background thread (to prevent rare timing crash)
	if (!Application || !Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) return;
		
	// Use this function as the callback function and check the parameter since it will be set if called back or null if called internally.
	if (!aExtensions) {
		Application.getExtensions(logExtensions);
		return false;
	}
	let extensions = aExtensions;

	// Set to initialized.  Do this here so the addons are always logged first
	_initialized = true;
	
	// Log OS, browser version and locale
	let logString = "\n\tOS = " + Services.appinfo.OS + "\n\tBrowser = " + Application.id + " - " + Application.name + " " + Application.version;
	logString += "\n\tLocale = " + Application.prefs.getValue("general.useragent.locale", "unknown");
	
	// Log Addons 
	if (extensions.all.length) {
		logString += "\n\tExtensions installed and enabled:\n\t   ";
		let extString = [];
		for (let i=0; i<extensions.all.length; i++) {
			if (extensions.all[i].enabled) {
				extString.push(extensions.all[i].name + " " + extensions.all[i].version);
			}
		}
		logString += extString.sort().join("\n\t   ");
	}
	
	// Log related Firefox prefences
	logString += "\n\tBrowser preferences:";
	logString += "\n\t   browser.privatebrowsing.autostart = " + Application.prefs.getValue("browser.privatebrowsing.autostart","");
	logString += "\n\t   browser.startup.page = " + Application.prefs.getValue("browser.startup.page","");
	let sessionStorePrefs = Services.prefs.getBranch("browser.sessionstore.").getChildList("",{});
	for (let i=0; i < sessionStorePrefs.length; i++) {
		logString += "\n\t   browser.sessionstore." + sessionStorePrefs[i] + " = " + Application.prefs.getValue("browser.sessionstore." + sessionStorePrefs[i],"");
	}
	logString += "\n\t   browser.tabs.warnOnClose = " + Application.prefs.getValue("browser.tabs.warnOnClose","");
	logString += "\n\t   browser.warnOnQuit = " + Application.prefs.getValue("browser.warnOnQuit","");
	logString += "\n\t   privacy.clearOnShutdown.history = " + Application.prefs.getValue("privacy.clearOnShutdown.history","");
	logString += "\n\t   privacy.sanitize.sanitizeOnShutdown = " + Application.prefs.getValue("privacy.sanitize.sanitizeOnShutdown","");
  
	// Log preferences
	let prefs = extensions.get(UUID).prefs.all
	if (prefs.length) {
		logString += "\n\tAdd-on preferences:\n\t   ";
		let prefStrings = [];
		for (let i=0; i<prefs.length; i++) {
			prefStrings.push(prefs[i].name + " = " + prefs[i].value);
		}
		logString += prefStrings.sort().join("\n\t   ");
	}
	
	// Actually log the logString.  This speeds up logging by a few 1000%.
	log(logString, "INFO");

	// Log anything stored in the buffer
	logStoredBuffer();
}

function logStoredBuffer() {
	if (buffer) {
		let item;
		while (item = buffer.shift()) {
			switch (item.functionName) {
			case "log":
				log(item.args[0], item.args[1], item.args[2], item.args[3]);
				break;
			case "logError":
				logError(item.args[0], item.args[1], item.args[2]);
				break;
			}
		}
		buffer = null;
		log("End of Stored Log Buffer", "INFO");
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
					_logEnabled = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME).value;
					break;
				case LOG_CONSOLE_PREFERENCE_NAME:
					_logToConsole = Application.prefs.get(LOG_CONSOLE_PREFERENCE_NAME).value;
					break;
				case LOG_LEVEL_PREFERENCE_NAME:
					_logLevel = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME).value;
					break;
			}
			break;
		case "final-ui-startup":
			Services.obs.removeObserver(this, "final-ui-startup");
			Services.obs.addObserver(this, "profile-change-teardown", false);
			
			// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
			// only need to register LOG_ENABLE_PREFERENCE_NAME because "*.logging" is in "*.logging_level" so it gets both of them
			Services.prefs.addObserver(LOG_ENABLE_PREFERENCE_NAME, this, false);
			
			_logEnabled = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME).value;
			_logToConsole = Application.prefs.get(LOG_CONSOLE_PREFERENCE_NAME).value;
			_logLevel = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME).value;
			
			// Do a conditional delete of the log file each time the application starts
			deleteLogFile();
			
			if (_logEnabled) {
				logExtensions();
			}
			else {
				// Set to initialized so we don't buffer any more
				_initialized = true;
				_logged_Addons = false;
				buffer = null;
			}
			break;
		case "profile-change-teardown":
			// remove observers
			Services.obs.removeObserver(this, "profile-change-teardown");
			Services.prefs.removeObserver(LOG_ENABLE_PREFERENCE_NAME, this);
		}
	}
}

// Initialize on the "final-ui-startup" notification because if we initialized prior to that a number of bad things will happen,
// including, the log file failing to delete and the Fuel Application component's preference observer not working.
Services.obs.addObserver(observer, "final-ui-startup", false);