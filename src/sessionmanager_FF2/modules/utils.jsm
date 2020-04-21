"use strict";

this.EXPORTED_SYMBOLS = ["Utils"];
						
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

const INVALID_FILENAMES = ["CON", "PRN", "AUX", "CLOCK$", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4",
						   "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4",
						   "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];


// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "resource://sessionmanager/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
XPCOMUtils.defineLazyGetter(this, "SM_BUNDLE", function() { return Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties"); });

XPCOMUtils.defineLazyServiceGetter(this, "secret_decoder_ring_service", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");

XPCOMUtils.defineLazyGetter(this, "PrivateBrowsing", function() {
	if (Cc["@mozilla.org/privatebrowsing;1"]) {
		XPCOMUtils.defineLazyServiceGetter(this, "PrivateBrowsing", "@mozilla.org/privatebrowsing;1", "nsIPrivateBrowsingService");
		return PrivateBrowsing;
	}
	else 
		return null;
});

// This only exists in Gecko 17 and up, so define our own lazy getter to set it to null if it doesn't exist instead of throwing an exception
XPCOMUtils.defineLazyGetter(this, "PrivateBrowsingUtils", function() {
	XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils", "resource://gre/modules/PrivateBrowsingUtils.jsm");
	try {
		return PrivateBrowsingUtils;
	}
	catch(ex) {
		return null
	}
});

// This only exists in Firefox 20 and up, so define our own lazy getter to set it to null if it doesn't exist instead of throwing an exception
XPCOMUtils.defineLazyGetter(this, "RecentWindow", function() {
	XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow", "resource://gre/modules/RecentWindow.jsm");
	try {
		return RecentWindow;
	}
	catch(ex) {
		return null
	}
});

if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}

// Reference to main thread for putting up alerts when not in main thread
var mainAlertThread = function(aText) {
  this.text = aText;
};
mainAlertThread.prototype = {
	run: function() {
		Services.prompt.alert(Utils.getMostRecentWindow(), SharedData.mTitle, this.text);
	},
	QueryInterface: function(iid) {
		if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
			return this;
		}
		throw Cr.NS_ERROR_NO_INTERFACE;
	}
};
						
this.Utils = {

	// 
	// Name functions
	//
	
	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager v2\]/m.test(aState))
		{
			return "[SessionManager v2]\nname=" + aName.replace(/\t/g, " ") + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager v2\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName.replace(/\t/g, " "); });
	},

	getFormattedName: function(aTitle, aDate, aFormat)
	{
		function cut(aString, aLength)
		{
			return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
		}
		function toISO8601(aDate, format)
		{
			if (format) {
				return aDate.toLocaleFormat(format);
			}
			else {
				return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
			}
		}
		function pad2(a) { return (a < 10)?"0" + a:a; }
		
		return (aFormat || PreferenceManager.get("name_format")).split("%%").map(function(aPiece) {
			return aPiece.replace(/%(\d*)([tdm])(\"(.*)\")?/g, function($0, $1, $2, $3, $4) {
				$0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate, $4):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
				return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
			});
		}).join("%");
	},

	makeFileName: function(aString)
	{
		// Make sure we don't replace spaces with _ in filename since tabs become spaces
		aString = aString.replace(/\t/g, " ");
		
		// Reserved File names under Windows so add a "_" to name if one of them is used
		if (INVALID_FILENAMES.indexOf(aString) != -1) aString += "_";
		
		// Don't allow illegal characters for Operating Systems:
		// NTFS - <>:"/\|*? or ASCII chars from 00 to 1F
		// FAT - ^
		// OS 9, OS X and Linux - :
		return aString.replace(/[<>:"\/\\|*?^\x00-\x1F]/g, "_").substr(0, 64) + Constants.SESSION_EXT;
//		return aString.replace(/[^\w ',;!()@&+=~\x80-\xFE-]/g, "_").substr(0, 64) + Constants.SESSION_EXT;
	},
	
	//
	// Browser Privacy Functions
	//
	
	// Return global private browsing mode (PBM) state - This is set to false in Firefox 20 and up since 
	// there is no private "browsing mode" only private windows
	isPrivateBrowserMode: function()
	{
		// Always return false for Firefox 20 and up (RecentWindow only exists in Firefox 20 and up).
		if (PrivateBrowsing && !RecentWindow) {
			return PrivateBrowsing.privateBrowsingEnabled;
		}
		else {
			return this.isAutoStartPrivateBrowserMode();
		}
	},
	
	// Per Window private browsing only exists in Firefox 20 and up.  For Firefox 19 and older return the global private browsing status
	isPrivateWindow: function(aWindow) 
	{
		if (PrivateBrowsingUtils && aWindow) {
			try {
				return PrivateBrowsingUtils.isWindowPrivate(aWindow);
			} 
			catch(ex) {
				return false;
			}
		}
		else 
			return this.isPrivateBrowserMode();
	},

	isAutoStartPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox - In Firefox 20 the PrivateBrowsingUtils.permanentPrivateBrowsing is 
		// used instead and changing the auto privacy setting will require a browser restart.  Until that's implemented, the PrivateBrowsingUtils.isWindowPrivate
		// won't be correct after changing the browser.privatebrowsing.autostart preference.
		if (PrivateBrowsingUtils && PrivateBrowsingUtils.permanentPrivateBrowsing != null)
			return PrivateBrowsingUtils.permanentPrivateBrowsing;
		else if (PrivateBrowsing) {
			return PrivateBrowsing.autoStarted;
		}
		else {
			return false;
		}
	},
	
	// 
	// Browser Window Functions
	//
	
	openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
	{
		if (!aArgument || typeof aArgument == "string")
		{
			let argString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
			argString.data = aArgument || "";
			aArgument = argString;
		}
		
		return Services.ww.openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
	},
	
	getMostRecentWindow: function(aType, aOpenWindowFlag, aAllowPrivate)
	{
		let window = null;
		if (Services.tm.isMainThread) {
			// If Private window browsing exists, grab a non-private window, otherwise any window will do
			if (RecentWindow && (aType == "navigator:browser"))
				window = RecentWindow.getMostRecentBrowserWindow(aAllowPrivate == true);
			else
				window = Services.wm.getMostRecentWindow(aType ? aType : null);
		}
		else {
			log("Sanity Check Failure: getMostRecentWindow() called from background thread - this would have caused a crash.", "EXTRA");
		}
		if (aOpenWindowFlag && !window) {
			window = this.openWindow(PreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
		}
		return window;
	},
	
	getBrowserWindows: function()
	{
		let windowsEnum = Services.wm.getEnumerator("navigator:browser");
		let windows = [];
		
		while (windowsEnum.hasMoreElements())
		{
			windows.push(windowsEnum.getNext());
		}
		
		return windows;
	},

//
// ........ User Prompts .............. 
//

	openSessionExplorer: function() {
		this.openWindow(
			"chrome://sessionmanager/content/sessionexplorer.xul",
//			"chrome://sessionmanager/content/places/places.xul",
			"chrome,titlebar,resizable,dialog=yes",
			{},
			this.getMostRecentWindow()
		);
	},
	
	prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
	{
		// Use existing dialog window if not modal
		let dialog = Services.wm.getMostRecentWindow("SessionManager:SessionPrompt");
    
		// For some reason someone got two startup prompts, this will prevent that
		if (dialog && !SharedData._running) {
			if (!dialog.gSessionManagerSessionPrompt.modal)
				dialog.close();
			else
				dialog.setTimeout(function() { dialog.focus(); }, 1000);
				return;
		}
  
		let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
		aValues = aValues || {};

		// Modal if startup or crash prompt or if there's a not a callback function or saving one window
		let window = SharedData._running ? this.getMostRecentWindow("navigator:browser") : null;
		let modal = !SharedData._running || !aValues.callbackData;
		//let modal = !SharedData._running || !aValues.callbackData || aValues.callbackData.oneWindow;
		
		// Clear out return data and initialize it
		SharedData.sessionPromptReturnData = null;
		
		SharedData.sessionPromptData = {
			// strings
			acceptExistingLabel: aAcceptExistingLabel || "",
			acceptLabel: aAcceptLabel,
			callbackData: aValues.callbackData || null,
			crashCount: aValues.count || "",
			defaultSessionName: aValues.text || "",
			filename: aValues.name || "",
			sessionLabel: aSessionLabel,
			textLabel: aTextLabel || "",
			// booleans
			addCurrentSession: aValues.addCurrentSession,
			allowNamedReplace: aValues.allowNamedReplace,
			append_replace: aValues.append_replace,
			autoSaveable: aValues.autoSaveable,
			grouping: aValues.grouping,
			ignorable: aValues.ignorable,
			multiSelect: aValues.multiSelect,
			preselect: aValues.preselect,
			remove: aValues.remove,
			selectAll: aValues.selectAll,
			startupPrompt: aValues.startupPrompt,
			modal: modal,
			startup: !SharedData._running,
			// override function
			getSessionsOverride: aValues.getSessionsOverride,
		};

		// Initialize return data if modal.  Don't initialize if not modal because that can result in a memory leak since it might
		// not be cleared
		if (modal) SharedData.sessionPromptReturnData = {};
		
		if (dialog && !modal)
		{
			dialog.focus();
			dialog.gSessionManagerSessionPrompt.drawWindow();
			return;
		}
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,resizable,dialog=yes" + (modal?",modal":""), 
		                params, window);
			
		if (params.GetInt(0)) {
			aValues.append = SharedData.sessionPromptReturnData.append;
			aValues.append_window = SharedData.sessionPromptReturnData.append_window;
			aValues.autoSave = SharedData.sessionPromptReturnData.autoSave;
			aValues.autoSaveTime = SharedData.sessionPromptReturnData.autoSaveTime;
			aValues.group = SharedData.sessionPromptReturnData.groupName;
			aValues.name = SharedData.sessionPromptReturnData.filename;
			aValues.text = SharedData.sessionPromptReturnData.sessionName;
			aValues.sessionState = SharedData.sessionPromptReturnData.sessionState;
			SharedData.sessionPromptReturnData.sessionState = null;
		}
		aValues.ignore = SharedData.sessionPromptReturnData ? SharedData.sessionPromptReturnData.ignore : null;

		// Clear out return data
		SharedData.sessionPromptReturnData = null;
		
		return params.GetInt(0);
	},
	
	// the aOverride variable in an optional callback procedure that will be used to get the session list instead
	// of the default getSessions() function.  The function must return an array of sessions where a session is an
	// object containing:
	//		name 		- This is what is displayed in the session select window
	//		fileName	- This is what is returned when the object is selected
	//		windows		- Window count (optional - if omited won't display either window or tab count)
	//		tabs		- Tab count	(optional - if omited won't display either window or tab count)
	//		autosave	- Will cause item to be bold (optional)
	//      group       - Group that session is associated with (optional)
	//
	// If the session list is not formatted correctly a message will be displayed in the Error console
	// and the session select window will not be displayed.
	//
	selectSession: function(aSessionLabel, aAcceptLabel, aValues, aOverride)
	{
		let values = aValues || {};
		
		if (aOverride) values.getSessionsOverride = aOverride;
		
		if (this.prompt(aSessionLabel, aAcceptLabel, values))
		{
			return values.name;
		}
		
		return null;
	},
	
	// 
	// Alert and Error functions
	//
	
	// This will always put up an alert prompt in the main thread
	threadSafeAlert: function(aText) {
		if (Services.tm.isMainThread) {
			Services.prompt.alert(this.getMostRecentWindow(), SharedData.mTitle, aText);
		}
		else {
			let mainThread = Services.tm.mainThread;
			mainThread.dispatch(new mainAlertThread(aText), mainThread.DISPATCH_NORMAL);
		}
	},

	// Put up error prompt
	error: function(aException, aString, aExtraText) {
		let location = "";
		if (aException) {
			logError(aException);
			location = aException.stack || aException.location || (aException.fileName + ":" + aException.lineNumber);
		}
	
		this.threadSafeAlert(SM_BUNDLE.formatStringFromName(aString, [(aException)?(aException.message + (aExtraText ? ("\n\n" + aExtraText) : "") + "\n\n" + location):SM_BUNDLE.GetStringFromName("unknown_error")], 1));
	},

	ioError: function(aException, aText)
	{
		this.error(aException, "io_error", aText);
	},

	sessionError: function(aException, aText)
	{
		this.error(aException, "session_error", aText);
	},

	cryptError: function(aException, notSaved)
	{
		let text;
		if (aException.message) {
			if (aException.message.indexOf("decryptString") != -1) {
				if (aException.name != "NS_ERROR_NOT_AVAILABLE") {
					text = this._string("decrypt_fail1");
				}
				else {
					text = this._string("decrypt_fail2");
				}
			}
			else {
				text = notSaved ? this._string("encrypt_fail2") : this._string("encrypt_fail");
			}
		}
		else text = aException;
		this.threadSafeAlert(text);
	},
	
	//
  // Encryption functions
	//
	
	decrypt: function(aData, aNoError, doNotDecode)
	{
		// If nothing passed in, nothing returned
		if (!aData)
			return null;
			
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = secret_decoder_ring_service.decryptString(aData);
				if (!doNotDecode) aData = decodeURIComponent(aData);
			}
			catch (ex) { 
				logError(ex);
				if (!aNoError) this.cryptError(ex); 
				// encrypted file corrupt, return false so as to not break things checking for aData.
				if (ex.name != "NS_ERROR_NOT_AVAILABLE") { 
					return false;
				}
				return null;
			}
		}
		return aData;
	},

	// This function will encrypt the data if the encryption preference is set.
	// It will also decrypt encrypted data if the encryption preference is not set.
	decryptEncryptByPreference: function(aData, aSilent, aReturnOriginalStateOnError)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		let encrypted = (aData.indexOf(":") == -1);
		try {
			if (PreferenceManager.get("encrypt_sessions") && !encrypted)
			{
				aData = secret_decoder_ring_service.encryptString(encodeURIComponent(aData));
			}
			else if (!PreferenceManager.get("encrypt_sessions") && encrypted)
			{
				aData = decodeURIComponent(secret_decoder_ring_service.decryptString(aData));
			}
		}
		catch (ex) { 
			if (!aSilent) {
				if (!encrypted && PreferenceManager.get("encrypted_only")) {
					this.cryptError(ex, true);
					return null;
				}
				else this.cryptError(ex);
			}
			else {
				logError(ex);
				if (!aReturnOriginalStateOnError)
					return ex;
			}
		}
		return aData;
	},
	
	//
	// Undo list handling
	//

	clearUndoListPrompt: function(aType)
	{
		let dontPrompt = { value: false };
		let prompttext = (aType == "tab") ? "clear_tab_list_prompt" : ((aType == "window") ? "clear_window_list_prompt" : "clear_list_prompt");
		if (PreferenceManager.get("no_" + prompttext) || Services.prompt.confirmEx(null, SharedData.mTitle, this._string(prompttext), Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			Private.clearUndoList(aType);
			if (dontPrompt.value)
			{
				PreferenceManager.set("no_" + prompttext, true);
			}
		}
	},

	getNoUndoData: function(aLoad, aMode)
	{
		return aLoad ? { tabs: (!PreferenceManager.get("save_closed_tabs") || ((PreferenceManager.get("save_closed_tabs") == 1) && (aMode != "startup"))),
		                 windows: (!PreferenceManager.get("save_closed_windows") || (PreferenceManager.get("save_closed_windows") == 1 && (aMode != "startup"))) }
		             : { tabs: (PreferenceManager.get("save_closed_tabs") < 2), windows: (PreferenceManager.get("save_closed_windows") < 2) };
	},
	
//
// AutoSave Functions
//

	// Read Autosave values from preference and store into global variables
	getAutoSaveValues: function(aValues, aWindow)
	{
		if (!aValues) aValues = "";
		let values = aValues.split("\n");
		log("getAutoSaveValues: aWindow = " + (aWindow ? aWindow.content.document.title : "null") + ", aValues = " + values.join(", "), "EXTRA");
		if (aWindow) {
			let obj = aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject;
			let old_window_session_filename = obj.__window_session_filename;
			let old_window_session_time = obj.__window_session_time;
			obj.__window_session_filename = values[0];
			obj.__window_session_name = values[1];
			obj.__window_session_group = values[2];
			obj.__window_session_time = isNaN(values[3]) ? 0 : values[3];
			try {
				// This throws whenever a window is already closed (during shutdown for example) or if the value doesn't exist and we try to delete it
				if (aValues) {
					// Store window session into Application storage and set window value
					SharedData.mActiveWindowSessions[values[0]] = true;
					this.SessionStore.setWindowValue(aWindow, "_sm_window_session_values", aValues);
				}
				else {
					if (old_window_session_filename) {
						// Remove window session from Application storage and delete window value
						delete SharedData.mActiveWindowSessions[old_window_session_filename];
					}
					this.SessionStore.deleteWindowValue(aWindow, "_sm_window_session_values");
					
					// the following forces SessionStore to save the state to disk (bug 510965)
					// Can't just set _sm_window_session_values to "" and then delete since that will throw an exception
					// This will throw an exception if window closes anyway, but oh well.
					this.SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
					this.SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
				}
			}
			catch(ex) {
				// log it so we can tell when things aren't working.  Don't log exceptions in deleteWindowValue
				// because it throws an exception if value we are trying to delete doesn't exist. Since we are 
				// deleting the value, we don't care if it doesn't exist.
				if (ex.message.indexOf("deleteWindowValue") == -1) logError(ex);
			}
			
			// start/stop window timer
			obj.checkWinTimer(old_window_session_time);
			Services.obs.notifyObservers(aWindow, "sessionmanager:updatetitlebar", null);
		}
		else {
			SharedData._autosave_filename = values[0];
			SharedData._autosave_name = values[1];
			SharedData._autosave_group = values[2];
			SharedData._autosave_time = isNaN(values[3]) ? 0 : values[3];
		}

		// Update tab tree if it's open
		Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
	},

	// Merge autosave variables into a a string
	mergeAutoSaveValues: function(filename, name, group, time)
	{
		let values = [ filename, name, group, isNaN(time) ? 0 : time ];
		return values.join("\n");
	},

	updateAutoSaveSessions: function(aOldFileName, aNewFileName, aNewName, aNewGroup) 
	{
		let updateTitlebar = false;
		
		// auto-save session
		if (SharedData._autosave_filename == aOldFileName) 
		{
			log("updateAutoSaveSessions: autosave change: aOldFileName = " + aOldFileName + ", aNewFileName = " + aNewFileName + ", aNewName = " + aNewName + ", aNewGroup = " + aNewGroup, "DATA");
			// rename or delete?
			if (aNewFileName) {
				PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aNewFileName, aNewName, SharedData._autosave_group, SharedData._autosave_time));
				updateTitlebar = true;
			}
			else if (aNewName) {
				PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, aNewName, SharedData._autosave_group, SharedData._autosave_time));
			}
			else if (aNewGroup) {
				PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, SharedData._autosave_name, aNewGroup, SharedData._autosave_time));
			}
			else {
				PreferenceManager.set("_autosave_values","");
				updateTitlebar = true;
			}
		}
		
		// window sessions
		this.getBrowserWindows().forEach(function(aWindow) {
			let obj = aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject;
			if (obj && obj.__window_session_filename && (obj.__window_session_filename == aOldFileName)) { 
				log("updateAutoSaveSessions: window change: aOldFileName = " + aOldFileName + ", aNewFileName = " + aNewFileName + ", aNewGroup = " + aNewGroup, "DATA");
				if (aNewFileName) {
					obj.__window_session_filename = aNewFileName;
					obj.__window_session_name = aNewName;
					delete SharedData.mActiveWindowSessions[aOldFileName];
					SharedData.mActiveWindowSessions[aNewFileName] = true;
					updateTitlebar = true;
				}
				else if (aNewGroup) {
					obj.__window_session_group = aNewGroup;
				}
				else
				{
					obj.__window_session_filename = null;
					obj.__window_session_name = null;
					obj.__window_session_group = null;
					obj.__window_session_time = 0;
					delete SharedData.mActiveWindowSessions[aOldFileName];
					updateTitlebar = true;
				}
			}
		});
		
		// Update titlebars
		if (updateTitlebar) Services.obs.notifyObservers(null, "sessionmanager:updatetitlebar", null);
	},
	
//
// Auxiliary Functions
//

	// count windows and tabs
	getCount: function(aState)
	{
		let windows = 0, tabs = 0;
		
		try {
			let state = this.JSON_decode(aState);
			state.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) { logError(ex); };

		return { windows: windows, tabs: tabs };
	},
	
	_string: function(aName)
	{
		return SM_BUNDLE.GetStringFromName(aName);
	},

	setDisabled: function(aObj, aValue)
	{
		if (!aObj) return;
		if (aValue)
		{
			aObj.setAttribute("disabled", "true");
		}
		else
		{
			aObj.removeAttribute("disabled");
		}
	},
	
	isCmdLineEmpty: function(aWindow)
	{
		if (Application.name.toUpperCase() != "SEAMONKEY") {
			try {
				// Use the defaultArgs, unless SessionStore was trying to resume or handle a crash.
				// This handles the case where the browser updated and SessionStore thought it was supposed to display the update page, so make sure we don't overwrite it.
				let defaultArgs = (this.SessionStartup.doRestore()) ? 
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).startPage :
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).defaultArgs;
				if (aWindow.arguments && aWindow.arguments[0] && aWindow.arguments[0] == defaultArgs) {
					aWindow.arguments[0] = null;
				}
				return !aWindow.arguments || !aWindow.arguments[0];
			}
			catch(ex) {
				logError(ex);
				return false;
			}
		}
		else {
			let startPage = "about:blank";
			if (PreferenceManager.get("browser.startup.page", 1, true) == 1) {
				startPage = Private.SeaMonkey_getHomePageGroup();
			}
			return "arguments" in aWindow && aWindow.arguments.length && (aWindow.arguments[0] == startPage);
		}
	},
	
	//
	// Utilities
	//
	
	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr, noError) {
		let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			// JSON can't parse when string is wrapped in parenthesis, it shouldn't but older versions of Firefox wrapped
			// JSON data in parenthesis, so simply removed them if they are there.
			if (aStr.charAt(0) == '(')
				aStr = aStr.slice(1, -1);
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so any sessions saved
			// with that version or earlier will fail here.  I used to try to eval in sandbox these, but that's not safe
			// so try to fix the actual session if possible.
			try {
				jsObject = JSON.parse(aStr);
			}
			catch (ex) {
				// All the following will attempt to convert an invalid JSON file into a valid one.  This is based off of old session
				// files that I had lying aroudn that had been saved years ago.  This fixed all of them, but it's possible there's
				// a session out there that won't get corrected.  The good news is that this is sessions that are from over 2 years ago
				// so hopefully it's not a big issue.  Also the user can always go back to an older version of Session Manager and load 
				// and resave the session.  If a session can be fixed, it will automatically be resaved so this should
				// only happen once per "bad" session.  Note Firefox itself still does an eval if it can't read a session, but apparently
				// addons aren't allowed to do so.
				
				// Needed for sessions saved under old versions of Firefox to prevent a JSON failure since Firefox bug 387859 was fixed in Firefox 4.
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {return "\\u" + $0.charCodeAt(0).toString(16)});
				}

				// Try to wrap all JSON properties with quotes.  Replace wrapped single quotes with double quotes.  Don't wrap single quotes
				// inside of data.  
				aStr = aStr.replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'?([^'":{}\[\]//]+)'?/gi, function(str, p1, p2, p3, p4, offset, s) { 
					return (p1 + '"' + p4.substr(0, p4.length - ((p4[p4.length-1] == "'") ? 1 : 0)) + '"').replace("'\"",'"',"g");
				});
				// Fix any escaped single quotes as those will cause a problem.
				aStr = aStr.replace(/([^\\])'(:)/g,'$1"$2').replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'/g,'$1"').replace("\\'","'","g");
				// Try to remove any escaped unicode characters as those also cause problems
				aStr = aStr.replace(/\\x([0-9|A-F]{2})/g, function (str, p1) {return String.fromCharCode(parseInt("0x" + p1)).toString(16)});
				// Hopefully at this point we have valid JSON, here goes nothing. :)
				jsObject = JSON.parse(aStr);
				if (jsObject)
					jsObject._fixed_bad_JSON_data = true;
			}
		}
		catch(ex) {
			jsObject._JSON_decode_error = ex;
			if (!noError) this.sessionError(ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		let jsString = null;
		try {
			jsString = JSON.stringify(aObj);
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsString;
	},
	
	get SessionStore() {
		return Private.SessionStore;
	},
	
	get SessionStartup() {
		return Private.SessionStartup;
	},
	
	get EOL() {
		return Private.EOL;
	},
}

// Freeze the Utils object
Object.freeze(Utils);

let Private = { 
	_EOL: null,
	_SessionStore: null,
	_SessionStartup: null,
	
	get EOL() {
		if (!this._EOL) 
			this._EOL = /mac|darwin/i.test(Services.appinfo.OS)?"\n":/win|os[\/_]?2/i.test(Services.appinfo.OS)?"\r\n":"\r";
			
		return this._EOL;
	},

	get SessionStore() {
		if (!this._SessionStore) {
			// Firefox or SeaMonkey
			let sessionStore = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
			if (sessionStore) 
				this._SessionStore = sessionStore.getService(Ci.nsISessionStore);
		}
		return this._SessionStore;
	},
	
	get SessionStartup() {
		if (!this._SessionStartup) {
			// Firefox or SeaMonkey
			let sessionStart = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
			if (sessionStart)
				this._SessionStartup = sessionStart.getService(Ci.nsISessionStartup);
		}
		return this._SessionStartup;
	},
	
	clearUndoList: function(aType)
	{
		let window = Utils.getMostRecentWindow("navigator:browser");
	
		if ((aType != "window") && window) {
			while (this.SessionStore.getClosedTabCount(window)) this.SessionStore.forgetClosedTab(window, 0);
		}

		if (aType != "tab") {
			if (PreferenceManager.get("use_SS_closed_window_list")) {
				// use forgetClosedWindow command if available (not in SeaMonkey), otherwise use hack
				if (typeof this.SessionStore.forgetClosedWindow == "function") {
				while (this.SessionStore.getClosedWindowCount()) this.SessionStore.forgetClosedWindow(0);
				}
				else if (window) {
					let state = { windows: [ {} ], _closedWindows: [] };
					this.SessionStore.setWindowState(window, Utils.JSON_encode(state), false);
				}
			}
			else {
				SessionIo.clearUndoData("window");
			}
		}
		
		if (window) {
			// the following forces SessionStore to save the state to disk which isn't done for some reason.
			this.SessionStore.setWindowValue(window, "SM_dummy_value","1");
			this.SessionStore.deleteWindowValue(window, "SM_dummy_value");
		}
		
		Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
	},
	
	SeaMonkey_getHomePageGroup: function()
	{
		let homePage = PreferenceManager.get("browser.startup.homepage", "", true);
		let count = PreferenceManager.get("browser.startup.homepage.count", 0, true);

		for (let i = 1; i < count; ++i) {
			homePage += '\n' + PreferenceManager.get("browser.startup.homepage." + i, "", true);
		}
		return homePage;
	},
}

