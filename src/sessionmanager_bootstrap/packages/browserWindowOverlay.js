"use strict";

// import the browser modules into the namespace
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

var australis = false;
try {
  Components.utils.import("resource:///modules/CustomizableUI.jsm");
  australis = true;
}
catch(ex) {}

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "isLoggingState", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "gSessionManager", "chrome://sessionmanager/content/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionConverter", "chrome://sessionmanager/content/modules/session_convert.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionDataProcessing", "chrome://sessionmanager/content/modules/session_data_processing.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");
XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 

// Observers to register for per window. 
const WIN_OBSERVING = ["sessionmanager:update-undo-button", "sessionmanager:updatetitlebar", "sessionmanager:initial-windows-restored",
											 "sessionmanager:save-tab-tree-change", "sessionmanager:close-windowsession", "sessionmanager:nsPref:changed", 
											 "browser:purge-session-history", "sessionmanager:shared-data-tmp-set", "sessionmanager:reopen-tab",
											 "sessionmanager:last-window-closed", "sessionmanager:update-window-session", "sessionmanager:restoring-window",
											 "sessionmanager:toolbar-button-added", "quit-application-granted", "domwindowclosed"];

// True if "_id" ends in "_window"
function isOneWindow(aEvent) {
	// Get true event source - needed for menuitems that use "command" attribute
	let sourceEvent = aEvent.sourceEvent || aEvent;
	return (sourceEvent.target.getAttribute("_id").substr(-7) == "_window");
}

// True if "_id" starts in "abandon"
function isAbandon(aEvent) {
	// Get true event source - needed for menuitems that use "command" attribute
	let sourceEvent = aEvent.sourceEvent || aEvent;
	return (sourceEvent.target.getAttribute("_id").substring(0,7) == "abandon");
}

// True if "_id" ends in "_replace"
function isReplace(aEvent) {
	// Get true event source - needed for menuitems that use "command" attribute
	let sourceEvent = aEvent.sourceEvent || aEvent;
	return (sourceEvent.target.getAttribute("_id").substr(-8) == "_replace");
}

// Listener for changes to tabs - See https://developer.mozilla.org/En/Listening_to_events_on_all_tabs
// Only care about location and favicon changes
// This is only registered when tab tree is visible in session prompt window while saving
var tabProgressListener = {

	findTabIndexForBrowser: function(aBrowser) {
		// Check each tab of this browser instance
		let gBrowser = aBrowser.getTabBrowser();
		for (var index = 0; index < gBrowser.browsers.length; index++) {
			if (aBrowser == gBrowser.getBrowserAtIndex(index)) return index;
		}
		return null;
	},
	
	// Interface functions
	onLocationChange: function(aBrowser, webProgress, request, location) {
		var index = this.findTabIndexForBrowser(aBrowser);
		if (index != null) Services.obs.notifyObservers(aBrowser.ownerDocument.defaultView, "sessionmanager:update-tab-tree", "locationChange " + index);
	},
	
	onLinkIconAvailable: function(aBrowser) {
		var index = this.findTabIndexForBrowser(aBrowser);
		if (index != null) Services.obs.notifyObservers(aBrowser.ownerDocument.defaultView, "sessionmanager:update-tab-tree", "iconChange " + index + " " +
													(aBrowser.mIconURL ? encodeURIComponent(aBrowser.mIconURL) : null));
	},

	onProgressChange: function() {},
	onSecurityChange: function() {},
	onStateChange: function() {},
	onStatusChange: function() {},
	onRefreshAttempted: function() { return true; }
};

// Listener to detect load progress for browser.  Used to trigger cache bypass when loading sessions
var tabbrowserProgressListener = {
	QueryInterface: function(aIID)
	{
		if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
				aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
				aIID.equals(Components.interfaces.nsISupports))
			return this;
		throw Components.results.NS_NOINTERFACE;
	},

	onStateChange: function(aWebProgress, aRequest, aFlag, aStatus)
	{
		let wpl = Components.interfaces.nsIWebProgressListener;

		// If load starts, bypass cache.  If network stops removes listener (this should handle all cases
		// such as closing tab/window, stopping load or changing url).
		if (aFlag & wpl.STATE_START)
		{
			// Force load to bypass cache
			aRequest.loadFlags = aRequest.loadFlags | aRequest.LOAD_BYPASS_CACHE;
		}
		else if ((aFlag & wpl.STATE_STOP) && (aFlag & wpl.STATE_IS_NETWORK)) {
			// remove listener
			try {
				aWebProgress.removeProgressListener(this);
			} catch(ex) { logError(ex); }
		}
	},

	onLocationChange: function(aProgress, aRequest, aURI) { },
	onProgressChange: function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) { },
	onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) { },
	onSecurityChange: function(aWebProgress, aRequest, aState) { }
};

//				
// Event Handler Functions
//
var SessionManagerEventHandlers = {

	/* ........ Menu/Toolbar action Functions .............. */
	
	abandonSession: function(aEvent) {
		return gSessionManager.abandonSession(isOneWindow(aEvent) ? aEvent.view : null);
	},
	
	cleanMenu: function(aEvent) {
		Utils.runAsync(function() { this.cleanMenu2(aEvent); }.bind(SessionManagerEventHandlers));
	},
	
	cleanMenu2: function(aEvent) {
		function get_(a_id) { return aEvent.target.getElementsByAttribute("_id", a_id)[0] || null; }

		let closed_separator = get_("closed-separator");
		let separator = get_("separator");
		let startSep = get_("start-separator");
		let backupMenu = get_("backup-menu");
		let deletedMenu = get_("deleted-menu");
				
		if (startSep) {
			let popup = startSep.parentNode;
			for (let item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
				popup.removeChild(item);
				
			let backupPopup = backupMenu.menupopup || backupMenu.firstChild; 
			while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
			
			// Delete items from end to start in order to not delete the two fixed menu items.
			let deletedPopup = deletedMenu.menupopup || deletedMenu.firstChild;
			while (deletedPopup.childNodes.length > 2) deletedPopup.removeChild(deletedPopup.childNodes[deletedPopup.childNodes.length - 1]);
			
			let undoMenu = get_("undo-menu");
			while (popup.lastChild != undoMenu)
				popup.removeChild(popup.lastChild);
		}

		if (closed_separator) {
			let popup = closed_separator.parentNode;
			let label = get_("windows");
			let listEnd = get_("end-separator");
			
			for (let item = closed_separator.previousSibling; item != label; item = closed_separator.previousSibling)
				popup.removeChild(item);
				
			for (let item = closed_separator.nextSibling.nextSibling; item != listEnd; item = closed_separator.nextSibling.nextSibling)
				popup.removeChild(item);
		}
	},

	clearUndoListPrompt: function(event) {
		// Get true event source - needed for menuitems that use "command" attribute
		let sourceEvent = event.sourceEvent || event;
		let id = sourceEvent.target.getAttribute("_id")
		return Utils.clearUndoListPrompt((id == "clear_windows") ? "window" : ((id == "clear_tabs") ? "tab" : ""));
	},
	
	clickSessionManagerMenu: function(event) {
		return gSessionManager.clickSessionManagerMenu(event);
	},
	
	closeSession: function(aEvent) {
		return SessionIo.closeSession(isOneWindow(aEvent) ? aEvent.view : null);
	},
	
	commandSessionManagerMenu: function(event) {
		// Get true event source - needed for menuitems that use "command" attribute
		return gSessionManager.commandSessionManagerMenu(event.sourceEvent || event);
	},
	
	deleted_session_delete: function(aEvent) {
		return gSessionManager.deleted_session_delete(aEvent.view);
	},
	
	emptyTrash: function() {
		return SessionIo.emptyTrash();
	},
	
	getClosedTabCount: function(aWindow) {
		return SessionStore.getClosedTabCount(aWindow);
	},
	
	group: function() {
		return SessionIo.group();
	},
	
	group_remove: function(aEvent) {
		return gSessionManager.group_remove(aEvent.view);
	},
	
	group_rename: function(aEvent) {
		return gSessionManager.group_rename(aEvent.view);
	},
	
	group_popupInit: function(aEvent) {
		return gSessionManager.group_popupInit(aEvent.target);
	},
	
	init: function(aEvent) {
		return gSessionManager.init(aEvent.target);
	},
	
	initUndo: function(aEvent) {
		return gSessionManager.initUndo(aEvent.target, true);
	},
	
	load: function(aEvent) {
		return SessionIo.load(aEvent.view);
	},
	
	openFolder: function() {
		return gSessionManager.openFolder();
	},
	
	openOptions: function() {
		return gSessionManager.openOptions();
	},
	
	openSessionExplorer: function() {
		return gSessionManager.openSessionExplorer();
	},
	
	remove: function() {
		return SessionIo.remove();
	},
	
	removeUndoMenuItem: function(aEvent) {
		return gSessionManager.removeUndoMenuItem(aEvent.view.document.popupNode);
	},
	
	rename: function() {
		return SessionIo.rename();
	},
	
	save: function(aEvent) {
		return SessionIo.save(aEvent.view, null, null, null, aEvent.shiftKey);
	},

	saveKBShortcut: function(aEvent) {
		return SessionIo.save(aEvent.view, null, null, null, false);
	},
	
	saveWindow: function(aEvent) {
		return SessionIo.saveWindow(aEvent.view);
	},
	
	session_close: function(aEvent) {
		return gSessionManager.session_close(aEvent.view, isOneWindow(aEvent), isAbandon(aEvent));
	},
	
	session_load: function(aEvent) {
		return gSessionManager.session_load(aEvent.view, isReplace(aEvent), isOneWindow(aEvent));
	},
	
	session_remove: function(aEvent) {
		return gSessionManager.session_remove(aEvent.view);
	},
	
	session_rename: function(aEvent) {
		return gSessionManager.session_rename(aEvent.view);
	},
	
	session_replace: function(aEvent) {
		return gSessionManager.session_replace(aEvent.view, isOneWindow(aEvent));
	},
	
	session_popupInit: function(aEvent) {
		return gSessionManager.session_popupInit(aEvent.target);
	},
	
	session_setStartup: function(aEvent) {
		return gSessionManager.session_setStartup(aEvent.view);
	},
	
	undoTooltipShowing: function(aEvent) {
		let tooltip = aEvent.target;
		let name = null;
		let url = null;
		if (SessionStore.getClosedTabCount(aEvent.view)) {
			let closedTabs = SessionStore.getClosedTabData(aEvent.view);
			closedTabs = Utils.JSON_decode(closedTabs);
			name = closedTabs[0].title
			url = closedTabs[0].state.entries[closedTabs[0].state.entries.length - 1].url;
		}
		if (name) {
			tooltip.childNodes[1].value = name;
			tooltip.childNodes[1].hidden = false;
			
			if (url) {
				tooltip.childNodes[2].value = url;
				tooltip.childNodes[2].hidden = false;
				aEvent.view.XULBrowserWindow.setOverLink(url);
			}
			else 
				tooltip.childNodes[2].hidden = true;
		}
		else {
			tooltip.childNodes[1].hidden = true;
			tooltip.childNodes[2].hidden = true;
		}
	}
};

exports.loadBrowserWindow = function(window, overlay) {
	var SessionManagerWindow = {
		// SessionManager Window ID
		__SessionManagerWindowId: null,
		
		// timers
		_win_timer : null,

		// window state
		_backup_window_session_data: null,
		__window_session: {
			filename: null,
			name: null,
			group: null,
			time: 0
		},
    mClosingAutoWindowState: null,
    mTempClosingWindowState: null,
		mTempCleanBrowser: null,
		mClosingWindowState: null,
		mCleanBrowser: null,
		mClosedWindowName: null,
		
		// true if browser window.
		isBrowser: false,  
		
		// For retry reading window.__SSi value
		grabSsiCount: 0,
		
		// Preference stuff
		currentStartupValue: 0,
		
	/* ........ Observers .............. */

		observe: function(aSubject, aTopic, aData)
		{
			log("Window " + window.__SSi + " observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
			switch (aTopic)
			{
			case "sessionmanager:nsPref:changed":
				switch (aData)
				{
				case "click_restore_tab":
					this.watchForMiddleMouseClicks();
					break;
				case "hide_tools_menu":
				case "show_icon_in_menu":
					this.showHideToolsMenu();
					break;
				case "reload":
					if (PreferenceManager.get("reload")) {
						window.gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					}
					else {
						window.gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					}
					break;
				case "max_closed_undo":
				case "use_SS_closed_window_list":
					this.updateUndoButton();
					break;
				case "do_not_color_toolbar_button":
					this.updateToolbarButton();
					break;
				case "session_name_in_titlebar":
					this.hideShowTitleBarLabel();
					break;
				case "_autosave_values":
					window.gBrowser.updateTitlebar();
					this.updateToolbarButton();
					this.hideShowTitleBarLabel();
					break;
				case "display_menus_in_submenu":
					this.updateMenus();
					break;
				case "keys":
					this.setKeys(true);
					break;
				}
				break;
			case "sessionmanager:shared-data-tmp-set":
				this.watchForMiddleMouseClicks();
				break;
			case "sessionmanager:save-tab-tree-change":
				// The "load" event won't fire for cached pages where the favicon doesn't change. For example going back and forth on Google's site pages.
				// Using addTabsProgressListener instead of "load" works in this case.  It doesn't return the tab, but we can easily get it by
				// searching all tabs to find the one that contains the event's target (getBrowserForTab()).  
				// Since this is slower, than the "load" method only do it if save window's tab tree is visible.
				switch (aData) {
					case "open":
						window.gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
						window.gBrowser.tabContainer.addEventListener("PrivateTab:PrivateChanged", this.onTabMove, false); // For Private Tab Add-on
						window.gBrowser.addTabsProgressListener(tabProgressListener);
						// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
						if (Services.appinfo.name == "Firefox")
							window.addEventListener("tabviewhidden", this.onTabViewHidden, false);
						break;
					case "close":
						window.gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false);
						window.gBrowser.tabContainer.removeEventListener("PrivateTab:PrivateChanged", this.onTabMove, false); // For Private Tab Add-on
						window.gBrowser.removeTabsProgressListener(tabProgressListener);
						// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
						if (Services.appinfo.name == "Firefox")
							window.removeEventListener("tabviewhidden", this.onTabViewHidden, false);
						break;
				}
				break;
			case "sessionmanager:last-window-closed":
				this.lastWindowClosing();
				break;
			case "sessionmanager:close-windowsession":
				// notification will either specify specific window session name or be null for all window sessions
				if (this.__window_session.filename && (!aData || (this.__window_session.filename == aData))) {
					let abandon = aSubject.QueryInterface(Components.interfaces.nsISupportsPRBool).data;
					log("Window observer: " + (abandon ? "Abandoning" : "Closing") + " window session " + this.__window_session.filename, "INFO");
					if (abandon) {
						gSessionManager.abandonSession(window);
					}
					else {
						SessionIo.closeSession(window);
					}
				}
				break;
			case "sessionmanager:initial-windows-restored":
				// If browser just started or upgraded/downgraded, then restore window sessions that were active
				// otherwise make sure the window session window values are deleted
				if (SharedData.justStartedUpDowngraded)
					this.restoreWindowSession();
				else
					Utils.getAutoSaveValues(null, window);
				// Update toolbar button in case auto/window session restored on crash
				this.updateToolbarButton();
				break;
			case "sessionmanager:reopen-tab":
				if (window == aSubject)
					this.undoCloseTab(aData)
				break;
			case "sessionmanager:update-undo-button":
				// only update all windows if window state changed.
				let values = JSON.parse(aData);
				if (!values || (values.type != "tab") || (window == aSubject))
					Utils.runAsync(function() { SessionManagerWindow.updateUndoButton(values ? values.value : null); });
				break;
			case "sessionmanager:updatetitlebar":
				if (!aSubject || aSubject == window) {
					window.gBrowser.updateTitlebar();
					this.updateToolbarButton();
				}
				break;
			case "sessionmanager:toolbar-button-added":
				if (!aSubject || aSubject == window)
					this.tweakToolbarTooltips(null, aData);
				break;
			case "sessionmanager:update-window-session":
				if (aSubject == window)
					this.updateWindowSession(aData);
				else if (!aSubject)
					this.changeWindowSession(aData);
				break;
			case "browser:purge-session-history":
				this.updateUndoButton(false);
				break;
      case "domwindowclosed":
        // If this is an auto-save window or using our own closed window list, save the closing window state to work around Firefox bug 1255578
        if (this.__window_session.filename || !PreferenceManager.get("use_SS_closed_window_list")) {
          this.mClosingAutoWindowState = SessionDataProcessing.getSessionState(null, window, null, null, null, true); 
          if (!PreferenceManager.get("use_SS_closed_window_list")) {
            this.mTempCleanBrowser = Array.every(window.gBrowser.browsers, gSessionManager.isCleanBrowser);
          } else {
            this.mTempCleanBrowser = null;
          }
        } else {
          this.mClosingAutoWindowState = null;
          this.mTempCleanBrowser = null;
        }
				break;
			case "quit-application-granted":
				// Copy window state to module
				SharedData.mClosingWindowState = this.mClosingWindowState;
				
				// Call unload manually to make sure window sessions get saved
				this.onUnload(false);
				break;
			// timer periodic call
			case "timer-callback":
				// save window session if open, but don't close it
				log("Timer callback for window timer", "EXTRA");
				SessionIo.closeSession(window, false, true);
				break;
			case "sessionmanager:restoring-window":
				if (aSubject == window) {
					// Store window session values into window value and also into window variables
					if (!this.__window_session.filename) {
						// Backup _sm_window_session_values first in case we want to restore window sessions from non-window session.
						// For example, in the case of loading the backup session at startup.
						this._backup_window_session_data = SessionStore.getWindowValue(window,"_sm_window_session_values");
						log("observe: Removed window session name from window: " + this._backup_window_session_data, "DATA");
						Utils.getAutoSaveValues(aData, window);
					}
					log("observe: restore done, window_name  = " + this.__window_session.filename, "DATA");
					// Save session manager window value for aWindow since it will be overwritten on load.  Other windows opened will have the value set correctly.
					if (("__SSi" in window)) {
						this.__SessionManagerWindowId = window.__SSi;
						SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
					}
				}
				break;
			}
		},
		
	/* ........ Window Listeners .............. */
		
		// Only load the window if not the hidden window and SessionStart is ready (Firefox)
		onLoadCheck: function() {
			log("OnLoadCheck start for " + window.location,"TRACE");
			
			this.updateMenus(true);
			this.setKeys(false);
			
			// Don't process for non-browser windows
			if ((window.location == "chrome://browser/content/browser.xul") || 
			    (window.location == "chrome://navigator/content/navigator.xul")) {
				
				// Clear any stored closing windos state data
				SharedData.mClosingWindowState = null;
				
				// Set whether Tab Groups (addon or built in) exists or not.
				SharedData.panoramaExists = SharedData.tabGroupsEnabled || ("TabView" in window);
				
				let sessionStartup = Utils.SessionStartup;
		
				// onceInitialized only exists in Firefox where we need to wait in case the browser crashed and we put up 
				// the crash prompt.  Only do this for the first browser window and only when private browsing isn't autostarting since SessionStore never
				// initializes in that case.
				if (!SharedData._browserWindowDisplayed && !SharedData._running && !Utils.isAutoStartPrivateBrowserMode() && sessionStartup && sessionStartup.onceInitialized) {
					log("Waiting for sessionStartup to initialize", "INFO");
					this.hideMenusandButton();
					
					sessionStartup.onceInitialized.then(
						SessionManagerWindow.onLoadDelayed.bind(SessionManagerWindow)
					);
				} 
				else {
					this.onLoad();
				}
			}
		},
		
		hideMenusandButton: function() {
			let sessionButton = window.document.getElementById("sessionmanager-toolbar");
			let undoButton = window.document.getElementById("sessionmanager-undo");
			let sessionMenu = window.document.getElementById("sessionmanager-menu");
			if (sessionButton) sessionButton.hidden = true;
			if (undoButton) undoButton.hidden = true;
			if (sessionMenu) sessionMenu.hidden = true;
		},
		
		// This is needed because in Firefox, after a crash a browser window opens and we don't want Session Manager to attach to it 
		// until after SessionStart finishes reading the crashed session data.
		onLoadDelayed: function() {
			let sessionButton = window.document.getElementById("sessionmanager-toolbar");
			let undoButton = window.document.getElementById("sessionmanager-undo");
			let sessionMenu = window.document.getElementById("sessionmanager-menu");
			if (sessionButton) sessionButton.hidden = false;
			if (undoButton) undoButton.hidden = false;
			if (sessionMenu) sessionMenu.hidden = false;
			
			this.onLoad();
		},
		
		onLoad: function() {
			log("onLoad Window start, window = " + window.document.title, "TRACE");

			// This is a browser window
			this.isBrowser = true;
			
			// Set the flag indicating that a browser window displayed
			SharedData._browserWindowDisplayed = true;
			
			// Do TweakToolbartips for initial load and add event listeners in the case user adds toolbar later
			this.tweakToolbarTooltips();
			
			// Add an event listener to check if user finishes customizing the toolbar so we can tweak the button tooltips.
			if (!australis)
				window.addEventListener("aftercustomization", this.tweakToolbarTooltips, false);

			// If the shutdown on last window closed preference is not set, set it based on the O/S.
			// Enable for Macs, disable for everything else
			if (!PreferenceManager.has("shutdown_on_last_window_close")) {
				if (/mac/i.test(window.navigator.platform)) {
					PreferenceManager.set("shutdown_on_last_window_close", true);
				}
				else {
					PreferenceManager.set("shutdown_on_last_window_close", false);
				}
			}
		
			WIN_OBSERVING.forEach(function(aTopic) {
				Services.obs.addObserver(this, aTopic, false);
			}, this);
			window.gBrowser.addEventListener("DOMContentLoaded", this.onPageLoad, true);
			window.gBrowser.tabContainer.addEventListener("TabClose", this.onTabOpenClose, false);
			window.gBrowser.tabContainer.addEventListener("TabOpen", this.onTabOpenClose, false)
			if (PreferenceManager.get("reload")) {
				window.gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			}
			// If saving tab tree currently open, add event listeners
			if (SharedData.savingTabTreeVisible) {
				window.gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
				window.gBrowser.tabContainer.addEventListener("PrivateTab:PrivateChanged", this.onTabMove, false); // For Private Tab Add-on
				window.gBrowser.addTabsProgressListener(tabProgressListener);
				// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
				if (Services.appinfo.name == "Firefox")
					window.addEventListener("tabviewhidden", this.onTabViewHidden, false);
			}
					
			// Hide Session Manager toolbar item if option requested
			this.showHideToolsMenu();
			
			// If in permanent private browsing, gray out session manager toolbar icon
			if (Utils.isAutoStartPrivateBrowserMode()) {
				var button = window.document.getElementById("sessionmanager-toolbar");
				if (button) button.setAttribute("private", "true"); 
			}
			
			// Undo close tab if middle click on tab bar - only do this if Tab Clicking Options
			// or Tab Mix Plus are not installed.
			log("Tab Mix Plus is " + SharedData.tabMixPlusEnabled, "EXTRA");
			this.watchForMiddleMouseClicks();

			// Handle restoring sessions do to crash, prompting, pre-chosen session, etc
			gSessionManager.recoverSession(window);
			Utils.runAsync(function() { SessionManagerWindow.updateUndoButton(); });
			
			// Tell Session Manager Helper Component that it's okay to restore the browser startup preference if it hasn't done so already
			Services.obs.notifyObservers(null, "sessionmanager:restore-startup-preference", null);
			
			// Update other browsers toolbars in case this was a restored window
			if (PreferenceManager.get("use_SS_closed_window_list")) {
				Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			if (!SharedData._running)
			{
				// make sure that the _running value is true
				SharedData._running = true;
			
				// If backup file is temporary, then delete it
				try {
					if (PreferenceManager.get("backup_temporary", true)) {
						PreferenceManager.set("backup_temporary", false);
						SessionIo.delFile(SessionIo.getSessionDir(Constants.BACKUP_SESSION_FILENAME));
					}
				} catch (ex) { logError(ex); }

				// If we did a temporary restore, set it to false			
				if (PreferenceManager.get("restore_temporary"))
					PreferenceManager.set("restore_temporary", false);

				// Force saving the preferences
				Services.obs.notifyObservers(null,"sessionmanager-preference-save",null);
			}
			
			// Watch for changes to the titlebar so we can add our sessionname after it since 
			// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
			// Don't watch for private windows since they will never be autosave or window sessions
			if (!Utils.isPrivateWindow(window))
				window.gBrowser.ownerDocument.watch("title", this.updateTitlebar);
			window.gBrowser.updateTitlebar();
			
			// Show the unhide the Session Manager titlebar label if user specifies
			this.hideShowTitleBarLabel();
			
			// add call to gSessionManager_Sanitizer (code take from Tab Mix Plus)
			// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
			// where the user disabled option to prompt before clearing data.  This is only needed in SeaMonkey
			// because Firefox always puts up a prompt when using the "Clear ..." menu item.
			let cmd = window.document.getElementById("Tools:Sanitize");
			if (cmd && (Services.appinfo.name == "SeaMonkey")) 
				cmd.addEventListener("command", gSessionManager.tryToSanitize, false);
			
			// Clear current window value setting if shouldn't be set.  Need try catch because first browser window will throw an exception.
			// As such window session value in first browser window won't be backed up or it's window value cleared, but that's 
			// okay because if session is loaded, it will get cleared then and if browser is restoring session it should be loaded (and it will).
			try {
				if (!this.__window_session.filename) {
					// Remove window session. Backup _sm_window_session_values first in case this is actually a restart or crash restore 
					if (!this._backup_window_session_data) 
						this._backup_window_session_data = SessionStore.getWindowValue(window,"_sm_window_session_values");
					log("onLoad: Removed window session name from window: " + this._backup_window_session_data, "DATA");
					if (this._backup_window_session_data) 
						Utils.getAutoSaveValues(null, window);
				}
			} catch(ex) {}
			
			// Put up one time message after upgrade if it needs to be displayed - only done for one window
			if (SharedData._displayUpdateMessage) {
				let url = SharedData._displayUpdateMessage;
				delete(SharedData._displayUpdateMessage);
				window.setTimeout(function() {
					window.gBrowser.selectedTab = window.gBrowser.addTab(url);
				},100);
			}
			
			// Keep track of opening windows on browser startup
			if (SharedData._countWindows) {
				Services.obs.notifyObservers(null, "sessionmanager:window-loaded", null);
			}

			// Store a window id from SessionStore's __SSi value for use when saving sessions. If not available yet, run Async.
			// Use the SessionStore __SSi value which exists for all window.
			if (window.__SSi) this.grabSSI();
			else Utils.runAsync(this.grabSSI.bind(this), this);
			
			log("onLoad Window end", "TRACE");
		},
		
		// Keep trying to grab SSi if it doesn't exist (give up after 5 tries)
		// ToDo: Replace using SSI with our own value
		grabSSI: function() {
			if (!window.__SSi && this.grabSsiCount < 5) {
				this.grabSsiCount++;
				log("grabSSI retry count " + this.grabSsiCount, "EXTRA");
				Utils.runAsync(this.grabSSI.bind(this), this);
			}
			else {
				this.__SessionManagerWindowId = window.__SSi;
				SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
				
				// Update tab tree if it's open and window is not private
				if (SharedData.savingTabTreeVisible && !Utils.isPrivateWindow(window)) {
					Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "windowOpen " + this.__SessionManagerWindowId);
				}
			}
		},

		// aDisableUninstall is set when add-on is being disabled/uninstalled, otherwise window is closing
		onUnload: function(aDisableUninstall)
		{
			log("onUnload Window start, aDisableUninstall = " + aDisableUninstall, "TRACE");
			if (aDisableUninstall) {
				// Remove all observers, events and watchers
				this.removeEventsObservers();
				
				// If there is an active window session, stop the timer
				if (this._win_timer) {
					this._win_timer.cancel();
					this._win_timer = null;
				}
			}
			else {
				
				let allWindows = Utils.getBrowserWindows();
				let numWindows = allWindows.length;
				log("onUnload: numWindows = " + numWindows, "DATA");
				
				this.removeEventsObservers();
				
				this.windowClosed();
								
				// This executes whenever the last browser window is closed (either manually or via shutdown).
				if (SharedData._running && numWindows == 0)
				{
					// Copy window data to module in case it's needed during shutdown
					SharedData.mClosingWindowState = this.mClosingWindowState;
				
					SharedData._screen_width = window.screen.width;
					SharedData._screen_height = window.screen.height;
					
					SharedData.mTitle += " - " + window.document.getElementById("bundle_brand").getString("brandFullName");

					// This will run the shutdown processing if the preference is set and the last browser window is closed manually
					if (PreferenceManager.get("shutdown_on_last_window_close") && !SharedData._stopping) {
						this.mClosingWindowState = null;
						this.mCleanBrowser = null;
						this.mClosedWindowName = null;
						gSessionManager.shutDown();
						// Don't look at the session startup type if a new window is opened without shutting down the browser.
						SharedData.mAlreadyShutdown = true;
					}
					else {
						// Close any open autosave sessions since there's no windows left.
						SessionIo.closeSession(false);
					}
				}
				
				// Update tab tree if it's open
				if (SharedData.savingTabTreeVisible) 
					Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "windowClose " + this.__SessionManagerWindowId);
			}
			
			log("onUnload Window end", "TRACE");
		},
		
		removeEventsObservers: function() {
			log("removeEventsObservers start", "TRACE");
			WIN_OBSERVING.forEach(function(aTopic) {
				try{
					Services.obs.removeObserver(this, aTopic);
				} catch(ex) {};
			}, this);
			
			if (!australis)
				window.removeEventListener("aftercustomization", this.tweakToolbarTooltips, false);

			// Remomving events that weren't added doesn't hurt anything so remove all possible events.
			window.gBrowser.removeEventListener("DOMContentLoaded", this.onPageLoad, true);
			window.gBrowser.tabContainer.removeEventListener("TabClose", this.onTabOpenClose, false);
			window.gBrowser.tabContainer.removeEventListener("TabOpen", this.onTabOpenClose, false);
			window.gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false)
			window.gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			window.gBrowser.tabContainer.removeEventListener("click", this.onTabBarClick, true);
			window.gBrowser.tabContainer.removeEventListener("PrivateTab:PrivateChanged", this.onTabMove, false); // For Private Tab Add-on
			// Only remove this event in Firefox
			if (Services.appinfo.name == "Firefox")
				window.removeEventListener("tabviewhidden", this.onTabViewHidden, false);
			// SeaMonkey 2.1 throws an exception on this if not listening so catch it
			try {
				window.gBrowser.removeTabsProgressListener(tabProgressListener);
			} catch(ex) {}

			// stop watching for titlebar changes
			window.gBrowser.ownerDocument.unwatch("title");
			
			// Remove event listener from sanitize command
			let cmd = window.document.getElementById("Tools:Sanitize");
			if (cmd && (Services.appinfo.name == "SeaMonkey")) 
				cmd.removeEventListener("command", gSessionManager.tryToSanitize, false);
		},

		// This is called when the last browser window closes so that Session Manager can temporarily save the browser state before the windows close
		// and the window gets moved to the closed window list.  It also grabs the window state and name for when using Session Manager's closed window list.
		lastWindowClosing: function() {
			log("lastWindowClosing start", "TRACE");
			try {
				// Store closing state if it will be needed later
				this.mClosingWindowState = SessionDataProcessing.getSessionState(null, window, null, null, null, true); 
				if (isLoggingState()) log(this.mClosingWindowState, "STATE");
				// Only need to save closed window data is not using browser's closed window list
				if (!PreferenceManager.get("use_SS_closed_window_list")) {
					this.mCleanBrowser = Array.every(window.gBrowser.browsers, gSessionManager.isCleanBrowser);
					this.mClosedWindowName = Utils.getCurrentTabTitle(window) || 
              (((window.gBrowser.currentURI.spec != "about:blank") || (window.gBrowser.currentURI.spec != "about:newtab")) ? window.gBrowser.currentURI.spec : Utils._string("untitled_window"));
				}
				else {
					this.mCleanBrowser = null;
					this.mClosedWindowName = null;
				}
			}
			catch(ex) { 
				logError(ex); 
			}
			
			log("lastWindowClosing end", "TRACE");
		},

		windowClosed: function()
		{
			log("windowClosed " + (window.__SSi || this.__SessionManagerWindowId) + " start", "TRACE");
			log("windowClosed: running = " + SharedData._running + ", _stopping = " + SharedData._stopping + ", restoring = " +  SharedData._restore_requested, "DATA");
			
			// if there is a window session save it (leave it open if browser is restarting)
			if (this.__window_session.filename) 
			{
        // Work around for Firefox bug 1255578
        SharedData.mClosingAutoWindowState = this.mClosingAutoWindowState;
				// This call fails to clear the _sm_window_session_values window value because window will be closed before it can be deleted in Utils.getAutoSaveValues.
				// Also since window observer won't fire, call updateWindowSession to clear out all window session related data from window and shared data.
				// Don't close session if Firefox or Session Manager will restore previous session or Session Manager will put up prompt to keep window session data active.
				SessionIo.closeSession(window, false, SharedData._restore_requested || (startup == 1) || ((startup == 2) || (PreferenceManager.get("resume_session") == Constants.BACKUP_SESSION_FILENAME)), window.__SSi || this.__SessionManagerWindowId);
				this.updateWindowSession("{}");
        this.mClosingAutoWindowState = null;
        SharedData.mClosingAutoWindowState = null;
			}
				
			let numWindows = Utils.getBrowserWindows().length;
			log("windowClosed: numWindows = " + numWindows, "DATA");

			// If running and not shutting down 
			if (SharedData._running && !SharedData._stopping) {
				// If using session manager's closed window list, save the closed window.
				// mClosingWindowState will always be null except when opening a new window after closing the last browser window without exiting browser
				if (!PreferenceManager.get("use_SS_closed_window_list")) {
					let state = SessionDataProcessing.getSessionState(null, window, null, null, null, true, null, this.mClosingWindowState || this.mClosingAutoWindowState);
					this.appendClosedWindow(state);
				}
				// For all closed windows except the last one
				if (numWindows > 0) 
					Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			log("windowClosed end", "TRACE");
		},
		
		// Listen for about:preferences page and add Session Manager items.
		onPageLoad: function(aEvent) {
			var doc = aEvent.originalTarget; 
			if (doc.location.href.indexOf("about:preferences") == 0) {
				var startMenu = doc.getElementById("browserStartupPage");
				if (startMenu) {
					var startup = PreferenceManager.get("startup", 0);
					var menuitem = startMenu.appendItem(Utils._string("startup_load"), Constants.STARTUP_LOAD);
					menuitem.setAttribute("id","browserStartupSessionmananagerLoad");
					menuitem = startMenu.appendItem(Utils._string("startup_prompt"), Constants.STARTUP_PROMPT);
					menuitem.setAttribute("id","browserStartupSessionmananagerPrompt");

					// add event listener for page unload 
					aEvent.originalTarget.defaultView.addEventListener("unload", SessionManagerWindow.onPageUnload, true);
					
					// Tell Session Manager Helper Component to ignore preference changes while preference window is open.
					Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "true");

					// Save current value
					SessionManagerWindow.currentStartupValue = doc.getElementById("browser.startup.page").valueFromPreferences;
					
					// Actually set preference so browser will pick up if user changes it
					if (startup) 
						doc.getElementById("browser.startup.page").valueFromPreferences = ((startup == 1) ? Constants.STARTUP_PROMPT : Constants.STARTUP_LOAD);
					
					doc.getElementById("browser.startup.page").addEventListener("change", SessionManagerWindow.prefPagePrefChange, false);
				}
			}
		},

		// Since ignoring preference changes, need to listen here and only update our startup preference.
		prefPagePrefChange: function(aEvent) {
			var browserStartup = aEvent.originalTarget.valueFromPreferences;
			PreferenceManager.set("startup", (browserStartup == Constants.STARTUP_PROMPT) ? 1 : 
					((browserStartup == Constants.STARTUP_LOAD) ? 2 : 0));
		},
		
		onPageUnload: function(aEvent) {
			aEvent.originalTarget.defaultView.removeEventListener("unload", SessionManagerWindow.onPageUnload, true);
			aEvent.originalTarget.getElementById("browser.startup.page").removeEventListener("change", SessionManagerWindow.prefPagePrefChange, false);

			if (aEvent.originalTarget.getElementById("browser.startup.page").valueFromPreferences <= Constants.STARTUP_PROMPT) {
				//log("restoring preference");
				aEvent.originalTarget.getElementById("browser.startup.page").valueFromPreferences = SessionManagerWindow.currentStartupValue;
			}
			Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "false");
		},
		
	/* ........ Tab Listeners .............. */

		onTabViewHidden: function(aEvent)
		{
			Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type);
		},

		onTabOpenClose: function(aEvent)
		{
			// Run asynchrounouly on tab close - Requested by author of Private Tabs add-on because that add-on removes tabs
			// on the tabclose event and the closed tab count is wrong unless this runs after his code.
			if (aEvent.type == "TabClose")
				Utils.runAsync(function() { SessionManagerWindow.updateUndoButton(); });
			else 
				SessionManagerWindow.updateUndoButton();
			
			// Update save session tab tree when tab is opened or closed. 
			if (SharedData.savingTabTreeVisible) Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + SessionManagerWindow.findTabIndex(aEvent.target));
		},
		
		// This is only registered when tab tree is visiable in session prompt window while saving.
		// It handles when tabs are repositioned.  It also handles when privacy changes with the Private Tab Add-on since the code 
		// to send the notification is identical.
		onTabMove: function(aEvent)
		{
			Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + SessionManagerWindow.findTabIndex(aEvent.target) + " " + aEvent.detail);
		},

		onTabRestoring_proxy: function(aEvent)
		{
			SessionManagerWindow.onTabRestoring(aEvent);
		},
		
		// This will set up tabs that are loaded during a session load to bypass the cache
		onTabRestoring: function(aEvent)
		{
			// If tab reloading enabled and not offline
			if (PreferenceManager.get("reload") && !Services.io.offline) 
			{	
				// This is a load and not restoring a closed tab or window
				let tab_time = SessionStore.getTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				
				if (tab_time) 
				{
					// Delete the tab value
					SessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
					
					// Compare the times to make sure this really was loaded recently and wasn't a tab that was loading, but then closed and reopened later
					tab_time = parseInt(tab_time);
					tab_time = isNaN(tab_time) ? 0 : tab_time;
					let current_time = new Date();
					current_time = current_time.getTime();
					
					log("onTabRestoring: Tab age is " + ((current_time - tab_time)/1000) + " seconds.", "EXTRA");
					
					// Don't reload a tab older than the specified preference (defaults to 1 minute)
					if (current_time - tab_time < PreferenceManager.get("reload_timeout")) 
					{
						// List for load requests to set to ignore cache
						aEvent.originalTarget.linkedBrowser.addProgressListener(tabbrowserProgressListener);
					}
				}
			}
		},
				
		onTabBarClick: function(aEvent)
		{
			//undo close tab on middle click on tab bar
			if (aEvent.button == 1 && aEvent.target.localName != "tab")
			{
				// If tab restored, prevent default since Firefox opens a new tab in middle click
				if (SessionManagerWindow.undoCloseTab()) {
					aEvent.preventDefault();
					aEvent.stopPropagation();
				}
			}
		},

		// Undo close tab if middle click on tab bar if enabled by user - only do this if Tab Clicking Options
		// or Tab Mix Plus are not installed.
		watchForMiddleMouseClicks: function() 
		{
			var tabBar = window.gBrowser.tabContainer;
			if (PreferenceManager.get("click_restore_tab") && (typeof tabClicking == "undefined") && !SharedData.tabMixPlusEnabled) {
				tabBar.addEventListener("click", this.onTabBarClick, true);
			}
			else tabBar.removeEventListener("click", this.onTabBarClick, true);
		},
		
		onUndoToolbarButtonCommand: function(aEvent) {
			if (aEvent.shiftKey) 
				gSessionManager.undoCloseWindow(window); 
			else if (SessionStore.getClosedTabCount(window))
				this.undoCloseTab(); 
			else {
				// Get true event source - needed for menuitems that use "command" attribute
				let sourceEvent = aEvent.sourceEvent || aEvent;
				sourceEvent.target.open = true;
			}
		},

		onToolbarClick: function(aEvent)
		{
			// Get true event source - needed for menuitems that use "command" attribute
			let sourceEvent = aEvent.sourceEvent || aEvent;
			let aButton = sourceEvent.target;
			if (sourceEvent.button == 1)
			{
				// simulate shift left clicking toolbar button when middle click is used
				let event = window.document.createEvent("XULCommandEvents");
				event.initCommandEvent("command", false, true, window, 0, false, false, true, false, null);
				aButton.dispatchEvent(event);
			}
			else if (sourceEvent.button == 2 && aButton.getAttribute("disabled") != "true")
			{
				aButton.open = true;
			}
		},
		
	/* ........ Miscellaneous Enhancements .............. */

		// For Firefox, the tab index is stored in _tPos. For SeaMonkey use window.gBrowser.getTabIndex.  If that doesn't exist, do a search.
		findTabIndex: function(aTab) {
			if (typeof aTab._tPos != "undefined") return aTab._tPos
			else if (typeof window.gBrowser.getTabIndex == "function") return window.gBrowser.getTabIndex(aTab);
			else {
				// Check each tab of this browser instance
				for (var index = 0; index < aTab.parentNode.childNodes.length; index++) {
					if (aTab == aTab.parentNode.childNodes[index]) return index;
				}
				return null;
			}
		},

		appendClosedWindow: function(aState)
		{
			let cleanBrowser = this.mCleanBrowser || this.mTempCleanBrowser || Array.every(window.gBrowser.browsers, gSessionManager.isCleanBrowser);
      this.mTempCleanBrowser = null;
			if (PreferenceManager.get("max_closed_undo") == 0 || Utils.isPrivateWindow(window) || cleanBrowser)
			{
				return;
			}
			
			let name = this.mClosedWindowName || Utils.getCurrentTabTitle(window) || 
          (((window.gBrowser.currentURI.spec != "about:blank") || (window.gBrowser.currentURI.spec != "about:newtab")) ? window.gBrowser.currentURI.spec : Utils._string("untitled_window"));
			let windows = SessionIo.getClosedWindows_SM();
			
			// encrypt state if encryption preference set
			if (PreferenceManager.get("encrypt_sessions")) {
				aState = Utils.decryptEncryptByPreference(aState);
				if (!aState) return;
			}
					
			aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
			windows.unshift({ name: name, state: aState });
			SessionIo.storeClosedWindows_SM(windows.slice(0, PreferenceManager.get("max_closed_undo")));
		},

		checkWinTimer: function()
		{
			// only act if timer already started
			if ((this._win_timer && ((this.__window_session.time <=0) || !this.__window_session.filename))) {
				this._win_timer.cancel();
				this._win_timer = null;
				log("checkWinTimer: Window Timer stopped", "INFO");
			}
			else if ((this.__window_session.time > 0) && this.__window_session.filename) {
				if (this._win_timer)
					this._win_timer.cancel();
				else
					this._win_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
				// Use slack timers are they are more efficient
				this._win_timer.init(this, this.__window_session.time * 60000, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
				log("checkWinTimer: Window Timer started for " + this.__window_session.time + " minutes", "INFO");
			}
			
			// Since this is called when starting/stoping a window session use it to set the attribute
			// on the toolbar button which changes it's color.
			this.updateToolbarButton();
		},
		
		// Change active window session data (rename, new group or delete)
		changeWindowSession: function(aData) {
			let update = JSON.parse(aData);
			
			if (update && update.oldFileName && (this.__window_session.filename == update.oldFileName)) {
				log("changeWindowSession: window change: " + aData, "DATA");
				if (update.newFileName) {
					this.__window_session.filename = update.newFileName;
					this.__window_session.name = update.newName;
					delete SharedData.mActiveWindowSessions[update.oldFileName];
					SharedData.mActiveWindowSessions[this.__window_session.filename] = true;
					SharedData.mWindowSessionData[window.__SSi] = this.__window_session;

					window.gBrowser.updateTitlebar();
					this.updateToolbarButton();
				}
				else if (update.newGroup != null) {
					this.__window_session.group = update.newGroup;
					SharedData.mWindowSessionData[window.__SSi] = this.__window_session;
				}
				else {
					this.updateWindowSession("{}");
				}
				
				// Update window session data
				let new_values = Utils.mergeAutoSaveValues(this.__window_session.filename, this.__window_session.name, this.__window_session.group, this.__window_session.time)
				Utils.getAutoSaveValues(new_values, window, true);
			}
		},
		
		// Update the window session data in the window and anywhere else it's stored.
		// aData = Window session data
		updateWindowSession: function(aData) {
			let session_data = JSON.parse(aData || null);
			
			if (session_data) {
				// If replacing window session, remove old one from active window session list
				if (this.__window_session.filename)
					delete SharedData.mActiveWindowSessions[this.__window_session.filename];

				// Store window session data
				this.__window_session.filename = session_data.filename;
				this.__window_session.name = session_data.name;
				this.__window_session.group = session_data.group;
				this.__window_session.time = isNaN(session_data.time) ? 0 : session_data.time;
		
				// update shared data values
				if (session_data.filename) {
					SharedData.mActiveWindowSessions[session_data.filename] = true;
					SharedData.mWindowSessionData[window.__SSi] = this.__window_session;
				}
				else {
					// if window is closing window__SSi is gone, but this.__SessionManagerWindowId should still exist
					delete SharedData.mWindowSessionData[window.__SSi || this.__SessionManagerWindowId];
				}
				
				// Currently the _sm_window_session_values window value is set in Utils.getAutoSaveValues because
				// this is too late to call it when the window closes.
				
				// start/stop timer and update titlebar and toolbar buttons
				this.checkWinTimer();
				window.gBrowser.updateTitlebar();
				this.updateToolbarButton();
			}
		},
		
		updateToolbarButton: function()
		{
			let privateWindow = Utils.isPrivateWindow(window);
		
			let windowTitleName = (this.__window_session.name && !privateWindow) ? (Utils._string("window_session") + " " + this.__window_session.name) : "";
			let sessionTitleName = (SharedData._autosave.name && !privateWindow) ? (Utils._string("current_session2") + " " + SharedData._autosave.name) : "";
			
			// Update toolbar button and tooltip
			let button = window.document.getElementById("sessionmanager-toolbar");
			// SeaMonkey keeps button in BrowserToolbarPalette which is in browser window.  The boxObject
			// only has a firstchild if the element is actually displayed so check that.
			if (button) {
			
				if (!PreferenceManager.get("do_not_color_toolbar_button")) {
					if (windowTitleName)
						button.setAttribute("windowsession", "true");
					else
						button.removeAttribute("windowsession");
						
					if (sessionTitleName)
						button.setAttribute("autosession", "true");
					else
						button.removeAttribute("autosession");
				} else {
						button.removeAttribute("windowsession");
						button.removeAttribute("autosession");
				}
			}
		},

		hideShowTitleBarLabel: function()
		{
			// Update Titlebar
			let titlebar = window.document.getElementById("titlebar");
			if (titlebar) {
				let toolbar_title_label = window.document.getElementById("sessionmanager-titlebar-label");
				if (toolbar_title_label) {
					let privateWindow = Utils.isPrivateWindow(window);
					let windowTitleName = (this.__window_session.name && !privateWindow) ? (Utils._string("window_session") + " " + this.__window_session.name) : "";
					let sessionTitleName = (SharedData._autosave.name && !privateWindow) ? (Utils._string("current_session2") + " " + SharedData._autosave.name) : "";
					
					if (!privateWindow && PreferenceManager.get("session_name_in_titlebar") != 2) {
						toolbar_title_label.value = windowTitleName + ((windowTitleName && sessionTitleName) ? ",   " : "") + sessionTitleName;
						toolbar_title_label.setAttribute("showLabel", "true");
					}
					else 
						toolbar_title_label.removeAttribute("showLabel");
				}
			}
		},
		
		tweakToolbarTooltips: function(aEvent, aButtonId) {
			let buttons = [null, null];
			if (!aButtonId || aButtonId == "sessionmanager-toolbar")
				buttons[0] = window.document.getElementById("sessionmanager-toolbar");
			if (!aButtonId || aButtonId == "sessionmanager-undo")
				buttons[1] = window.document.getElementById("sessionmanager-undo");
				
//			log("tweakToolbarTooltips: aButtonId = " + aButtonId, "TRACE");
//			log("tweakToolbarTooltips: Before sessionmanager-toolbar events already added =  " + 
//				(window.document.getElementById("sessionmanager-toolbar") && window.document.getElementById("sessionmanager-toolbar").eventsAdded) , "TRACE");
//			log("tweakToolbarTooltips: Before sessionmanager-undo events already added =  " + 
//				(window.document.getElementById("sessionmanager-undo") && window.document.getElementById("sessionmanager-undo").eventsAdded) , "TRACE");
				
			for (let i=0; i < buttons.length; i++) {
				if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild) {
					buttons[i].boxObject.firstChild.setAttribute("tooltip",( i ? "sessionmanager-undo-button-tooltip" : "sessionmanager-button-tooltip"));
				}
				
				// If just added toolbar button, add event listeners
				if (buttons[i] && !buttons[i].eventsAdded)
					buttons[i].eventsAdded = addEventListeners((i == 0) ? smButtonEventHandlers : undoButtonEventHandlers);
			}

//			log("tweakToolbarTooltips: After sessionmanager-toolbar events already added =  " + 
//				(window.document.getElementById("sessionmanager-toolbar") && window.document.getElementById("sessionmanager-toolbar").eventsAdded) , "TRACE");
//			log("tweakToolbarTooltips: After sessionmanager-undo events already added =  " + 
//				(window.document.getElementById("sessionmanager-undo") && window.document.getElementById("sessionmanager-undo").eventsAdded) , "TRACE");
			
			// Update menus as well in case toolbar button was just added
			SessionManagerWindow.updateMenus();
			
			// update toolbar button if auto-save session is loaded and watch titlebar if it exists to see if we should update
			SessionManagerWindow.updateToolbarButton();
		},
		
		buttonTooltipShowing: function(aEvent) {
			let privateWindow = Utils.isPrivateWindow(window);
			let tooltip = aEvent.target;
		
			let windowTitleName = (this.__window_session.name && !privateWindow) ? (Utils._string("window_session") + " " + this.__window_session.name) : "";
			let sessionTitleName = (SharedData._autosave.name && !privateWindow) ? (Utils._string("current_session2") + " " + SharedData._autosave.name) : "";
		
			let value1 = sessionTitleName || windowTitleName;
			let value2 = sessionTitleName ? windowTitleName : "";

			if (value1) {
				tooltip.childNodes[1].value = value1;
				tooltip.childNodes[1].hidden = false;
				// Auto-session always on top.
				if (sessionTitleName) 
					tooltip.childNodes[1].setAttribute("autosession", "true");
				else 
					tooltip.childNodes[1].removeAttribute("autosession");
				if (value2) {
					tooltip.childNodes[2].value = value2;
					tooltip.childNodes[2].hidden = false;
				}
				else 
					tooltip.childNodes[2].hidden = true;
			}
			else {
				tooltip.childNodes[1].hidden = true;
				tooltip.childNodes[2].hidden = true;
			}
		},
		
		updateUndoButton: function(aEnable)
		{
			let button = (window.document)?window.document.getElementById("sessionmanager-undo"):null;
			if (button)
			{
				let tabcount = 0;
				let wincount = 0;
				if (typeof(aEnable) != "boolean") {
					try {
						wincount = PreferenceManager.get("use_SS_closed_window_list") ? SessionStore.getClosedWindowCount() : SessionIo.getClosedWindowsCount();
						tabcount = SessionStore.getClosedTabCount(window);
					} catch (ex) { logError(ex); }
				}
				Utils.setDisabled(button, (typeof(aEnable) == "boolean")?!aEnable:tabcount == 0 && wincount == 0);
			}
		},
		
		// Put current session name in browser titlebar
		// This is a watch function which is called any time the titlebar text changes
		// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
		updateTitlebar: function(id, oldVal, newVal)
		{
			if (id == "title") {
				// Don't kill browser if something goes wrong
				try {
					if (!Utils.isPrivateWindow(window)) {
						let windowTitleName = (SessionManagerWindow.__window_session.name) ? (Utils._string("window_session") + " " + SessionManagerWindow.__window_session.name) : "";
						let sessionTitleName = (SharedData._autosave.name) ? (Utils._string("current_session2") + " " + SharedData._autosave.name) : "";
						let title = ((windowTitleName || sessionTitleName) ? "(" : "") + windowTitleName + ((windowTitleName && sessionTitleName) ? ", " : "") + sessionTitleName + ((windowTitleName || sessionTitleName) ? ")" : "")
						
						if (title) {
							// Add window and browser session titles
							switch(PreferenceManager.get("session_name_in_titlebar")) {
								case 0:
									newVal = newVal + " - " + title;
									break;
								case 1:
									newVal = title + " - " + newVal;
									break;
							}
						}
					}
				} 
				catch (ex) { 
					logError(ex); 
				}
			}
			return newVal;
		},

		updateMenus: function(aForceUpdateAppMenu)
		{
				function get_(a_parent, a_id) { return a_parent.getElementsByAttribute("_id", a_id)[0] || null; }
		
				// Need to get menus and popups this way since once cloned they would have same id.
				var toolsmenu_popup = window.document.getElementById("sessionmanager-menu-popup");
				
				// This should always exist for browser and Mac hidden window.  If it doesn't exit.
				if (!toolsmenu_popup)
					return;
				
				var toolsmenu_submenu = get_(toolsmenu_popup,"_sessionmanager-management-menu-popup");
				var toolsmenu_menu = get_(toolsmenu_popup,"sessionmanager-tools-menu");
				var toolsmenu_splitmenu = get_(toolsmenu_popup,"sessionmanager-tools-splitmenu");
				var toolsmenu_submenus_hidden = toolsmenu_splitmenu.hidden && toolsmenu_menu.hidden;
				
				var toolbar_popup = window.document.getElementById("sessionmanager-toolbar-popup");
				var toolbar_button_menu = toolbar_popup ? window.document.getElementById("sessionmanager-toolbar-menu") : null;
				var toolbar_button_splitmenu = toolbar_popup ? window.document.getElementById("sessionmanager-toolbar-splitmenu") : null;
				var toolbar_button_submenus_hidden = toolbar_popup ? (toolbar_button_splitmenu.hidden && toolbar_button_menu.hidden) : false;

				var update_app_menu = false || aForceUpdateAppMenu;

				// Display in submenu
				if (PreferenceManager.get("display_menus_in_submenu")) {
					// Find any added menu items not in submenu and remove them.  They will have the "_sm_menu_to_remove" attribute set to "true"
					var added_menuitems = toolsmenu_popup.getElementsByAttribute("_sm_menu_to_remove", "true");
					if (added_menuitems.length) {
						update_app_menu = true;
						while (added_menuitems.length) 
							toolsmenu_popup.removeChild(added_menuitems[0]);
					}
					if (toolbar_popup) {
						added_menuitems = toolbar_popup.getElementsByAttribute("_sm_menu_to_remove", "true");
						while (added_menuitems.length) 
							toolbar_popup.removeChild(added_menuitems[0]);
					}
					
					// Split menus don't work in SeaMonkey, OS X or in Firefox 28 and up.
					let no_splitmenu = (Services.appinfo.name != "Firefox") || (Services.vc.compare(Services.appinfo.version, "28.0a1") >= 0) ||
							 (/mac|darwin/i.test(window.navigator.platform)) || PreferenceManager.get("no_splitmenu", false);
				
					// Popup menu is under the normal menu item by default.  In Firefox on Windows and Linux move it to the splitmenu
					if (!no_splitmenu) {
						if (!toolsmenu_splitmenu.firstChild) {
							var menupopup = toolsmenu_menu.removeChild(toolsmenu_menu.menupopup);
							toolsmenu_splitmenu.appendChild(menupopup);
						}
						toolsmenu_splitmenu.hidden = false;
						toolsmenu_menu.hidden = true;
						if (toolbar_button_splitmenu) {
							if (!toolbar_button_splitmenu.firstChild) {
								var menupopup = toolbar_button_menu.removeChild(toolbar_button_menu.menupopup);
								toolbar_button_splitmenu.appendChild(menupopup);
							}
							toolbar_button_splitmenu.hidden = false;
							toolbar_button_menu.hidden = true;
						}
					}
					else {
						toolsmenu_menu.hidden = false;
						toolsmenu_splitmenu.hidden = true;
						if (toolbar_button_menu) {
							toolbar_button_menu.hidden = false;
							toolbar_button_splitmenu.hidden = true;
						}
					}
				}
				else if (!toolsmenu_submenus_hidden || !toolbar_button_submenus_hidden) {
					// Clone the menu items into the Session Manager menu (quick and dirty, but it works)
					// Since the toolbar can be added and removed and it's state might not be known, check its state before re-adding menuitems.
					toolsmenu_menu.hidden = true;
					toolsmenu_splitmenu.hidden = true;
					var change_toolbar_button = (toolbar_button_menu && !toolbar_button_submenus_hidden);
					if (change_toolbar_button) {
						toolbar_button_menu.hidden = true;
						toolbar_button_splitmenu.hidden = true;
					}

					// Copy the menuitems from the tools menu popup.  Can do this for the button menu since it's the same as the tools menu
					for (var i=0; i<toolsmenu_submenu.childNodes.length; i++) {
						if (!toolsmenu_submenus_hidden) {
							var menuitem = toolsmenu_submenu.childNodes[i].cloneNode(true);
							menuitem.setAttribute("_sm_menu_to_remove", "true");
							toolsmenu_menu.parentNode.insertBefore(menuitem,toolsmenu_menu);
							update_app_menu = true;
						}
						if (change_toolbar_button) {
							var menuitem = toolsmenu_submenu.childNodes[i].cloneNode(true);
							menuitem.setAttribute("_sm_menu_to_remove", "true");
							toolbar_button_menu.parentNode.insertBefore(menuitem,toolbar_button_menu);
						}
					}
				}
				
				// There's a problem where sometimes switching menu styles causes toolbar button menupopup to no longer open
				// until any other menupopup (even in another window) is opened.  Calling the hidePopup() method seems to work around that.
				if (toolbar_popup) {
					toolbar_popup.hidePopup();
				}

				// clone popup menu for app menu menu
				if (window.document.getElementById("sessionmanager-appmenu") && update_app_menu) {
					var popup_menu = toolsmenu_popup.cloneNode(true);
					let oldAppMenuPopup = window.document.getElementById("sessionmanager-appmenu-popup");
					if (oldAppMenuPopup)
						window.document.getElementById("sessionmanager-appmenu").replaceChild(popup_menu, oldAppMenuPopup);
					else
						window.document.getElementById("sessionmanager-appmenu").appendChild(popup_menu);
						
					popup_menu.setAttribute("id", "sessionmanager-appmenu-popup");
					popup_menu.addEventListener("popupshowing", SessionManagerEventHandlers.init, false);
					popup_menu.addEventListener("popuphidden", SessionManagerEventHandlers.cleanMenu, false);
					popup_menu.addEventListener("click", SessionManagerEventHandlers.clickSessionManagerMenu, false);
					// Remove event listener when popup is removed
					unload(function() {
						popup_menu.removeEventListener("popupshowing", SessionManagerEventHandlers.init, false);
						popup_menu.removeEventListener("popuphidden", SessionManagerEventHandlers.cleanMenu, false);
						popup_menu.removeEventListener("click", SessionManagerEventHandlers.clickSessionManagerMenu, false);
					}, popup_menu);
				}
				
				// The below doesn't work correctly (generates errors with splitmenu)
	/*				
				let appmenu_popup = window.document.getElementById("sessionmanager-appmenu-popup");
				if (appmenu_popup && update_app_menu) {
					// Remove existing menus
					while (appmenu_popup.childNodes.length)
						appmenu_popup.removeChild(appmenu_popup.childNodes[0]);
						
					// Clone new menus
					for (let i=0; i<toolsmenu_popup.childNodes.length; i++) 
						appmenu_popup.appendChild(toolsmenu_popup.childNodes[i].cloneNode(true));
				}
	*/
		},
		
		showHideToolsMenu: function()
		{
			// app menu is only in FF 4 and up
			for (var i=0; i<2; i++) {
				let sessionMenu = i ? window.document.getElementById("sessionmanager-appmenu") : window.document.getElementById("sessionmanager-menu");
				if (sessionMenu) {
					sessionMenu.hidden = PreferenceManager.get("hide_tools_menu");
					if (PreferenceManager.get("show_icon_in_menu"))
						sessionMenu.setAttribute("icon", "true");
					else
						sessionMenu.removeAttribute("icon");
				}
			}
		},

		setKeys: function(keysChanged)
		{
			function get_(a_parent, a_id) { return a_parent.getElementsByAttribute("_id", a_id)[0] || null; }
			
			try {
				let keys = PreferenceManager.get("keys", ""), keyname;
				keys = Utils.JSON_decode(keys, true);

				if (!keys._JSON_decode_failed) {
					let keyset, parent;
					
					// Get keyset
					let orig_keyset = window.document.getElementById("SessionManagerKeyset");
					
					if (orig_keyset) {
						// If keys changed, need to remove the entire keyset to change the key values and have them work
						if (keysChanged) {
							parent = orig_keyset.parentNode;
							keyset = orig_keyset.cloneNode(true);
							parent.removeChild(orig_keyset);
						}
						else 
							keyset = orig_keyset;
							
						let keysetKeys = keyset.getElementsByTagName("key");
						
						for (var i=0; i < keysetKeys.length; i++) {
							if (keyname = keysetKeys[i].id.match(/key_session_manager_(.*)/)) {
								if (keys[keyname[1]]) {
									keysetKeys[i].setAttribute("key", keys[keyname[1]].key || keys[keyname[1]].keycode);
									keysetKeys[i].setAttribute("modifiers", keys[keyname[1]].modifiers);
								}
								else {
									keysetKeys[i].setAttribute("key", "");
									keysetKeys[i].setAttribute("modifiers", "");
								}
							}
						}
						
						if (keysChanged) {
							parent.appendChild(keyset);
						
							// Key shortcut text won't update until key attribute is removed and re-added again. (shortcuts work, but are displayed wrong)
							let popups = ["sessionmanager-menu-popup", "sessionmanager-appmenu-popup", "sessionmanager-toolbar-popup"];
							for (let j in popups) {
								let popup = window.document.getElementById(popups[j]);
								if (popup) {
									let nodeList = popup.getElementsByAttribute("key","*");
									for (var i = 0; i < nodeList.length; ++i) {
										let item = nodeList[i];
										let keyname = item.getAttribute("key");
										item.removeAttribute("key");
										item.setAttribute("key", keyname);
									}
								}
							}
						}
					}
				}
			} catch(ex) { logError(ex); }
		},
		
		restoreWindowSession: function()
		{
			log("restoreWindowSession start", "TRACE");
			
			// check both the backup and current window value just in case
			let window_values = (this._backup_window_session_data || SessionStore.getWindowValue(window,"_sm_window_session_values"));
			if (window_values) {
				// Check to see if window session still exists and if it does, read it autosave data from file in case it was modified after backup
				let values = Utils.parseAutoSaveValues(window_values);
				// build regular expression, escaping all special characters
				let escaped_name = values.filename.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
				let regexp = new RegExp("^" + escaped_name + "$");
				let sessions = SessionIo.getSessions(regexp,null,true);
				// If filenames and session names match consider it a match
				if ((sessions.length == 1) && (sessions[0].fileName == values.filename) && (sessions[0].name == values.name)) {
					// If session is no longer an autosave session don't restore it.
					let matchArray;
					if (matchArray = /^(window|session)\/?(\d*)$/.exec(sessions[0].autosave)) {
						let time = parseInt(matchArray[2]);
						// use new group and time if they changed
						window_values = Utils.mergeAutoSaveValues(sessions[0].fileName, sessions[0].name, sessions[0].group, time)
						Utils.getAutoSaveValues(window_values, window);
					}
				}
			}
			log("restoreWindowSession: Restore new window after startup done, window session = " + this.__window_session.filename, "DATA");
			this._backup_window_session_data = null;
				
			this.updateUndoButton();

			// Update the __SessionManagerWindowId if it's not set (this should only be for the first browser window).
			if (!this.__SessionManagerWindowId) {
				this.__SessionManagerWindowId = window.__SSi;
				SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
			}
			log("restoreWindowSession end", "TRACE");
		},
		
	/* ........ Auxiliary Functions .............. */

		// Undo closed tab function
		undoCloseTab: function(aIndex) {
			// SeaMonkey doesn't have an undoCloseTab function so call ours, otherwise call built-in one
			if (typeof window.undoCloseTab == "function") 
				return window.undoCloseTab(aIndex);
			else
				return this.undoCloseTabSM(aIndex);
		},
		
		// Undo closed tab function for SeaMonkey
		undoCloseTabSM: function(aIndex)
		{
			// Don't do anything if there's no closed tabs
			if (SessionStore.getClosedTabCount(window) == 0)	
				return false;
				
			SessionStore.undoCloseTab(window, aIndex || 0);
			// Only need to check for empty close tab list if possibly re-opening last closed tabs
			if (!parseInt(aIndex)) 
				this.updateUndoButton();
			
			return true;
		},
	};

	// Event handlers
	var eventHandlers = [
		["cmd_session_manager_delete", "command", SessionManagerEventHandlers.remove],
		["cmd_session_manager_group", "command", SessionManagerEventHandlers.group],
		["cmd_session_manager_load", "command", SessionManagerEventHandlers.load],
		["cmd_session_manager_openFolder", "command", SessionManagerEventHandlers.openFolder],
		["cmd_session_manager_options", "command", SessionManagerEventHandlers.openOptions],
		["cmd_session_manager_rename", "command", SessionManagerEventHandlers.rename],
		["cmd_session_manager_save", "command", SessionManagerEventHandlers.save],
		// Need different event for button, because if save command is disabled, toolbar button menu is disabled.
		["cmd_session_manager_saveButton", "command", SessionManagerEventHandlers.save],
		// Need different event for keyboard shortcut because shift is passed to event so treats as save window.
		["cmd_session_manager_saveKBShortcut", "command", SessionManagerEventHandlers.saveKBShortcut],
		["cmd_session_manager_save_window", "command", SessionManagerEventHandlers.saveWindow],
		["cmd_session_manager_menu", "command", SessionManagerEventHandlers.commandSessionManagerMenu],
	//		["cmd_session_manager_explorer", "command", SessionManagerEventHandlers.openSessionExplorer],
		["cmd_session_manager_close", "command", SessionManagerEventHandlers.closeSession],
		["cmd_session_manager_abandon", "command", SessionManagerEventHandlers.abandonSession],
		["cmd_session_manager_emptyTrash", "command", SessionManagerEventHandlers.emptyTrash],
		["cmd_session_manager_clear", "command", SessionManagerEventHandlers.clearUndoListPrompt],
		["cmd_session_manager_undoToolbar", "command", SessionManagerWindow.onUndoToolbarButtonCommand.bind(SessionManagerWindow)],
		["cmd_session_manager_sessionLoad", "command", SessionManagerEventHandlers.session_load],
		["cmd_session_manager_sessionReplace", "command", SessionManagerEventHandlers.session_replace],
		["cmd_session_manager_sessionClose", "command", SessionManagerEventHandlers.session_close],
		["cmd_session_manager_sessionRename", "command", SessionManagerEventHandlers.session_rename],
		["cmd_session_manager_sessionRemove", "command", SessionManagerEventHandlers.session_remove],
		["cmd_session_manager_groupRename", "command", SessionManagerEventHandlers.group_rename],
		["cmd_session_manager_groupRemove", "command", SessionManagerEventHandlers.group_remove],
		["cmd_session_manager_setStartup", "command", SessionManagerEventHandlers.session_setStartup],
		["cmd_session_manager_removeUndoMenuItem", "command", SessionManagerEventHandlers.removeUndoMenuItem],
		["cmd_session_manager_deleteSession", "command", SessionManagerEventHandlers.deleted_session_delete],
		["sessionmanager-menu-popup", "popupshowing", SessionManagerEventHandlers.init],
		["sessionmanager-menu-popup", "popuphidden", SessionManagerEventHandlers.cleanMenu],
		["sessionmanager-menu-popup", "click", SessionManagerEventHandlers.clickSessionManagerMenu],
		["sessionmanager-ContextMenu", "popupshowing", SessionManagerEventHandlers.session_popupInit],
		["sessionmanager-groupContextMenu", "popupshowing", SessionManagerEventHandlers.group_popupInit],
		["sessionmanager-button-tooltip", "popupshowing", SessionManagerWindow.buttonTooltipShowing.bind(SessionManagerWindow)],
		["sessionmanager-undo-button-tooltip", "popupshowing", SessionManagerEventHandlers.undoTooltipShowing]
	];
	var smButtonEventHandlers = [
		["sessionmanager-toolbar", "click", SessionManagerWindow.onToolbarClick.bind(SessionManagerWindow)],
		["sessionmanager-toolbar-popup", "popupshowing", SessionManagerEventHandlers.init],
		["sessionmanager-toolbar-popup", "popuphidden", SessionManagerEventHandlers.cleanMenu],
		["sessionmanager-toolbar-popup", "click", SessionManagerEventHandlers.clickSessionManagerMenu]
	];
	var undoButtonEventHandlers = [
		["sessionmanager-undo", "click", SessionManagerWindow.onToolbarClick.bind(SessionManagerWindow)],
		["sessionmanager-undo-popup", "popupshowing", SessionManagerEventHandlers.initUndo],
		["sessionmanager-undo-popup", "popuphidden", SessionManagerEventHandlers.cleanMenu],
		["sessionmanager-undo-popup", "click", SessionManagerEventHandlers.clickSessionManagerMenu]
	];

	function loadOverlay(window, overlay) {
		function insertNode(aParent, aChild) {
			try {
				let before = aChild.getAttribute("insertbefore") ? window.document.getElementById(aChild.getAttribute("insertbefore")) : null;
				let after = aChild.getAttribute("insertafter") ? window.document.getElementById(aChild.getAttribute("insertafter")) : null;
				if ((before && (aParent == before.parentNode)) || (after && (aParent == after.parentNode)))
					aParent.insertBefore(aChild, before || after.nextSibling);
				else
					aParent.appendChild(aChild);
			} catch (ex) {
				Cu.reportError(ex);
			}
		}

		let toolbarElems = ["toolbarbutton", "toolbaritem"];
		let popupElems = ["sessionmanager-button-tooltip", "sessionmanager-undo-button-tooltip", "sessionmanager-ContextMenu",
											"sessionmanager-deleted-ContextMenu", "sessionmanager-groupContextMenu", "sessionmanager-undo-ContextMenu",
											"sessionmanager-menu-popup"];
		let elemsToSkip = [];
											
		// Add non special items to window
		for (let id in overlay) {
			switch(overlay[id].id) {
			case "BrowserToolbarPalette":
				// Toolbar buttons needs to be added manually
				if (window.document.getElementById("navigator-toolbox")) {
					let buttons = [];
					for (let i=0; i < overlay[id].childNodes.length; i++) 
						if (toolbarElems.indexOf(overlay[id].childNodes[i].nodeName.toLowerCase()) != -1) 
							buttons.push(overlay[id].childNodes[i].cloneNode(true));
					
					// Add toolbar items at the same time to prevent issues with adding
					if (buttons.length > 0)
						restorePosition(window.document, buttons);
				}
				break;
			case "SessionManagerKeyset":
			case "SessionManagerCommandset":
				// As does keyset and commandset
				let mainKeyset = window.document.getElementById("mainKeyset");
				let parent = mainKeyset ? mainKeyset.parentNode : window.document.getElementById("main-window");
				if (parent)
					insertNode(parent,overlay[id].cloneNode(true));
				break;
			default:
			// If normal element, just add it's children to the element (popups are special)
				let elem = window.document.getElementById(id);
				if (elem) {
					// Free floating popupElems need to replace the popup element placeholder
					if (popupElems.indexOf(overlay[id].id) != -1) {
						let parentNode = elem.parentNode;
						parentNode.removeChild(elem);
						insertNode(parentNode,overlay[id].cloneNode(true));
						// Don't need to remove the free floating popup/tooltip elems since they'll get removed when process parent
						elemsToSkip.push(overlay[id]);
					}
					else {
						for (let i=0; i < overlay[id].childNodes.length; i++) 
							insertNode(elem,overlay[id].childNodes[i].cloneNode(true));
					}
				}
			}
		}

		// if aEvent is set that means this is being called because of a window unload, otherwise add-on in being disabled
		return function removeOverlay(aEvent) {
			let toolbarItems = ["sessionmanager-undo", "sessionmanager-toolbar"];

			// App menu will hold reference to our items if we open it so remove that reference
			let elem = window.document.getElementById("appmenu-popup");
			if (elem && elem._currentPopup && elem._currentPopup.id == "sessionmanager-appmenu-popup")
				elem._currentPopup = null;

			// Current Tools menu leaks, so remove our popup menu so that doesn't leak too.
			elem = window.document.getElementById("sessionmanager-menu-popup");
			if (elem)
				elem.parentNode.removeChild(elem);
				
			// Do the same for the toolbar button since this is also a problem in Australis with toolbar in panel UI
			elem = window.document.getElementById("sessionmanager-toolbar-popup");
			if (elem)
				elem.parentNode.removeChild(elem);
			
			// Try to find and remove toolbar button from the toolbar palette.
			let toolbox = window.document.getElementById("navigator-toolbox");
			if (toolbox) {
				let nextChildElem;
				for (let childElem = toolbox.palette.firstElementChild; childElem; childElem = nextChildElem) {
					nextChildElem = childElem.nextElementSibling;
					if (toolbarItems.indexOf(childElem.id) != -1)
						childElem.parentNode.removeChild(childElem);
				}
			}
					
			for (let id in overlay) {
				if ((overlay[id].id == "SessionManagerKeyset") || (overlay[id].id == "SessionManagerCommandset")) {
					let theSet = window.document.getElementById(overlay[id].getAttribute("id"));
					if (theSet)
						theSet.parentNode.removeChild(theSet);
				}	
				else if (elemsToSkip.indexOf(overlay[id]) == -1) {
					for (let i=0; i < overlay[id].childNodes.length; i++) {
						let childElem = window.document.getElementById(overlay[id].childNodes[i].getAttribute("id"));
						if (childElem) 
							childElem.parentNode.removeChild(childElem);
					}
				}
			}
		}
	}
	
	function addEventListeners(handlers) {
		let exists = false;
		for (let i = 0; i < handlers.length; i++)
		{
			let [id, event, handler] = handlers[i];
			let element = window.document.getElementById(id);
			if (element) {
				exists = true;
				element.addEventListener(event, handler, false);
			}
		}
		return exists;
	}

	function removeEventListeners() {
		// Remove event listeners
		let handlers = eventHandlers.concat(smButtonEventHandlers, undoButtonEventHandlers);
		for (let i = 0; i < handlers.length; i++)
		{
			let [id, event, handler] = handlers[i];
			let element = window.document.getElementById(id);
			if (element) 
				element.removeEventListener(event, handler, false);
		}
	}

	var removeOverlay = loadOverlay(window,overlay);

	if (!window.gBrowser) {
		// This causes SeaMonkey to initialize window.gBrowser.
		try {
			window.getBrowser();
		} catch(ex) {}
	}
	
	// Protect all functions and hide everything from enumeration in SessionManagerEventHandlers object (still show up in Object.getOwnPropertyNames though)
	let keys = Object.keys(SessionManagerEventHandlers);
	for (var i in keys) {
		Object.defineProperty(SessionManagerEventHandlers, keys[i], {
			configurable: false, enumerable: false,
			value: SessionManagerEventHandlers[keys[i]], 
			writable: (typeof SessionManagerEventHandlers[keys[i]] != "function")
		});
	}

	// Add event listeners
	addEventListeners(eventHandlers);

	// if aEvent is set that means this is being called because of a window unload, otherwise add-on in being disabled
	unload(function (aEvent) {
		log("unloading " + window.location + ", isBrowser = " + this.isBrowser, "INFO");
		removeEventListeners();
		if (this.isBrowser) this.onUnload(!aEvent);
		removeOverlay(aEvent);
	}.bind(SessionManagerWindow), window);
	
	// Load the window
	SessionManagerWindow.onLoadCheck.bind(SessionManagerWindow)();
}
