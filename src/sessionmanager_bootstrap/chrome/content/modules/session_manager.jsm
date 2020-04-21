"use strict";

this.EXPORTED_SYMBOLS = ["gSessionManager"];
						
const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

// Observers to register for once.
const OBSERVING = ["browser:purge-session-history", "quit-application-requested", "quit-application-granted"];

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

// Session Manager modules
XPCOMUtils.defineLazyModuleGetter(this, "AddonInfo", "chrome://sessionmanager/content/modules/shared_data/addonInfo.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PasswordManager", "chrome://sessionmanager/content/modules/password_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionDataProcessing", "chrome://sessionmanager/content/modules/session_data_processing.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "chrome://sessionmanager/content/modules/sql_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

// Define getter for SessionStore and SessionStartup here. 
XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 
XPCOMUtils.defineLazyGetter(this, "SessionStartup", function() { return Utils.SessionStartup; }); 

this.gSessionManager = {
/* ........ Menu Event Handlers .............. */
	
	init: function(aPopup) {
		return Private.init(aPopup);
	},
	
	// Called from Session Prompt window when not in modal mode
	sessionPromptCallBack: function(aCallbackData) {
		return Private.sessionPromptCallBack(aCallbackData);
	},

	abandonSession: function(aWindow, aQuiet) {
		return Private.abandonSession(aWindow, aQuiet);
	},
	
	openFolder: function() {
		return Private.openFolder();
	},

	openOptions: function() {
		return Private.openOptions();
	},
	
/* ........ Undo Menu Event Handlers .............. */
	
	initUndo: function(aPopup, aStandAlone) {
		return Private.initUndo(aPopup, aStandAlone);
	},
	
	undoCloseWindow: function(aWindow, aIx, aMode) {
		return Private.undoCloseWindow(aWindow, aIx, aMode);
	},
	
	commandSessionManagerMenu: function(event) {
		return Private.commandSessionManagerMenu(event);
	},
	
	clickSessionManagerMenu: function(event) {
		return Private.clickSessionManagerMenu(event);
	},
	
	removeUndoMenuItem: function(aTarget) {
		return Private.removeUndoMenuItem(aTarget);
	},
	
/* ........ Right click menu handlers .............. */
	
	group_popupInit: function(aPopup) {
		return Private.group_popupInit(aPopup);
	},
	
	group_rename: function(aWindow) {
		return Private.group_rename(aWindow);
	},
	
	group_remove: function(aWindow) {
		return Private.group_remove(aWindow);
	},
	
	session_popupInit: function(aPopup) {
		return Private.session_popupInit(aPopup);
	},
	
	session_close: function(aWindow, aOneWindow, aAbandon) {
		return Private.session_close(aWindow, aOneWindow, aAbandon);
	},
	
	session_load: function(aWindow, aReplace, aOneWindow) {
		return Private.session_load(aWindow, aReplace, aOneWindow);
	},
	
	session_replace: function(aWindow, aOneWindow) {
		return Private.session_replace(aWindow, aOneWindow);
	},

	session_rename: function(aWindow) {
		return Private.session_rename(aWindow);
	},
	
	session_remove: function(aWindow) {
		return Private.session_remove(aWindow);
	},
	
	session_setStartup: function(aWindow) {
		return Private.session_setStartup(aWindow);
	},
	
	deleted_session_delete: function(aWindow, aFileName) {
		return Private.deleted_session_delete(aWindow, aFileName);
	},

/* ........ Miscellaneous Enhancements .............. */
	
	shutDown: function() {
		return Private.shutDown();
	},
	
	tryToSanitize: function() {
		return Private.tryToSanitize();
	},

	recoverSession: function(aWindow) {
		return Private.recoverSession(aWindow);
	},
	
	checkBackupTimer: function() {
		return Private.checkBackupTimer();
	},
	
	doResumeCurrent: function() {
		return Private.doResumeCurrent();
	},
	
	isCleanBrowser: function(aBrowser) {
		return Private.isCleanBrowser(aBrowser);
	},
}

// No changes allowed
Object.freeze(gSessionManager);

let Private = {

	// Timer data
	_autosave_timer: null,
	_backup_timer: null,
	_old_backup_every_time: 0,

	// Flag used to ignore changes to encrypt_session preference
	ignore_encrypt_sessions_preference_change: false,
	
	// Set to true if Session Manager sanitized all sessions on shutdown
	shutDownSanitized: false,

	initialize: function(extensions)
	{
		log("gSessionManager initialize start", "TRACE");

		// Not supported
		if (!SessionStore || !SessionStartup) {
			this.uninstall();
			return;
		}
		
		// Send unload function to bootstrap.js
		let subject = { wrappedJSObject: Private.uninitialize };
		Services.obs.notifyObservers(subject, "session-manager-unload", null);
		
		// Save title for when shutting down
		SharedData.old_mTitle = SharedData.mTitle = Utils._string("sessionManager");
		
		// split out name and group if application just started or just upgraded/downgraded
		// otherwise clear preference
		if (SharedData.justStartedUpDowngraded)
			Utils.getAutoSaveValues(PreferenceManager.get("_autosave_values", ""));
		else 
			PreferenceManager.delete("_autosave_values");
		
		// Add observers
		PreferenceManager.observe("", this, true);
		OBSERVING.forEach(function(aTopic) {
			Services.obs.addObserver(this, aTopic, true);
		}, this);
		
		log("gSessionManager initialize end", "TRACE");
	},
	
	uninitialize: function() {
		// remove observers
		PreferenceManager.unobserve("", Private);
		OBSERVING.forEach(function(aTopic) {
			Services.obs.removeObserver(Private, aTopic);			
		}, Private);
		
		// Stop timers
		if (Private._backup_timer) {
			log("Cancelling Backup timer because Session Manager disabled", "EXTRA");
			Private._backup_timer.cancel();
			Private._backup_timer = null;
			Private._old_backup_every_time = 0;
		}
		if (Private._autosave_timer) {
			log("Abandoning Autosave session because Session Manager disabled", "EXTRA");
			// Cancel auto-session timer and clear the preference
			Private._autosave_timer.cancel();
			Private._autosave_timer = null;
		}
		log("gSessionManager uninitialized", "TRACE");
	},
			
/* ........ Listeners / Observers.............. */

	// If SessionStore component does not exist hide Session Manager GUI and uninstall
	uninstall: function()
	{
		log("Uninstalling Because SessionStore does not exist", "INFO");
	
		let title = Utils._string("sessionManager");
		let text = Utils._string("not_supported");
		Services.prompt.alert(null, title, text);
		Components.utils.import("resource://gre/modules/AddonManager.jsm");
		AddonManager.getAddonByID(AddonInfo.id, function(addon) {
			addon.uninstall();
		});
	},
	
	observe: function(aSubject, aTopic, aData)
	{
		log("gSessionManager.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "browser:purge-session-history":
			SessionIo.clearUndoData("all");
			break;
		case "nsPref:changed":
			switch (aData)
			{
			case "backup_every":
			case "backup_every_time":
				this.checkBackupTimer();
				break;
			case "encrypt_sessions":
				if (!this.ignore_encrypt_sessions_preference_change) {
					// if already changing encryption and someone changes preference, revert change
					if (SharedData.mEncryptionChangeInProgress) {
						this.ignore_encrypt_sessions_preference_change = true;
						PreferenceManager.set("encrypt_sessions", !PreferenceManager.get("encrypt_sessions"));
						this.ignore_encrypt_sessions_preference_change = false;
					}
					else {
						// force a master password prompt so we don't waste time if user cancels it
						if (PasswordManager.enterMasterPassword()) 
							Services.obs.notifyObservers(null, "sessionmanager:encryption-change", "start");
						// failed to encrypt/decrypt so revert setting
						else {
							PreferenceManager.set("encrypt_sessions",!PreferenceManager.get("encrypt_sessions"));
							Utils.cryptError(Utils._string("change_encryption_fail"));
						}
					}
				}
				break;
			case "max_closed_undo":
				if (!PreferenceManager.get("use_SS_closed_window_list")) {
					if (PreferenceManager.get("max_closed_undo") == 0)
					{
						SessionIo.clearUndoData("window", true);
						Services.obs.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
					}
					else
					{
						let closedWindows = SessionIo.getClosedWindows_SM();
						if (closedWindows.length > PreferenceManager.get("max_closed_undo"))
						{
							SessionIo.storeClosedWindows_SM(closedWindows.slice(0, PreferenceManager.get("max_closed_undo")));
						}
					}
				}
				break;
			case "_autosave_values":
				// split out name and group
				let old_time = SharedData._autosave.time;
				Utils.getAutoSaveValues(PreferenceManager.get("_autosave_values"));
				this.checkAutoSaveTimer(old_time);
				Services.obs.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "use_SS_closed_window_list":
			case "click_restore_tab":
			case "hide_tools_menu":
			case "show_icon_in_menu":
			case "reload":
			case "session_name_in_titlebar":
			case "do_not_color_toolbar_button":
			case "display_menus_in_submenu":
			case "keys":
				// Use our own preference notification for notifying windows so we can trigger "updates" at will
				Services.obs.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "use_SQLite_cache":
				SQLManager.changeSQLCacheSetting();
				break;
			}
			break;
		case "quit-application-requested":
			// Save restart flag
			SharedData._browser_restarting = (aData == "restart");
			// If browser will restore windows and tabs next time
			SharedData._restore_requested = (aData == "restart") || this.doResumeCurrent();
			break;
		case "quit-application-granted":
			// quit granted so stop listening for closed windows
			SharedData._stopping = true;
			SharedData.mShutdownState = SessionDataProcessing.getSessionState(null, null, null, null, null, true);
			// remove observers
			PreferenceManager.unobserve("", this);
			OBSERVING.forEach(function(aTopic) {
				Services.obs.removeObserver(this, aTopic);			
			}, this);

			// Check to see if we need to sanitize sessions, if we did don't close auto-save sessions.
			// Shutdown function won't save either if sanitized.
			if (!SharedData._browser_restarting )
				this.shutDownSanitize();
			
			// Don't shutdown, if we've already done so (only occurs if shutdown on last window close is set)
			if (!SharedData.mAlreadyShutdown) {
				// only run shutdown for one window and if not restarting browser (or on restart is user wants)
				if (PreferenceManager.get("backup_on_restart") || !SharedData._browser_restarting )
				{
					this.shutDown();
				}
				else
				{
					// Save any active auto-save session, but leave it open.
					SessionIo.closeSession(false, false, true);
				}
			}
			break;
		// timer periodic call
		case "timer-callback":
			if (aSubject == this._autosave_timer) {
				// save auto-save session if open, but don't close it
				if (Utils.getBrowserWindows().length > 0) {
					log("Timer callback for autosave session timer", "EXTRA");
					SessionIo.closeSession(false, false, true);
				}
			}
			if (aSubject == this._backup_timer) {
				// save backup session regardless of backup setting
				if (Utils.getBrowserWindows().length > 0) {
					log("Timer callback for backup session timer", "EXTRA");
					SessionIo.backupCurrentSession(true);
				}
			}
			break;
		}
	},
	QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference, Ci.nsIObserver]),

/* ........ Menu Event Handlers .............. */

	init: function(aPopup)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }

		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
	
		let separator = get_("separator");
		let backupSep = get_("backup-separator");
		let startSep = get_("start-separator");
		let closer = get_("closer");
		let closerWindow = get_("closer_window");
		let abandon = get_("abandon");
		let abandonWindow = get_("abandon_window");
		let backupMenu = get_("backup-menu");
		let deletedMenu = get_("deleted-menu");
				
		for (let item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		// The first time this function is run after an item is added or removed from the browser toolbar
		// using the customize feature, the backupMenu.menupopup value is not defined.  This happens once for
		// each menu (tools menu and toolbar button).  Using the backupMenu.firstChild will work around this
		// Firefox bug, even though it technically isn't needed.
		let backupPopup = backupMenu.menupopup || backupMenu.firstChild; 
		while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
		
		// Delete items from end to start in order to not delete the two fixed menu items.
		let deletedPopup = deletedMenu.menupopup || deletedMenu.firstChild;
		while (deletedPopup.childNodes.length > 2) deletedPopup.removeChild(deletedPopup.childNodes[deletedPopup.childNodes.length - 1]);
		
		closer.hidden = abandon.hidden = !SharedData._autosave.filename;
		closerWindow.hidden = abandonWindow.hidden = !(window.__SSi in SharedData.mWindowSessionData);
		
		get_("autosave-separator").hidden = closer.hidden && closerWindow.hidden && abandon.hidden && abandonWindow.hidden;
		
		// Disable saving in private windows or if privacy is permanently enabled.
		let inPrivateBrowsing = Utils.isAutoStartPrivateBrowserMode() || !Utils.getBrowserWindows().length;
		let inPrivateBrowsingWindow = Utils.isPrivateWindow(window) || !Utils.getBrowserWindows().length;
		// Need to disable commands otherwise item isn't disabled.
		Utils.setDisabled(document.getElementById("cmd_session_manager_save"), inPrivateBrowsing);
		Utils.setDisabled(document.getElementById("cmd_session_manager_save_window"), inPrivateBrowsingWindow);
		
		let sessions = SessionIo.getSessions();
		let groupNames = [];
		let groupMenus = {};
		let count = 0;
		let backupCount = 0;
		let deletedCount = 0;
		let user_latest = false;
		let backup_latest = false;
		sessions.forEach(function(aSession, aIx) {
			if (!aSession.backup && !aSession.group && (PreferenceManager.get("max_display") >= 0) && (count >= PreferenceManager.get("max_display")))
				return;
	
			let key = (aSession.backup || aSession.group)?"":(++count < 10)?count:(count == 10)?"0":"";
			let disabled = SharedData.mActiveWindowSessions[aSession.fileName] || (aSession.fileName == SharedData._autosave.filename);
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("tooltiptext", menuitem.getAttribute("label"));
			menuitem.setAttribute("contextmenu", "sessionmanager-ContextMenu");
			menuitem.setAttribute("command", "cmd_session_manager_menu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("backup-item", aSession.backup);
			menuitem.setAttribute("sm_menuitem_type", "session");
			menuitem.setAttribute("accesskey", key);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			Utils.setDisabled(menuitem, disabled);
			menuitem.setAttribute("crop", "center");
			// only display one latest (even if two have the same timestamp)
			if (!(aSession.backup?backup_latest:user_latest) &&
			    ((aSession.backup?sessions.latestBackUpTime:sessions.latestTime) == aSession.timestamp)) {
				menuitem.setAttribute("latest", true);
				if (aSession.backup) backup_latest = true;
				else user_latest = true;
			}
			if (aSession.backup) {
				backupCount++;
				backupPopup.appendChild(menuitem);
			}
			else {
				if (aSession.group) {
					let groupMenu = groupMenus[aSession.group];
					if (!groupMenu) {
						groupMenu = document.createElement("menu");
						groupMenu.setAttribute("_id", aSession.group);
						groupMenu.setAttribute("label", aSession.group);
						groupMenu.setAttribute("tooltiptext", aSession.group);
						groupMenu.setAttribute("accesskey", aSession.group.charAt(0));
						groupMenu.setAttribute("contextmenu", "sessionmanager-groupContextMenu");
						let groupPopup = document.createElement("menupopup");
						groupPopup.addEventListener("popupshowing", function(event) { event.stopPropagation(); }, false);
						groupMenu.appendChild(groupPopup);
						
						groupNames.push(aSession.group);
						groupMenus[aSession.group] = groupMenu;
					}
					let groupPopup = groupMenu.menupopup || groupMenu.lastChild; 
					groupPopup.appendChild(menuitem);
				}
				else aPopup.insertBefore(menuitem, separator);
			}
		}, this);
		
		// Display groups in alphabetical order at the top of the list
		if (groupNames.length) {
			groupNames.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
			let insertBeforeEntry = startSep.nextSibling;
			
			groupNames.forEach(function(aGroup, aIx) {
				aPopup.insertBefore(groupMenus[aGroup], insertBeforeEntry);
			},this);
		}
		
		// Populate Deleted Sessions
		let deleted_sessions = SessionIo.getSessions(null, Utils.deletedSessionsFolder);
		deleted_sessions.forEach(function(aSession, aIx) {
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("tooltiptext", menuitem.getAttribute("label"));
			menuitem.setAttribute("contextmenu", "sessionmanager-deleted-ContextMenu");
			menuitem.setAttribute("command", "cmd_session_manager_menu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			menuitem.setAttribute("sm_menuitem_type", "deleted_session");
			menuitem.setAttribute("crop", "center");
			deletedCount++;
			deletedPopup.appendChild(menuitem);
		});
		
		backupMenu.hidden = (backupCount == 0);
		deletedMenu.hidden = (deletedCount == 0)
		backupSep.hidden = backupMenu.hidden && deletedMenu.hidden;
		
		let undoMenu = get_("undo-menu");
		while (aPopup.lastChild != undoMenu)
		{
			aPopup.removeChild(aPopup.lastChild);
		}
		
		let undoDisabled = ((PreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true) == 0) &&
		                    ((!PreferenceManager.get("use_SS_closed_window_list") && (PreferenceManager.get("max_closed_undo") == 0)) ||
							 (PreferenceManager.get("use_SS_closed_window_list") && (PreferenceManager.get("browser.sessionstore.max_windows_undo", 10, true) == 0))));
		// don't show undo menu items if in toolbarbutton menu and undo button is visible
		// In SeaMonkey the undo toolbar exists in toolbarpallete even when not displayed so check to make sure it's actually in a toolbar.
		let divertedMenu = (aPopup.parentNode.localName == "toolbarbutton") && document.getElementById("sessionmanager-undo") && 
		                   (document.getElementById("sessionmanager-undo").parentNode.localName == "toolbar");
		let canUndo = !undoDisabled && !divertedMenu && this.initUndo(undoMenu.firstChild);
		
		undoMenu.hidden = undoDisabled || divertedMenu || !PreferenceManager.get("submenus") || !canUndo;
		startSep.hidden = (PreferenceManager.get("max_display") == 0) || ((sessions.length - backupCount) == 0);
		separator.hidden = (!canUndo && undoMenu.hidden);
		Utils.setDisabled(undoMenu, !canUndo);
		// Need to disable commands otherwise item isn't disabled.
		Utils.setDisabled(document.getElementById("cmd_session_manager_load"), !sessions.length);
		Utils.setDisabled(document.getElementById("cmd_session_manager_rename"), !sessions.length);
		Utils.setDisabled(document.getElementById("cmd_session_manager_delete"), !sessions.length);
		Utils.setDisabled(document.getElementById("cmd_session_manager_group"), !sessions.length);
		
		if (!PreferenceManager.get("submenus") && canUndo)
		{
			for (let item = undoMenu.firstChild.firstChild; item; item = item.nextSibling)
			{
				aPopup.appendChild(item.cloneNode(true));
				
				// Event handlers aren't copied so need to set them up again to display status bar text
				if (item.getAttribute("statustext")) {
					aPopup.lastChild.addEventListener("DOMMenuItemActive", Private.ToggleDisplayOfURL, false);
					aPopup.lastChild.addEventListener("DOMMenuItemInactive",  Private.ToggleDisplayOfURL, false);
				}
			}
		}
	},

	// Called from Session Prompt window when not in modal mode
	sessionPromptCallBack: function(aCallbackData) {
		let window = aCallbackData.window__SSi ? Utils.getWindowBySSI(aCallbackData.window__SSi) : null;
		let writing_file = true;
	
		switch(aCallbackData.type) {
			case "save":
				SessionIo.save(
					window,
					SharedData.sessionPromptReturnData.sessionName,
					SharedData.sessionPromptReturnData.filename,
					SharedData.sessionPromptReturnData.groupName,
					aCallbackData.oneWindow,
					{ append: SharedData.sessionPromptReturnData.append,
					  autoSave: SharedData.sessionPromptReturnData.autoSave,
					  autoSaveTime: SharedData.sessionPromptReturnData.autoSaveTime,
					  sessionState: SharedData.sessionPromptReturnData.sessionState
					}
				);
				break;
			case "load":
				SessionIo.load(
					window,
					SharedData.sessionPromptReturnData.filename, 
					SharedData.sessionPromptReturnData.append ? "newwindow" : (SharedData.sessionPromptReturnData.append_window ? "append" : "overwrite"),
					SharedData.sessionPromptReturnData.sessionState
				);
				writing_file = false;
				break;
			case "group":
				SessionIo.group(SharedData.sessionPromptReturnData.filename,SharedData.sessionPromptReturnData.groupName);
				break;
			case "rename":
				SessionIo.rename(SharedData.sessionPromptReturnData.filename, SharedData.sessionPromptReturnData.sessionName);
				break;
			case "delete":
				SessionIo.remove(SharedData.sessionPromptReturnData.filename, SharedData.sessionPromptReturnData.sessionState);
				break;
		}
		
		return writing_file;
	},

	abandonSession: function(aWindow, aQuiet)
	{
		let dontPrompt = { value: false };
		if (aQuiet || PreferenceManager.get("no_abandon_prompt") || Services.prompt.confirmEx(null, SharedData.mTitle, Utils._string("abandom_prompt"), Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1, null, null, null, Utils._string("prompt_not_again"), dontPrompt) == 0)
		{
			if (aWindow) {
				Utils.getAutoSaveValues(null, aWindow);
			}
			else {
				PreferenceManager.set("_autosave_values","");
			}
			if (dontPrompt.value)
			{
				PreferenceManager.set("no_abandon_prompt", true);
			}
		}
	},

	openFolder: function()
	{
		let dir = SessionIo.getSessionDir();
		if (dir && dir.exists() && dir.isDirectory()) {
			try {
				// "Double click" the session directory to open it
				dir.launch();
			} catch (e) {
				try {
					// If launch also fails (probably because it's not implemented), let the
					// OS handler try to open the session directory
					let uri = Services.io.newFileURI(dir);
					let protocolSvc = Cc["@mozilla.org/uriloader/external-protocol-service;1"].
														getService(Ci.nsIExternalProtocolService);
					protocolSvc.loadUrl(uri);
				}
				catch (ex)
				{
					Utils.ioError(ex, dir.path);
				}
			}
		}
	},

	openOptions: function()
	{
		let dialog = Utils.getMostRecentWindow("SessionManager:Options");
		if (dialog)
		{
			dialog.focus();
			return;
		}
		
		Utils.openWindow("chrome://sessionmanager/content/options/options.xul", "chrome,titlebar,toolbar,centerscreen,dialog=no", 
		                null, Utils.getMostRecentWindow());
		
	},

/* ........ Undo Menu Event Handlers .............. */

	// Overlink is used in all versions of Firefox and SeaMonkey to set the link status.  In SeaMonkey, it sets the 
	// status bar text.  In Firefox it shows a popup status entry at the bottom of the window.
	ToggleDisplayOfURL: function(event) 
	{
		switch(event.type) {
			case "DOMMenuItemActive":
				this.ownerDocument.defaultView.XULBrowserWindow.setOverLink(this.getAttribute("statustext"));
				break;
			case "DOMMenuItemInactive":
				this.ownerDocument.defaultView.XULBrowserWindow.setOverLink('');
				break;
		} 
	},

	initUndo: function(aPopup, aStandAlone)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
	
		let separator = get_("closed-separator");
		let label = get_("windows");
		
		for (let item = separator.previousSibling; item != label; item = separator.previousSibling)
		{
			aPopup.removeChild(item);
		}
		
		let defaultIcon = (Services.appinfo.name.toUpperCase() == "SEAMONKEY") ? "chrome://sessionmanager/skin/bookmark-item.png" :
		                                                            "chrome://sessionmanager/skin/defaultFavicon.png";
		
		let encrypt_okay = true;
		// make sure user enters master password if using sessionmanager.dat
		if (!PreferenceManager.get("use_SS_closed_window_list") && PreferenceManager.get("encrypt_sessions") && !PasswordManager.enterMasterPassword()) {
			encrypt_okay = false;
			Utils.cryptError(Utils._string("decrypt_fail2"));
		}
		
		let number_closed_windows = 0;
		if (encrypt_okay) {
			let badClosedWindowData = false;
			let closedWindows = SessionIo.getClosedWindows();
			closedWindows.forEach(function(aWindow, aIx) {
				// Try to decrypt is using sessionmanager.dat, if can't then data is bad since we checked for master password above
				let state = PreferenceManager.get("use_SS_closed_window_list") ? aWindow.state : Utils.decrypt(aWindow.state, true);
				if (!state && !PreferenceManager.get("use_SS_closed_window_list")) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = "crypt_error";
					return;
				}
				state = Utils.JSON_decode(state, true);
			
				// detect corrupt sessionmanager.dat file
				if (state._JSON_decode_failed && !PreferenceManager.get("use_SS_closed_window_list")) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = state._JSON_decode_error;
					return;
				}
				// Get favicon
				let image = defaultIcon;
				if (state.windows[0].tabs.length > 0) {
					if (state.windows[0].tabs[0].attributes && state.windows[0].tabs[0].attributes.image)
					{
						image = state.windows[0].tabs[0].attributes.image;
					}
					else if (state.windows[0].tabs[0].image) 
					{
						image = state.windows[0].tabs[0].image;
					}
				}
				// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
				// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
				// use the work around for https.
				if (/^https:/.test(image)) {
					image = "moz-anno:favicon:" + image;
				}
			
				// Get tab count
				let count = state.windows[0].tabs.length;
				let menuitem = document.createElement("menuitem");
				menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
				menuitem.setAttribute("label", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("tooltiptext", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("index", "window" + aIx);
				menuitem.setAttribute("image", image);
				menuitem.setAttribute("sm_menuitem_type", "closed_wintab");
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
				menuitem.setAttribute("command", "cmd_session_manager_menu");
				menuitem.setAttribute("crop", "center");
				aPopup.insertBefore(menuitem, separator);
			}, this);
		
			// Remove any bad closed windows
			if (badClosedWindowData)
			{
				let error = null;
				for (let i=0; i < closedWindows.length; i++)
				{
					if (closedWindows[i]._decode_error)
					{
						error = closedWindows[i]._decode_error;
						closedWindows.splice(i, 1);
						SessionIo.storeClosedWindows_SM(closedWindows);
						// Do this so we don't skip over the next entry because of splice
						i--;
					}
				}
				if (error == "crypt_error") {
					Utils.cryptError(Utils._string("decrypt_fail1"));
				}
				else {
					Utils.sessionError(error, Constants.CLOSED_WINDOW_FILE);
				}
			}
			
			number_closed_windows = closedWindows.length;
		}
		
		label.hidden = !encrypt_okay || (number_closed_windows == 0);
		
		let listEnd = get_("end-separator");
		for (let item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		let closedTabs = SessionStore.getClosedTabData(window);
		let mClosedTabs = [];
		closedTabs = Utils.JSON_decode(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null, 
								url:aValue.state.entries[aValue.state.entries.length - 1].url }
			// Get favicon
			mClosedTabs[aIndex].image = defaultIcon;
			if (aValue.state.attributes && aValue.state.attributes.image)
			{
				mClosedTabs[aIndex].image = aValue.state.attributes.image;
			}
			else if (aValue.state.image) 
			{
				mClosedTabs[aIndex].image = aValue.state.image;
			}
			// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
			// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
			// use the work around for https.
			if (/^https:/.test(mClosedTabs[aIndex].image)) {
				mClosedTabs[aIndex].image = "moz-anno:favicon:" + mClosedTabs[aIndex].image;
			}
		}, this);

		mClosedTabs.forEach(function(aTab, aIx) {
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
			menuitem.setAttribute("image", aTab.image);
			menuitem.setAttribute("label", aTab.title);
			menuitem.setAttribute("tooltiptext", aTab.title + "\n" + aTab.url);
			menuitem.setAttribute("index", "tab" + aIx);
			menuitem.setAttribute("statustext", aTab.url);
			menuitem.setAttribute("sm_menuitem_type", "closed_wintab");
			menuitem.setAttribute("crop", "center");
			menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			menuitem.setAttribute("command", "cmd_session_manager_menu");
			menuitem.addEventListener("DOMMenuItemActive", Private.ToggleDisplayOfURL, false);
			menuitem.addEventListener("DOMMenuItemInactive",  Private.ToggleDisplayOfURL, false);
			aPopup.insertBefore(menuitem, listEnd);
		}, this);
		
		separator.nextSibling.hidden = get_("clear_tabs").hidden = (mClosedTabs.length == 0);
		separator.hidden = get_("clear_windows").hidden = get_("clear_tabs").hidden = separator.nextSibling.hidden || label.hidden;

		let showPopup = number_closed_windows + mClosedTabs.length > 0;
		
		if (aStandAlone && !showPopup) {
			Services.obs.notifyObservers(window, "sessionmanager:update-undo-button", "{\"type\":\"window\", \"value\": \"false\"}");
			Utils.runAsync(function() { this.parentNode.open = false; }, aPopup);
		}

		return showPopup;
	},

	undoCloseWindow: function(aWindow, aIx, aMode)
	{
		let closedWindows = SessionIo.getClosedWindows();
		if (closedWindows[aIx || 0])
		{
			let state = closedWindows.splice(aIx || 0, 1)[0].state;
			
			// If no window passed in or not a real window (no windows open), make sure aMode is not overwrite or append and don't show session prompt
			if (!aWindow || (aWindow.location.href == "chrome://browser/content/hiddenWindow.xul")) {
				aMode = null;
				aWindow = null;
				SharedData._no_prompt_for_session = true;
			}
			// Tab Mix Plus's single window mode is active
			else if (SharedData.tabMixPlusEnabled && PreferenceManager.get("extensions.tabmix.singleWindow", false, true)) 
				aMode = "append";

			if (aMode == "overwrite")
			{
				Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			// If using SessionStore closed windows list and doing a normal restore, just use SessionStore API
			if (PreferenceManager.get("use_SS_closed_window_list") && (aMode != "append") && (aMode != "overwrite")) {
				SessionStore.undoCloseWindow(aIx);
			}
			else {
				let okay = SessionDataProcessing.restoreSession((aMode == "overwrite" || aMode == "append")?aWindow:null, state, aMode != "append");
				if (okay) {
					SessionIo.storeClosedWindows(aWindow, closedWindows, aIx);
					Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
				}
			}
		}
	},
	
	commandSessionManagerMenu: function(event)
	{
		// Prevent toolbar button handling this event
		event.stopPropagation();
		
		// If a dynamic menu item process it
		let type = event.target.getAttribute("sm_menuitem_type");

		if (type)
			this.processSessionManagerMenuItem(type, 0, event);
	},
	
	clickSessionManagerMenu: function(event)
	{
		// Prevent toolbar button handling this event
		event.stopPropagation();
		
		// For some reason splitmenu won't trigger "command" event so handle it here
		if (event.target.localName == "splitmenu") {
			SessionIo.load(event.view);
		}
		else {
			// If middle clicking on any dynamic menu item or right clicking on a closed window or tab item or deleted session, process it
			let type = event.target.getAttribute("sm_menuitem_type");
			if ((type && (event.button == 1)) || ((event.button == 2) && ((type == "closed_wintab") || (type == "deleted_session")))) 
				this.processSessionManagerMenuItem(type, event.button, event);
		}
	},
	
	processSessionManagerMenuItem: function(type, button, event) {
		let ctrl_keys = (event.ctrlKey || event.metaKey);
		let filename = event.target.getAttribute("filename");
		let middle_click =(button == 1);
		// Take action depending on the menu item type
		switch(type) {
			case "deleted_session":
				// Restore clicked menu item if it is a deleted session, or delete if ctrl right click it
				if (filename) {
					if (button != 2) {
						let file = SessionIo.getSessionDir(Utils.deletedSessionsFolder);
						file.append(filename);
						SessionIo.restoreDeletedSessionFile(file);
						// If middle click, menu doesn't close so update the menu
						if (middle_click) {
							let popup = event.target.parentNode.parentNode.parentNode;
							this.init(popup, popup.id == "sessionmanager-toolbar-popup");
						}
					}
					else if (ctrl_keys) {
						this.deleted_session_delete(null, filename);
						// remove from menu
						event.target.parentNode.removeChild(event.target);
						event.preventDefault();
					}
				}
				break;
			case "session":
				if (filename) 
					SessionIo.load(event.view, filename, (!middle_click && event.shiftKey && ctrl_keys)?"overwrite":(middle_click || event.shiftKey)?"newwindow":(ctrl_keys)?"append":"");
				// Middle click doesn't hide the popup, so hide it manually
				if (middle_click) 
					event.target.parentNode.hidePopup(); 
				break;
			case "closed_wintab":
				this.processClosedUndoMenuItem(event, button);
			default:
				break;
		}
	},

	processClosedUndoMenuItem: function(event, button) 
	{
		// if ctrl/command right click, ignore so context-menu opens.
		if (button == 2)
		{
			// If also press ctrl or meta key, remove the item and prevent context-menu from opening
			if (event.ctrlKey || event.metaKey) {
				this.removeUndoMenuItem(event.target);
				// Don't show context menu
				event.preventDefault();
			}
			return;
		}

		// Find index of item clicked
		let match_array = event.target.getAttribute("index").match(/^(window|tab)(\d+)$/);
		if (match_array) {
			let tabWindow = match_array[1];
			let aIx = match_array[2];
			
			// If middle click and closed tab, restore it without closing menu
			let window = event.view;
			if (tabWindow == "tab") {
				Services.obs.notifyObservers(window, "sessionmanager:reopen-tab", aIx);
			}	
			else {
				this.undoCloseWindow(window, aIx, (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.ctrlKey || event.metaKey)?"append":"");
			}
			
			// If middle click, update list
			if (button == 1)
				this.updateClosedList(event.target, aIx, tabWindow);
		}
	},
	
	removeUndoMenuItem: function(aTarget)
	{	
		let window = aTarget.ownerDocument.defaultView;
			
		let aIx = null;
		let indexAttribute = aTarget.getAttribute("index");
		// removing window item
		if (indexAttribute.indexOf("window") != -1) {
			// get index
			aIx = indexAttribute.substring(6);
			
			// If using built in closed window list, use SessionStore method (doesn't exist in SeaMonkey).
			if (PreferenceManager.get("use_SS_closed_window_list") && (typeof SessionStore.forgetClosedWindow == "function")) {
				SessionStore.forgetClosedWindow(aIx);
				
				// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
				SessionStore.setWindowValue(window, "SM_dummy_value","1");
				SessionStore.deleteWindowValue(window, "SM_dummy_value");
			}
			else {
				// remove window from closed window list and tell other open windows
				let closedWindows = SessionIo.getClosedWindows();
				closedWindows.splice(aIx, 1);
				SessionIo.storeClosedWindows(window, closedWindows, aIx);
			}
			Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", "{\"type\":\"window\"}");

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "window");
		}
		// removing tab item
		else if (indexAttribute.indexOf("tab") != -1) {
			// get index
			aIx = indexAttribute.substring(3);

			SessionStore.forgetClosedTab(window, aIx);

			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(window, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(window, "SM_dummy_value");
			
			// Update toolbar button if no more tabs
			if (SessionStore.getClosedTabCount(window) == 0) 
			{
				Services.obs.notifyObservers(window, "sessionmanager:update-undo-button", "{\"type\":\"tab\"}");
			}

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "tab");
		}
	},
	
	updateClosedList: function(aMenuItem, aIx, aType) 
	{
		// Since main menu items are clones of submenu and below them try and return array entry 1 if it exists
		function get_(a_id) { 
			let elems = popup.getElementsByAttribute("_id", a_id);
			return elems[1] || elems[0] || null; 
		}
	
		// Get menu popup
		let popup = aMenuItem.parentNode;

		// remove item from list
		popup.removeChild(aMenuItem);
					
		// Hide popup if no more tabs, an empty undo popup contains 7 items (submenu and undo close toolbar only - see sessionmanager.xul file)
		if (popup.childNodes.length == 7) 
		{
			// Don't do this as it breaks the parent menu and it's not needed since popup hides anyway
			//popup.hidePopup();
		}
		// otherwise adjust indexes
		else 
		{
			for (let i=0; i<popup.childNodes.length; i++)
			{ 
				let index = popup.childNodes[i].getAttribute("index");
				if (index && index.substring(0,aType.length) == aType)
				{
					let indexNo = index.substring(aType.length);
					if (parseInt(indexNo) > parseInt(aIx))
					{
						popup.childNodes[i].setAttribute("index",aType + (parseInt(indexNo) - 1).toString());
					}
				}
			}
			
			let no_windows = get_("windows").nextSibling == get_("closed-separator");
			let no_tabs = get_("tabs").nextSibling == get_("end-separator");
			let main_separator = get_("separator");
			
			// If removed all of a specific type, hide that type header and footer menu items.
			// If removed everything (none sub-menu), hide all undo close related stuff
			get_("clear_windows").hidden = get_("clear_tabs").hidden = no_windows || no_tabs;
			get_("windows").hidden = get_("closed-separator").hidden = no_windows;
			get_("tabs").hidden = get_("end-separator").hidden = no_tabs;
			get_("clear_all").hidden = no_windows && no_tabs;
			if (main_separator)
				main_separator.hidden = no_windows && no_tabs;
		}
	},

/* ........ Right click menu handlers .............. */
	group_popupInit: function(aPopup) {
		let document = aPopup.ownerDocument.defaultView.document;
		let childMenu = document.popupNode.menupopup || document.popupNode.lastChild;
		childMenu.hidePopup();
	},
	
	group_rename: function(aWindow) {
		let filename = aWindow.document.popupNode.getAttribute("filename");
		let parentMenu = aWindow.document.popupNode.parentNode.parentNode;
		let group = filename ? ((parentMenu.id != "sessionmanager-toolbar" && parentMenu.id != "sessionmanager-menu" && parentMenu.id != "sessionmanager-appmenu") ? parentMenu.label : "")
		                     : aWindow.document.popupNode.getAttribute("label");
		let newgroup = { value: group };
		let dummy = {};
		Services.prompt.prompt(aWindow, Utils._string("rename_group"), null, newgroup, null, dummy);
		if (newgroup.value == Utils._string("backup_sessions")) {
			Services.prompt.alert(aWindow, SharedData.mTitle, Utils._string("rename_fail"));
			return;
		}
		else if (newgroup.value != group) {
			// changing group for one session or multiple sessions?
			if (filename) SessionIo.group(filename, newgroup.value);
			else {
				let sessions = SessionIo.getSessions();
				sessions.forEach(function(aSession) {
					if (!aSession.backup && (aSession.group == group)) {
						SessionIo.group(aSession.fileName, newgroup.value);
					}
				}, this);
			}
		}
	},
	
	group_remove: function(aWindow) {
		let group = aWindow.document.popupNode.getAttribute("label");
		if (Services.prompt.confirm(aWindow, SharedData.mTitle, Utils._string("delete_confirm_group"))) {
			
			let sessions = SessionIo.getSessions();
			let sessionsToDelete = [];
			sessions.forEach(function(aSession) {
				if (!aSession.backup && (aSession.group == group)) {
					sessionsToDelete.push(aSession.fileName);
				}
			}, this);
			if (sessionsToDelete.length) {
				sessionsToDelete = sessionsToDelete.join("\n");
				SessionIo.remove(sessionsToDelete);
			}
		}
	},

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		let document = aPopup.ownerDocument.defaultView.document;
		
		let current = (document.popupNode.getAttribute("disabled") == "true");
		let autosave = document.popupNode.getAttribute("autosave");
		let replace = get_("replace");
		
		replace.hidden = (Utils.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode or loaded auto-save session
		let inPrivateBrowsing = Utils.isAutoStartPrivateBrowserMode() || !Utils.getBrowserWindows().length;
		Utils.setDisabled(replace, (inPrivateBrowsing || current));
		Utils.setDisabled(get_("replace_window"), (inPrivateBrowsing || current));
		
		// Disable almost everything for currently loaded auto-save session
		Utils.setDisabled(get_("load_append_window"), current);
		Utils.setDisabled(get_("load_append"), current);
		Utils.setDisabled(get_("load_replace"), current);

		// Hide change group choice for backup items		
		get_("changegroup").hidden = (document.popupNode.getAttribute("backup-item") == "true")
		
		// Hide option to close or abandon sessions if they aren't loaded
		get_("closer").hidden = get_("abandon").hidden = !current || (autosave != "session");
		get_("closer_window").hidden = get_("abandon_window").hidden = !current || (autosave != "window");
		get_("close_separator").hidden = get_("closer").hidden && get_("closer_window").hidden;
		
		// Disable setting startup if already startup
		Utils.setDisabled(get_("startup"), ((PreferenceManager.get("startup") == 2) && (document.popupNode.getAttribute("filename") == PreferenceManager.get("resume_session"))));
		
		// If Tab Mix Plus's single window mode is enabled, hide options to load into new windows
		get_("load_append").hidden = (SharedData.tabMixPlusEnabled && PreferenceManager.get("extensions.tabmix.singleWindow", false, true));
	},

	session_close: function(aWindow, aOneWindow, aAbandon) {
		if (aOneWindow) {
			let document = aWindow.document;
			let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
			abandonBool.data = (aAbandon == true);
			Services.obs.notifyObservers(abandonBool, "sessionmanager:close-windowsession", document.popupNode.getAttribute("filename"));
		}
		else {
			if (aAbandon) this.abandonSession();
			else SessionIo.closeSession();
		}
	},
	
	session_load: function(aWindow, aReplace, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		SessionIo.load(aWindow, session, (aReplace?"overwrite":(aOneWindow?"append":"newwindow")));
	},
	
	session_replace: function(aWindow, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		let parent = document.popupNode.parentNode.parentNode;
		let group = null;
		if (parent.id.indexOf("sessionmanager-") == -1) {
			group = parent.label;
		}
		if (aOneWindow) {
			SessionIo.saveWindow(aWindow, SessionIo.mSessionCache[session].name, session, group);
		}
		else {
			SessionIo.save(aWindow, SessionIo.mSessionCache[session].name, session, group);
		}
	},
	
	session_rename: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		SessionIo.rename(session);
	},

	session_remove: function(aWindow) {
		let dontPrompt = { value: false };
		let session = aWindow.document.popupNode.getAttribute("filename");
		if (PreferenceManager.get("no_delete_prompt") || Services.prompt.confirmEx(aWindow, SharedData.mTitle, Utils._string("delete_confirm"), Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1, null, null, null, Utils._string("prompt_not_again"), dontPrompt) == 0) {
			SessionIo.remove(session);
			if (dontPrompt.value) {
				PreferenceManager.set("no_delete_prompt", true);
			}
		}
	},
	
	session_setStartup: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		PreferenceManager.set("resume_session", session);
		PreferenceManager.set("startup", 2);
		
		// Update options window if open
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		if (window) {
			window.updateSpecialPreferences();
			window.disableApply();
		}
	},
	
	deleted_session_delete: function(aWindow, aFileName) {
		let file = SessionIo.getSessionDir(Utils.deletedSessionsFolder);
		file.append(aFileName || aWindow.document.popupNode.getAttribute("filename"));
		SessionIo.delFile(file, false, true);
	},
	
/* ........ Miscellaneous Enhancements .............. */

	shutDown: function()
	{
		log("gSessionManager:shutDown start", "TRACE");
		
		// Make a backup of the current autosave values for use at startup if resuming last session
		if (PreferenceManager.has("_autosave_values"))
			PreferenceManager.set("_backup_autosave_values", PreferenceManager.get("_autosave_values"));
		
		// Don't save if just deleted all sessions
		if (!this.shutDownSanitized)
		{
			// If preference to clear save windows or using SessionStore closed windows, delete our closed window list
			if (!PreferenceManager.get("save_window_list") || PreferenceManager.get("use_SS_closed_window_list"))
			{
				SessionIo.clearUndoData("window", true);
			}
			
			// If user chose to not save the sesssion for resuming and options set to resume backup session, don't automatically resume the last auto-save session.
			if ((PreferenceManager.get("startup") == 2) && (PreferenceManager.get("resume_session") == Constants.BACKUP_SESSION_FILENAME) && (SharedData.mShutdownPromptResults == 1))
				PreferenceManager.set("_no_restore_autosave", true);
		
			// If not in permanent private browsing, save the currently opened session (if there is one) otherwise backup
			// Only do backup processing if a browser window actually displayed (ie browser didn't exit before window displayed)
			if (!Utils.isAutoStartPrivateBrowserMode() && !SessionIo.closeSession(false))
			{
				if (SharedData._browserWindowDisplayed) SessionIo.backupCurrentSession();
			}
			else
			{
				if (SharedData._browserWindowDisplayed) SessionIo.keepOldBackups(false);
			}
			
			// Remove all auto_save sessions
			let sessions = SessionIo.getSessions(Constants.AUTO_SAVE_SESSION_REGEXP, false, true);
			sessions.forEach(function(aSession) {
				SessionIo.delFile(SessionIo.getSessionDir(aSession.fileName), true, true);
			});
		}
		
		PreferenceManager.delete("_autosave_values");
		SharedData.mClosingWindowState = null;
		SharedData.mTitle = SharedData.old_mTitle;
		SharedData._screen_width = null;
		SharedData._screen_height = null;
		
		// Allow prompting to occur now
		SharedData.justStartedUpDowngraded = true;

		// Cleanup left over files from Crash Recovery
		if (PreferenceManager.get("extensions.crashrecovery.resume_session_once", false, true))
		{	
			SessionIo.delFile(SessionIo.getProfileFile("crashrecovery.dat"), true, true);
			SessionIo.delFile(SessionIo.getProfileFile("crashrecovery.bak"), true, true);
			PreferenceManager.delete("extensions.crashrecovery.resume_session_once", true);
		}
		SharedData._running = false;
		log("gSessionManager:shutDown end", "TRACE");
	},

	// Called to sanitize sessions on browser shutdown (and not a restart)
	shutDownSanitize: function() {
		// Handle sanitizing if sanitize on shutdown without prompting (only SeaMonkey ever prompts)
		let prompt = PreferenceManager.get("privacy.sanitize.promptOnSanitize", null, true);
		let sanitize = (PreferenceManager.get("privacy.sanitize.sanitizeOnShutdown", false, true) && 
		               (((prompt == false) && PreferenceManager.get("privacy.item.extensions-sessionmanager", false, true)) ||
		                ((prompt == null) && PreferenceManager.get("privacy.clearOnShutdown.extensions-sessionmanager", false, true))));
						
		if (sanitize)
		{
			SessionIo.sanitize();
			this.shutDownSanitized = true;
		}
	},
	
	// Called to handle clearing of private data (stored sessions) when the toolbar item is selected
	// and when the clear now button is pressed in the privacy options pane.  If the option to promptOnSanitize
	// is set, this function ignores the request and let's the SeaMonkey Sanitize function call
	// gSessionManager.santize when Clear Private Data okay button is pressed and Session Manager's checkbox
	// is selected.  This is only called in SeaMonkey.
	tryToSanitize: function()
	{
		// User disabled the prompt before clear option and session manager is checked in the privacy data settings
		if ( !PreferenceManager.get("privacy.sanitize.promptOnSanitize", true, true) &&
			 PreferenceManager.get("privacy.item.extensions-sessionmanager", false, true) ) 
		{
			SessionIo.sanitize();
			return true;
		}
	
		return false;
	},
	
	// This returns an autosave session that was saved when the browser shut instead of the normal backup session
	getAutoSaveSessionNewerThanLastBackupSession: function()
	{
		let session = null;
		let sessions = SessionIo.getSessions();
		// if latest user saved session newer than latest backup session
		if (sessions.latestBackUpTime < sessions.latestTime) {
			// find latest session if it's an autosave session
			session = sessions.filter(function(element, index, array) {  
				return ((sessions.latestTime == element.timestamp) && /^session/.exec(element.autosave));  
			})[0];
			if (session) 
				session = session.fileName;
		}
		return session;
	},
		
	recoverSession: function(aWindow)
	{
		let file, temp_restore = null, first_temp_restore = null, temp_restore_index = 1;
		// Use SessionStart's value because preference is cleared by the time we are called
		let sessionstart = !SharedData.mAlreadyShutdown && (SharedData._browserCrashed || SessionStartup.doRestore()) ;
		let recoverOnly = SharedData._running || sessionstart || SharedData._no_prompt_for_session;
		SharedData._no_prompt_for_session = false;
		SharedData._browserCrashed = false;
		log("recoverSession: recovering = " + (SharedData._recovering ? SharedData._recovering.fileName : "null") + ", sessionstart = " + sessionstart + ", recoverOnly = " + recoverOnly, "DATA");
		if (typeof(SharedData._temp_restore) == "string") {
			log("recoverSession: command line session data = \"" + SharedData._temp_restore + "\"", "DATA");
			temp_restore = SharedData._temp_restore.split("\n");
			first_temp_restore = temp_restore[1];
		}
		SharedData._temp_restore = null;

		// handle crash where user chose a specific session
		if (SharedData._recovering)
		{
			let recovering = SharedData._crash_session_filename = SharedData._recovering.fileName;
			let sessionState = SharedData._recovering.sessionState;
			SharedData._recovering = null;
			SessionIo.load(aWindow, recovering, "startup", sessionState);
			// Clear out return data and preset to not accepting
			SharedData.sessionPromptReturnData = null;
		}
		else if (!recoverOnly && (PreferenceManager.get("restore_temporary") || first_temp_restore || (PreferenceManager.get("startup") == 1) || ((PreferenceManager.get("startup") == 2) && PreferenceManager.get("resume_session"))) && (SessionIo.getSessions().length > 0))
		{
			// allow prompting for tabs.  
			let values = { ignorable: true, preselect: PreferenceManager.get("preselect_previous_session"), no_parent_window: true, startupPrompt: true };
			
			// Order preference:
			// 1. Temporary backup session
			// 2. Prompt or selected session
			// 3. Command line session.
			let session = (PreferenceManager.get("restore_temporary")?Constants.BACKUP_SESSION_FILENAME:((PreferenceManager.get("startup") == 1)?Utils.selectSession(Utils._string("resume_session"), Utils._string("resume_session_ok"), values):
			              ((PreferenceManager.get("startup") == 2)?PreferenceManager.get("resume_session"):first_temp_restore)));
			// If no session chosen to restore, use the command line specified session
			if (!session) session = first_temp_restore;
			if (session && (session == first_temp_restore)) {
				log("recoverSession: Restoring startup command line session or chosen session \"" + first_temp_restore + "\"", "DATA");
				// Go to next command line item if it exists
				temp_restore_index++;
			}
			log("recoverSession: Startup session = " + session, "DATA");
			// If restoring backup session and we already shutdown (meaning last closed window closed but browser did not exit) simply unclose the last window
			if (SharedData.mAlreadyShutdown && (session == Constants.BACKUP_SESSION_FILENAME)) {
				log("recoverSession: Opening last closed window or let browser do it", "TRACE");
				// If browser preference set to restore windows and tabs, don't do anything as the browser will take care of restoring the window.
				if (!this.doResumeCurrent())
					this.undoCloseWindow();
			}
			else if (session && (file = SessionIo.getSessionDir(session)) && (file.exists() || (session == Constants.BACKUP_SESSION_FILENAME)))
			{
				// If user chooses to restore backup session, but there is no backup session, then an auto-save session was open when 
				// browser closed so restore that.  Don't restore an auto-save session if user chose to quit without saving on exit.
				if (session == Constants.BACKUP_SESSION_FILENAME) {
					let backup_file_exists = file.exists();
					// No backup session and user didn't choose to quit without saving so use auto-save if it exists.
					if (!backup_file_exists && !PreferenceManager.get("_no_restore_autosave")) {
						let autosave_backup = this.getAutoSaveSessionNewerThanLastBackupSession();
						if (autosave_backup) {
							SharedData._restoring_autosave_backup_session = true;
							session = autosave_backup;
							log("recoverSession: Backup session not found, using autosave session = " + session, "DATA");
						}
						else
							session = null;
					}
					// Backup session exists and not loading auto-save session so load backup session, otherwise do nothing.
					if (session == Constants.BACKUP_SESSION_FILENAME) {
						if (backup_file_exists)
							SharedData._restoring_backup_session = true;
						else
							session = null;
					}
				}
				if (session) SessionIo.load(aWindow, session, "startup", values.sessionState);
				else log("recoverSession: Backup session not found.", "TRACE");
			}
			// if user set to resume previous session, don't clear this so that way user can choose whether to backup
			// current session or not and still have it restore.
			else if ((PreferenceManager.get("startup") == 2) && (PreferenceManager.get("resume_session") != Constants.BACKUP_SESSION_FILENAME)) {
				PreferenceManager.set("resume_session",Constants.BACKUP_SESSION_FILENAME);
				PreferenceManager.set("startup",0);
			}
			if (values.ignore)
			{
				PreferenceManager.set("resume_session", session || Constants.BACKUP_SESSION_FILENAME);
				PreferenceManager.set("startup", (session)?2:0);
			}
			// For some reason if the browser was already running (closed last window, but didn't exit browser) and we prompt for a session, but
			// don't actually load a session and the browser restores the tabs, the selected tab will change to "about:blank". 
			if (SharedData.mAlreadyShutdown && (PreferenceManager.get("startup") == 1) && this.doResumeCurrent() && (!session || (session == Constants.BACKUP_SESSION_FILENAME))) {
				log("recoverSession: Session Manager prompted for session, but browser restored tabs so fix about:blank issue.", "TRACE");
				Utils.runAsync(function() { this.gotoIndex(0) }, aWindow.gBrowser);
			}
			// Display Home Page if user selected to do so
			//if (display home page && Utils.isCmdLineEmpty(aWindow)) {
			//	BrowserHome();
			//}
			// Delete the preference to not restore the autosave session, if it's set
			PreferenceManager.delete("_no_restore_autosave");
		}
		// handle browser reload with same session and when opening new windows
		else if (recoverOnly) {
			this.checkAutoSaveTimer();
		}
		
		// Not shutdown 
		SharedData.mAlreadyShutdown = false;
		
		// If browser restored last session and there was an autosave session, resume it
		if (sessionstart) {
			let last_autosave_session = PreferenceManager.get("_backup_autosave_values", null);
			if (last_autosave_session) {
				PreferenceManager.set("_autosave_values", last_autosave_session);
				log("recoverSession: browser restored last session, restored autosave session = " + last_autosave_session, "DATA");
			}
		}
		
		// Remove any backed up autosave values
		PreferenceManager.delete("_backup_autosave_values");
		
		// Restore command line specified session(s) in a new window if they haven't been restored already
		if (first_temp_restore) {
			// For each remaining session in the command line
			while (temp_restore.length > temp_restore_index) {
				file = SessionIo.getSessionDir(temp_restore[temp_restore_index]);
				if (file && file.exists()) {
					log("recoverSession: Restoring additional command line session " + temp_restore_index + " \"" + temp_restore[temp_restore_index] + "\"", "DATA");
					// Only restore into existing window if not startup and first session in command line
					SessionIo.load(aWindow, temp_restore[temp_restore_index], (((temp_restore_index > 1) || (temp_restore[0] == "0")) ? "newwindow_always" : "overwrite_window"));
				}
				temp_restore_index++;
			}
		}
		
		// If need to encrypt backup file, do it
		// Even though we now check for encryption during session caching, on a crash the cache will already
		// have been created so it won't check again until the next browser restart so just encrypt manually here.
		if (SharedData._encrypt_file) {
			let file = SessionIo.getSessionDir(SharedData._encrypt_file);
			SharedData._encrypt_file = null;
			SessionIo.readSessionFile(file, false, function(state) {
				if (state) 
				{
					if (Constants.SESSION_REGEXP.test(state))
					{
						state = state.split("\n")
						state[4] = Utils.decryptEncryptByPreference(state[4]);
						// if could be encrypted or encryption failed but user allows unencrypted sessions
						if (state[4]) {
							// if encrypted save it
							if (state[4].indexOf(":") == -1) {
								state = state.join("\n");
								SessionIo.writeFile(file, state);
							}
						}
						// couldn't encrypt and user does not want unencrypted files so delete it
						else SessionIo.delFile(file);
					}
					else SessionIo.delFile(file, false, true);
				}
			});
		}
	},

	checkAutoSaveTimer: function(aOldTime)
	{
		// If in permanent private browsing, don't allow starting backup timer
		if (Utils.isAutoStartPrivateBrowserMode())
			return;
	
		// only act if timer already started
		if (this._autosave_timer && ((SharedData._autosave.time <= 0) || !SharedData._autosave.filename)) {
			this._autosave_timer.cancel();
			this._autosave_timer = null;
			log("checkAutoSaveTimer: Autosave Session Timer stopped", "INFO");
		}
		else if ((SharedData._autosave.time > 0) && SharedData._autosave.filename) {
			if (aOldTime != SharedData._autosave.time) {
				if (this._autosave_timer)
					this._autosave_timer.cancel();
				else
					this._autosave_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				// Use slack timers since they are more efficient
				this._autosave_timer.init(this, SharedData._autosave.time * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
				log("checkAutoSaveTimer: Autosave Session Timer (re-)started for " + SharedData._autosave.time + " minute(s)", "INFO");
			}
		}
	},
	
	checkBackupTimer: function()
	{
		// If in permanent private browsing, don't allow starting backup timer
		if (Utils.isAutoStartPrivateBrowserMode())
			return;
	
		let backup_every = PreferenceManager.get("backup_every");
		let backup_every_time = PreferenceManager.get("backup_every_time");
		log("checkBackupTimer: timer = " + this._backup_timer + ", checked = " + backup_every + ", time = " + backup_every_time + ", oldtime = " + this._old_backup_every_time, "DATA");
		// only act if timer already started
		if (this._backup_timer && (!backup_every || (backup_every_time <= 0))) {
			this._backup_timer.cancel();
			this._backup_timer = null;
			log("checkBackupTimer: Backup Session Timer stopped", "INFO");
		}
		else if (backup_every && (backup_every_time > 0)) {
			if (!this._backup_timer || (this._old_backup_every_time != backup_every_time)) {
				if (this._backup_timer)
					this._backup_timer.cancel();
				else
					this._backup_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				// Use slack timers since they are more efficient
				this._backup_timer.init(this, backup_every_time * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
				log("checkBackupTimer: Backup Session Timer (re-)started for " + backup_every_time + " minute(s)", "INFO");
			}
		}
		// Save current preference value
		this._old_backup_every_time = backup_every_time;
	},
	
	haltTimers: function() {
		if (this._backup_timer) {
			log("Backup timer canceled because last window closed", "EXTRA");
			SessionIo.backupCurrentSession(true);
			this._backup_timer.cancel();
			this._old_backup_every_time = 0;
		}
		if (this._autosave_timer) {
			log("Autosave timer canceled because last window closed", "EXTRA");
			// Close and save the autosave session
			SessionIo.closeSession();
		}
	},
	
	doResumeCurrent: function()
	{
		return (PreferenceManager.get("browser.startup.page", 1, true) == 3)?true:false;
	},

	isCleanBrowser: function(aBrowser)
	{
    // This throws an error in nightly versions when trying to access sessionHistory so just return false in that case.
    try {
      return (aBrowser.currentURI.spec == "about:blank" || aBrowser.currentURI.spec == "about:newtab") && aBrowser.sessionHistory.count < 2;
    } catch(ex) {
      return false;
    }
	},
};

// Initialize
Private.initialize();