"use strict";

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger objects - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "gSessionManager", "chrome://sessionmanager/content/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "EncryptionManager", "chrome://sessionmanager/content/modules/encryption_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionDataProcessing", "chrome://sessionmanager/content/modules/session_data_processing.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");
XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 

const Cc = Components.classes;
const Ci = Components.interfaces;

const BLANK_SESSION = '{"windows":[],"selectedWindow":0}';

var gSessionManagerSessionBrowser = {

	gTabTree: null,
	gWinLabel: null,
	gStateObject: null,
	gTreeData: null,
	gNoTabsChecked: false,
	gAllTabsChecked: true,
	gDeleting: false,
	gObservingSaving: false,
	gObservingGroupChange: false,
	gSaving: false,
	gAnyPrivateTabs: false,
	
	gIgnoreTabOpenTime: 0,
	gIgnoreUpdates: false,
	gWaitingForRestore: false,

	aShowWindowSessions: false,
	
	updateData: null,
	oneWindow: null,
	
	onUnload_proxy: function(aEvent) {
		window.removeEventListener("unload", gSessionManagerSessionBrowser.onUnload_proxy, false);
		if (gSessionManagerSessionBrowser.gObservingGroupChange) {
			Services.obs.removeObserver(gSessionManagerSessionBrowser, "sessionmanager:tag-group-change");
		}
		if (gSessionManagerSessionBrowser.gObservingSaving) {
			Services.obs.removeObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree");
		}
		if (gSessionManagerSessionBrowser.gWaitingForRestore)
			Services.obs.removeObserver(gSessionManagerSessionBrowser, "sessionstore-browser-state-restored");
	},
	
	// Used to update tree when session data changes
	observe: function(aSubject, aTopic, aData)
	{
		log("sessionbrowser.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "EXTRA");
		switch (aTopic)
		{
		case "sessionmanager:tag-group-change":
			this.showHideTabGroupColumns();
			break;
		case "sessionmanager:update-tab-tree":
			// Only update if saving and the tab tree box is not hidden
			if (this.gSaving && !this.gIgnoreUpdates && !gSessionManagerSessionPrompt.gTabTreeBox.hidden)
			{
				var data = aData.split(" ");
				
				// Give it a chance to update before processing events
				setTimeout(function() { 
					gSessionManagerSessionBrowser.updateData = { window: aSubject, data: aData };
					gSessionManagerSessionBrowser.initTreeView("", false, false, true, true); 
					gSessionManagerSessionBrowser.updateData.window = null;
					gSessionManagerSessionBrowser.updateData = null;
					gSessionManagerSessionBrowser.checkAllNoneChecked();
				}, 100);
			}
			break;
		case "sessionstore-browser-state-restored":
			Services.obs.removeObserver(gSessionManagerSessionBrowser, "sessionstore-browser-state-restored");
			this.gWaitingForRestore = false;
			this.gIgnoreUpdates = false;
			this.initTreeView("", false, false, true);
			break;
		}
	},
	
	showHideTabGroupColumns: function() {
		var tabgroup = document.getElementById("tabgroup");
		var hidden = document.getElementById("hidden");
		var hidden_hidden = hidden.getAttribute("_hidden");
		var tabgroup_hidden = tabgroup.getAttribute("_hidden");
		tabgroup.hidden = !SharedData.panoramaExists || (tabgroup_hidden == "true");
		hidden.hidden = !SharedData.panoramaExists || (hidden_hidden == "true");
		if (SharedData.panoramaExists) {
			tabgroup.removeAttribute("ignoreincolumnpicker");
			hidden.removeAttribute("ignoreincolumnpicker");
		} else {
			tabgroup.setAttribute("ignoreincolumnpicker", "true");
			hidden.setAttribute("ignoreincolumnpicker", "true");
		}
	},
	
	initTreeView: function(aFileName, aDeleting, aStartupPrompt, aSaving, aUpdate) {
		
		var firstTime = false;
		
		log("initTreeView start", "TRACE");
	
		// Initialize common values
		if (!this.gTabTree) {
			this.gTabTree = document.getElementById("sessionmanager_tabTree");
			this.gWinLabel = this.gTabTree.getAttribute("_window_label");
			firstTime = true;
		}
		this.aShowWindowSessions = false;
		
		// Observe tab group enable/disable.  Only can happen if using addon.
		if (!this.gObservingGroupChange) {
			this.gObservingGroupChange = true;
			Services.obs.addObserver(gSessionManagerSessionBrowser, "sessionmanager:tag-group-change", false);
		}
			

		// If updating call updateTree function otherwise wipe out old tree data and repopulate it
		if (aUpdate) {
			// If saving one window and update isn't for that window, don't do anything
			if (!this.oneWindow || (this.updateData.window == this.oneWindow)) {
				this.updateTree();
				// update menu if no windows open
				gSessionManagerSessionPrompt.checkForNoWindows();
			}
		}
		else {
			var state = null, currentSession = false;
			// Save off current window if saving one window so we can tell if it gets updated
			// Try to get window by stored SSI, otherwise grab recent non-private window
			let callbackData = gSessionManagerSessionPrompt.gParams.callbackData;
			this.oneWindow = (callbackData && callbackData.oneWindow) ? 
				(callbackData.window__SSi ? Utils.getWindowBySSI(callbackData.window__SSi) : Utils.getMostRecentWindow("navigator:browser", false, false)) :
				null;
		
			// Check to see if Tab Groups exist (only do once per session manager window open)
			if (firstTime) 
				this.showHideTabGroupColumns();
			
			// Save deleting and saving parameters
			this.gDeleting = aDeleting;
			this.gSaving = aSaving;

			this.gNoTabsChecked = false;
			this.gAllTabsChecked = true;
			this.treeView.initialize();
			
			// Watch for session changes when saving sessions
			if (aSaving && !this.gObservingSaving) {
				this.gObservingSaving = true;
				Services.obs.addObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree", false);
			}

			// Force accept button to be disabled if not deleting
			if (!aDeleting) gSessionManagerSessionPrompt.isAcceptable(true);
			
			// If Saving show current session in tabs
			if (aSaving) {
				try {
					// If Private Browsing is permanently enabled don't display any windows
					if (Utils.isAutoStartPrivateBrowserMode()) 
						state = BLANK_SESSION;
					else
						state = this.oneWindow ? SessionStore.getWindowState(this.oneWindow) : SessionStore.getBrowserState();
				} catch(ex) { 
					logError(ex);
					return; 
				}
			}
			// if chose crashed session read from sessionstore.js instead of session file
			else if (aFileName == "*") {
				state = SharedData.mShutdownState;
				currentSession = true;
			}
			else {
				state = SessionIo.readSessionFile(SessionIo.getSessionDir(aFileName));
				if (!state)
				{
					Utils.ioError();
					return;
				}

				if (!Constants.SESSION_REGEXP.test(state))
				{
					Utils.sessionError();
					return;
				}
				state = state.split("\n")[4];
			}

			if (!currentSession) {
				// Decrypt first, then evaluate
				state = Utils.decrypt(state);
				if (!state) return;
				state = Utils.JSON_decode(state);
				if (!state || state._JSON_decode_failed) {
					if (currentSession && state && state._JSON_decode_error)
						logError(state._JSON_decode_error);
					return;
				}
			}
			
			// If the invalid session flag is set resave with valid data (do this here since it's the only
			// place where we know the filename while decoding the data
			if (state._fixed_bad_JSON_data) {
				delete state._fixed_bad_JSON_data;
				// read the header
				var file = SessionIo.getSessionDir(aFileName);
				var new_state = SessionIo.readSessionFile(file, true);
				new_state = new_state.split("\n");
				new_state[4] = Utils.JSON_encode(state);
				new_state[4] = Utils.decryptEncryptByPreference(new_state[4], true);
				if (new_state[4] && (typeof(new_state[4]) == "string")) {
					new_state = new_state.join("\n");
					SessionIo.writeFile(file, new_state);
					log("Fixed invalid session file " + aFileName, "INFO");
				}
			}

			// Remove private windows if saving
			if (aSaving) {
				for (let i = state.windows.length - 1; i >= 0; i--) {
					if (state.windows[i].isPrivate) {
						state.windows.splice(i, 1);
					}
				}
			}
			
			// Save new state
			this.gStateObject = state;
			
			// Find if session closed at shutdown was an autosave session
			let last_autosave_session_filename = null;
			
			if (aStartupPrompt) {
				let last_autosave_session = PreferenceManager.get("_backup_autosave_values", null);
				if (last_autosave_session)
					last_autosave_session_filename = last_autosave_session.split("\n")[0];
			}
			
			// Create or re-create the Tree
			this.aShowWindowSessions = currentSession || (aStartupPrompt && (aFileName == Constants.BACKUP_SESSION_FILENAME) || (aFileName == last_autosave_session_filename));
			this.createTree();
			this.aShowWindowSessions = false;
		}
		
		// Update accept button
		gSessionManagerSessionPrompt.isAcceptable();
		
		log("initTreeView end", "TRACE");
	},

	addWindowStateObjectToTree: function(aWinData, aIx) {
		var windowSessionName = null;
		if (this.aShowWindowSessions) {
			windowSessionName = (aWinData.extData) ? aWinData.extData["_sm_window_session_values"] : null;
			windowSessionName = (windowSessionName) ? (Utils._string("window_session") + "   " + Utils.parseAutoSaveValues(windowSessionName).name) : null;
		}
		// Try to find tab group nanes if they exists, 0 is the default group and has no name
		var tab_groups = { 0:"" };
		if (aWinData.extData && aWinData.extData["tabview-group"]) {
			var tabview_groups = Utils.JSON_decode(aWinData.extData["tabview-group"], true);
			if (tabview_groups && !tabview_groups._JSON_decode_failed) {
				for (var id in tabview_groups) {
					tab_groups[id] = tabview_groups[id].title;
				}
			}
		}
		var winState = {
			label: this.gWinLabel.replace("%S", (aIx + 1)),
			open: true,
			checked: true,
			sessionName: windowSessionName,
			ix: aIx,
			tabGroups: tab_groups,
			selectedTab: aWinData.selected
		};
		winState.tabs = aWinData.tabs.map(function(aTabData) {
			return this.addTabStateObjectToTree(aTabData, winState);
		}, this);
		this.gTreeData.push(winState);
		let privateCount = 0;
		for (var tab of winState.tabs) {
			if (tab.isPrivate) privateCount++;
			this.gTreeData.push(tab);
		}
		// Any private tabs, update checkbox for window
		if (privateCount) {
			this.gAnyPrivateTabs = true;
			winState.checked = (privateCount == winState.tabs.length) ? false : 0;
		}
	},
	
	findGroupID: function(aTabData) {
		// Try to find tab group ID if it exists, 0 is default group
		var groupID = 0;
		if (aTabData.extData && aTabData.extData["tabview-tab"]) {
			var tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
			if (tabview_data && !tabview_data._JSON_decode_failed) 
				groupID = tabview_data.groupID;
		}
		return groupID;
	},
	
	addTabStateObjectToTree: function(aTabData, aWinParentState, aIconURL) {
		var entry = aTabData.entries[aTabData.index - 1] || { url: "about:blank" };
		var iconURL = (("attributes" in aTabData) && aTabData.attributes.image) || aTabData.image || aIconURL || null;
		var isPrivate = ("attributes" in aTabData) && (aTabData.attributes["privateTab-isPrivate"] == "true");
		
		// if no iconURL, look in pre Firefox 3.1 storage location
		if (!iconURL && aTabData.xultab) {
			iconURL = /image=(\S*)(\s)?/i.exec(aTabData.xultab);
			if (iconURL) iconURL = iconURL[1];
		}
		//dump(aIconURL + ", " + iconURL + "\n");
		
		// Try to find tab group ID if it exists, 0 is default group
		var groupID = this.findGroupID(aTabData);
		// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
		// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
		// use the work around for https.
		if (/^https:/.test(iconURL))
			iconURL = "moz-anno:favicon:" + iconURL;
		return {
			label: entry.title || entry.url,
			url: entry.url,
			checked: !isPrivate,
			hidden: aTabData.hidden,
			isPrivate: isPrivate,
			group: groupID,
			groupName: (aWinParentState && aWinParentState.tabGroups && aWinParentState.tabGroups[groupID]) || (groupID ? groupID : ""),
			src: iconURL,
			parent: aWinParentState
		};
	},
	
	// Find the window that the update occurred on and return index into this.gStateObject.windows
	// and this.gTreeData arrays for that window
	findUpdatedWindow: function(window) {
		// Look for window that contains updated tab
		var window_id = SessionStore.getWindowValue(window,"__SessionManagerWindowId");
		if (window_id) {
			for (var i=0; i<this.gStateObject.windows.length; i++) {
				// find matching window in gStateObject
				if (this.gStateObject.windows[i].extData && (this.gStateObject.windows[i].extData.__SessionManagerWindowId == window_id)) {
					// find matching window in gTreeData
					for (var j=0; j<this.gTreeData.length; j++) {
						// if window found
						if (this.gTreeData[j].ix == i) {
							return [i,j];
						}
					}
				}
			}
		}
		return [null,null];
	},
	
	createTree: function() {
		this.gStateObject.windows.forEach(this.addWindowStateObjectToTree, this);
		
		if (this.gAnyPrivateTabs) this.checkAllNoneChecked();
		
		// Set tree display view if not already set, otherwise just update tree
		if (!this.treeView.treeBox) this.gTabTree.view = this.treeView;
		else {
			this.gTabTree.treeBoxObject.rowCountChanged(0, this.treeView.rowCount);
		}
		//preselect first row
		//this.gTabTree.view.selection.select(0);
	},
	
	// This is called any time there is an updated tab event or window event.  In all cases:
	//    - updateData.window contains window object that is opening or closing or that contains the tab.
	//    - data[0] contains a string of what happened (TabOpen, TabClose, TabMove, locationChange, iconChange, windowOpen or windowClose)
	//              In Firefox it can also be tabviewhidden to indicate that the tab candy screen was closed.  
	//              In that case data[1] and data[2] are null.
	//              If Private Tabs addon is installed, this can also be "PrivateTab:PrivateChanged".
	//    - data[1] contains the tab position for tabs or the extData.__SessionManagerWindowId window value for windows
	//    - data[2] contains the original tab position for TabMove.  It is undefined for all other events except for "PrivateTab:PrivateChanged" where it is 0 or 1 for privacy disabled or enabled.
	//    - data[3] contains the favicon URL of the tab if data[0] is iconChange.  This is needed because the label isn't always set correctly in SeaMonkey in the window state.
	//
	updateTree: function() {
		log("updateTree: " + this.updateData.data, "EXTRA");
		var i, j, data = this.updateData.data.split(" ");
		var removing = (data[0] == "windowClose") || (data[0] == "TabClose");
		var new_window_state = removing ? null : SessionStore.getWindowState(this.updateData.window);
		if (new_window_state) {
			new_window_state = Utils.JSON_decode(new_window_state);
			if (!new_window_state || new_window_state._JSON_decode_failed) return;
		}

		switch(data[0]) {
		// If window is opening add it's state to end of current state since open windows are added to the end of the session
		// If SeaMonkey opens with multiple tabs, it includes them here, but also fires one "TabOpen" event per tab over 1.  As such there will
		// be extra blank tab(s) in our list.  For SeaMonkey ignore "TabOpen" events after a "windowOpen" event until a "locationChange" or "iconChange"
		// event comes in.  For sanity purposes also save the time in case there are no home pages and user manually opens a new tab for whatever reason.
		case "windowOpen":
			var row = this.treeView.rowCount;
			//dump(new_window_state.windows[0].toSource() + "\n");
			this.addWindowStateObjectToTree(new_window_state.windows[0], this.gStateObject.windows.length);
			this.gTabTree.treeBoxObject.rowCountChanged(row, new_window_state.windows[0].tabs.length + 1);
			this.gStateObject.windows.push(new_window_state.windows[0]);
			this.gStateObject.windows.selectedWindow = this.gStateObject.windows.length - 1;
			if (Services.appinfo.name == "SeaMonkey") {
				this.gIgnoreTabOpenTime = Date.parse(Date());
			}
			break;
		// If tab view was hidden replace window data since states of tabs may have changed.  Do this by adding updated
		// window to end of gTreeData and then moving it into the correct position, replacing the existing data
		case "tabviewhidden":
			// Find updated window
			[i,j] = this.findUpdatedWindow(this.updateData.window);
			if ((i != null) && (j != null)) {
				var windowOpen = this.gTreeData[j].open;;
				var current_length = this.gTreeData.length;
				this.addWindowStateObjectToTree(new_window_state.windows[0], i);
				var winTabLength = this.gTreeData.length - current_length;
				// Remove added window and update opened variable.
				var winState = this.gTreeData.splice(current_length, winTabLength);
				if (!windowOpen) {
					winState.splice(1, winTabLength - 1);
					winState[0].open = false;
				}
				// splice in new window, need to do it this way because winState is an array.
				var k = 0;
				while (winState.length) {
					this.gTreeData.splice(j + k++, 1, winState.shift());
				}
				// update view
				if (windowOpen)
					this.treeView.treeBox.invalidateRange(j, j + winTabLength - 1);
					
				// Save the new window state
				this.gStateObject.windows[i] = new_window_state.windows[0];
			}
			break;
		case "PrivateTab:PrivateChanged":
			// Find updated window
			[i,j] = this.findUpdatedWindow(this.updateData.window);
			if ((i != null) && (j != null)) {
				let tab_position = parseInt(data[1]);
				let isPrivate = !!parseInt(data[2]);
				let windowOpen = this.treeView.isContainerOpen(j);
				if (tab_position < this.gTreeData[j].tabs.length) {
					if (isPrivate != this.gTreeData[j].tabs[tab_position].isPrivate) {
						this.gTreeData[j].tabs[tab_position].checked = !isPrivate
						// Correct window's checkbox
						this.updateWindowCheckbox(this.gTreeData[j]);
					}
					this.gTreeData[j].tabs[tab_position].isPrivate = isPrivate;
					
					// Update tab tree
					if (windowOpen) 
						this.treeView.treeBox.invalidateRow(j + tab_position + 1);
				}
			}
			break;
		default:
			var isWindow = (data[0] == "windowClose");
			var adding = (data[0] == "TabOpen");
			var loading = (data[0] == "locationChange") || (data[0] == "iconChange");
		
			// If SeaMonkey sends extra "TabOpen" events after a window open, ignore them.  500 ms is a good threshold
			if (Services.appinfo.name == "SeaMonkey") {
				if (adding && (Date.parse(Date()) - this.gIgnoreTabOpenTime < 500))
					break;
				else if (loading)
					this.gIgnoreTabOpenTime = 0;
			}

			var tab_position = !isWindow ? parseInt(data[1]) : null;
			var old_tab_position = parseInt(data[2]);
			var moving = !isNaN(old_tab_position) ? (tab_position - old_tab_position) : 0;
			
			// If moving tab to same position, don't do anything (SeaMonkey does this when opening a new tab)
			if ((data[0] == "TabMove") && (tab_position == old_tab_position))
				break;
				
			// Find window that contained update
			[i,j] = this.findUpdatedWindow(this.updateData.window);
			if ((i != null) && (j != null)) {
				// sometimes when the last time was just closed, Firefox uses a tab position of 1.  This causes the following to throw an exception so adjust
				// the tab_position variable so it's valid.
				if (adding || loading) {
					var length = adding ? new_window_state.windows[0].tabs.length : this.gTreeData[j].tabs.length;
					if (length <= tab_position) tab_position = length - 1;
					if (tab_position < 0) tab_position = 0;
				}
				// Get tab tree state - don't bother copying parent window if loading since we don't use that
				var tabData = (removing || moving) ? null : this.addTabStateObjectToTree(new_window_state.windows[0].tabs[tab_position], loading ? null : this.gTreeData[j], data[3] ? decodeURIComponent(data[3]) : null);
				//if (tabData) dump(tabData.toSource() + "\n");
				var pos = isWindow ? j : (j + tab_position + 1);
				var windowOpen = this.treeView.isContainerOpen(j);
				if (loading && this.gTreeData[j].tabs.length > 0) {
					// Just update gTreeData for window object and if windowOpen update 
					// the gTreeData for the tab and invalidate the row
					this.gTreeData[j].tabs[tab_position].label = Utils.getCurrentTabTitle(this.updateData.window);
					this.gTreeData[j].tabs[tab_position].url = tabData.url;
					this.gTreeData[j].tabs[tab_position].src = tabData.src;

					// For Private Tab add-on, check if privacy change occurred.  Shouldn't be necessary, but doesn't hurt.
					if (tabData.isPrivate != this.gTreeData[j].tabs[tab_position].isPrivate) {
						this.gTreeData[j].tabs[tab_position].checked = !tabData.isPrivate
						// Correct window's checkbox
						this.updateWindowCheckbox(this.gTreeData[j]);
						this.gTreeData[j].tabs[tab_position].isPrivate = tabData.isPrivate;
					}
					
					// The group ID is only set on a load so read it here
					if (this.gTreeData[j].tabs[tab_position].group == 0) {
						var groupID = this.findGroupID(new_window_state.windows[0].tabs[tab_position]);
						this.gTreeData[j].tabs[tab_position].group = groupID;
						this.gTreeData[j].tabs[tab_position].groupName = this.gTreeData[j].tabs[tab_position].parent.tabGroups[groupID] || (groupID ? groupID : "");
						
						// update other tabs if needed
						if (groupID != 0) {
							for (var tab in new_window_state.windows[0].tabs) {
								if ((tab != tab_position) && (this.gTreeData[j].tabs[tab].group == 0) && (this.findGroupID(new_window_state.windows[0].tabs[tab]) == groupID)) {
									this.gTreeData[j].tabs[tab].group = groupID;
									this.gTreeData[j].tabs[tab].groupName = this.gTreeData[j].tabs[tab].parent.tabGroups[groupID] || (groupID ? groupID : "");
									if (windowOpen) {
										this.treeView.treeBox.invalidateRow(j + tab + 1);
									}
								}
							}
						}
					}

					if (windowOpen) {
						this.treeView.treeBox.invalidateRow(pos);
					}
				}
				else {
					// if loading with no tabs in gTreeData then we are in a bad state so treat it as an add and invalidate the whole tree to get things in sync
					if (loading) {
						adding = true;
						this.treeView.treeBox.invalidate();
					}

					// 1 row if window and not open or tab and open, 0 rows if tab and window collapse,
					// tab length if window and open or "moving" rows if moving or tab length if window and open.
					var rows = (((isWindow && !windowOpen) || (!isWindow && windowOpen)) && 1) || 
										 (isWindow && (this.gTreeData[j].tabs.length + 1)) || 0;
								 
					// if add/removing tab, add/remove it from the gTreeData window's tab value
					// if moving tab, splice back in removed tab
					if (!isWindow) {
						if (tabData) this.gTreeData[j].tabs.splice(tab_position, 0, tabData);
						else {
							// If moving a tab that doesn't exist (SeaMonkey frequently does this when opening tabs), get out of here
							if (this.gTreeData[j].tabs.length <= (tab_position - moving))
								break;
							var splicedTab = this.gTreeData[j].tabs.splice(tab_position - moving, 1);
							if (moving) this.gTreeData[j].tabs.splice(tab_position, 0, splicedTab[0]);
						}
						// Update Window's checkbox if needed
						if (!moving)
							this.updateWindowCheckbox(this.gTreeData[j]);
					}
					
					if (rows > 0) {
						// reindex remaining windows if removing window
						if (isWindow) {
							for (var k=pos+rows; k<this.gTreeData.length; k++) {
								if (this.treeView.isContainer(k)) this.gTreeData[k].ix--;
							}
						}
						
						// add/remove tab or remove window and its tabs and update the tree
						if (tabData) this.gTreeData.splice(pos, 0, tabData);
						else {
							var splicedTab = this.gTreeData.splice(pos - moving, rows);
							if (moving) this.gTreeData.splice(pos, 0, splicedTab[0]);
						}
						
						if (moving) {
							var start = (moving > 0) ? (pos - moving) : pos;
							var end = (moving > 0) ? pos : (pos - moving);
							this.treeView.treeBox.invalidateRange(start, end);
						}
						else this.gTabTree.treeBoxObject.rowCountChanged(pos, adding ? rows : -rows);
					}
				}
					
				switch(data[0]) {
					// If closing window or tab, need to delete it from gStateObject
					// If changing tabs, simply replace the old window state with the new one to make things simpler
					case "windowClose":
						this.gStateObject.windows.splice(i, 1);
						// clear out saved window and switch to "save" if window is saved since if it is, this is only called if window is closed
						if (this.oneWindow) {
							this.oneWindow = null;
							SessionIo.save();
						}
						break;
					case "TabClose":
						this.gStateObject.windows[i].tabs.splice(tab_position, 1);
						break;
					case "TabOpen":
					case "TabMove":
					case "locationChange":
					case "iconChange":
						this.gStateObject.windows[i] = new_window_state.windows[0];
						break;
				}
			}
			break;
		}
	},
	
	// User actions

	storeSession: function(aSaving) {
		// If saving make sure we have the most up to date session data
		if (aSaving) this.gStateObject = Utils.JSON_decode(this.oneWindow ? SessionStore.getWindowState(this.oneWindow) : SessionStore.getBrowserState());
	
		// remove all unselected tabs from the state before restoring it
		// remove all selected tabs from state when deleting
		var ix = this.gStateObject.windows.length - 1;
		for (var t = this.gTreeData.length - 1; t >= 0; t--) {
			if (this.treeView.isContainer(t)) {
				if (this.gTreeData[t].checked === 0) {
					// this window will be restored or deleted partially
					// remove window session name
					if (this.gStateObject.windows[ix].extData && this.gStateObject.windows[ix].extData["_sm_window_session_values"])
						delete this.gStateObject.windows[ix].extData["_sm_window_session_values"];
					// if deleting fix selected tab index if necessary
					if (this.gDeleting) {
						let selectedTab = this.gStateObject.windows[ix].selected;
						log(this.gStateObject.windows[ix].selected);
						this.gStateObject.windows[ix].selected -= this.gStateObject.windows[ix].tabs.filter(function(aTabData, aIx) 
							gSessionManagerSessionBrowser.gTreeData[t].tabs[aIx].checked && (aIx <= (selectedTab - 1))).length;
						log(this.gStateObject.windows[ix].selected);
					}
					// filter out checked/unchecked tabs
					this.gStateObject.windows[ix].tabs = (this.gDeleting) ?
						this.gStateObject.windows[ix].tabs.filter(function(aTabData, aIx) !gSessionManagerSessionBrowser.gTreeData[t].tabs[aIx].checked) :
						this.gStateObject.windows[ix].tabs.filter(function(aTabData, aIx) gSessionManagerSessionBrowser.gTreeData[t].tabs[aIx].checked);
				}
				else if (!this.gTreeData[t].checked && !this.gDeleting)
					// this window won't be restored at all
					this.gStateObject.windows.splice(ix, 1);
				else if (this.gTreeData[t].checked && this.gDeleting)
					// this window will be deleted
					this.gStateObject.windows.splice(ix, 1);
				ix--;
			}
		}
		return Utils.JSON_encode(this.gStateObject);
	},

	onTabTreeClick: function(aEvent) {
		// don't react to right-clicks
		if (aEvent.button == 2)
			return;

		var row = {}, col = {};
		this.treeView.treeBox.getCellAt(aEvent.clientX, aEvent.clientY, row, col, {});
		if (col.value) {
			// restore this specific tab in the same window for middle-clicking
			// or alt+clicking on a tab's title
			if (!this.gDeleting && (aEvent.button == 1 || aEvent.altKey) && ((col.value.id == "title") || (col.value.id == "location"))) {
				if (this.treeView.isContainer(row.value))
					this.restoreSingleWindow(row.value);
				else
					this.restoreSingleTab(row.value, aEvent.shiftKey);
			}
			else if (col.value.id == "restore")
				this.toggleRowChecked(row.value);
			else if (this.gSaving && !this.treeView.isContainer(row.value))
				this.populateSessionNameFromTabLabel(row.value);
		}
	},

	onTabTreeKeyDown: function(aEvent) {
		switch (aEvent.keyCode)
		{
		case KeyEvent.DOM_VK_SPACE:
			this.toggleRowChecked(this.gTabTree.currentIndex);
			break;
		case KeyEvent.DOM_VK_RETURN:
			var ix = this.gTabTree.currentIndex;
			if (aEvent.altKey) {
				if (this.treeView.isContainer(ix))
					this.restoreSingleWindow(ix);
				else
					this.restoreSingleTab(ix, aEvent.shiftKey);
			}
			else if (this.gSaving && !this.treeView.isContainer(ix)) {
				this.populateSessionNameFromTabLabel(ix);
			}
			// Don't submit if hit enter on tab tree
			aEvent.preventDefault();
			break;
		case KeyEvent.DOM_VK_UP:
		case KeyEvent.DOM_VK_DOWN:
		case KeyEvent.DOM_VK_PAGE_UP:
		case KeyEvent.DOM_VK_PAGE_DOWN:
		case KeyEvent.DOM_VK_HOME:
		case KeyEvent.DOM_VK_END:
			aEvent.preventDefault(); // else the page scrolls unwantedly
		break;
		}
	},

	onTabTreeSelection: function(aEvent) {
		var ix = this.gTabTree.currentIndex;
		if ((ix != -1) && this.treeView.isContainer(ix) && this.treeView.isContainerOpen(ix)) {
			if (this.gTabTree.view.selection.isSelected(ix))
				this.gTabTree.view.selection.rangedSelect(ix + 1, ix + this.gTreeData[ix].tabs.length, true);
			else
				this.gTabTree.view.selection.clearRange(ix + 1, ix + this.gTreeData[ix].tabs.length);
		}
	},
	
	// Helper functions
	
	isTabSelected: function(aIx) {
		if (gSessionManagerSessionBrowser.gSaving || gSessionManagerSessionBrowser.gDeleting)
			return false;
			
		var item = this.gTreeData[aIx];
		return (item.parent && (item.parent.selectedTab == aIx));
	},

	getBrowserWindow: function() {
		let win = null;
		if (window.opener) {
			// This will throw if opening window has been closed, so catch it
			try {
				win = window.opener.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebNavigation)
									 .QueryInterface(Ci.nsIDocShellTreeItem).rootTreeItem
									 .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
			}
			catch(ex) {}
		}
		return win;
	},

	checkAllNoneChecked: function() {
		function isChecked(aItem) aItem.checked;
		
		this.gAllTabsChecked = this.gTreeData.every(isChecked);
		gSessionManagerSessionPrompt.gAcceptButton.disabled = this.gNoTabsChecked = !this.gTreeData.some(isChecked);
		if (this.gSaving) gSessionManagerSessionPrompt.isAcceptable();
	},
	
	updateWindowCheckbox: function(aWindow) {
		function isChecked(aItem) aItem.checked;
		
		// update the window's checkmark as well (0 means "partially checked")
		aWindow.checked = aWindow.tabs.every(isChecked) ? true :
								aWindow.tabs.some(isChecked) ? 0 : false;
		this.treeView.treeBox.invalidateRow(this.gTreeData.indexOf(aWindow));
	},
	
	toggleRowChecked: function(aIx) {
		var item = this.gTreeData[aIx];
		item.checked = !item.checked && !item.isPrivate;
		this.treeView.treeBox.invalidateRow(aIx);

		function isChecked(aItem) aItem.checked;

		if (this.treeView.isContainer(aIx)) {
			let privateCount = 0;
			// (un)check all tabs of this window as well
			for (var tab of item.tabs) {
				if (tab.isPrivate) privateCount++;
				tab.checked = item.checked && !tab.isPrivate;
				this.treeView.treeBox.invalidateRow(this.gTreeData.indexOf(tab));
			}
			if (privateCount) {
				item.checked = (privateCount == item.tabs.length) ? false : 0;
			}
		}
		else {
			// update the window's checkmark as well (0 means "partially checked")
			this.updateWindowCheckbox(item.parent);
		}

		this.checkAllNoneChecked();
	},

	tabTreeSelect: function(aType) {

		function isChecked(aItem) { return aItem.checked; }

		for (var item of this.gTreeData) {
			// only act on window items
			if (item.tabs) {
				var numberChecked = 0;
				var windowIndex = this.gTreeData.indexOf(item);
				var windowSelected = !this.treeView.isContainerOpen(windowIndex) && this.gTabTree.view.selection.isSelected(windowIndex);
				for (var tab of item.tabs) {
					if ((aType != "TOGGLE") || windowSelected || this.gTabTree.view.selection.isSelected(this.gTreeData.indexOf(tab)))
						tab.checked =  !tab.isPrivate && ((aType == "TOGGLE") ? !tab.checked : (aType == "ALL"));
					if (tab.checked) numberChecked++;
				}
				// if not all checked set to 0 ("partially checked"), otherwise set to true or false.
				var check = (numberChecked == item.tabs.length) ? true : (!numberChecked ? false : 0);
				item.checked = check;
			}
		}
		this.checkAllNoneChecked();

		// update the whole tree view
		this.treeView.treeBox.invalidate();
	},

	restoreSingleWindow: function(aIx) {
		// only allow this is there is an existing window open.  Basically if it's not a prompt at browser startup.
		var win = this.getBrowserWindow();

		// If haven't opened any windows yet (startup or crash prompt), don't allow opening a new window
		let useWindow = false;
		if (!win) {
			if (SharedData._running) {
				win = Utils.getMostRecentWindow("navigator:browser");
				if (!win) {
					useWindow = true;
				}
			}
			else return;
		}

		// Tab Mix Plus's single window mode is enabled and we want to open a new window
		var TMP_SingleWindowMode = !useWindow && SharedData.tabMixPlusEnabled && PreferenceManager.get("extensions.tabmix.singleWindow", false, true)

		var item = this.gTreeData[aIx];
		var winState = { windows : new Array(1) };
		winState.windows[0] = this.gStateObject.windows[item.ix];

		// if Tab Mix Plus's single window mode is enabled and there is an existing window restores all tabs in that window
		SessionDataProcessing.restoreSession(TMP_SingleWindowMode && win, Utils.JSON_encode(winState), !TMP_SingleWindowMode, 
										 (PreferenceManager.get("save_closed_tabs") < 2), useWindow, TMP_SingleWindowMode, true);

		// bring current window back into focus
		setTimeout(function() { window.focus(); }, 1000);
	},

	restoreSingleTab: function(aIx, aShifted) {
		var win = this.getBrowserWindow() || Utils.getMostRecentWindow("navigator:browser");
		if (!win) return;
		var tabbrowser = win.gBrowser;
		var newTab = tabbrowser.addTab();
		var item = this.gTreeData[aIx];

		var tabState = this.gStateObject.windows[item.parent.ix].tabs[aIx - this.gTreeData.indexOf(item.parent) - 1];
		SessionStore.setTabState(newTab, Utils.JSON_encode(tabState));

		// respect the preference as to whether to select the tab (the Shift key inverses)
		if (Services.prefs.getBoolPref("browser.tabs.loadInBackground") != !aShifted)
			tabbrowser.selectedTab = newTab;
	},
	
	populateSessionNameFromTabLabel: function(aIx) {
		var name = Utils.getFormattedName(this.gTreeData[aIx].label, new Date());
		if (name) gSessionManagerSessionPrompt.populateDefaultSessionName(name, true);
	},

	// Tree controller

	treeView: {
		_atoms: {},
		_getAtom: function(aName)
		{
			if (!this._atoms[aName]) {
				var as = Cc["@mozilla.org/atom-service;1"].getService(Ci.nsIAtomService);
				this._atoms[aName] = as.getAtom(aName);
			}
			return this._atoms[aName];
		},

		treeBox: null,
		selection: null,

		get rowCount()                     { return gSessionManagerSessionBrowser.gTreeData.length; },
		setTree: function(treeBox)         { this.treeBox = treeBox; },
		getCellText: function(idx, column) { 
			if (column.id == "location") {
				if (gSessionManagerSessionBrowser.gTreeData[idx].sessionName && (gSessionManagerSessionBrowser.gTreeData[idx].checked == true)) 
					return gSessionManagerSessionBrowser.gTreeData[idx].sessionName;
				return gSessionManagerSessionBrowser.gTreeData[idx].url ? gSessionManagerSessionBrowser.gTreeData[idx].url : "";
			}
			else if (column.id == "hidden") 
				return gSessionManagerSessionBrowser.gTreeData[idx].hidden ? "     *" : "";
			else if (column.id == "tabgroup") 
				return gSessionManagerSessionBrowser.gTreeData[idx].groupName || "";
			else return gSessionManagerSessionBrowser.gTreeData[idx].label; 
		},
		isContainer: function(idx)         { return "open" in gSessionManagerSessionBrowser.gTreeData[idx]; },
		getCellValue: function(idx, column){ 
			if (this.isContainer(idx) && ((column.id == "title") || (column.id == "location"))) 
				return gSessionManagerSessionBrowser.gTreeData[idx].sessionName;
			else if (this.isContainer(idx) && (column.id == "tabgroup"))
				return gSessionManagerSessionBrowser.gTreeData[idx].sessionName
			else 
				return gSessionManagerSessionBrowser.gTreeData[idx].checked;
		},
		isContainerOpen: function(idx)     { return gSessionManagerSessionBrowser.gTreeData[idx].open; },
		isContainerEmpty: function(idx)    { return false; },
		isSeparator: function(idx)         { return false; },
		isSorted: function()               { return false; },
		isEditable: function(idx, column)  { return false; },
		getLevel: function(idx)            { return this.isContainer(idx) ? 0 : 1; },

		getParentIndex: function(idx) {
			if (!this.isContainer(idx))
				for (var t = idx - 1; t >= 0 ; t--)
					if (this.isContainer(t))
						return t;
			return -1;
		},

		hasNextSibling: function(idx, after) {
			var thisLevel = this.getLevel(idx);
			for (var t = after + 1; t < gSessionManagerSessionBrowser.gTreeData.length; t++)
				if (this.getLevel(t) <= thisLevel)
					return this.getLevel(t) == thisLevel;
			return false;
		},

		toggleOpenState: function(idx) {
			var toinsert;
			if (!this.isContainer(idx))
				return;
			var item = gSessionManagerSessionBrowser.gTreeData[idx];
			if (item.open) {
				// remove this window's tab rows from the view
				var thisLevel = this.getLevel(idx);
				for (var t = idx + 1; t < gSessionManagerSessionBrowser.gTreeData.length && this.getLevel(t) > thisLevel; t++);
				var deletecount = t - idx - 1;
				gSessionManagerSessionBrowser.gTreeData.splice(idx + 1, deletecount);
				this.treeBox.rowCountChanged(idx + 1, -deletecount);
			}
			else {
				// add this window's tab rows to the view
				toinsert = gSessionManagerSessionBrowser.gTreeData[idx].tabs;
				for (var i = 0; i < toinsert.length; i++)
					gSessionManagerSessionBrowser.gTreeData.splice(idx + i + 1, 0, toinsert[i]);
				this.treeBox.rowCountChanged(idx + 1, toinsert.length);
			}
			item.open = !item.open;
			this.treeBox.invalidateRow(idx);
			// select tabs if window selected and just opened
			if (item.open && this.selection.isSelected(idx))
				this.selection.rangedSelect(idx + 1, idx + toinsert.length, true);
		},
		
		setProperty: function(prop, value) {
			if (prop) {
				prop.AppendElement(this._getAtom(value));
				return "";
			}
			else
				return " " + value;
		},

		getCellProperties: function(idx, column, prop) {
			let property = "";
			if (column.id == "restore" && this.isContainer(idx) && gSessionManagerSessionBrowser.gTreeData[idx].checked === 0)
				property += this.setProperty(prop,"partial");
			if (column.id == "title") {
				if (this.isContainer(idx))
					property += this.setProperty(prop,"window");
				else
					property += this.setProperty(prop,this.getImageSrc(idx, column) ? "icon" : "noicon");
			}
			if (this.isContainer(idx) && ((column.id == "title") || (column.id == "location")) && this.getCellValue(idx, column))
				property += this.setProperty(prop,"sessionName");
			if (!this.isContainer(idx) && gSessionManagerSessionBrowser.isTabSelected(idx))
				property += this.setProperty(prop,"selectedTab");
			if (this.getCellText(idx, this.treeBox.columns.getColumnFor(document.getElementById("hidden"))))
				property += this.setProperty(prop,"disabled");
			if (!this.isContainer(idx) && gSessionManagerSessionBrowser.gTreeData[idx].isPrivate)
				property += this.setProperty(prop,"private");
				
			return property;
		},

		getImageSrc: function(idx, column) {
			if (column.id == "title")
				return gSessionManagerSessionBrowser.gTreeData[idx].src || null;
			return null;
		},

		initialize: function() {
			var count;
			if (gSessionManagerSessionBrowser.gTreeData) count = this.rowCount;
			delete gSessionManagerSessionBrowser.gTreeData;
			gSessionManagerSessionBrowser.gTreeData = [];
			if (this.treeBox && count)
				this.treeBox.rowCountChanged(0, -count);
		},

		getProgressMode : function(idx, column) { },
		cycleHeader: function(column) { },
		cycleCell: function(idx, column) { },
		selectionChanged: function() { },
		performAction: function(action) { },
		performActionOnCell: function(action, index, column) { },
		getColumnProperties: function(column, prop) {},
		getRowProperties: function(idx, prop) {}
	}
}

// Add event listener to clean up observers
window.addEventListener("unload", gSessionManagerSessionBrowser.onUnload_proxy, false);
