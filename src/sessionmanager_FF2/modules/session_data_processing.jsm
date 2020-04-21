"use strict";

this.EXPORTED_SYMBOLS = ["SessionDataProcessing"];
						
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "resource://sessionmanager/modules/utils.jsm");

XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 

XPCOMUtils.defineLazyModuleGetter(this, "Rect", "resource://gre/modules/Geometry.jsm");
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
		// The passed in state is used for saving old state when shutting down in private browsing mode and when saving specific windows
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
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
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
				 ", aWindowSessionValues = " + (aWindowSessionValues ? ("\"" + aWindowSessionValues.split("\n").join(", ") + "\"") : "undefined") + ", xDelta = " + xDelta + 
				 ", yDelta = " + yDelta + ", aFileName = " + aFileName, "DATA");
		// decrypt state if encrypted
		aState = Utils.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = Utils.openWindow(PreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				SessionDataProcessing.restoreSession(this, aState, aReplaceTabs, aNoUndoData, null, null, null, aWindowSessionValues, xDelta, yDelta, aFileName);
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		aState = this.modifySessionData(aState, aNoUndoData, false, aWindow, aEntireSession, aOneWindow, aStartup, (aFileName == SharedData._crash_session_filename),
		                                SharedData._restoring_backup_session, xDelta, yDelta, aWindow.screen);  

		if (aEntireSession)
		{
			try {
				SessionStore.setBrowserState(aState);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
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
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
				}
				else throw(ex);
			}
		}
		
		// Store autosave values into window value and also into window variables
		if (!aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename) {
			// Backup _sm_window_session_values first in case we want to restore window sessions from non-window session.
			// For example, in the case of loading the backup session at startup.
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject._backup_window_sesion_data = SessionStore.getWindowValue(aWindow,"_sm_window_session_values");
			log("restoreSession: Removed window session name from window: " + aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject._backup_window_sesion_data, "DATA");
			Utils.getAutoSaveValues(aWindowSessionValues, aWindow);
		}
		log("restoreSession: restore done, window_name  = " + aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename, "DATA");
		// On Startup, if Session Manager is restoring crashed, backup or last autosave session tell Session Manager Component the number of windows being restored.  
		if (aStartup && (aFileName == SharedData._crash_session_filename || SharedData._restoring_backup_session || SharedData._restoring_autosave_backup_session)) {
			SharedData._countWindows = true;
			Services.obs.notifyObservers(null, "sessionmanager:windows-restored", this._number_of_windows);
		}

		// Save session manager window value for aWindow since it will be overwritten on load.  Other windows opened will have the value set correctly.
		if (aWindow.__SSi && aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject) {
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__SessionManagerWindowId = aWindow.__SSi;
			SessionStore.setWindowValue(aWindow, "__SessionManagerWindowId", aWindow.__SSi);
		}
		
		return true;
	},

	// Panorama will not restore tab groups correctly if there are matching group ids, but mismatching tab ids.  
	// This forces TabView to reconnect the tabs to the correct group after a restore.
	// Currently if a tab is not in a group, it will get added to active group which isn't correct, need to fix that.
	forceTabReconnections:function(aWindow, aTabsState) {
		let groupIDByTabNumber = [];
		aTabsState.forEach(function(aTabData, aIndex) {
			if (aTabData.extData && aTabData.extData["tabview-tab"]) {
				let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
				if (tabview_data && !tabview_data._JSON_decode_failed) {
					groupIDByTabNumber[aIndex] = tabview_data.groupID;
				}
			}
		});
	
		try {
			let tabs = aWindow.gBrowser.tabs;
			for (var i=0; i<tabs.length; i++) {
				if (tabs[i]._tabViewTabItem) {
					let tabView = tabs[i]._tabViewTabItem;
					let data = tabView.getStorageData();
					if (data && data.groupID && (data.groupID != groupIDByTabNumber[i])) {
						tabView._reconnected = false;
						log("forceTabReconnections: Forced tab " + i + " to reconnect as groupIDs did not match.", "EXTRA");
					}
				}
				else 
					log("forceTabReconnections: Tab " + i + " has no TabView", "EXTRA");
			}
		} 
		catch(ex) {
			logError(ex);
		}
	},

	// Remote Tab groups which contain no tabs
	removeEmptyTabGroups: function(aWinData, aReturnGroupData) {
		let current_tab_groups, current_tab_group;

		// Get tabview-groups data
		if (aWinData.extData && aWinData.extData["tabview-groups"]) {
			current_tab_groups = Utils.JSON_decode(aWinData.extData["tabview-groups"], true);
		}
		if (!current_tab_groups || current_tab_groups._JSON_decode_failed )
			return;

		if (aWinData.extData && aWinData.extData["tabview-group"]) {
			current_tab_group = Utils.JSON_decode(aWinData.extData["tabview-group"], true);
		}
		if (!current_tab_group || current_tab_group._JSON_decode_failed )
			return;
			
		// find tab groups in use
		let tab_groups_in_use = [];
		aWinData.tabs.forEach(function(aTabData) {
			if (aTabData.extData && aTabData.extData["tabview-tab"]) {
				let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
				if (tabview_data && !tabview_data._JSON_decode_failed) {
					if (tab_groups_in_use.indexOf(tabview_data.groupID) == -1)
						tab_groups_in_use.push(tabview_data.groupID);
				}
			}
		});
			
		// remove tab groups that don't have a corresponding tab
		let deleted_count = 0;
		for (var id in current_tab_group) {
			if (tab_groups_in_use.indexOf(parseInt(id)) == -1) {
				delete current_tab_group[id];
				deleted_count++;
			}
		};
		
		if (deleted_count) {
			if (deleted_count == parseInt(current_tab_groups.totalNumber)) {
				current_tab_group = null;
				current_tab_groups = null;
				delete aWinData.extData["tabview-groups"];
				delete aWinData.extData["tabview-group"];
			}
			else {
				// update total group count
				current_tab_groups.totalNumber = parseInt(current_tab_groups.totalNumber) - deleted_count;
				// if active group removed, switch to new active group
				if (tab_groups_in_use.indexOf(current_tab_groups.activeGroupId) == -1)
					current_tab_groups.activeGroupId = tab_groups_in_use[0];
				// save new tab group data
				aWinData.extData["tabview-groups"] = Utils.JSON_encode(current_tab_groups);
				aWinData.extData["tabview-group"] = Utils.JSON_encode(current_tab_group);
			}
		}
		return [current_tab_groups,current_tab_group];
},
	
	// Parameters are current window to process and existing tab group data
	// The function will update the group data to make sure it is unique
	fixTabGroups: function(aWinData, tab_group_data) {
		let no_group_data = !tab_group_data;

		// Remove empty tab groups and get groups data
		let return_data = this.removeEmptyTabGroups(aWinData);
		if (!return_data)
			return;
		let current_tab_groups = return_data[0];
		let current_tab_group = return_data[1];
		if (!current_tab_group || !current_tab_groups)
			return;
			
		// If no existing group data, store current data otherwise merge the data
		if (!tab_group_data)
			tab_group_data = { tabview_groups : current_tab_group, tabview_group : current_tab_group };
		else {
			// Update nextID
			if (current_tab_groups.nextID > tab_group_data.tabview_groups.nextID)
				tab_group_data.tabview_groups.nextID = current_tab_groups.nextID;
			// Find Tab Group Names
			let tab_group_name_mapping = {};
			for (var id in tab_group_data.tabview_group) {
				if (tab_group_data.tabview_group[id].title)
					tab_group_name_mapping[tab_group_data.tabview_group[id].title] = id;
			}
			// Change group id numbers if need be
			for (var id in current_tab_group) {
				// if id already exists, choose a different id.  If group name already exists, use that group
				if (tab_group_data.tabview_group[id] || tab_group_name_mapping[current_tab_group[id].title]) {
					let new_id = -1;
					
					// If tab names match, use that group id otherwise get a new group id
					if (tab_group_name_mapping[current_tab_group[id].title])
						new_id = tab_group_name_mapping[current_tab_group[id].title];
					else if (tab_group_data.tabview_group[id])
						new_id = tab_group_data.tabview_groups.nextID++;

					// only update if not already in the right group
					if (new_id != -1) {
						tab_group_data.tabview_group[new_id] = current_tab_group[id];
						tab_group_data.tabview_group[new_id].id = new_id;
						
						// update tabview-tab data
						aWinData.tabs.forEach(function(aTabData) {
							if (aTabData.extData && aTabData.extData["tabview-tab"]) {
								let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
								if (tabview_data && !tabview_data._JSON_decode_failed) {
									if (tabview_data.groupID == id) {
										// update id and save
										tabview_data.groupID = new_id;
										aTabData.extData["tabview-tab"] = Utils.JSON_encode(tabview_data);
									}
								}
							}
						});
					}
				}
				else {
					tab_group_data.tabview_group[id] = current_tab_group[id];
				}
			}
		}
	},
	
	// Make sure none of the tab groups overlap each other in the Tab View UI
	fixOverlappingTabGroups: function(aTabview_ui, tabview_group) {
		if (!aTabview_ui) 
			return;

		let tabview_ui = Utils.JSON_decode(aTabview_ui, true);
		if (!tabview_ui || tabview_ui._JSON_decode_failed )
			return;
			
		let groups = [];
		for (var id in tabview_group) {
			groups.push({id: id, bounds: new Rect(tabview_group[id].bounds.left, tabview_group[id].bounds.top, 
			                                  tabview_group[id].bounds.width, tabview_group[id].bounds.height)});
		}
		
		function overlaps(i) {
			return groups.some(function(group, index) {
				if (index == i) // can't overlap with yourself.
					return false;
				return groups[i].bounds.intersects(group.bounds);
			});
		}
		
		// find if any groups overlap
		let overlap = false;
		for (var i in groups) {
			if (overlaps(i)) {
				overlap = true;
				break;
			}
		}
		
		// if overlap just tile all groups because it's easier. 
		if (overlap) {
			let column_number = Math.ceil(Math.sqrt(groups.length));
			let new_height = Math.floor((tabview_ui.pageBounds.height - tabview_ui.pageBounds.top) / column_number);
			let new_width = Math.floor((tabview_ui.pageBounds.width - tabview_ui.pageBounds.left) / column_number);
			let new_x = tabview_ui.pageBounds.left;
			let new_y = tabview_ui.pageBounds.top;
			
			for (var i in groups) {
				tabview_group[groups[i].id].bounds.left = new_x;
				tabview_group[groups[i].id].bounds.top = new_y;
				tabview_group[groups[i].id].bounds.width = new_width;
				tabview_group[groups[i].id].bounds.height = new_height;
				tabview_group[groups[i].id].userSize = null;
				
				new_x += new_width;
				if (new_x + new_width > tabview_ui.pageBounds.width) {
					new_x = tabview_ui.pageBounds.left;
					new_y += new_height;
				}
			}
		}
	},
	
	// aBrowserWindow = existing browser window
	makeOneWindow: function(aBrowserWindow,aState)
	{
		let tab_group_data;
	
		// Grab existing tab group info from browser window
		let currentWindowState = SessionStore.getWindowState(aBrowserWindow);
		let tabview_groups = SessionStore.getWindowValue(aBrowserWindow, "tabview-groups");
		let tabview_group = SessionStore.getWindowValue(aBrowserWindow, "tabview-group");
		if (tabview_groups && tabview_group) {
			tabview_groups = Utils.JSON_decode(tabview_groups);
			tabview_group = Utils.JSON_decode(tabview_group);
			if (tabview_groups && !tabview_groups._JSON_decode_failed && tabview_group && !tabview_group._JSON_decode_failed)
				tab_group_data = { tabview_groups: tabview_groups, tabview_group: tabview_group };
		}
	
		if (aState.windows.length > 1)
		{
			// take off first window
			let firstWindow = aState.windows.shift();
			this.fixTabGroups(firstWindow, tab_group_data);
			// make sure toolbars are not hidden on the window
			delete firstWindow.hidden;
			// Move tabs to first window
			aState.windows.forEach(function(aWindow) {
				Private.fixTabGroups(aWindow, tab_group_data);
				while (aWindow.tabs.length > 0)
				{
					this.tabs.push(aWindow.tabs.shift());
				}
			}, firstWindow);
			
			// Update firstWindow with new group info
			if (tab_group_data) {
				if (!firstWindow.extData) 
					firstWindow.extData = {};
				this.fixOverlappingTabGroups(firstWindow.extData["tabview-ui"], tab_group_data.tabview_group);
				firstWindow.extData["tabview-groups"] = Utils.JSON_encode(tab_group_data.tabview_groups);
				firstWindow.extData["tabview-group"] = Utils.JSON_encode(tab_group_data.tabview_group);
			}
			
			// Remove all but first window
			aState.windows = [];
			aState.windows[0] = firstWindow;
			
			// Make sure selected window is correct
			aState.selectedWindow = 1;
		}
		else if (aState.windows.length == 1) {
			this.fixTabGroups(aState.windows[0], tab_group_data);
			// Update Window with new group info
			if (tab_group_data) {
				if (!aState.windows[0].extData) 
					aState.windows[0].extData = {};
				this.fixOverlappingTabGroups(aState.windows[0].extData["tabview-ui"], tab_group_data.tabview_group);
				aState.windows[0].extData["tabview-groups"] = Utils.JSON_encode(tab_group_data.tabview_groups);
				aState.windows[0].extData["tabview-group"] = Utils.JSON_encode(tab_group_data.tabview_group);
			}
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

	// Note, there are two cases where loading a session can result in merging of multiple window.  One is when the aOneWindow
	// value is set, and the other is when aReplaceTabs is true, but aEntireSession is false.  The later can only occur at browser startup
	// and only when the user starts Firefox with a command line argument or when browser updates.  Neither of those cases will have a group
	// so we only need to fix groups when merging into oneWindow.
	modifySessionData: function(aState, aNoUndoData, aSaving, aBrowserWindow, aReplacingWindow, aSingleWindow, aStartup, aCrashFile, aPreviousSession, xDelta, yDelta, aScreen)
	{
		if (!xDelta) xDelta = 1;
		if (!yDelta) yDelta = 1;
	
		aState = Utils.JSON_decode(aState);
		
		// Forget about private windows if saving
		if (aSaving) {
			if (aState.windows) {
				for (let i = aState.windows.length - 1; i >= 0; i--) {
					if (aState.windows[i].isPrivate) {
						aState.windows.splice(i, 1);
					}
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
		if (aStartup && aReplacingWindow) aState._firstTabs = true;
		
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
			if (!isNaN(aWindowNumber))
				Private.removeEmptyTabGroups(aWindow);
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
			if (aState.selectedWindow > aState.windows.length);
				aState.selectedWindow = aState.windows.length;
		}
		
		// If overwriting first window, force any grouped tabs to reconnect if the groupID doesn't match
		if (!aSaving && aReplacingWindow) 
			this.forceTabReconnections(aBrowserWindow, aState.windows[0].tabs);
		
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