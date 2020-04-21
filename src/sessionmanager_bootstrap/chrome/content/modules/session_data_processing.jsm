"use strict";

this.EXPORTED_SYMBOLS = ["SessionDataProcessing"];
						
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "TabGroupManager", "chrome://sessionmanager/content/modules/tab_group_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 

XPCOMUtils.defineLazyServiceGetter(this, "screen_manager", "@mozilla.org/gfx/screenmanager;1", "nsIScreenManager");

// 
// public functions
//
this.SessionDataProcessing = {

	//
	// Get/Restore Session Data functions
	//
	
	getSessionState: function(aName, aWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState, aMergeState) {
		return Private.getSessionState(aName, aWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState, aMergeState);
	},
	
	restoreSession: function(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta, aFileName) {
		return Private.restoreSession(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta, aFileName);
	},
}

// Freeze the SessionDataProcessing object. We don't want anyone to modify it.
Object.freeze(SessionDataProcessing);

//
// private functions
//
let Private = {

	_number_of_windows: 0,

	getSessionState: function(aName, aWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState, aMergeState)
	{
		// aState - State JSON string to use instead of the getting the current state.
		// aMergeState - State JSON string to merge with either the current state or aState.
		//
		// The passed in state is used when saving specific windows
		// The merge state is used to append to sessions.
		if (aState) log("getSessionState: " + (aMergeState ? "Merging" : "Returning") + " passed in state", "INFO");
		let state;
		try {
			try {
				state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message && ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
				}
				else throw(ex);
			}
			
			if (aMergeState) {
				state = Utils.JSON_decode(state);
				aMergeState = Utils.JSON_decode(aMergeState);
				state.windows = state.windows.concat(aMergeState.windows);
				if (state._closedWindows && aMergeState._closedWindows) state._closedWindows = state._closedWindows.concat(aMergeState._closedWindows);
				state = Utils.JSON_encode(state);
			}
		}
		catch(ex) {
			// Log and rethrow errors
			logError(ex);
			throw(ex);
		}
		
		state = this.modifySessionData(state, aNoUndoData, true);
		if (!state) 
			return null;
		let count = Utils.getCount(state);
		
		// encrypt state if encryption preference set and flag not set
		if (!aDoNotEncrypt) {
			state = Utils.decryptEncryptByPreference(state); 
			if (!state) return null;
		}

		let width = null;
		let height = null;
		let window = aWindow || Utils.getMostRecentWindow();
		if (window && (typeof(window) == "object") && !window.closed) {
			width = window.screen.width;
			height = window.screen.height;
		}
		aAutoSaveTime = isNaN(aAutoSaveTime) ? 0 : aAutoSaveTime;
		
		return (aName != null)?Utils.nameState("timestamp=" + Date.now() + "\nautosave=" + ((aAutoSave)?aWindow?("window/" + aAutoSaveTime):("session/" + aAutoSaveTime):"false") +
		                                      "\tcount=" + count.windows + "/" + count.tabs + (aGroup? ("\tgroup=" + aGroup.replace(/\t/g, " ")) : "") +
		                                      "\tscreensize=" + (SharedData._screen_width || width) + "x" + (SharedData._screen_height || height) + "\n" + state, aName || "") : state;
	},
	
	restoreSession: function(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta, aFileName)
	{
		log("restoreSession: aWindow = " + aWindow + ", aReplaceTabs = " + aReplaceTabs + ", aNoUndoData = " + (aNoUndoData ? JSON.stringify(aNoUndoData) : "undefined") + 
				", aEntireSession = " + aEntireSession + ", aOneWindow = " + aOneWindow + ", aStartup = " + aStartup + 
				", aWindowSessionValues = " + aWindowSessionValues + ", xDelta = " + xDelta + ", yDelta = " + yDelta + ", aFileName = " + aFileName, "DATA");
		// decrypt state if encrypted
		aState = Utils.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = Utils.openWindow(PreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				// Run this asynchronously so browser can load SessionStore components first
				Utils.runAsync(function() {
					aWindow.removeEventListener("load", aWindow.__SM_restore, true);
					SessionDataProcessing.restoreSession(aWindow, aState, aReplaceTabs, aNoUndoData, null, null, null, aWindowSessionValues, xDelta, yDelta, aFileName);
					delete aWindow.__SM_restore;
				});
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		aState = this.modifySessionData(aState, aNoUndoData, false, aWindow, aEntireSession, aOneWindow, aStartup, 
		                                (aFileName == SharedData._crash_session_filename), SharedData._restoring_backup_session, xDelta, yDelta, aWindow.screen);  
		if (aEntireSession)
		{
			try {
				SessionStore.setBrowserState(aState);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message && ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setBrowserState(aState);
				}
				else throw(ex);
			}
		}
		else
		{
			try {
				// if not overwriting tabs on startup (i.e. clicked shortcut to start Firefox) and not preserving app tabs, remove them
				if (aStartup && !aReplaceTabs && !PreferenceManager.get("preserve_app_tabs")) {
					let i = 0;
					while (i < aWindow.gBrowser.mTabs.length) {
						if (aWindow.gBrowser.mTabs[i].pinned)
							aWindow.gBrowser.removeTab(aWindow.gBrowser.mTabs[i]);
						else
							i++;
					}
				}
			
				SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" or NS_ERROR_INVALID_ARG then force SessionStore 
				// to initialize and try again otherwise just re-throw
				if ((ex.result && (ex.result == Components.results.NS_ERROR_INVALID_ARG)) || 
						(ex.message && (ex.message.indexOf("this._prefBranch is undefined") != -1))) {
					SessionStore.init(aWindow);
					SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
				}
				else throw(ex);
			}
		}

		// Store window session values into window value and also into backup window variable.
		// Make backup copy of window.__SSi for Session Manager to use. 
		Services.obs.notifyObservers(aWindow, "sessionmanager:restoring-window", aWindowSessionValues);
		
		// On Startup, if Session Manager is restoring crashed, backup or last autosave session tell Session Manager Component the number of windows being restored.  
		if (aStartup && (aFileName == SharedData._crash_session_filename || SharedData._restoring_backup_session || SharedData._restoring_autosave_backup_session)) {
			SharedData._countWindows = true;
			Services.obs.notifyObservers(null, "sessionmanager:windows-restored", this._number_of_windows);
		}

		return true;
	},
	
	// aBrowserWindow = existing browser window
	// aState = state for session being loaded
	makeOneWindow: function(aBrowserWindow,aState)
	{
		// Grab existing tab group info from browser window.  
		let tab_group_data = SharedData.panoramaExists ? TabGroupManager.getTabGroupData(aBrowserWindow) : null;
	
		if (aState.windows.length > 1)
		{
			// take off first window
			let firstWindow = aState.windows.shift();
			if (SharedData.panoramaExists) 
				tab_group_data = TabGroupManager.fixTabGroups(firstWindow, tab_group_data, aBrowserWindow);
			// make sure toolbars are not hidden on the window
			delete firstWindow.hidden;
			// Move tabs to first window
			aState.windows.forEach(function(aWindow) {
				if (SharedData.panoramaExists) 
					tab_group_data = TabGroupManager.fixTabGroups(aWindow, tab_group_data);
				while (aWindow.tabs.length > 0)
				{
					this.tabs.push(aWindow.tabs.shift());
				}
			}, firstWindow);
			
			// Update firstWindow in loaded session with new group info
			if (SharedData.panoramaExists) 
				TabGroupManager.updateTabGroupData(firstWindow, tab_group_data);
			
			// Remove all but first window
			aState.windows = [];
			aState.windows[0] = firstWindow;
			
			// Make sure selected window is correct
			aState.selectedWindow = 1;
		}
		else if (SharedData.panoramaExists && (aState.windows.length == 1)) {
			tab_group_data = TabGroupManager.fixTabGroups(aState.windows[0], tab_group_data, aBrowserWindow);
			// Update Window in session data with new group info
			TabGroupManager.updateTabGroupData(aState.windows[0], tab_group_data);
		}
	},
	
	// returns an array of windows containing app tabs for that window or null (if no app tabs in window)
	// If aCrashRecover is true, read app tabs from crash backup since we didn't restore crashed session
	gatherAppTabs: function(aCrashRecover) 
	{
		let state = null;
	
		// only check if user cares
		if (PreferenceManager.get("preserve_app_tabs")) {
			
			try {
				if (aCrashRecover) {
					log("recover app tabs from crash file", "INFO");
					let file = SessionIo.getSessionDir(SharedData._crash_backup_session_file);
					state = SessionIo.readSessionFile(file).split("\n")[4];
					state = Utils.JSON_decode(Utils.decrypt(state));
				}
				else
					state = Utils.JSON_decode(SessionStore.getBrowserState());
			}
			catch (ex) { 
				logError(ex);
				return null;
			};
			
			if (state) {
				// filter out all tabs that aren't pinned
				state = state.windows.map(function(aWindow) {
					aWindow.tabs = aWindow.tabs.filter(function(aTab) {
						return aTab.pinned;
					});
					// fix selected tab index
					if (aWindow.selected > aWindow.tabs.length)
						aWindow.selected = aWindow.tabs.length;
						
					return (aWindow.tabs.length > 0) ? aWindow : null;
				});
			}
		}
		
		return state;
	},
	
	removePrivateTabs: function(windowState) {
		windowState.tabs = windowState.tabs.filter(function(tabState) {
			var isPrivate = ("attributes" in tabState) && (tabState.attributes["privateTab-isPrivate"] == "true");
			return !isPrivate;
		}, this);
	},
  
	unhideHiddenTabs: function(windowState) {
		windowState.tabs.forEach(function(aTab) {
			aTab.hidden = false;
		});
	},

	// Note, there are two cases where loading a session can result in merging of multiple window.  One is when the aOneWindow
	// value is set, and the other is when aReplaceTabs is true, but aEntireSession is false.  The later can only occur at browser startup
	// and only when the user starts Firefox with a command line argument or when browser updates.  Neither of those cases will have a group
	// so we only need to fix groups when merging into oneWindow.
	modifySessionData: function(aState, aNoUndoData, aSaving, aBrowserWindow, aReplacingWindow, aSingleWindow, aStartup, aCrashFile, aPreviousSession, xDelta, yDelta, aScreen)
	{
		if (!xDelta) xDelta = 1;
		if (!yDelta) yDelta = 1;
	
		aState = Utils.JSON_decode(aState);
		
		// Forget about private windows if saving (also forget Private Tabs from Private Tab add-on)
		if (aSaving) {
			if (aState.windows) {
				for (let i = aState.windows.length - 1; i >= 0; i--) {
					if (aState.windows[i].isPrivate) {
						aState.windows.splice(i, 1);
					}
					else if (SharedData.privateTabsEnabled) 
						this.removePrivateTabs(aState.windows[i]);
				}
			}
			if (aState._closedWindows) {
				for (let i = aState._closedWindows.length - 1; i >= 0; i--) {
					if (aState._closedWindows[i].isPrivate) {
						aState._closedWindows.splice(i, 1);
					}
				}
			}
			// If no windows left return nothing.  - *** DON'T DO THIS BECAUSE IT BREAKS BACKUP SESSIONS WITH NO WINDOWS ***
//			if (aState.windows.length ==0)
//				return null;
		}
		
		// set _firsttabs to true on startup to prevent closed tabs list from clearing when not overwriting tabs.
		// The ability to do this was removed in Firefox 26 and above so the work around no longer works - see Firefox bugs 904460 and 907129.
		if (aStartup && aReplacingWindow && (Services.vc.compare(Services.appinfo.platformVersion, "26.0") < 0)) 
			aState._firstTabs = true;
		
		// Fix window data based on settings
		let fixWindow = function(aWindow, aWindowNumber) {
			// Strip out cookies if user doesn't want to save them
			if (aSaving && !PreferenceManager.get("save_cookies")) delete aWindow.cookies;

			// remove closed tabs			
			if (aNoUndoData && aNoUndoData.tabs) aWindow._closedTabs = [];
			
			// adjust window position and height if screen dimensions don't match saved screen dimensions
			aWindow.width = aWindow.width * xDelta;
			aWindow.height = aWindow.height * yDelta;
			aWindow.screenX = aWindow.screenX * xDelta;
			aWindow.screenY = aWindow.screenY * yDelta;
			
			// Make sure window doesn't load offscreen.  Only do this if there is one screen, otherwise it causes windows to move to first screen.
			if (aScreen && (screen_manager.numberOfScreens == 1)) {
				if (aWindow.screenX > aScreen.width) 
					aWindow.screenX = aScreen.width - aWindow.width;
				else if ((aWindow.screenX + aWindow.width) < 0)
					aWindow.screenX = 0;
				if (aWindow.screenY > aScreen.height) 
					aWindow.screenY = aScreen.height - aWindow.height;
				else if ((aWindow.screenY + aWindow.height) < 0)
					aWindow.screenY = 0;
			}
			
			// fix selected tab index
			if (aWindow.selected > aWindow.tabs.length)
				aWindow.selected = aWindow.tabs.length;
				
			// remove empty tab groups (if not already done in makeOneWindow)
			if (!isNaN(aWindowNumber) && SharedData.panoramaExists)
				TabGroupManager.removeEmptyTabGroups(aWindow);
      
			// Unhide hidden tabs if Tab grouping doesn't exit
			if (!SharedData.panoramaExists)
        		Private.unhideHiddenTabs(aWindow);
		};
		
		// If loading, replacing windows and not previous session, add app tabs to loading state (if needed)
		if (!aSaving && aReplacingWindow && !aPreviousSession) {
			let appTabState = this.gatherAppTabs(aStartup && aCrashFile);
			//log("Gathered App Tabs = " + Utils.JSON_encode(appTabState), "EXTRA");
			if (appTabState) {
				appTabState.forEach(function(aWindow, aIndex) {
					// if there are any app tabs copy them to the loading state
					if (aWindow) {
						if (aState.windows.length > aIndex) {
							aState.windows[aIndex].tabs = aState.windows[aIndex].tabs.concat(aWindow.tabs);
						}
						else  {
							aState.windows.push(aWindow);
						}
					}
				});
				//log("Merged load session = " + Utils.JSON_encode(aState), "EXTRA");
			}
		}

		// If loading and making one window do that, otherwise process opened window
		if (!aSaving && !aReplacingWindow && aSingleWindow) {
			this.makeOneWindow(aBrowserWindow,aState);
			fixWindow(aState.windows[0]);
		}
		else {
			aState.windows.forEach(fixWindow, this);
			// Make sure selected window is correct
			if (aState.selectedWindow > aState.windows.length)
				aState.selectedWindow = aState.windows.length;
		}
		
		// If overwriting first window, force any grouped tabs to reconnect if the groupID doesn't match
		if (!aSaving && aReplacingWindow && SharedData.panoramaExists) 
			TabGroupManager.forceTabReconnections(aBrowserWindow, aState.windows[0].tabs);
		
		// process closed windows (for sessions only)
		if (aState._closedWindows) {
			if (PreferenceManager.get("use_SS_closed_window_list") && aNoUndoData && aNoUndoData.windows) {
				aState._closedWindows = [];
			}
			else  {
				aState._closedWindows.forEach(fixWindow, this);
			}
		}

		// if only one window, don't allow toolbars to be hidden
		if (aReplacingWindow && (aState.windows.length == 1) && aState.windows[0].hidden) {
			delete aState.windows[0].hidden;
			// Since nothing is hidden in the first window, it cannot be a popup (see Firefox bug 519099)
			delete aState.windows[0].isPopup;
		}
		
		// save number of windows
		this._number_of_windows = aState.windows.length;
		
		return Utils.JSON_encode(aState);
	},
}