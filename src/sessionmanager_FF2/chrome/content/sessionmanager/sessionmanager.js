"use strict";

// Create a namespace so as not to polute the global namespace
(function() {
let obj = {};

// import the browser modules into the namespace
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(obj, "log", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "logError", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(obj, "gSessionManager", "resource://sessionmanager/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "Constants", "resource://sessionmanager/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "PreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "SessionDataProcessing", "resource://sessionmanager/modules/session_data_processing.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "Utils", "resource://sessionmanager/modules/utils.jsm");
XPCOMUtils.defineLazyGetter(obj, "SessionStore", function() { return obj.Utils.SessionStore; }); 

// Observers to register for per window.  WIN_OBSERVING2 is for notifications that won't be removed for the last window closed
const WIN_OBSERVING = ["sessionmanager:update-undo-button", "sessionmanager:updatetitlebar", "sessionmanager:initial-windows-restored",
                       "sessionmanager:save-tab-tree-change", "sessionmanager:close-windowsession", "sessionmanager:nsPref:changed", 
                       "sessionmanager:middle-click-update", "browser:purge-session-history", "private-browsing"];

const WIN_OBSERVING2 = ["sessionmanager:process-closed-window", "sessionmanager:last-window-closed", "quit-application-granted"];

// use the namespace
obj.gSessionManagerWindowObject = {
	mFullyLoaded: false,
	
	// SessionManager Window ID
	__SessionManagerWindowId: null,
	
	// timers
	_win_timer : null,

	// window state
	_backup_window_sesion_data: null,
	__window_session_filename: null,
	__window_session_name: null,
	__window_session_time: 0,
	__window_session_group: null,
	mClosingWindowState: null,
	mCleanBrowser: null,
	mClosedWindowName: null,
	
/* ........ Observers .............. */

	// Listener for changes to tabs - See https://developer.mozilla.org/En/Listening_to_events_on_all_tabs
	// Only care about location and favicon changes
	// This is only registered when tab tree is visible in session prompt window while saving
	tabProgressListener: {
	
		findTabIndexForBrowser: function(aBrowser) {
			// Check each tab of this browser instance
			for (var index = 0; index < gBrowser.browsers.length; index++) {
				if (aBrowser == gBrowser.getBrowserAtIndex(index)) return index;
			}
			return null;
		},
		
		// Interface functions
		onLocationChange: function(aBrowser, webProgress, request, location) {
			var index = this.findTabIndexForBrowser(aBrowser);
			if (index != null) Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "locationChange " + index);
		},
		
		onLinkIconAvailable: function(aBrowser) {
			var index = this.findTabIndexForBrowser(aBrowser);
			if (index != null) Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "iconChange " + index + " " +
																													encodeURIComponent(aBrowser.contentDocument.title) + "  " + (aBrowser.mIconURL ? encodeURIComponent(aBrowser.mIconURL) : null));
		},

		onProgressChange: function() {},
		onSecurityChange: function() {},
		onStateChange: function() {},
		onStatusChange: function() {},
		onRefreshAttempted: function() { return true; }
	},
	
	// Listener to detect load progress for browser.  Used to trigger cache bypass when loading sessions
	tabbrowserProgressListener: {
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
					aWebProgress.chromeEventHandler.removeProgressListener(this);
				} catch(ex) { obj.logError(ex); }
			}
		},

		onLocationChange: function(aProgress, aRequest, aURI) { },
		onProgressChange: function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) { },
		onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) { },
		onSecurityChange: function(aWebProgress, aRequest, aState) { }
	},

	observe: function(aSubject, aTopic, aData)
	{
		obj.log("gSessionManagerWindowObject.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
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
				if (obj.PreferenceManager.get("reload")) {
					gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
				}
				else {
					gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
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
			case "_autosave_values":
				gBrowser.updateTitlebar();
				this.updateToolbarButton();
				break;
			case "display_menus_in_submenu":
				this.updateMenus();
				break;
			case "keys":
				this.setKeys();
				break;
			}
			break;
		case "sessionmanager:middle-click-update":
			this.watchForMiddleMouseClicks();
			break;
		case "sessionmanager:save-tab-tree-change":
			// The "load" event won't fire for cached pages where the favicon doesn't change. For example going back and forth on Google's site pages.
			// Using addTabsProgressListener instead of "load" works in this case.  It doesn't return the tab, but we can easily get it by
			// searching all tabs to find the one that contains the event's target (getBrowserForTab()).  
			// Since this is slower, than the "load" method only do it if save window's tab tree is visible.
			switch (aData) {
				case "open":
					gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
					gBrowser.addTabsProgressListener(this.tabProgressListener);
					// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
					if (Application.name == "Firefox")
						window.addEventListener("tabviewhidden", this.onTabViewHidden, false);
					break;
				case "close":
					gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false);
					gBrowser.removeTabsProgressListener(this.tabProgressListener);
					// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
					if (Application.name == "Firefox")
						window.removeEventListener("tabviewhidden", this.onTabViewHidden, false);
					break;
			}
			break;
		case "sessionmanager:last-window-closed":
			this.lastWindowClosing();
			break;
		case "sessionmanager:close-windowsession":
			// if entering private browsing mode store a copy of the current window session name for use when exiting pbm
			let pb_window_session_data = null;
			if (obj.SharedData.mAboutToEnterPrivateBrowsing && this.__window_session_filename) 
				pb_window_session_data = obj.SessionStore.getWindowValue(window,"_sm_window_session_values");
				
			// notification will either specify specific window session name or be null for all window sessions
			if (this.__window_session_filename && (!aData || (this.__window_session_filename == aData))) {
				let abandon = aSubject.QueryInterface(Components.interfaces.nsISupportsPRBool).data;
				obj.log((abandon ? "Abandoning" : "Closing") + " window session " + this.__window_session_filename);
				if (abandon) {
					obj.gSessionManager.abandonSession(window);
				}
				else {
					obj.SessionIo.closeSession(window);
				}
			}
			
			// if entering private browsing mode store a copy of the current window session name in the window state for use when exiting pbm
			// Do this after we save the window
			if (obj.SharedData.mAboutToEnterPrivateBrowsing) {
				obj.SessionStore.setWindowValue(window, "_sm_pb_window_session_data", pb_window_session_data);
			}
			break;
		case "sessionmanager:initial-windows-restored":
			this.restoreWindowSession();
			break;
		case "sessionmanager:update-undo-button":
			// only update all windows if window state changed.
			if ((aData != "tab") || (window == aSubject)) this.updateUndoButton();
			break;
		case "sessionmanager:process-closed-window":
			// This will handle any left over processing that results from closing the last browser window, but
			// not actually exiting the browser and then opening a new browser window.  The window will be
			// autosaved or saved into the closed window list depending on if it was an autosave session or not.
			// The observers will then be removed which will result in the window being removed from memory.
			if (window != aSubject) {
				// Temporarily copy closing state to module
				obj.SharedData.mClosingWindowState = this.mClosingWindowState;
				try { 
					if (!obj.SessionIo.closeSession(false)) this.onWindowClosed();
				}
				catch(ex) { obj.logError(ex); }
				obj.SharedData.mClosingWindowState = null;
				this.mClosingWindowState = null;
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
				WIN_OBSERVING2.forEach(function(aTopic) {
					// This will throw an error if observers already removed so catch
					try {
						Services.obs.removeObserver(this, aTopic);
					}
					catch(ex) {}
				}, this);
				obj.log("observe: done processing closed window", "INFO");
			}
			break;
		case "sessionmanager:updatetitlebar":
			if (!aSubject || aSubject == window) {
				gBrowser.updateTitlebar();
				this.updateToolbarButton();
			}
			break;
		case "browser:purge-session-history":
			this.updateUndoButton(false);
			break;
		case "quit-application-granted":
			// Since we are quiting don't listen for any more notifications on last window
			WIN_OBSERVING2.forEach(function(aTopic) {
				// This will throw an error for if observers already removed so catch
				try {
					Services.obs.removeObserver(this, aTopic);
				}
				catch(ex) {}
			}, this);
			
			// Copy window state to module
			obj.SharedData.mClosingWindowState = this.mClosingWindowState;
			
			// Not doing the following because I want to keep the window session values in
			// backup sessions.  Currently the code won't restore window sessions unless the backup
			// session is loaded at startup anyway so it's okay that we don't clear out the values at shutdown.
/*				
			// If not restarting or if this window doesn't have a window session open, 
			// hurry and wipe out the window session value before Session Store stops allowing 
			// window values to be updated.
			if (!obj.SharedData._restart_requested || !this.__window_session_filename) {
				obj.log("observe: Clearing window session data", "INFO");
				// this throws if it doesn't exist so try/catch it
				try { 
					obj.SessionStore.deleteWindowValue(window, "_sm_window_session_values");
				}
				catch(ex) {}
			}
*/					
			break;
		// timer periodic call
		case "timer-callback":
			// save window session if open, but don't close it
			obj.log("Timer callback for window timer", "EXTRA");
			obj.SessionIo.closeSession(window, false, true);
			break;
		case "private-browsing":   // Not sent in Firefox 20 and up
			var button = document.getElementById("sessionmanager-toolbar");
			if (button) {
				if (aData == "enter") {
					button.setAttribute("private", "true"); 
					// abandon any open window sessions.  They will already have been saved by the Session Manager component
					obj.gSessionManager.abandonSession(window, true);
				}
				else {
					button.removeAttribute("private"); 
					// delay because the obj.SessionStore values are wrong at this point
					window.setTimeout(function() { this.restoreWindowSession(true); }.bind(this), 0);
				}
			}
			break;
		}
	},
	

/* ........ Window Listeners .............. */
	
	// If the Session Manager module has initialized call onLoad otherwise hide the Session Manager menus.
	onLoad_proxy: function(aEvent) {
		this.removeEventListener("load", obj.gSessionManagerWindowObject.onLoad_proxy, false);
		// Don't process for the hidden window
		if (obj.SharedData._initialized && this.location != "chrome://browser/content/hiddenWindow.xul") {
			obj.gSessionManagerWindowObject.updateMenus(true);
			obj.gSessionManagerWindowObject.setKeys();
			
			let sessionStartup = obj.Utils.SessionStartup;
	
			// onceInitialized only exists in Firefox 20 and up, where we need to wait in case the browser crashed and we put up 
			// the crash prompt.  Only do this for the first browser window and only when private browsing isn't autostarting since obj.SessionStore never
			// initializes in that case.
			if (!obj.SharedData._browserWindowDisplayed && !obj.Utils.isAutoStartPrivateBrowserMode() && sessionStartup && sessionStartup.onceInitialized) {
				obj.log("Waiting for sessionStartup to initialize", "INFO");
				let sessionButton = document.getElementById("sessionmanager-toolbar");
				let undoButton = document.getElementById("sessionmanager-undo");
				let sessionMenu = document.getElementById("sessionmanager-menu");
				if (sessionButton) sessionButton.hidden = true;
				if (undoButton) undoButton.hidden = true;
				if (sessionMenu) sessionMenu.hidden = true;
				
				sessionStartup.onceInitialized.then(
					obj.gSessionManagerWindowObject.onLoadDelayed.bind(obj.gSessionManagerWindowObject)
				);
			} 
			else {
				obj.gSessionManagerWindowObject.onLoad();
			}
		}
		else {
			let sessionButton = document.getElementById("sessionmanager-toolbar");
			let undoButton = document.getElementById("sessionmanager-undo");
			let sessionMenu = document.getElementById("sessionmanager-menu");
			if (sessionButton) sessionButton.hidden = true;
			if (undoButton) undoButton.hidden = true;
			if (sessionMenu) sessionMenu.hidden = true;
			
			obj.log("Window opened before Session Manager initialized or hidden window opened, window = " + this.location, "TRACE");
		}
	},
	
	// This is needed because in Firefox 20 and up, after a crash a browser window opens and we don't want Session Manager to attach to it 
	// until after SessionStart finishes reading the crashed session data.
	onLoadDelayed: function() {
		let sessionButton = document.getElementById("sessionmanager-toolbar");
		let undoButton = document.getElementById("sessionmanager-undo");
		let sessionMenu = document.getElementById("sessionmanager-menu");
		if (sessionButton) sessionButton.hidden = false;
		if (undoButton) undoButton.hidden = false;
		if (sessionMenu) sessionMenu.hidden = false;
		
		this.onLoad();
	},
	
	onLoad: function() {
		obj.log("onLoad start, window = " + document.title, "TRACE");
		
		// Set the flag indicating that a browser window displayed
		obj.SharedData._browserWindowDisplayed = true;

		// The unload event fires when any window closes, but it fires too late to use obj.SessionStore's setWindowValue which is needed to clear any window
		// session information.  This is okay though since Session Manager will strip out window sessions when loading sessions except in the case
		// of restoring the latest backup or crash session.  Backups can be taken care of by watching for the "browser-lastwindow-close-requested", which
		// the Session Manager component does and then calls lastWindowClosing() to handle saving the window data.  Crashes are okay since if the crash
		// occurs after closing a window session, it might be restored but that is not terrible.
		// The close event fires when the window is either manually closed or when the window.close() function is called except on shutdown or when
		// windows close from loading sessions.  Unfortunately the close event no longer fires in Firefox if the Menu bar is hidden so we can't use that.
		// See https://bugzilla.mozilla.org/show_bug.cgi?id=827880
		window.addEventListener("unload", this.onUnload_proxy, false);
		
		// Add an event listener to check if user finishes customizing the toolbar so we can tweak the button tooltips.
		window.addEventListener("aftercustomization", this.tweakToolbarTooltips, false);

		// Fix tooltips for toolbar buttons
		this.tweakToolbarTooltips();
		
		// If the shutdown on last window closed preference is not set, set it based on the O/S.
		// Enable for Macs, disable for everything else
		if (!obj.PreferenceManager.has("shutdown_on_last_window_close")) {
			if (/mac/i.test(navigator.platform)) {
				obj.PreferenceManager.set("shutdown_on_last_window_close", true);
			}
			else {
				obj.PreferenceManager.set("shutdown_on_last_window_close", false);
			}
		}
	
		// This will handle any left over processing that results from closing the last browser window, but
		// not actually exiting the browser and then opening a new browser window.  We do this before adding the observer
		// below because we don't want to run on the opening window, only on the closed window
		if (obj.Utils.getBrowserWindows().length == 1) 
			Services.obs.notifyObservers(window, "sessionmanager:process-closed-window", null);
			
		WIN_OBSERVING.forEach(function(aTopic) {
			Services.obs.addObserver(this, aTopic, false);
		}, this);
		WIN_OBSERVING2.forEach(function(aTopic) {
			Services.obs.addObserver(this, aTopic, false);
		}, this);
		gBrowser.tabContainer.addEventListener("TabClose", this.onTabOpenClose, false);
		gBrowser.tabContainer.addEventListener("TabOpen", this.onTabOpenClose, false)
		if (obj.PreferenceManager.get("reload")) {
			gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
		}
		// If saving tab tree currently open, add event listeners
		if (obj.SharedData.savingTabTreeVisible) {
			gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
			gBrowser.addTabsProgressListener(this.tabProgressListener);
			// For Firefox need to listen for "tabviewhidden" event to handle tab group changes
			if (Application.name == "Firefox")
				window.addEventListener("tabviewhidden", this.onTabViewHidden, false);
		}
				
		// Hide Session Manager toolbar item if option requested
		this.showHideToolsMenu();
		
		// If in private browsing mode gray out session manager toolbar icon
		if (obj.Utils.isPrivateBrowserMode()) {
			var button = document.getElementById("sessionmanager-toolbar");
			if (button) button.setAttribute("private", "true"); 
		}
		
		// Undo close tab if middle click on tab bar - only do this if Tab Clicking Options
		// or Tab Mix Plus are not installed.
		this.watchForMiddleMouseClicks();

		// Handle restoring sessions do to crash, prompting, pre-chosen session, etc
		obj.gSessionManager.recoverSession(window);
		this.updateUndoButton();
		
		// Tell Session Manager Helper Component that it's okay to restore the browser startup preference if it hasn't done so already
		Services.obs.notifyObservers(null, "sessionmanager:restore-startup-preference", null);
		
		// Update other browsers toolbars in case this was a restored window
		if (obj.PreferenceManager.get("use_SS_closed_window_list")) {
			Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
		}
		
		if (!obj.SharedData._running)
		{
			// make sure that the _running value is true
			obj.SharedData._running = true;
		
			// If backup file is temporary, then delete it
			try {
				if (obj.PreferenceManager.get("backup_temporary", true)) {
					obj.PreferenceManager.set("backup_temporary", false);
					obj.SessionIo.delFile(obj.SessionIo.getSessionDir(obj.Constants.BACKUP_SESSION_FILENAME));
				}
			} catch (ex) { obj.logError(ex); }

			// If we did a temporary restore, set it to false			
			if (obj.PreferenceManager.get("restore_temporary"))
				obj.PreferenceManager.set("restore_temporary", false);

			// Force saving the preferences
			Services.obs.notifyObservers(null,"sessionmanager-preference-save",null);
		}
		
		// Watch for changes to the titlebar so we can add our sessionname after it since 
		// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
		// In SeaMonkey 2.9.1 and earlier it doesn't change and there's nothing else to watch so we need to do a hook.
		if ((Application.name != "SeaMonkey") || (Services.vc.compare(Application.version, "2.9.1") > 0)) {
			// Don't watch for private windows since they will never be autosave or window sessions
			if (!obj.Utils.isPrivateWindow(window))
				gBrowser.ownerDocument.watch("title", this.updateTitlebar);
		}
		else {
			this.hookSeaMonkeyUpdateTitlebar();
		}
		gBrowser.updateTitlebar();
		
		// update toolbar button if auto-save session is loaded and watch titlebar if it exists to see if we should update
		this.updateToolbarButton();

		// SeaMonkey doesn't have an undoCloseTab function so create one
		if (typeof(window.undoCloseTab) == "undefined") {
			window.undoCloseTab = function(aIndex) { obj.gSessionManagerWindowObject.undoCloseTabSM(aIndex); }
		}
		
		// add call to obj.gSessionManager_Sanitizer (code take from Tab Mix Plus)
		// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
		// where the user disabled option to prompt before clearing data.  This is only needed in SeaMonkey
		// because Firefox always puts up a prompt when using the "Clear ..." menu item.
		let cmd = document.getElementById("Tools:Sanitize");
		if (cmd && (Application.name == "SeaMonkey")) 
			cmd.addEventListener("command", obj.gSessionManager.tryToSanitize, false);
		
		// Clear current window value setting if shouldn't be set.  Need try catch because first browser window will throw an exception.
		try {
			if (!this.__window_session_filename) {
				// Remove window session if not restoring from private browsing mode otherwise restore window session
				if (!obj.SessionStore.getWindowValue(window, "_sm_pb_window_session_data")) {
					// Backup _sm_window_session_values first in case this is actually a restart or crash restore 
					if (!this._backup_window_sesion_data) this._backup_window_sesion_data = obj.SessionStore.getWindowValue(window,"_sm_window_session_values");
					obj.log("onLoad: Removed window session name from window: " + this._backup_window_sesion_data, "DATA");
					if (this._backup_window_sesion_data) obj.Utils.getAutoSaveValues(null, window);
				}
				else {
					this.restoreWindowSession(true);
				}
			}
		} catch(ex) {}
		
		// Put up one time message after upgrade if it needs to be displayed - only done for one window
		if (obj.SharedData._displayUpdateMessage) {
			let url = obj.SharedData._displayUpdateMessage;
			delete(obj.SharedData._displayUpdateMessage);
			setTimeout(function() {
				gBrowser.selectedTab = gBrowser.addTab(url);
			},100);
		}
		
		// Keep track of opening windows on browser startup
		if (obj.SharedData._countWindows) {
			Services.obs.notifyObservers(null, "sessionmanager:window-loaded", null);
		}

		// Store a window id for use when saving sessions.  Use the obj.SessionStore __SSi value which exists for all
		// windows except the first window open.  For first window set it when SS
		if (window.__SSi) {
			this.__SessionManagerWindowId = window.__SSi;
			obj.SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
		}
		
		// Update tab tree if it's open and window is not private
		if (obj.SharedData.savingTabTreeVisible && !obj.Utils.isPrivateWindow(window)) {
			Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "windowOpen " + this.__SessionManagerWindowId);
		}
		
		obj.log("onLoad end", "TRACE");
	},

	// This fires any time the window is closed.  It fires too late to use obj.SessionStore's setWindowValue.
	onUnload_proxy: function(aEvent)
	{
		obj.log("onUnload Fired", "INFO");
		this.removeEventListener("unload", obj.gSessionManagerWindowObject.onUnload_proxy, false);
		this.removeEventListener("aftercustomization", obj.gSessionManagerWindowObject.tweakToolbarTooltips, false);
		obj.gSessionManagerWindowObject.onUnload();
	},

	onUnload: function()
	{
		obj.log("onUnload start", "TRACE");
		let allWindows = obj.Utils.getBrowserWindows();
		let numWindows = allWindows.length;
		obj.log("onUnload: numWindows = " + numWindows, "DATA");
		
		WIN_OBSERVING.forEach(function(aTopic) {
			Services.obs.removeObserver(this, aTopic);
		}, this);

		// Remomving events that weren't added doesn't hurt anything so remove all possible events.
		gBrowser.tabContainer.removeEventListener("TabClose", this.onTabOpenClose, false);
		gBrowser.tabContainer.removeEventListener("TabOpen", this.onTabOpenClose, false);
		gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false)
		gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
		gBrowser.tabContainer.removeEventListener("click", this.onTabBarClick, false);
		// Only remove this event in Firefox
		if (Application.name == "Firefox")
			window.removeEventListener("tabviewhidden", this.onTabViewHidden, false);
		// SeaMonkey 2.1 throws an exception on this if not listening so catch it
		try {
			gBrowser.removeTabsProgressListener(this.tabProgressListener);
		} catch(ex) {}

		// stop watching for titlebar changes
		gBrowser.ownerDocument.unwatch("title");
		
		// Last window closing will leaks briefly since mObserving2 observers are not removed from it 
		// until after shutdown is run, but since browser is closing anyway, who cares?
		if (numWindows != 0) {
			WIN_OBSERVING2.forEach(function(aTopic) {
				// This will throw an error for if observers already removed so catch
				try {
					Services.obs.removeObserver(this, aTopic);
				}
				catch(ex) {}
			}, this);
		}
		
		// Remove event listener from sanitize command
		let cmd = document.getElementById("Tools:Sanitize");
		if (cmd && (Application.name == "SeaMonkey")) 
			cmd.removeEventListener("command", obj.gSessionManager.tryToSanitize, false);
		
		this.onWindowClosed();
						
		// This executes whenever the last browser window is closed (either manually or via shutdown).
		if (obj.SharedData._running && numWindows == 0)
		{
		
			obj.SharedData._screen_width = screen.width;
			obj.SharedData._screen_height = screen.height;
			
			obj.SharedData.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");

			// This will run the shutdown processing if the preference is set and the last browser window is closed manually
			if (obj.PreferenceManager.get("shutdown_on_last_window_close") && !obj.SharedData._stopping) {
				WIN_OBSERVING2.forEach(function(aTopic) {
					// This will throw an error for if observers already removed so catch
					try {
						Services.obs.removeObserver(this, aTopic);
					}
					catch(ex) {}
				}, this);
				// Copy window state to module so session data is available
				obj.SharedData.mClosingWindowState = this.mClosingWindowState;
				this.mClosingWindowState = null;
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
				obj.gSessionManager.shutDown();
				// Don't look at the session startup type if a new window is opened without shutting down the browser.
				obj.SharedData.mAlreadyShutdown = true;
			}
		}
		
		// Update tab tree if it's open
		if (obj.SharedData.savingTabTreeVisible) Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", "windowClose " + this.__SessionManagerWindowId);
		
		obj.log("onUnload end", "TRACE");
	},

	// This is called when the last browser window closes so that Session Manager can temporarily save the browser state before the windows close
	// and the window gets moved to the closed window list.  It also grabs the window state and name for when using Session Manager's closed window list.
	lastWindowClosing: function() {
		obj.log("lastWindowClosing start", "TRACE");
		try {
			// Store closing state if it will be needed later
			this.mClosingWindowState = obj.SessionDataProcessing.getSessionState(null, window, null, null, null, true); 
			// Only need to save closed window data is not using browser's closed window list
			if (!obj.PreferenceManager.get("use_SS_closed_window_list")) {
				this.mCleanBrowser = Array.every(gBrowser.browsers, obj.gSessionManager.isCleanBrowser);
				this.mClosedWindowName = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:obj.Utils._string("untitled_window"));
			}
			else {
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
			}
		}
		catch(ex) { 
			obj.logError(ex); 
		}
		
		obj.log("lastWindowClosing end", "TRACE");
	},

	onWindowClosed: function()
	{
		obj.log("onWindowClosed start", "TRACE");
		
		// if there is a window session save it (leave it open if browser is restarting)
		if (this.__window_session_filename) 
		{
			// This currently fails to clear the _sm_window_session_values window value because setting window values fail after window is closed.
			// This is okay though since the value is only read in for backup or crashed sessions.
			obj.SessionIo.closeSession(window, false, obj.SharedData._restart_requested);
		}
			
		obj.log("onWindowClosed: running = " + obj.SharedData._running + ", _stopping = " + obj.SharedData._stopping, "DATA");
		
		let numWindows = obj.Utils.getBrowserWindows().length;
		obj.log("onWindowClosed: numWindows = " + numWindows, "DATA");

		// For all closed windows except the last one
		if (numWindows > 0) {
			// If running and not shutting down 
			if (obj.SharedData._running && !obj.SharedData._stopping) {
				// If using session manager's closed window list, save the closed window.
				// mClosingWindowState will always be null except when opening a new window after closing the last browser window without exiting browser
				if (!obj.PreferenceManager.get("use_SS_closed_window_list")) {
					let state = obj.SessionDataProcessing.getSessionState(null, window, null, null, null, true, null, this.mClosingWindowState);
					this.appendClosedWindow(state);
				}
				Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
		}
		
		obj.log("onWindowClosed end", "TRACE");
	},
	
/* ........ Tab Listeners .............. */

	onTabViewHidden: function(aEvent)
	{
		Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type);
	},

	onTabOpenClose: function(aEvent)
	{
		obj.gSessionManagerWindowObject.updateUndoButton();
		
		// Update tab tree when tab is opened or closed. For open
		if (obj.SharedData.savingTabTreeVisible) Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + obj.gSessionManagerWindowObject.findTabIndex(aEvent.target));
	},
	
	// This is only registered when tab tree is visiable in session prompt window while saving
	onTabMove: function(aEvent)
	{
		Services.obs.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + obj.gSessionManagerWindowObject.findTabIndex(aEvent.target) + " " + aEvent.detail);
	},

	onTabRestoring_proxy: function(aEvent)
	{
		obj.gSessionManagerWindowObject.onTabRestoring(aEvent);
	},
	
	// This will set up tabs that are loaded during a session load to bypass the cache
	onTabRestoring: function(aEvent)
	{
		// If tab reloading enabled and not offline
		if (obj.PreferenceManager.get("reload") && !Services.io.offline) 
		{	
			// This is a load and not restoring a closed tab or window
			let tab_time = obj.SessionStore.getTabValue(aEvent.originalTarget, "session_manager_allow_reload");
			
			if (tab_time) 
			{
				// Delete the tab value
				obj.SessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				
				// Compare the times to make sure this really was loaded recently and wasn't a tab that was loading, but then closed and reopened later
				tab_time = parseInt(tab_time);
				tab_time = isNaN(tab_time) ? 0 : tab_time;
				let current_time = new Date();
				current_time = current_time.getTime();
				
				obj.log("onTabRestoring: Tab age is " + ((current_time - tab_time)/1000) + " seconds.", "EXTRA");
				
				// Don't reload a tab older than the specified preference (defaults to 1 minute)
				if (current_time - tab_time < obj.PreferenceManager.get("reload_timeout")) 
				{
					// List for load requests to set to ignore cache
					aEvent.originalTarget.linkedBrowser.addProgressListener(this.tabbrowserProgressListener);
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
			if (window.undoCloseTab()) {
				aEvent.preventDefault();
				aEvent.stopPropagation();
			}
		}
	},

	// Undo close tab if middle click on tab bar if enabled by user - only do this if Tab Clicking Options
	// or Tab Mix Plus are not installed.
	watchForMiddleMouseClicks: function() 
	{
		var tabBar = gBrowser.tabContainer;
		if (obj.PreferenceManager.get("click_restore_tab") && (typeof tabClicking == "undefined") && !obj.SharedData.tabMixPlusEnabled) {
			tabBar.addEventListener("click", this.onTabBarClick, true);
		}
		else tabBar.removeEventListener("click", this.onTabBarClick, true);
	},

	onToolbarClick: function(aEvent, aButton)
	{
		if (aEvent.button == 1)
		{
			// simulate shift left clicking toolbar button when middle click is used
			let event = document.createEvent("XULCommandEvents");
			event.initCommandEvent("command", false, true, window, 0, false, false, true, false, null);
			aButton.dispatchEvent(event);
		}
		else if (aEvent.button == 2 && aButton.getAttribute("disabled") != "true")
		{
			aButton.open = true;
		}
	},
	
/* ........ Miscellaneous Enhancements .............. */

	// For Firefox, the tab index is stored in _tPos. For SeaMonkey use gBrowser.getTabIndex.  If that doesn't exist, do a search.
	findTabIndex: function(aTab) {
		if (typeof aTab._tPos != "undefined") return aTab._tPos
		else if (typeof gBrowser.getTabIndex == "function") return gBrowser.getTabIndex(aTab);
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
		let cleanBrowser = (this.mCleanBrowser != null) ? this.mCleanBrowser : Array.every(gBrowser.browsers, obj.gSessionManager.isCleanBrowser);
		if (obj.PreferenceManager.get("max_closed_undo") == 0 || obj.Utils.isPrivateWindow(window) || cleanBrowser)
		{
			return;
		}
		
		let name = this.mClosedWindowName || content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:obj.Utils._string("untitled_window"));
		let windows = obj.SessionIo.getClosedWindows_SM();
		
		// encrypt state if encryption preference set
		if (obj.PreferenceManager.get("encrypt_sessions")) {
			aState = obj.Utils.decryptEncryptByPreference(aState);
			if (!aState) return;
		}
				
		aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
		windows.unshift({ name: name, state: aState });
		obj.SessionIo.storeClosedWindows_SM(windows.slice(0, obj.PreferenceManager.get("max_closed_undo")));
	},

	checkWinTimer: function()
	{
		// only act if timer already started
		if ((this._win_timer && ((this.__window_session_time <=0) || !this.__window_session_filename))) {
			this._win_timer.cancel();
			this._win_timer = null;
			obj.log("checkWinTimer: Window Timer stopped", "INFO");
		}
		else if ((this.__window_session_time > 0) && this.__window_session_filename) {
			if (this._win_timer)
				this._win_timer.cancel();
			else
				this._win_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
			// Use slack timers are they are more efficient
			this._win_timer.init(this, this.__window_session_time * 60000, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
			obj.log("checkWinTimer: Window Timer started for " + this.__window_session_time + " minutes", "INFO");
		}
		
		// Since this is called when starting/stoping a window session use it to set the attribute
		// on the toolbar button which changes it's color.
		this.updateToolbarButton();
	},
	
	updateToolbarButton: function()
	{
		let privateWindow = obj.Utils.isPrivateWindow(window);
	
		let windowTitleName = (this.__window_session_name && !privateWindow) ? (obj.Utils._string("window_session") + " " + this.__window_session_name) : "";
		let sessionTitleName = (obj.SharedData._autosave_name && !privateWindow) ? (obj.Utils._string("current_session2") + " " + obj.SharedData._autosave_name) : "";
		
		// Update toolbar button and tooltip
		let button = document.getElementById("sessionmanager-toolbar");
		// SeaMonkey keeps button in BrowserToolbarPalette which is in browser window.  The boxObject
		// only has a firstchild if the element is actually displayed so check that.
		if (button) {
		
			if (!obj.PreferenceManager.get("do_not_color_toolbar_button")) {
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
		
		// Update Titlebar
		let titlebar = document.getElementById("titlebar");
		if (titlebar) {
			let toolbar_title_label = document.getElementById("sessionmanager-titlebar-label");
			if (toolbar_title_label) {
				if (!privateWindow && obj.PreferenceManager.get("session_name_in_titlebar") != 2) {
					toolbar_title_label.value = windowTitleName + ((windowTitleName && sessionTitleName) ? ",   " : "") + sessionTitleName;
					toolbar_title_label.removeAttribute("hidden");
				}
				else 
					toolbar_title_label.setAttribute("hidden", "true");
			}
		}
	},
	
	tweakToolbarTooltips: function(aEvent) {
		let buttons = [document.getElementById("sessionmanager-toolbar"), document.getElementById("sessionmanager-undo")];
		for (let i=0; i < buttons.length; i++) {
			if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild) {
				buttons[i].boxObject.firstChild.setAttribute("tooltip",( i ? "sessionmanager-undo-button-tooltip" : "sessionmanager-button-tooltip"));
			}
		}
		
		// Update menus as well in case toolbar button was just added
		obj.gSessionManagerWindowObject.updateMenus();
	},
	
	buttonTooltipShowing: function(aEvent, tooltip) {
		let privateWindow = obj.Utils.isPrivateWindow(window);
	
		let windowTitleName = (this.__window_session_name && !privateWindow) ? (obj.Utils._string("window_session") + " " + this.__window_session_name) : "";
		let sessionTitleName = (obj.SharedData._autosave_name && !privateWindow) ? (obj.Utils._string("current_session2") + " " + obj.SharedData._autosave_name) : "";
	
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
	
	undoTooltipShowing: function(aEvent,tooltip) {
		let name = null;
		let url = null;
		if (obj.SessionStore.getClosedTabCount(window)) {
			let closedTabs = obj.SessionStore.getClosedTabData(window);
			closedTabs = obj.Utils.JSON_decode(closedTabs);
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
	},
	
	updateUndoButton: function(aEnable)
	{
		let button = (document)?document.getElementById("sessionmanager-undo"):null;
		if (button)
		{
			let tabcount = 0;
			let wincount = 0;
			if (typeof(aEnable) != "boolean") {
				try {
					wincount = obj.PreferenceManager.get("use_SS_closed_window_list") ? obj.SessionStore.getClosedWindowCount() : obj.SessionIo.getClosedWindowsCount();
					tabcount = obj.SessionStore.getClosedTabCount(window);
				} catch (ex) { obj.logError(ex); }
			}
			obj.Utils.setDisabled(button, (typeof(aEnable) == "boolean")?!aEnable:tabcount == 0 && wincount == 0);
		}
	},
	
	// Replace SeaMonkey's gBrowser.updateTitlebar function with our own which is used
	// to update the title bar with auto session names after SeaMonkey changes the title.
	hookSeaMonkeyUpdateTitlebar: function() {
		var _original = gBrowser.updateTitlebar; // Reference to the original function
		gBrowser.updateTitlebar = function() {
			// Execute before
			var rv = _original.apply(gBrowser, arguments);
			// execute afterwards
			try {
				var title = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
													.getInterface(Components.interfaces.nsIWebNavigation)
													.QueryInterface(Components.interfaces.nsIBaseWindow).title;
				title = obj.gSessionManagerWindowObject.updateTitlebar("title", "", title);
				window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
							.getInterface(Components.interfaces.nsIWebNavigation)
							.QueryInterface(Components.interfaces.nsIBaseWindow).title = title;
			} catch (ex) {}

			// return the original result
			return rv;
		};
	},
	
	// Put current session name in browser titlebar
	// This is a watch function which is called any time the titlebar text changes
	// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
	updateTitlebar: function(id, oldVal, newVal)
	{
		if (id == "title") {
			// Don't kill browser if something goes wrong
			try {
				if (!obj.Utils.isPrivateWindow(window)) {
					let windowTitleName = (obj.gSessionManagerWindowObject.__window_session_name) ? (obj.Utils._string("window_session") + " " + obj.gSessionManagerWindowObject.__window_session_name) : "";
					let sessionTitleName = (obj.SharedData._autosave_name) ? (obj.Utils._string("current_session2") + " " + obj.SharedData._autosave_name) : "";
					let title = ((windowTitleName || sessionTitleName) ? "(" : "") + windowTitleName + ((windowTitleName && sessionTitleName) ? ", " : "") + sessionTitleName + ((windowTitleName || sessionTitleName) ? ")" : "")
					
					if (title) {
						// Add window and browser session titles
						switch(obj.PreferenceManager.get("session_name_in_titlebar")) {
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
				obj.logError(ex); 
			}
		}
		return newVal;
	},

	updateMenus: function(aForceUpdateAppMenu)
	{
			function get_(a_parent, a_id) { return a_parent.getElementsByAttribute("_id", a_id)[0] || null; }					
	
			// Need to get menus and popups this way since once cloned they would have same id.
			var toolsmenu_popup = document.getElementById("sessionmanager-menu-popup");
			var toolsmenu_submenu = get_(toolsmenu_popup,"_sessionmanager-management-menu-popup");
			var toolsmenu_menu = get_(toolsmenu_popup,"sessionmanager-tools-menu");
			var toolsmenu_splitmenu = get_(toolsmenu_popup,"sessionmanager-tools-splitmenu");
			var toolsmenu_submenus_hidden = toolsmenu_splitmenu.hidden && toolsmenu_menu.hidden;
			
			var toolbar_popup = document.getElementById("sessionmanager-toolbar-popup");
			var toolbar_button_menu = toolbar_popup ? document.getElementById("sessionmanager-toolbar-menu") : null;
			var toolbar_button_splitmenu = toolbar_popup ? document.getElementById("sessionmanager-toolbar-splitmenu") : null;
			var toolbar_button_submenus_hidden = toolbar_popup ? (toolbar_button_splitmenu.hidden && toolbar_button_menu.hidden) : false;

			var update_app_menu = false || aForceUpdateAppMenu;

			// Display in submenu
			if (obj.PreferenceManager.get("display_menus_in_submenu")) {
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
				
				let no_splitmenu = (Application.name != "Firefox") ||
													 (/mac|darwin/i.test(navigator.platform)) || obj.PreferenceManager.get("no_splitmenu", false);
			
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
			if (document.getElementById("sessionmanager-appmenu") && update_app_menu) {
				var popup_menu = toolsmenu_popup.cloneNode(true);
				document.getElementById("sessionmanager-appmenu").replaceChild(popup_menu, document.getElementById("sessionmanager-appmenu-popup"));
				popup_menu.setAttribute("id", "sessionmanager-appmenu-popup");
			}
	},
	
	showHideToolsMenu: function()
	{
		// app menu is only in FF 4 and up
		for (var i=0; i<2; i++) {
			let sessionMenu = i ? document.getElementById("sessionmanager-appmenu") : document.getElementById("sessionmanager-menu");
			if (sessionMenu) {
				sessionMenu.hidden = obj.PreferenceManager.get("hide_tools_menu");
				if (obj.PreferenceManager.get("show_icon_in_menu"))
					sessionMenu.setAttribute("icon", "true");
				else
					sessionMenu.removeAttribute("icon");
			}
		}
	},

	setKeys: function()
	{
		try {
			let keys = obj.PreferenceManager.get("keys", ""), keyname;
			keys = obj.Utils.JSON_decode(keys, true);

			if (!keys._JSON_decode_failed) {
				let keysets = document.getElementById("mainKeyset").getElementsByTagName("key");
				
				for (var i=0; i < keysets.length; i++) {
					if (keyname = keysets[i].id.match(/key_session_manager_(.*)/)) {
						if (keys[keyname[1]]) {
							keysets[i].setAttribute("key", keys[keyname[1]].key || keys[keyname[1]].keycode);
							keysets[i].setAttribute("modifiers", keys[keyname[1]].modifiers);
						}
						else {
							keysets[i].setAttribute("key", "");
							keysets[i].setAttribute("modifiers", "");
						}
					}
				}
			}
		} catch(ex) { obj.logError(ex); }
	},
	
	restoreWindowSession: function(aPrivateBrowsingRestore)
	{
		let pb_window_session_data = obj.SessionStore.getWindowValue(window,"_sm_pb_window_session_data");
		if (aPrivateBrowsingRestore && !pb_window_session_data)
			return;
	
		// check both the backup and current window value just in case
		let window_values = aPrivateBrowsingRestore ? pb_window_session_data : (this._backup_window_sesion_data || obj.SessionStore.getWindowValue(window,"_sm_window_session_values"));
		if (window_values) {
			// Check to see if window session still exists and if it does, read it autosave data from file in case it was modified after backup
			let values = window_values.split("\n");
			// build regular expression, escaping all special characters
			let escaped_name = values[0].replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
			let regexp = new RegExp("^" + escaped_name + "$");
			let sessions = obj.SessionIo.getSessions(regexp,null,true);
			// If filenames and session names match consider it a match
			if ((sessions.length == 1) && (sessions[0].fileName == values[0]) && (sessions[0].name == values[1])) {
				// If session is no longer an autosave session don't restore it.
				let matchArray;
				if (matchArray = /^(window|session)\/?(\d*)$/.exec(sessions[0].autosave)) {
					let time = parseInt(matchArray[2]);
					// use new group and time if they changed
					window_values = obj.Utils.mergeAutoSaveValues(sessions[0].fileName, sessions[0].name, sessions[0].group, time)
					obj.Utils.getAutoSaveValues(window_values, window);
				}
			}
		}
		obj.log("restoreWindowSession: Restore new window after " + (aPrivateBrowsingRestore ? "exit private browsing" : "startup") + " done, window session = " + this.__window_session_filename, "DATA");
		if (aPrivateBrowsingRestore && pb_window_session_data) 
			obj.SessionStore.deleteWindowValue(window, "_sm_pb_window_session_data");
		else
			this._backup_window_sesion_data = null;
			
		this.updateUndoButton();

		// Update the __SessionManagerWindowId if it's not set (this should only be for the first browser window).
		if (!this.__SessionManagerWindowId) {
			this.__SessionManagerWindowId = window.__SSi;
			obj.SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
		}
	},
	
/* ........ Auxiliary Functions .............. */

	// Functions for convert Tab Mix Plus sessions into Session Manager sessions
	doTMPConvert: function(aSession)
	{
		Components.utils.import("resource://sessionmanager/modules/session_convert.jsm", this);
		this.SessionConverter.convertTMP(null, true);
	},
	
	doTMPConvertFile: function(aFileUri, aSilent)
	{
		Components.utils.import("resource://sessionmanager/modules/session_convert.jsm", this);
		this.SessionConverter.convertTMP(aFileUri, aSilent);
	},
	
	// Undo closed tab function for SeaMonkey
	undoCloseTabSM: function(aIndex)
	{
		if (obj.SessionStore.getClosedTabCount(window) == 0)	return;
		obj.SessionStore.undoCloseTab(window, aIndex || 0);
		// Only need to check for empty close tab list if possibly re-opening last closed tabs
		if (!aIndex) this.updateUndoButton();
	},
}

// Define a window.com.morac.SessionManagerAddon object and add local objects to it
if(!window.com) window.com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={ 
	gSessionManagerWindowObject: obj.gSessionManagerWindowObject,
	gSessionManager: obj.gSessionManager,
	SessionIo: obj.SessionIo,
	SessionStore: obj.SessionStore,
	Utils: obj.Utils
}

// For Tab Mix Plus until the author fixes his code
com.morac.gSessionManagerSessionBrowser = true;
com.morac.gSessionManager = {
	openOptions: function() {
		var consoleService = Components.classes["@mozilla.org/consoleservice;1"].getService(Components.interfaces.nsIConsoleService);
		consoleService.logStringMessage("com.morac.gSessionManager.openOptions() does not exist, please call com.morac.SessionManagerAddon.gSessionManager.openOptions()");
		obj.gSessionManager.openOptions();
	}
}

window.addEventListener("load", obj.gSessionManagerWindowObject.onLoad_proxy, false);

})()