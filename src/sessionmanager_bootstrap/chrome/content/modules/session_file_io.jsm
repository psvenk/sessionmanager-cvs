"use strict";

this.EXPORTED_SYMBOLS = ["SessionIo"];
						
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "isLoggingState", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionConverter", "chrome://sessionmanager/content/modules/session_convert.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionDataProcessing", "chrome://sessionmanager/content/modules/session_data_processing.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "chrome://sessionmanager/content/modules/sql_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 

XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm");
XPCOMUtils.defineLazyServiceGetter(this, "screen_manager", "@mozilla.org/gfx/screenmanager;1", "nsIScreenManager");

// Cache
var mSessionCache = {};
var mClosedWindowCache = { timestamp: 0, data: null };

// Set if user selected session folder can't be read/created so we only report this error once
var reportedUserSessionFolderIOError = false;  

// Time we last checked the trash folder to see if there's old sessions that can be removed
var _lastCheckedTrashForRemoval = 0;

//
// Session Manager IO
//
this.SessionIo = {

	get mSessionCache() {
		return mSessionCache;
	},
	
	save: function(aWindow, aName, aFileName, aGroup, aOneWindow, aValues) {
		return Private.save(aWindow, aName, aFileName, aGroup, aOneWindow, aValues);
	},
	
	saveWindow: function(aWindow, aName, aFileName, aGroup)
	{
		return Private.save(aWindow, aName, aFileName, aGroup, true);
	},
	
	load: function(aWindow, aFileName, aMode, aSessionState) {
		return Private.load(aWindow, aFileName, aMode, aSessionState);
	},
	
	rename: function(aSession, aText) {
		return Private.rename(aSession, aText);
	},
	
	group: function(aSession, aNewGroup) {
		return Private.group(aSession, aNewGroup);
	},
	
	remove: function(aSession, aSessionState) {
		return Private.remove(aSession, aSessionState);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	// aSSi is only used when a window closed (call from browserWindowOverlay) since by that time the window.SSi value is gone.
	closeSession: function(aWindow, aForceSave, aKeepOpen, aSSi) {
		return Private.closeSession(aWindow, aForceSave, aKeepOpen, aSSi);
	},
	
	// Used to save window sessions that were open when browser crashed
	saveCrashedWindowSessions: function() {
		return Private.saveCrashedWindowSessions();
	},
	
	// Sanitize Session Manager data
	sanitize: function(aRange) {
		return Private.sanitize(aRange);
	},
	
	getProfileFile: function(aFileName) {
		return Private.getProfileFile(aFileName);
	},
	
	getUserDir: function(aFileName) {
		return Private.getUserDir(aFileName);
	},
	
	getSessionDir: function(aFileName, aUnique) {
		return Private.getSessionDir(aFileName, aUnique);
	},
	
	// Cache the session data so menu opens faster, don't want to use async since that reads the entire
	// file in and we don't need to do that.  So simulate it by doing a bunch of short synchronous reads.
	// This reads in one file every 50 ms.  Since it's possible for getSessions() to be called during that
	// time frame, simply stop caching if a session is already cached as that means getSessions() was called.
	cacheSessions: function(aSubFolder) {
		return Private.cacheSessions(aSubFolder);
	},
	
	// Use to update cache with new timestamp so we don't re-read it for no reason
	updateCachedLastModifiedTime: function(aFullFilePath, aLastModifiedTime) {
		return Private.updateCachedLastModifiedTime(aFullFilePath, aLastModifiedTime);
	},	

	// Use to update cache with new encryption status since file won't be re-read.
	updateCachedEncryptionStatus: function(aFullFilePath) {
		return Private.updateCachedEncryptionStatus(aFullFilePath);
	},	
	
	getClosedWindowsCount: function() {
		return Private.getClosedWindowsCount();
	},
	
	// Get SessionStore's or Session Manager's Closed window List depending on preference.
	// Return the length if the Length Only parameter is true - only ever true if not using built in closed window list
	getClosedWindows: function(aLengthOnly) {
		return Private.getClosedWindows(aLengthOnly);
	},
	
	getClosedWindows_SM: function(aLengthOnly) {
		return Private.getClosedWindows_SM(aLengthOnly);
	},
	
	// Stored closed windows into Session Store or Session Manager controller list.
	storeClosedWindows: function(aWindow, aList, aIx) {
		return Private.storeClosedWindows(aWindow, aList, aIx);
	},
	
	// Store closed windows into Session Manager controlled list
	storeClosedWindows_SM: function(aList) {
		return Private.storeClosedWindows_SM(aList);
	},
	
	clearUndoData: function(aType, aSilent) {
		return Private.clearUndoData(aType, aSilent);
	},
	
	autoSaveCurrentSession: function(aForceSave) {
		return Private.autoSaveCurrentSession(aForceSave);
	},

	backupCurrentSession: function(aPeriodicBackup) {
		return Private.backupCurrentSession(aPeriodicBackup)
	},

	keepOldBackups: function(backingUp, aAutoSaveBackup) {
		return Private.keepOldBackups(backingUp, aAutoSaveBackup);
	},
	
	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	// aSubFolder - optional sub-folder to look for sessions in.  Used to check "Deleted" folder.
	// aFilterByFileName - if set to true, then apply filter to filename instead of name
	//
	getSessions: function(filter, aSubFolder, aFilterByFileName) {
		return Private.getSessions(filter, aSubFolder, aFilterByFileName);
	},
	
	readSessionFile: function(aFile,headerOnly,aSyncCallback, aDoNotProcess) {
		return Private.readSessionFile(aFile,headerOnly,aSyncCallback, aDoNotProcess);
	},
	
	asyncReadFile: function(aFile, aCallback) {
		return Private.asyncReadFile(aFile, aCallback);
	},

	readFile: function(aFile,headerOnly) {
		return Private.readFile(aFile,headerOnly);
	},
	
	writeFile: function(aFile, aData, aCallback) {
		return Private.writeFile(aFile, aData, aCallback);
	},
	
	delFile: function(aFile, aSilent, aDeleteOnly) {
		return Private.delFile(aFile, aSilent, aDeleteOnly);
	},
	
	restoreDeletedSessionFile: function(aFile, aSilent) {
		return Private.restoreDeletedSessionFile(aFile, aSilent);
	},
	
	// Purge old deleted sessions when they get too old.  This function will check on program startup 
	// and then at most every 24 hours (triggered by a call to delfile).
	purgeOldDeletedSessions: function() {
		return Private.purgeOldDeletedSessions();
	},
	
	emptyTrash: function() {
		return Private.emptyTrash();
	},
	
	moveToFolder: function(aFile, aFolderName, aOverwrite) {
		return Private.moveToFolder(aFile, aFolderName, aOverwrite);
	},
}

// Don't allow changing
Object.freeze(SessionIo);

//
// Private Functions	
//
let Private = {
	// Cache session timer, needs to be be stored to prevent garbage collection and stored globally so can be canceled on addon disable
	cacheSessionTimer: null,
	cacheSessionFolderList: [],

	// Files that couldn't be deleted because they were locked (likely do to a write)
	mDeleteLaterList: [],

	save: function(aWindow, aName, aFileName, aGroup, aOneWindow, aValues)
	{
		// Need a window if saving a window - duh
		if ((!aWindow && aOneWindow) || (!aOneWindow && Utils.isAutoStartPrivateBrowserMode()) || (aOneWindow && Utils.isPrivateWindow(aWindow)) || !Utils.getBrowserWindows().length) 
			return;

		// Save Window should be modal
		let values = aValues || { text: aWindow ? (Utils.getFormattedName((Utils.getCurrentTabTitle(aWindow) || "about:blank"), new Date()) || (new Date()).toLocaleString()) : "", 
		                          autoSaveable : true, allowNamedReplace : PreferenceManager.get("allowNamedReplace"), 
								  callbackData: { type: "save", window__SSi: (aWindow ? aWindow.__SSi : null), oneWindow: aOneWindow }};
								  
		if (!aName)
		{
			if (!Utils.prompt(Utils._string("save2_session"), Utils._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, Utils._string("save_" + ((aOneWindow)?"window":"session")), Utils._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
			aGroup = values.group;
		}
		if (aName)
		{
			let file = this.getSessionDir(aFileName || Utils.makeFileName(aName), !aFileName);
			try
			{
				let oldstate = null, merge = false;
				// If appending, get the old state and pass it to getSessionState to merge with the current state
				if (values.append && aFileName && file.exists()) {
					oldstate = this.readSessionFile(file);
					if (oldstate) {
						let matchArray = Constants.SESSION_REGEXP.exec(oldstate);
						if (matchArray) {
							oldstate = oldstate.split("\n")[4];
							oldstate = Utils.decrypt(oldstate);
							if (oldstate) merge = true;
						}
					}
				}
				this.writeFile(file, SessionDataProcessing.getSessionState(aName, aOneWindow?aWindow:false, Utils.getNoUndoData(), values.autoSave, aGroup, null, values.autoSaveTime, values.sessionState, oldstate), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						let refresh = true;
						// Do not make the session active if appending to an auto-save session
						if (!values.append) {
							// Combine auto-save values into string
							let autosaveValues = Utils.mergeAutoSaveValues(file.leafName, aName, aGroup, values.autoSaveTime);
							if (!aOneWindow)
							{
								if (values.autoSave)
								{
									PreferenceManager.set("_autosave_values", autosaveValues);
								}
								else if (SharedData._autosave.filename == file.leafName)
								{
									// If in auto-save session and user saves on top of it as manual turn off autosave
									PreferenceManager.set("_autosave_values","");
								}
							}
							else 
							{
								if (values.autoSave)
								{
									// Store autosave values into window value and also into window variables
									Utils.getAutoSaveValues(autosaveValues, aWindow);
									refresh = false;
								}
							}
						}
						
						// Update tab tree if it's open (getAutoSaveValues does this as well so don't do it again if already done)
						if (refresh) Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
						
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, file.leafName);
					}
					else {
						let exception = new Components.Exception(file.leafName, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			}
			catch (ex)
			{
				Utils.ioError(ex, (file ? file.leafName : ""));
			}
		}
	},

	load: function(aWindow, aFileName, aMode, aSessionState)
	{
		log("load: aFileName = " + aFileName + ", aMode = " + aMode + ", aSessionState = " + !!aSessionState, "DATA");
		let state, window_autosave_values, force_new_window = false, overwrite_window = false, use_new_window = false;
		
		// If no window passed, just grab a recent one.  
		aWindow = aWindow || Utils.getMostRecentWindow("navigator:browser");
		
		// If Mac hidden window, set aWindow to null so we grab a new window
		if (aWindow && aWindow.location.href == "chrome://browser/content/hiddenWindow.xul")
			aWindow = null;

		if (!aFileName) {
			let values = { append_replace: true, callbackData: { type: "load", window__SSi: (aWindow ? aWindow.__SSi : null) } };
			aFileName = Utils.selectSession(Utils._string("load_session"), Utils._string("load_session_ok"), values);
			let file;
			if (!aFileName || !(file = this.getSessionDir(aFileName)) || !file.exists()) return;
			aSessionState = values.sessionState;
			aMode = values.append ? "newwindow" : (values.append_window ? "append" : "overwrite");
		}
		// If loading passed in state date, get session header data from disk, otherwise get entire session
		state = this.readSessionFile(this.getSessionDir(aFileName), !!aSessionState);
		if (!state)
		{
			Utils.ioError(new Components.Exception(aFileName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller));
			return;
		}

		let matchArray = Constants.SESSION_REGEXP.exec(state);
		if (!matchArray)
		{
			Utils.sessionError(null, aFileName);
			return;
		}		
		
		// If no passed or recent browser window, open a new one (without prompting for a session)
		if (!aWindow || !aWindow.gBrowser) {
			SharedData._no_prompt_for_session = true;
			aWindow = Utils.openWindow(PreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			use_new_window = true;
		}
		
		// If user somehow managed to load an active Window or Auto Session, ignore it
		if ((/^window/.test(matchArray[3]) && SharedData.mActiveWindowSessions[aFileName]) ||
		    (/^session/.test(matchArray[3]) && (SharedData._autosave.filename == aFileName)))
		{
			log("Opened an already active auto or window session: " + aFileName, "INFO");
			return;
		}

		// handle case when always want a new window (even if current window is blank) and
		// want to overwrite the current window, but not the current session
		switch (aMode) {
			case "newwindow_always":
				force_new_window = true;
				aMode = "newwindow";
				break;
			case "overwrite_window":
				overwrite_window = true;
				aMode = "append";			// Basically an append with overwriting tabs
				break;
		}
		
		let sessionWidth = parseInt(matchArray[9]);
		let sessionHeight = parseInt(matchArray[10]);
		let xDelta = (isNaN(sessionWidth) || (screen_manager.numberOfScreens > 1)) ? 1 : (aWindow.screen.width / sessionWidth);
		let yDelta = (isNaN(sessionHeight) || (screen_manager.numberOfScreens > 1)) ? 1 : (aWindow.screen.height / sessionHeight);
		log("xDelta = " + xDelta + ", yDelta = " + yDelta, "DATA");
			
		state = aSessionState ? aSessionState : state.split("\n")[4];
			
		let startup = (aMode == "startup");
		let newWindow = false;
		let overwriteTabs = true;
		let tabsToMove = null;
		let noUndoData = Utils.getNoUndoData(true, aMode);

		// Tab Mix Plus's single window mode is enabled
		let TMP_SingleWindowMode = SharedData.tabMixPlusEnabled && PreferenceManager.get("extensions.tabmix.singleWindow", false, true);
		if (TMP_SingleWindowMode) log("Tab Mix Plus single window mode is enabled", "INFO");

		// Use only existing window if our preference to do so is set or Tab Mix Plus's single window mode is enabled
		let singleWindowMode = (PreferenceManager.get("append_by_default") && (aMode != "newwindow")) || TMP_SingleWindowMode;
	
		if (singleWindowMode && (aMode == "newwindow" || (!startup && (aMode != "overwrite") && !PreferenceManager.get("overwrite"))))
			aMode = "append";
		
		// Use specified mode or default.
		aMode = aMode || "default";
		
		if (startup)
		{
			overwriteTabs = Utils.isCmdLineEmpty(aWindow);
			// Tabs to move to end of tabs
			tabsToMove = (!overwriteTabs)?Array.slice(aWindow.gBrowser.mTabs):null;
			// If user opened multiple windows then don't overwrite the other windows
			if (Utils.getBrowserWindows().length > 1)
				overwrite_window = true;
		}
		else if (!overwrite_window && (aMode == "append"))
		{
			overwriteTabs = false;
		}
		else if (!use_new_window && !singleWindowMode && !overwrite_window && (aMode == "newwindow" || (aMode != "overwrite" && !PreferenceManager.get("overwrite"))))
		{
			// if there is only a blank window with no closed tabs, just use that instead of opening a new window
			let tabs = aWindow.gBrowser;
			if (force_new_window || Utils.getBrowserWindows().length != 1 || !tabs || tabs.mTabs.length > 1 || 
				tabs.mTabs[0].linkedBrowser.currentURI.spec != "about:blank" || 
				SessionStore.getClosedTabCount(aWindow) > 0) {
				newWindow = true;
			}
		}
		
		// Handle case where trying to restore to a newly opened window and Tab Mix Plus's Single Window Mode is active.
		// TMP is going to close this window after the restore, so restore into existing window
		let altWindow = null;
		if (TMP_SingleWindowMode) {
			let windows = Utils.getBrowserWindows();
			if (windows.length == 2) {
				log("load: Restoring window into existing window because TMP single window mode active", "INFO");
				if (windows[0] == aWindow) altWindow = windows[1];
				else altWindow = windows[0];
				overwriteTabs = false;
			}
		}

		// Check whether or not to close open auto and window sessions.
		// Don't save current session on startup since there isn't any.  Don't save unless 
		// overwriting existing window(s) since nothing is lost in that case.
		if (!startup && !use_new_window) {
			let alreadyClosedWindows = false;
			if (!newWindow && overwriteTabs && !overwrite_window)
			{
				// Closed all open window sessions
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				Services.obs.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
				alreadyClosedWindows = true;
			
				// close current autosave session if open
				if (SharedData._autosave.filename) 
				{
					this.closeSession(false);
				}
				else 
				{
					if (PreferenceManager.get("autosave_session")) this.autoSaveCurrentSession();
				}
			}
			if (!alreadyClosedWindows && ((!newWindow && overwriteTabs) || overwrite_window)) {
				// close current window session if open
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				Services.obs.notifyObservers(abandonBool, "sessionmanager:close-windowsession", aWindow);
			}
		}
		
		// If not a private window and did not choose tabs and not appending to current window
		if (!aSessionState && !Utils.isPrivateWindow(aWindow) && (overwriteTabs || startup) && !altWindow)
		{
			let matchArray2;
			// if this is a window session, keep track of it
			if (matchArray2 = /^window\/?(\d*)$/.exec(matchArray[3])) {
				let time = parseInt(matchArray2[1]);
				window_autosave_values = Utils.mergeAutoSaveValues(aFileName, matchArray[1], matchArray[7], time);
				log("load: window session", "INFO");
			}
		
			// If this is an autosave session, keep track of it if not opening it in a new window and if there is not already an active session
			if (!newWindow && !overwrite_window && !SharedData._autosave.filename && (matchArray2 = /^session\/?(\d*)$/.exec(matchArray[3]))) 
			{
				let time = parseInt(matchArray2[1]);
				PreferenceManager.set("_autosave_values", Utils.mergeAutoSaveValues(aFileName, matchArray[1], matchArray[7], time));
			}
		}
		
		// If reload tabs enabled and not offline, set the tabs to allow reloading
		if (PreferenceManager.get("reload") && !Services.io.offline) {
			try {
				state = Utils.decrypt(state);
				if (!state) return;
		
				let current_time = new Date();
				current_time = current_time.getTime();
				let tempState = Utils.JSON_decode(state);
				for (let i in tempState.windows) {
					for (let j in tempState.windows[i].tabs) {
						// Only tag web pages as allowed to reload (this excludes chrome, about, etc)
						if (tempState.windows[i].tabs[j].entries && tempState.windows[i].tabs[j].entries.length != 0 &&
						    /^https?:\/\//.test(tempState.windows[i].tabs[j].entries[tempState.windows[i].tabs[j].index - 1].url)) {
							if (!tempState.windows[i].tabs[j].extData) tempState.windows[i].tabs[j].extData = {};
							tempState.windows[i].tabs[j].extData["session_manager_allow_reload"] = current_time;
						}
					}
				}
				state = Utils.JSON_encode(tempState);
			}
			catch (ex) { logError(ex); };
		}
		
		// if no browser window open, simply call restoreSession, otherwise do setTimeout.
		if (use_new_window) {
			let okay = SessionDataProcessing.restoreSession(null, state, overwriteTabs, noUndoData, true, (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
			if (!okay) PreferenceManager.set("_autosave_values", "");
			aWindow.close();
		}
		else {
			Utils.runAsync(function() {
				let tabcount = aWindow.gBrowser.mTabs.length;
				let okay = SessionDataProcessing.restoreSession((!newWindow)?(altWindow?altWindow:aWindow):null, state, overwriteTabs, noUndoData, (overwriteTabs && !newWindow && !singleWindowMode && !overwrite_window), 
														  (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
				if (okay) {
					Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);

					if (tabsToMove)
					{
						let endPos = aWindow.gBrowser.mTabs.length - 1;
						tabsToMove.forEach(function(aTab) { aWindow.gBrowser.moveTabTo(aTab, endPos); });
					}
				}
				// failed to load so clear autosession in case user tried to load one
				else PreferenceManager.set("_autosave_values", "");
			});
		}
	},

	rename: function(aSession, aText)
	{
		let values;
		if (aSession && !aText) values = { name: aSession, text: mSessionCache[aSession].name };
		else values = {};
		values.callbackData = { type: "rename" };
		
		// if not callback
		if (!aText) {
			if (!Utils.prompt(Utils._string("rename_session"), Utils._string("rename_session_ok"), values, Utils._string("rename2_session")))
			{
				return;
			}
		}
		else {
			values.name = aSession;
			values.text = aText;
		}
		let file = this.getSessionDir(values.name);
		let filename = Utils.makeFileName(values.text);
		let newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
		
		try
		{
			if (!file || !file.exists()) throw new Error(Utils._string("file_not_found"));
		
			this.readSessionFile(file, false, function(state) {
				// remove group name if it was a backup session
				if (mSessionCache[values.name].backup)
					state = state.replace(/\tgroup=[^\t\n\r]+/m, "");
				Private.writeFile(newFile || file, Utils.nameState(state, values.text), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						if (newFile)
						{
							if (PreferenceManager.get("resume_session") == file.leafName && PreferenceManager.get("resume_session") != Constants.BACKUP_SESSION_FILENAME &&
								!Constants.AUTO_SAVE_SESSION_REGEXP.test(PreferenceManager.get("resume_session")))
							{
								PreferenceManager.set("resume_session", newFile.leafName);
							}
							
							Private.delFile(file, false, true);
						}

						// Update any renamed auto or window session
						Utils.updateAutoSaveSessions(file.leafName, newFile ? newFile.leafName: null, values.text);
						
						// Update tab tree if it's open
						Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
						
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, newFile ? newFile.leafName : filename);
					}
					else {
						let exception = new Components.Exception(newFile ? newFile.leafName : filename, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			});
		}
		catch (ex)
		{
			Utils.ioError(ex, filename);
		}
	},
	
	group: function(aSession, aNewGroup)
	{
		let values = { multiSelect: true, grouping: true, callbackData: { type: "group" } };
		if (typeof(aNewGroup) == "undefined") {
			aSession = Utils.prompt(Utils._string("group_session"), Utils._string("group_session_okay"), values, Utils._string("group_session_text"));
		}
		else {
			values.name = aSession;
			values.group = aNewGroup;
		}
		
		if (aSession)
		{
			values.name.split("\n").forEach(function(aFileName) {
				try
				{
					let file = this.getSessionDir(aFileName);
					if (!file || !file.exists()) 
						throw new Error(Utils._string("file_not_found"));
					this.readSessionFile(file, false, function(state) {
						state = state.replace(/(\tcount=\d+\/\d+)(\tgroup=[^\t\n\r]+)?/m, function($0, $1) { return $1 + (values.group ? ("\tgroup=" + values.group.replace(/\t/g, " ")) : ""); });
						Private.writeFile(file, state, function(aResults) {
							if (Components.isSuccessCode(aResults)) {
								// Update tab tree if it's open
								Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
								
								// Update SQL cache file
								SQLManager.addSessionToSQLCache(false, file.leafName);
							}
							else {
								let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
								Utils.ioError(exception);
							}
						});

						// Update cached group name
						mSessionCache[aFileName].group = values.group;
						
						// Update any regrouped auto or window session
						Utils.updateAutoSaveSessions(aFileName, null, null, values.group);
					});
				}
				catch (ex)
				{
					Utils.ioError(ex, aFileName);
				}
				
			}, this);
		}
	},

	remove: function(aSession, aSessionState)
	{
		if (!aSession || aSessionState)
		{
			let values = { multiSelect: true, remove: true, callbackData: { type: "delete" } };
			aSession = aSession || Utils.selectSession(Utils._string("remove_session"), Utils._string("remove_session_ok"), values);
			aSessionState = aSessionState || values.sessionState;
			
			// If user chose to delete specific windows and tabs in a session
			if (aSessionState) {
				// Get windows and tabs that were not deleted
				try
				{
					let file = this.getSessionDir(aSession);
					if (file.exists()) {
						let sessionStateBackup = aSessionState;
						this.readSessionFile(file, false, function(state) {
							if (state && Constants.SESSION_REGEXP.test(state)) {
								state = state.split("\n");
								let count = Utils.getCount(sessionStateBackup);
								state[3] = state[3].replace(/\tcount=[1-9][0-9]*\/[1-9][0-9]*/, "\tcount=" + count.windows + "/" + count.tabs);
								state[4] = Utils.decryptEncryptByPreference(sessionStateBackup);
								state = state.join("\n");
								Private.writeFile(file, state, function(aResults) {
									if (Components.isSuccessCode(aResults)) {
										// Update tab tree if it's open
										Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
										
										// Update SQL cache file
										SQLManager.addSessionToSQLCache(false, file.leafName);
									}
									else {
										let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
										Utils.ioError(exception);
									}
								});
							}
						});
					}
				}
				catch(ex) {
					Utils.ioError(ex, aSession);
				}
				aSessionState = null;
				aSession = null;
			}
		}
		if (aSession)
		{
			aSession.split("\n").forEach(function(aFileName) {
				// If deleted autoload session, revert to no autoload session
				if ((aFileName == PreferenceManager.get("resume_session")) && (aFileName != Constants.BACKUP_SESSION_FILENAME)) {
					PreferenceManager.set("resume_session", Constants.BACKUP_SESSION_FILENAME);
					PreferenceManager.set("startup", 0);
					// Update Options window if it's open
					let window = Services.wm.getMostRecentWindow("SessionManager:Options");
					if (window) window.updateSpecialPreferences(true);
				}
				// In case deleting an auto-save or window session, update browser data
				Utils.updateAutoSaveSessions(aFileName);
				this.delFile(this.getSessionDir(aFileName));
			}, this);
			Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
		}
	},

	// if aOneWindow is true, then close the window session otherwise close the browser session
	// aSSi is only used when a window closed (call from browserWindowOverlay) since by that time the window.SSi value is gone.
	closeSession: function(aWindow, aForceSave, aKeepOpen, aSSi)
	{
		let SSi = aWindow ? (aWindow.__SSi || aSSi) : null;
		log("closeSession " + (SSi ? SSi : "session") + ": " + ((aWindow) ? SharedData.mWindowSessionData[SSi].filename : SharedData._autosave.filename) + 
		    ", aForceSave = " + (aForceSave) + ", aKeepOpen = " + (aKeepOpen), "DATA");
		let filename = (aWindow) ? SharedData.mWindowSessionData[SSi].filename : SharedData._autosave.filename;
		let name = (aWindow) ? SharedData.mWindowSessionData[SSi].name : SharedData._autosave.name;
		let group = (aWindow) ? SharedData.mWindowSessionData[SSi].group : SharedData._autosave.group;
		let time = (aWindow) ? SharedData.mWindowSessionData[SSi].time : SharedData._autosave.time;
		if (filename)
		{
			let file = this.getSessionDir(filename);
			// If forcing a save or not in private browsing save auto or window session.  Use stored closing window state if it exists.
			if (aForceSave || !Utils.isPrivateWindow(aWindow)) {
				try
				{
					this.writeFile(file, SessionDataProcessing.getSessionState(name, aWindow, Utils.getNoUndoData(), true, group, null, time, SharedData.mClosingWindowState || SharedData.mClosingAutoWindowState || (!aWindow && SharedData.mShutdownState)), function(aResults) {
						if (Components.isSuccessCode(aResults)) {
						
							if (!aKeepOpen) {
								if (!aWindow) {
									PreferenceManager.set("_autosave_values","");
								}
								else {
									Utils.getAutoSaveValues(null, aWindow);
								}
							}
						
							// Update SQL cache file
							SQLManager.addSessionToSQLCache(false, file.leafName);
						}
						else {
							let exception = new Components.Exception(file.leafName, aResults, Components.stack.caller);
							Utils.ioError(exception);
						}
					});
				}
				catch (ex)
				{
					Utils.ioError(ex, (file ? file.leafName : ""));
				}
			}
		
			return true;
		}
		return false;
	},
	
	saveWindowSession: function(aWindowSessionData, aWindowState) {
		log("saveWindowSession: Saving Window Session: " + aWindowSessionData.filename + ", " + aWindowSessionData.name + ", " + aWindowSessionData.group + ", " + aWindowSessionData.time, "DATA");
		if (aWindowSessionData.filename) {
			let file = this.getSessionDir(aWindowSessionData.filename);
			
			try
			{
				let window_session = Utils.JSON_encode({ windows:[ aWindowState ] });
				this.writeFile(file, SessionDataProcessing.getSessionState(aWindowSessionData.name, true, Utils.getNoUndoData(), true, aWindowSessionData.group, null, aWindowSessionData.time, window_session), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, file.leafName);
					}
					else {
						let exception = new Components.Exception(file.leafName, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			}
			catch (ex)
			{
				Utils.ioError(ex, (file ? file.leafName : ""));
			}
		}
	},
	
	// Used to save window sessions that were open when browser crashed
	saveCrashedWindowSessions: function()
	{
		let file = this.getSessionDir(SharedData._crash_backup_session_file);
		if (file) {
			this.readSessionFile(file, false, function(crashed_session) {
				if (crashed_session) {
					crashed_session = Utils.decrypt(crashed_session.split("\n")[4], true);
					if (crashed_session) {
						crashed_session = Utils.JSON_decode(crashed_session, true);
						if (!crashed_session._JSON_decode_failed) {
							// Save each window session found in crashed file
							crashed_session.windows.forEach(function(aWindow) {
								if (aWindow.extData && aWindow.extData._sm_window_session_values) {
									// read window session data and save it and the window into the window session file		
									let window_session_data = Utils.parseAutoSaveValues(aWindow.extData._sm_window_session_values);
									Private.saveWindowSession(window_session_data, aWindow);
								}
							});
						}
					}
				}
			});
		}
	},
	
	sanitize: function(aRange, aSilent)
	{
		log("sanitize - aRange = " + aRange + ",aSilent = " + aSilent, "DATA");
		// If "Clear Recent History" prompt then use range, otherwise remove all sessions
		if (aRange && (typeof aRange[0] == "number")) {
			let error = null;
			let errorFileNames = "";
			// Delete sessions folder first, then deleted folder.  Only delete sessions after startDate.
			for (var i=0; i<2; i++) {
				let sessions = (i==0) ? this.getSessions() : this.getSessions(null, Utils.deletedSessionsFolder);
				let folder = (i==0) ? "" : Utils.deletedSessionsFolder;
				sessions.forEach(function(aSession, aIx) { 
					if (aRange[0] <= aSession.timestamp*1000) {
						try {
							log("Deleting " + aSession.fileName, "EXTRA");
							let file = this.getSessionDir(folder);
							file.append(aSession.fileName);
							this.delFile(file, true, true, true);
						}
						catch(ex) {
							error = ex;
							errorFileNames = (folder ? (folder + "/") : "") + aSession.fileName;
							logError(ex);
							// If file is locked it's probably being written to (likely a backup file) so add it to the delete later list
							if (ex.result == Components.results.NS_ERROR_FILE_IS_LOCKED) {
								log("File " + aSession.fileName + " is locked, adding to delete later list.", "INFO");
								this.mDeleteLaterList.push(file.path);
							}
						}
					}
				}, this);
			}
			if (!aSilent && error) Utils.ioError(ex, errorFileName);
		}
		else {
			try {
				this.getSessionDir().remove(true);
				// clear out cache;
				mSessionCache = [];
				SQLManager.removeSessionFromSQLCache();
				
				// If using SessionStore closed windows, delete our closed window list
				if (PreferenceManager.get("use_SS_closed_window_list"))
					this.clearUndoData("window", true);
			}
			catch(ex) {
				logError(ex);
				// If folder delete fails, try deleting the files individually by specifying smallest number possible
				this.sanitize([0], true);
			}
		}
	},

	// Get User profile directory, set aIsDir if aFileName is a directory
	getProfileFile: function(aFileName, aIsDir)
	{
		return aIsDir ? FileUtils.getDir("ProfD", Array.isArray(aFileName) ? aFileName : [aFileName], true) : 
				FileUtils.getFile("ProfD", Array.isArray(aFileName) ? aFileName : [aFileName]);
	},
	
	getUserDir: function(aFileName)
	{
		let dir = null;
		let dirname = PreferenceManager.get("sessions_dir", "");
		try {
			if (dirname) {
				try {
					dir = new FileUtils.File(dirname);
          // If directory does not exist, try to create it.
          if (!dir.exists())
            dir.create(1, 777);
				}
				catch (ex) {
					if (!reportedUserSessionFolderIOError) {
						reportedUserSessionFolderIOError = true;
						Utils.ioError(ex, dir.path);
						log("User folder '" + dir.path + "' cannot be read or created.  Using default session dir.", "ERROR");
					}
					dir = null;
					// execute jumps to finally clause below which returns dir (null) 
					return null;
				}
				reportedUserSessionFolderIOError = false;
				if (aFileName) {
					if (dir.isDirectory() && dir.isWritable()) {
						dir.append(aFileName);
					}
					else {
						dir = null;
					}
				}
			}
		} catch (ex) {
			dir = null;
		} finally {
			return dir;
		}
	},

	getSessionDir: function(aFileName, aUnique)
	{
		// Check for absolute path first, session names can't have \ or / in them so this will work.  Relative paths will throw though.
		if (/[\\\/]/.test(aFileName)) {
			let file;
			try {
				file = new FileUtils.File(aFileName);
			}
			catch(ex) {
				Utils.ioError(ex, aFileName);
				file = null;
			}
			return file;
		}
		else {
			// allow overriding of location of sessions directory
			let dir = this.getUserDir();
			
			// use default if not specified or not a writable directory
			if (dir == null) {
				try {
					dir = this.getProfileFile("sessions", true);
				}
				catch (ex) {
					Utils.ioError(ex, dir.path);
					return null;
				}
			}
			if (!dir.isDirectory()) {
				Utils.ioError(new Components.Exception(dir.path, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller));
				return null;
			}
			if (aFileName)
			{
				dir.append(aFileName);
				if (aUnique)
					dir = this.makeUniqueSessionFileName(dir, aFileName);
			}
			return dir.QueryInterface(Ci.nsILocalFile);  // In Gecko 14 and up don't need to set interface to nsILocalFile
		}
	},
	
	makeUniqueSessionFileName: function(dir, aFileName)
	{
		let postfix = 1, ext = "";
		if (aFileName.slice(-Constants.SESSION_EXT.length) == Constants.SESSION_EXT)
		{
			aFileName = aFileName.slice(0, -Constants.SESSION_EXT.length);
			ext = Constants.SESSION_EXT;
		}
		while (dir.exists())
		{
			dir = dir.parent;
			dir.append(aFileName + "-" + (++postfix) + ext);
		}
		return dir;
	},

	// Cache the session data so menu opens faster, don't want to use async since that reads the entire
	// file in and we don't need to do that.  So simulate it by doing a bunch of short synchronous reads.
	// This reads in one file every 50 ms.  Since it's possible for getSessions() to be called during that
	// time frame, simply stop caching if a session is already cached as that means getSessions() was called.
	cacheSessions: function(aSubFolder) {
		// If there is already a timer started, simply add the folder to be checked later)
		if (this.cacheSessionTimer) {
			this.cacheSessionFolderList.push(aSubFolder);
			return;
		}
	
		let encryption_mismatch = false;
		let sessionFiles = [];
		let folder = this.getSessionDir(aSubFolder);
		if (!folder.exists()) {
			Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", null);
			return;
		}
		let filesEnum = folder.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		let folderName = aSubFolder ? (aSubFolder + "/") : "";
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			sessionFiles.push({filename: file.leafName, lastModifiedTime: file.lastModifiedTime});
		}
		let cache_count = sessionFiles.length;
		if (!cache_count) {
			Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", null)
			return;
		}
		
		log("SessionIo:cacheSessions: Caching " + cache_count + " session files" + (aSubFolder ? (" in " + aSubFolder) : "") + ".", "INFO");	
		// timer call back function to cache session data
		var callback = {
			notify: function(timer) {
				//let a = Date.now();
				let session;
				try {
					session = sessionFiles.pop();
				}
				catch(ex) { 
					logError(ex);
					session = null;
				};
				// if the session is already cached, that means getSession() was called so stop caching sessions, also stop on an encryption mismatch since
				// the encryption change processing will kick off and that reads files as well.
				if (!encryption_mismatch && session && !mSessionCache[folderName + session.filename]) {
					let file = folder.clone();
					file.append(session.filename);
					let session_data = Private.readSessionFile(file, true);
					let matchArray;
					if (matchArray = Constants.SESSION_REGEXP.exec(session_data))
					{
						let timestamp = parseInt(matchArray[2]) || session.lastModifiedTime;
						let backupItem = Constants.BACKUP_SESSION_REGEXP.test(session.filename);
						let group = matchArray[7] ? matchArray[7] : "";
						let encrypted = (session_data.split("\n")[4].indexOf(":") == -1);
						encryption_mismatch = encryption_mismatch || (encrypted != PreferenceManager.get("encrypt_sessions"));
						// save mSessionCache data
						mSessionCache[folderName + session.filename] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: session.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group, encrypted: encrypted };
						//log("SessionIo:cacheSessions: Cached " + session.filename + " in " + (Date.now() - a) + " milli-seconds.", "INFO");
					}
					else {
						log(file.leafName + " session file corrupt.  Will try to repair later if possible");
						// Don't move to corrupt folder since we might be able to repair it in processReadSessionFile when reading session list
						//	this.moveToCorruptFolder(file);
					}
				}
				else {
					Private.cacheSessionTimer.cancel();
					Private.cacheSessionTimer = null;
					SharedData.convertFF3Sessions = false;
					log("SessionIo:cacheSessions: Finished caching " + (cache_count - sessionFiles.length) + " session files" + (aSubFolder ? (" in " + aSubFolder) : "") + ".", "INFO");
					Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", encryption_mismatch ? "encryption_change_detected" : null);
					
					if (Private.cacheSessionFolderList.length) {
						let folder = Private.cacheSessionFolderList.shift();
						Utils.runAsync(function() { Private.cacheSessions(folder); }.bind(Private), Private);
					}
				}
			}
		}
		
		log("convertFF3Sessions = " + SharedData.convertFF3Sessions, "DATA");
		this.cacheSessionTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		this.cacheSessionTimer.initWithCallback(callback, 50, Ci.nsITimer.TYPE_REPEATING_SLACK);
	},

	// Use to update cache with new timestamp so we don't re-read it for no reason
	updateCachedLastModifiedTime: function(aFullFilePath, aLastModifiedTime) {
		if (mSessionCache[aFullFilePath]) {
			mSessionCache[aFullFilePath].time = aLastModifiedTime;
		}
	},
	
	// Use to update cache with new encryption status since file won't be re-read.
	updateCachedEncryptionStatus: function(aFullFilePath) {
		if (mSessionCache[aFullFilePath]) {
			mSessionCache[aFullFilePath].encrypted = PreferenceManager.get("encrypt_sessions");
		}
	},	

	getClosedWindowsCount: function() {
		return this.getClosedWindows(true);
	},
	
	// Get SessionStore's or Session Manager's Closed window List depending on preference.
	// Return the length if the Length Only parameter is true - only ever true if not using built in closed window list
	getClosedWindows: function(aLengthOnly)
	{
		if (PreferenceManager.get("use_SS_closed_window_list")) {
			let closedWindows = Utils.JSON_decode(SessionStore.getClosedWindowData());
			if (aLengthOnly) return closedWindows.length;
			let parts = new Array(closedWindows.length);
			closedWindows.forEach(function(aWindow, aIx) {
				parts[aIx] = { name: aWindow.title, state: Utils.JSON_encode({windows:[aWindow]}) };
			}, this);
			return parts;
		}
		else {
			return this.getClosedWindows_SM(aLengthOnly);
		}
	},

	getClosedWindows_SM: function(aLengthOnly)
	{
		// Use cached data unless file has changed or was deleted
		let data = null;
		let file = this.getProfileFile(Constants.CLOSED_WINDOW_FILE);
		if (!file.exists()) return (aLengthOnly ? 0 : []);
		else if (file.lastModifiedTime > mClosedWindowCache.timestamp) {
			data = this.readFile(this.getProfileFile(Constants.CLOSED_WINDOW_FILE));
			data = data ? data.split("\n\n") : null;
			mClosedWindowCache.data = data;
			mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
			if (aLengthOnly) return (data ? data.length : 0);
		}
		else {
			data = mClosedWindowCache.data;
		}
		if (aLengthOnly) {
			return (data ? data.length : 0);
		}
		else {
			return (data)?data.map(function(aEntry) {
				let parts = aEntry.split("\n");
				return { name: parts.shift(), state: parts.join("\n") };
			}):[];
		}
	},

	// Stored closed windows into Session Store or Session Manager controller list.
	storeClosedWindows: function(aWindow, aList, aIx)
	{
		if (PreferenceManager.get("use_SS_closed_window_list")) {
			// The following works in that the closed window appears to be removed from the list with no side effects
			let closedWindows = Utils.JSON_decode(SessionStore.getClosedWindowData());
			closedWindows.splice(aIx || 0, 1);
			let state = { windows: [ {} ], _closedWindows: closedWindows };
			SessionStore.setWindowState(aWindow, Utils.JSON_encode(state), false);
			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
		}
		else {
			this.storeClosedWindows_SM(aList);
		}
	},

	// Store closed windows into Session Manager controlled list
	storeClosedWindows_SM: function(aList)
	{
		let file = this.getProfileFile(Constants.CLOSED_WINDOW_FILE);
		if (aList.length > 0)
		{
			let data = aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state
			});
			try {
				this.writeFile(file, data.join("\n\n"), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						mClosedWindowCache.data = data;
						mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
					}
					else {
						let exception = new Components.Exception(Constants.CLOSED_WINDOW_FILE, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			}
			catch(ex) {
				Utils.ioError(ex, Constants.CLOSED_WINDOW_FILE);
				return;
			}
		}
		else
		{
			try {
				this.delFile(file, false, true);
				mClosedWindowCache.data = null;
				mClosedWindowCache.timestamp = 0;
			}
			catch(ex) {
				Utils.ioError(ex, Constants.CLOSED_WINDOW_FILE);
				return;
			}
		}
		
		if (Services.tm.isMainThread) {
			Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
		}
	},

	clearUndoData: function(aType, aSilent)
	{
		if (aType == "window" || aType == "all")
		{
			this.delFile(this.getProfileFile(Constants.CLOSED_WINDOW_FILE), aSilent, true);
		}
	},
	
	autoSaveCurrentSession: function(aForceSave)
	{
		try
		{
			if (aForceSave || !Utils.isAutoStartPrivateBrowserMode()) {
				let state = SessionDataProcessing.getSessionState(Utils._string("autosave_session"), null, null, null, Utils._string("backup_sessions"));
				if (!state) return;
				// backup older autosave sessions
				this.keepOldBackups(true,true);
				this.writeFile(this.getSessionDir(Constants.AUTO_SAVE_SESSION_NAME), state, function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, Constants.AUTO_SAVE_SESSION_NAME);
					}
					else {
						let exception = new Components.Exception(Constants.AUTO_SAVE_SESSION_NAME, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			}
		}
		catch (ex)
		{
			Utils.ioError(ex, Constants.AUTO_SAVE_SESSION_NAME);
		}
	},

	backupCurrentSession: function(aPeriodicBackup)
	{
		log("SessionIo.backupCurrentSession start", "TRACE");
		let backup = PreferenceManager.get("backup_session");
		
		// Force backup if a periodic backup
		if (aPeriodicBackup)
			backup = 1;

		// Don't automatically backup and restore if user chose to quit.
		let temp_backup = (PreferenceManager.get("startup") == 2) && (PreferenceManager.get("resume_session") == Constants.BACKUP_SESSION_FILENAME);

		// Get results from prompt in component if it was displayed and set the value back to the default
		let results = SharedData.mShutdownPromptResults;
		log("backupCurrentSession: results = " + results, "DATA");
		if (results != -1) 
			SharedData.mShutdownPromptResults = -1;
		
		// If prompting for backup, read values from Component if they exist, else prompt here
		if (backup == 2)
		{
			// If there was no prompt in Component (older browser), prompt here
			let dontPrompt = { value: false };
			if (results == -1) {
				let saveRestore = !(PreferenceManager.get("browser.sessionstore.resume_session_once", false, true) || this.doResumeCurrent());
				let flags = Services.prompt.BUTTON_TITLE_SAVE * Services.prompt.BUTTON_POS_0 + 
							Services.prompt.BUTTON_TITLE_DONT_SAVE * Services.prompt.BUTTON_POS_1 + 
							(saveRestore ? (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_2) : 0); 
				results = Services.prompt.confirmEx(null, SharedData.mTitle, Utils._string("preserve_session"), flags,
			              null, null, Utils._string("save_and_restore"), Utils._string("prompt_not_again"), dontPrompt);
			}
			// If quit was pressed, skip all the session stuff below
			backup = (results == 1)?-1:1;
			switch(results) {
				case 2:	// If chose Save & Restore
					if (dontPrompt.value) {
						PreferenceManager.set("resume_session", Constants.BACKUP_SESSION_FILENAME);
						PreferenceManager.set("startup", 2);
					}
					else PreferenceManager.set("restore_temporary", true);
					break;
				case 1: // If chose Quit
					// If set to restore previous session and chose to quit and remember, set startup to "none"
					if (dontPrompt.value && temp_backup) {
						PreferenceManager.set("startup", 0);
					}
					// Don't temporarily restore
					temp_backup = false;
					break;
			}
			if (dontPrompt.value)
			{
				PreferenceManager.set("backup_session", (backup == -1)?0:1);
			}
		}
		
		log("backupCurrentSession: backup = " + backup + ", temp_backup = " + temp_backup, "DATA");
		
		// Don't save if just a blank window, if there's an error parsing data, just save
		let state = null;
		if ((backup > 0) || temp_backup) {
			try {
				state = SessionDataProcessing.getSessionState(Utils._string("backup_session"), null, Utils.getNoUndoData(), null, Utils._string("backup_sessions"), true);
			} catch(ex) {
				logError(ex);
			}
			try {
				let aState = Utils.JSON_decode(state.split("\n")[4]);
				log("backupCurrentSession: Number of Windows #1 = " + aState.windows.length + ((aState.windows.length >= 1) ? (", Number of Tabs in Window[1] = " + aState.windows[0].tabs.length) : ""), "DATA");
				let logging_state = isLoggingState();
				if (logging_state) log(state, "STATE");
				// if window data has been cleared ("Visited Pages" cleared on shutdown), use mClosingWindowState, if it exists.
				if ((aState.windows.length == 0 || (aState.windows.length >= 1 && aState.windows[0].tabs.length == 0)) && (SharedData.mClosingWindowState || SharedData.mShutdownState)) {
					log("backupCurrentSession: Using " + (SharedData.mClosingWindowState ? "closing Window State" :"Shutdown state"), "INFO");
					state = SessionDataProcessing.getSessionState(Utils._string("backup_session"), null, Utils.getNoUndoData(), null, Utils._string("backup_sessions"), true, null, SharedData.mClosingWindowState || SharedData.mShutdownState);
					if (logging_state) log(state, "STATE");
					aState = Utils.JSON_decode(state.split("\n")[4]);
				}
				log("backupCurrentSession: Number of Windows #2 = " + aState.windows.length, "DATA");
				// If there isn't any actual session data, don't do a backup - closed window data is considered session data
				if ((!aState._closedWindows || aState._closedWindows.length == 0) && 
				    ((aState.windows.length == 0) || 
				     !((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || 
				       (aState._closedWindows && aState._closedWindows.length > 0) ||
				       (aState.windows[0].tabs.length > 1) || (aState.windows[0].tabs[0].entries.length > 1) || 
				       ((aState.windows[0].tabs[0].entries.length == 1 && aState.windows[0].tabs[0].entries[0].url != "about:blank"))
				    ))) {
					backup = 0;
					temp_backup = false;
				}
			} catch(ex) { 
				logError(ex);
			}
		}

		if (backup > 0 || temp_backup)
		{
			this.keepOldBackups(backup > 0);
			
			// encrypt state if encryption preference set
			if (PreferenceManager.get("encrypt_sessions")) {
				state = state.split("\n")
				state[4] = Utils.decryptEncryptByPreference(state[4]);
				if (!state[4]) return;
				state = state.join("\n");
			}
			
			try
			{
				this.writeFile(this.getSessionDir(Constants.BACKUP_SESSION_FILENAME), state, function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, Constants.BACKUP_SESSION_FILENAME);
					}
					else {
						let exception = new Components.Exception(Constants.BACKUP_SESSION_FILENAME, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
				if (temp_backup && (backup <= 0)) PreferenceManager.set("backup_temporary", true);
			}
			catch (ex)
			{
				Utils.ioError(ex, Constants.BACKUP_SESSION_FILENAME);
			}
		}
		else this.keepOldBackups(false);
		log("backupCurrentSession end", "TRACE");
	},

	keepOldBackups: function(backingUp, aAutoSaveBackup)
	{
		log("keepOldBackups start for " + (aAutoSaveBackup ? "autosave" : "backup"), "TRACE");
		let max_backup_keep = PreferenceManager.get("max_backup_keep");
		if (!backingUp && (max_backup_keep > 0)) 
			max_backup_keep += 1; 
		let backup = this.getSessionDir(aAutoSaveBackup ? Constants.AUTO_SAVE_SESSION_NAME : Constants.BACKUP_SESSION_FILENAME);
		if (backup.exists()) {
			if (aAutoSaveBackup || max_backup_keep)
			{
				let oldBackup = this.getSessionDir(aAutoSaveBackup ? Constants.AUTO_SAVE_SESSION_NAME : Constants.BACKUP_SESSION_FILENAME, true);
				// preserve date that file was backed up
				let date = new Date();
				date.setTime(backup.lastModifiedTime); 
				let name = Utils.getFormattedName("", date, Utils._string(aAutoSaveBackup ? "old_autosave_session" : "old_backup_session"));
				this.writeFile(oldBackup, Utils.nameState(this.readSessionFile(backup), name), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						SQLManager.addSessionToSQLCache(false, oldBackup.leafName);
					}
					else {
						let exception = new Components.Exception(oldBackup.leafName, aResults, Components.stack.caller);
						Utils.ioError(exception);
					}
				});
			}
			if (!backingUp)
				this.delFile(backup, true, true);
		}	
		
		// Prune backed up sessions down to max keep value.  Does not apply to autosave sessions
		if (!aAutoSaveBackup && max_backup_keep != -1)
		{
			this.getSessions().filter(function(aSession) {
				return /^backup-\d+\.session$/.test(aSession.fileName);
			}).sort(function(a, b) {
				return b.timestamp - a.timestamp;
			}).slice(max_backup_keep).forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true);
			}, this);
		}
		log("keepOldBackups end", "TRACE");
	},

	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	// aSubFolder - optional sub-folder to look for sessions in.  Used to check "Deleted" folder.
	// aFilterByFileName - if set to true, then apply filter to filename instead of name
	//
	getSessions: function(filter, aSubFolder, aFilterByFileName)
	{
		let matchArray;
		let sessions = [];
		sessions.latestTime = sessions.latestBackUpTime = 0;
		
		let dir = this.getSessionDir(aSubFolder);
		if (!dir.exists() || !dir.isDirectory())
			return sessions;
		let filesEnum = dir.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		let folderName = aSubFolder ? (aSubFolder + "/") : "";
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory or if it somehow just got deleted (delayed writing can do that, especially with backup sessions at shutdown)
			try {
				if (!file.exists() || file.isDirectory()) continue;
			}
			catch(ex) {
				// catch errors in case file can't be read or was deleted during the check
				logError(ex);
				continue;
			}
			let fileName = file.leafName;
			// Check here if filtering by filename as there's no reason to read the file if it's filtered.
			if (aFilterByFileName && filter && !filter.test(fileName)) continue;
			let backupItem = Constants.BACKUP_SESSION_REGEXP.test(fileName);
			let cached = mSessionCache[folderName + fileName] || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				try {
					if (filter && !aFilterByFileName && !filter.test(cached.name)) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				if (!backupItem && (sessions.latestTime < cached.timestamp)) 
				{
					sessions.latestTime = cached.timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < cached.timestamp)) {
					sessions.latestBackUpTime = cached.timestamp;
				}
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem, group: cached.group, encrypted: cached.encrypted });
				continue;
			}
			let session_header_data = this.readSessionFile(file, true);
			if (matchArray = Constants.SESSION_REGEXP.exec(session_header_data))
			{
				try {
					if (filter && !aFilterByFileName  && !filter.test(matchArray[1])) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				let timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
				if (!backupItem && (sessions.latestTime < timestamp)) 
				{
					sessions.latestTime = timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < timestamp)) {
					sessions.latestBackUpTime = timestamp;
				}
				let group = matchArray[7] ? matchArray[7] : "";
				let encrypted = (session_header_data.split("\n")[4].indexOf(":") == -1);
				sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
				// save mSessionCache data unless browser is shutting down
				if (!SharedData._stopping)
					mSessionCache[folderName + fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group, encrypted: encrypted };
			}
		}
		
		switch (Math.abs(PreferenceManager.get("session_list_order")))
		{
		case 1: // alphabetically
			sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
			break;
		case 2: // chronologically
			sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
			break;
		}
		
		return (PreferenceManager.get("session_list_order") < 0)?sessions.reverse():sessions;
	},
	
	// This function procseses read session file, it is here because it can be called as a callback function and I 
	// don't want it called directly from outside this module
	getCountString: function (aCount) { 
		return "\tcount=" + aCount.windows + "/" + aCount.tabs + "\n"; 
	},

	processReadSessionFile: function(state, aFile, headerOnly, aSyncCallback) {
		let matchArray;
		// old crashrecovery file format
		if ((/\n\[Window1\]\n/.test(state)) && 
			(matchArray = /^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.exec(state))) 
		{
			// read entire file if only read header
			let name = matchArray[1] || Utils._string("untitled_window");
			let timestamp = parseInt(matchArray[2]) || aFile.lastModifiedTime;
			if (headerOnly) state = this.readFile(aFile);
			headerOnly = false;
			state = state.substring(state.indexOf("[Window1]\n"), state.length);
			state = Utils.JSON_encode(SessionConverter.decodeOldFormat(state, true));
			let countString = this.getCountString(Utils.getCount(state));
			state = "[SessionManager v2]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
			this.writeFile(aFile, state, function(aResults) {
				// Update tab tree if it's open
				if (Components.isSuccessCode(aResults)) 
					Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
			});
		}
		// Not latest session format
		else if ((/^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n/m.test(state)) && (!Constants.SESSION_REGEXP.test(state)))
		{
			// This should always match, but is required to get the RegExp values set correctly.
			// matchArray[0] - Entire 4 line header
			// matchArray[1] - Top 3 lines (includes name and timestamp)
			// matchArray[2] - " v2" (if it exists) - if missing file is in old format
			// matchArray[3] - Autosave string (if it exists)
			// matchArray[4] - Autosave value (not really used at the moment)
			// matchArray[5] - Count string (if it exists)
			// matchArray[6] - Group string and any invalid count string before (if either exists)
			// matchArray[7] - Invalid count string (if it exists)
			// matchArray[8] - Group string (if it exists)
			// matchArray[9] - Screen size string and, if no group string, any invalid count string before (if either exists)
			// matchArray[10] - Invalid count string (if it exists)
			// matchArray[11] - Screen size string (if it exists)
			matchArray = /(^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session\/?\d*|window\/?\d*)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*[\n]?)?((\t.*)?(\tgroup=[^\t\n\r]+[\n]?))?((\t.*)?(\tscreensize=\d+x\d+[\n]?))?/m.exec(state)
			if (matchArray)
			{	
				// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
				let goodSession = !/autosave=(false|true|session\/?\d*|window\/?\d*).*\nautosave=(false|true|session\/?\d*|window\/?\d*)/m.test(state);
				
				// read entire file if only read header
				if (headerOnly) state = this.readFile(aFile);
				headerOnly = false;

				if (goodSession)
				{
					let data = state.split("\n")[((matchArray[3]) ? 4 : 3)];
					if (!data) {
						// There's no session data, but it might have gotten appended to end of group name so check
						let line3 = state.split("\n")[3];
						let matchArray2;
						if (line3 && (matchArray2 = line3.match(/MI|{"/))) {
							data = line3.substring(matchArray2.index);
							line3 = line3.substring(0,matchArray2.index);
							if (!data) {
								// There's still no session data, something is horribly wrong with session file so just chuck it
								log("Moving to corrupt folder:" + aFile.leafName, "DATA");
								this.moveToCorruptFolder(aFile);
								return null;
							}
						}
						else {
							// There's still no session data, something is horribly wrong with session file so just chuck it
							log("Moving to corrupt folder:" + aFile.leafName, "DATA");
							this.moveToCorruptFolder(aFile);
							return null;
						}
						// fix group if it exists and was corrupted (screen size fixes itself)
						if (matchArray[8] && !matchArray[11]) {
							matchArray[8] = matchArray[8].replace(RegExp(matchArray2[0] + ".*"), "");
						}
					}
					let backup_data = data;
					// decrypt if encrypted, do not decode if in old format since old format was not encoded
					data = Utils.decrypt(data, true, !matchArray[2]);
					// If old format test JSON data
					if (!matchArray[2]) {
						matchArray[1] = matchArray[1].replace(/^\[SessionManager\]/, "[SessionManager v2]");
						let test_decode = Utils.JSON_decode(data, true);
						// if it failed to decode, try to decrypt again using new format
						if (test_decode._JSON_decode_failed) {
							data = Utils.decrypt(backup_data, true);
						}
					}
					backup_data = null;
					if (!data) {
						// master password entered, but still could not be decrypted - either corrupt or saved under different profile
						if (data == false) {
							log("Moving to corrupt folder:" + aFile.leafName, "DATA");
							this.moveToCorruptFolder(aFile);
						}
						return null;
					}
					let countString = (matchArray[5]) ? (matchArray[5]) : this.getCountString(Utils.getCount(data));
					// If the session has no windows in it, flag it as corrupt and move it to the corrupted folder
					// if it has no closed windows otherwise make the first closed window the active window.
					// old Firefox versions could create sessions with no tabs, so don't mark those as corrupt
					if (/(0\/\d)/.test(countString)) 
					{
						// if there is a closed window in this session, make that the current window otherwise it's unrecoverable
						let decoded_data = Utils.JSON_decode(data, true);
						if (decoded_data._closedWindows && decoded_data._closedWindows.length > 0) {
							decoded_data.windows = []; 
							decoded_data.windows.push(decoded_data._closedWindows.shift());
							countString = this.getCountString({ windows: 1, tabs: decoded_data.windows[0].tabs.length });
							data = Utils.JSON_encode(decoded_data);
						}
						else {
							log("Moving to corrupt folder:" + aFile.leafName, "DATA");
							this.moveToCorruptFolder(aFile);
							return null;
						}
					}
					// remove \n from count string if group or screen size is there
					if ((matchArray[8] || matchArray[11]) && (countString[countString.length-1] == "\n")) countString = countString.substring(0, countString.length - 1);
					let autoSaveString = (matchArray[3]) ? (matchArray[3]).split("\n")[0] : "autosave=false";
					if (autoSaveString == "autosave=true") autoSaveString = "autosave=session/";
					state = matchArray[1] + autoSaveString + countString + (matchArray[8] ? matchArray[8] : "") + (matchArray[11] ? matchArray[11] : "");
					// If there is no newline at the end of line three add it (prevents state from ending up on line 3)
					if (state[state.length-1] != "\n") 
						state += "\n";
					state += Utils.decryptEncryptByPreference(data);
					this.writeFile(aFile, state, function(aResults) {
						// Update tab tree if it's open
						if (Components.isSuccessCode(aResults)) 
							Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
					});
				}
				// else bad session format, attempt to recover by removing extra line
				else {
					let newstate = state.split("\n");
					newstate.splice(3,newstate.length - (newstate[newstate.length-1].length ? 5 : 6));
					if (matchArray[7] == "\tcount=0/0") newstate.splice(3,1);
					state = newstate.join("\n");
					// Simply do a write and recursively proces the session again with the current state until it's correct
					// or marked as invalid.  This handles the issue with asynchronous writes.
					this.writeFile(aFile, state, function(aResults) {
						// Update tab tree if it's open
						if (Components.isSuccessCode(aResults)) 
							Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
					});
					state = this.processReadSessionFile(state, aFile, headerOnly, aSyncCallback) 
				}
			}
		}
		
		// Convert from Firefox 2/3 format to 3.5+ format since Firefox 4 and later won't read the old format.  
		// Only convert if we haven't converted before.  This will only be called when
		// either caching or displaying the session list so just do a asynchronous read to do the conversion since the
		// session contents are not returned in those cases.
		if (SharedData.convertFF3Sessions && state) {
			// Do an asynchronous read and then check that to prevent tying up GUI
			this.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
				if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
					let state;
					// Read the session file from the stream and process and return it to the callback function
					try {
						state = NetUtil.readInputStreamToString(aInputStream, aInputStream.available(), { charset : "UTF-8" } );
					}
					catch(ex) {
						logError("Error reading " + aFile.leafName);
						logError(ex);
					}
					if ((/,\s?\"(xultab|text|ownerURI|postdata)\"\s?:/m).test(state)) {
						try {
							state = state.replace(/\r\n?/g, "\n");
							state = SessionConverter.convertToLatestSessionFormat(aFile, state);
						}
						catch(ex) { 
							logError(ex); 
						}
					}
					// if fix new line is set fix any sessions that contain "\r\r\n"
					else if (SharedData._fix_newline) {
						if ((/\r\r+\n?/gm).test(state)) {
							log("Fixing " + aFile.leafName + " to remove extra new line characters added by version 0.6.9", "TRACE");
							state = state.replace(/\r+\n?/g, "\n").replace(/\n$/, "");
							Private.writeFile(aFile, state, function(aResults) {
								// Update tab tree if it's open
								if (Components.isSuccessCode(aResults)) 
									Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
							});
						}
					}
				}
				else {
					logError(new Components.Exception(aFile.leafName, aStatusCode, Components.stack.caller));
				}
			});
		}
		
		return state;
	},
	
	readSessionFile: function(aFile,headerOnly,aSyncCallback, aDoNotProcess)
	{
		try {
			// Since there's no way to really actually read only the first few lines in a file with an
			// asynchronous read, we do header only reads synchronously.
			if (typeof aSyncCallback == "function") {
				this.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
					if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
						let state;
						// Read the session file from the stream and process and return it to the callback function
						try {
							state = NetUtil.readInputStreamToString(aInputStream, headerOnly ? 1024 : aInputStream.available(), { charset : "UTF-8" } );
						}
						catch(ex) {
							logError("Error reading " + aFile.leafName);
							logError(ex);
						}
						state = state.replace(/\r\n?/g, "\n");
						if (!aDoNotProcess)
							state = Private.processReadSessionFile(state, aFile, headerOnly, aSyncCallback);
						if (state) aSyncCallback(state);
					}
					else {
						logError(new Components.Exception(aFile.leafName, aStatusCode, Components.stack.caller));
					}
				});
				return null;
			}
			else {
				let state = this.readFile(aFile,headerOnly);
				return this.processReadSessionFile(state, aFile, headerOnly);
			}
		}
		catch(ex) {
			logError(ex);
			return null;
		}
	},
	
	asyncReadFile: function(aFile, aCallback)
	{
		let fileURI = Services.io.newFileURI(aFile);
		let channel;
    // newChannelFromURI doesn't exist as of Firefox 48.
    if (Services.io.newChannelFromURI2) {
      channel = Services.io.newChannelFromURI2(fileURI, null, Services.scriptSecurityManager.getSystemPrincipal(),
          null, Ci.nsILoadInfo.SEC_NORMAL, Ci.nsIContentPolicy.TYPE_OTHER);
    } else {
      channel = Services.io.newChannelFromURI(fileURI);
		}
		NetUtil.asyncFetch(channel, aCallback);
	},
	
	readFile: function(aFile,headerOnly)
	{
		try
		{
			let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
			stream.init(aFile, 0x01, 0, 0);
			let cvstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
			cvstream.init(stream, "UTF-8", 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
			
			let content = "";
			let data = {};
			while (cvstream.readString(4096, data))
			{
				content += data.value;
				if (headerOnly) break;
			}
			cvstream.close();
			
			return content.replace(/\r\n?/g, "\n");
		}
		catch (ex) { }
		
		return null;
	},

	// This will write the specified data to the specified file and call the optional aCallback function when finished.
	writeFile: function(aFile, aData, aCallback)
	{
		if (!aData) return;  // this handles case where data could not be encrypted and null was passed to writeFile
		// Don't need to change EOL more than once
		aData = aData.replace(/\n/g, Utils.EOL);  // Change EOL for OS
		
		this.writeFileNext(aFile, aData, aCallback);
	},

	// safe file output streams can't be appended to so don't use them when appending.
	writeFileNext: function(aFile, aData, aCallback, aAppended)
	{
		let istream, ostream, callback;
		// Default is 20 MB, but can be changed in preferences
		let session_max_write_size = parseInt(PreferenceManager.get("max_file_write_size", 20)) * 1048576;

		let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
		converter.charset = "UTF-8";
		
		// If the aData is too large (> ~30 MB), then the convert will fail with an out of memory exception.
		// Get around this by doing multiple convert and writes, appending to the file.  Do this for >20 MB to be safe.
		// Make sure first write is not an append, which would be bad
		if (aData.length > session_max_write_size) {
				istream = converter.convertToInputStream(aData.substring(0,session_max_write_size));
				callback = function(aResult) {
					if (Components.isSuccessCode(aResult)) 
						Private.writeFileNext(aFile, aData.substring(session_max_write_size), aCallback, true);
					else if (typeof aCallback == "function")
						aCallback(aResult);
				}
		}
		else {
				istream = converter.convertToInputStream(aData);
				callback = aCallback;
		}
		// If already wrote once, need to append and therefore need to use non-safe file output stream
		if (aAppended)
				ostream = FileUtils.openFileOutputStream(aFile, FileUtils.MODE_WRONLY | FileUtils.MODE_CREATE | FileUtils.MODE_APPEND); 
		else
				ostream = FileUtils.openSafeFileOutputStream(aFile);  // write only, create file, truncate
		
		// Asynchronously copy the data to the file.  Wrap callback in check for sanitize so can delete locked files.
		NetUtil.asyncCopy(istream, ostream, function(aResult) {
			let index = this.mDeleteLaterList.indexOf(aFile.path);
			if (index != -1) {
				log("Deleting file that was being written while sanitized - " + aFile.leafName);
				this.mDeleteLaterList.splice(index, 1);
				this.delFile(aFile, true, true, true);
			}
			else if (typeof aCallback == "function")
				callback(aResult);
		}.bind(this));
	},

	delFile: function(aFile, aSilent, aDeleteOnly, aSanitizing)
	{
		if (aFile && aFile.exists())
		{
			let in_session_folder = false;
			try
			{
				// When deleting a session, remove from SQL Cache.
				// We don't remove files in the deleted folder since they won't be added and deleting them can cause
				// items from the cache to be removed if the filename is the same as one in the sessions folder
				if (aFile.parent.path == this.getSessionDir().path) {
					in_session_folder = true;
					SQLManager.removeSessionFromSQLCache(aFile.leafName);
				}
			
				if (aDeleteOnly || (PreferenceManager.get("recycle_time", 7) <= 0)) {
					aFile.remove(false);
					if (aFile.parent) {
						if (in_session_folder)
							delete mSessionCache[aFile.leafName];
						else 
							delete mSessionCache[aFile.parent.leafName + "/" + aFile.leafName];
					}
				}
				else {
					aFile.lastModifiedTime = Date.now();
					let folder = Utils.deletedSessionsFolder;
					this.moveToFolder(aFile, folder);
				}
			}
			catch (ex)
			{
				if (aSanitizing)
					throw ex;
			
				if (!aSilent)
				{
					Utils.ioError(ex, (aFile ? aFile.leafName : ""));
				}
				else logError(ex);
			}
		}
		
		if (!aSanitizing)
			this.purgeOldDeletedSessions();
	},
	
	restoreDeletedSessionFile: function(aFile, aSilent)
	{
		if (aFile && aFile.exists())
		{
			try
			{
				this.moveToFolder(aFile);
				SQLManager.addSessionToSQLCache(false, aFile.leafName);
			}
			catch (ex)
			{
				if (!aSilent)
				{
					Utils.ioError(ex, (aFile ? aFile.leafName : ""));
				}
				else logError(ex);
			}
		}
	},
	
	// Purge old deleted sessions when they get too old.  This function will check on program startup 
	// and then at most every 24 hours (triggered by a call to delfile).
	purgeOldDeletedSessions: function() {
		let time = Date.now();
		// if current time is greater than the last checked time + 24 hours (in milliseconds)
		if (time > (_lastCheckedTrashForRemoval + 86400000)) {
			_lastCheckedTrashForRemoval = time;
			
			// Set time to "recycle_time" days ago
			time = time - PreferenceManager.get("recycle_time", 7) * 86400000;
			
			// Get trash folder, if it doesn't exist exit
			let dir = this.getSessionDir(Utils.deletedSessionsFolder);
			if (!dir.exists()) return;
			
			// Permanently delete any old files in the trash folder
			let filesEnum = dir.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
			while (filesEnum.hasMoreElements())
			{
				let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
				if (file.lastModifiedTime < time) {
					this.delFile(file, true, true);
				}
			}
		}
	},
	
	emptyTrash: function() {
		let dontPrompt = { value: false };
		if (PreferenceManager.get("no_empty_trash_prompt") || Services.prompt.confirmEx(null, SharedData.mTitle, Utils._string("empty_trash_prompt"), Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1, null, null, null, Utils._string("prompt_not_again"), dontPrompt) == 0)
		{
			let dir = this.getSessionDir(Utils.deletedSessionsFolder);
			try
			{
				dir.remove(true);
			}
			catch (ex)
			{
				Utils.ioError(ex, (dir ? dir.path : ""));
			}
			if (dontPrompt.value)
			{
				PreferenceManager.set("no_empty_trash_prompt", true);
			}
		}
	},
	
	moveToCorruptFolder: function(aFile, aSilent)
	{
		try {
			if (aFile.exists()) 
			{
				this.moveToFolder(aFile, Utils._string("corrupt_sessions_folder"), true);
			}
		}	
		catch (ex) { 
			if (!aSilent && !SharedData._stopping) Utils.ioError(ex, (aFile ? aFile.leafName : ""));
			else logError(ex);
		}
	},
	
	moveToFolder: function(aFile, aFolderName, aOverwrite)
	{
		let dir = this.getSessionDir(aFolderName);
		let old_parentname = aFile.parent ? aFile.parent.leafName : "";
		let old_name = aFile.leafName;
		let new_name = null;
	
		if (!dir.exists()) {
			dir.create(Ci.nsIFile.DIRECTORY_TYPE, 448);
		}

		// check to see if file with same name exists and if so rename file
		if (!aOverwrite) {
			let newFile = dir.clone();
			newFile.append(aFile.leafName);
			if (newFile.exists()) 
				new_name = this.makeUniqueSessionFileName(newFile, newFile.leafName).leafName;
		}
		
		aFile.moveTo(dir, new_name);
		
		// move to correct cache area using new name (if name changed)
		if (aFolderName && mSessionCache[old_name]) {
			mSessionCache[aFolderName + "/" + (new_name || old_name)] = mSessionCache[old_name];
			delete mSessionCache[old_name];
		}
		else if (!aFolderName && mSessionCache[old_parentname + "/" + old_name]) {
			mSessionCache[new_name || old_name] = mSessionCache[old_parentname + "/" + old_name];
			delete mSessionCache[old_parentname + "/" + old_name];
		}
	},
	
	unload: function() 
	{
		if (Private.cacheSessionTimer) {
			Private.cacheSessionTimer.cancel();
			Private.cacheSessionTimer = null;
		}
	}
}

// Send unload function to bootstrap.js
let subject = { wrappedJSObject: Private.unload };
Services.obs.notifyObservers(subject, "session-manager-unload", null);
