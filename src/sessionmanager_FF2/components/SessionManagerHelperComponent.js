/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Michael Kraft.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
 
"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const report = Components.utils.reportError;

// Browser preferences
const BROWSER_STARTUP_PAGE_PREFERENCE = "browser.startup.page";
const BROWSER_WARN_ON_QUIT = "browser.warnOnQuit";
const BROWSER_TABS_WARN_ON_CLOSE = "browser.tabs.warnOnClose";
const BROWSER_WARN_ON_RESTART = "browser.warnOnRestart";

// Tab Mix Plus preference
const TMP_PROTECTED_TABS_WARN_ON_CLOSE = "extensions.tabmix.protectedtabs.warnOnClose";

// Session Manager preferences
const OLD_BROWSER_STARTUP_PAGE_PREFERENCE = "old_startup_page";
const SM_BACKUP_SESSION_PREFERENCE = "backup_session";
const SM_ENCRYPT_SESSIONS_PREFERENCE = "encrypt_sessions";
const SM_RESUME_SESSION_PREFERENCE = "resume_session";
const SM_STARTUP_PREFERENCE = "startup";
const SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE = "shutdown_on_last_window_close";
const SM_DISABLED_OR_UNINSTALLED = "disabled_or_uninstalled";

const HIGHEST_STARTUP_PROCESSING_VALUE = 4;
const IDLE_TIME = 20; // How many seconds to wait before system is considered idle.  Can be low since processing will stop when no longer idle
const PERIODIC_TIME = 86400000;  // Do background processing every 24 hours (when idle)
const PROCESS_AT_STARTUP = false;  // Process background processing immediately upon startup if true, otherwise wait till system is idle or time below
const STARTUP_TIMER = 600000; // Time (10 minutes) to wait for system to go idle before forcing background processing to start

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "deleteLogFile", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "AddonManager", "resource://gre/modules/AddonManager.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "gSessionManager", "resource://sessionmanager/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "resource://sessionmanager/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "EncryptionManager", "resource://sessionmanager/modules/encryption_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PasswordManager", "resource://sessionmanager/modules/password_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "resource://sessionmanager/modules/sql_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "resource://sessionmanager/modules/utils.jsm");


// Used for when Session Manager is disabled or uninstalled
var beingDisabled = false;
var beingUninstalled = false;

// Session Manager's helper component.  It handles the following:
// 1. Searching command line arguments for sessions to load
// 2. Clearing autosave preference on a crash if crash recovery is disabled
// 3. Putting up the crash prompt
// 4. Handle saving session data when entering private browsing mode (Firefox 19 and earlier only).
// 5. Kick off the initial window restored processing when SessionStore restores all windows at startup
// 6. Force saving of the preference file upon notification
// 7. Handles syncing the Firefox and Session Manager startup preferences.  
// 8. Handles saving and restoring browser startup preference at startup and shutdown (if need be).
// 9. Handles displaying the Session Manager shut down prompt and overriding the browser and Tab Mix Plus's prompts.
// 10. Prevent shutdown when encryption change is in progress
// 11. Check for when initial window load is complete at startup to kick off saving crashed windows (if needed) and caching sessions.
//
function SessionManagerHelperComponent() {
	// Listen for command line startup options - TODO for later
	//Services.obs.addObserver(this, "command-line-startup", false);
};

SessionManagerHelperComponent.prototype = {
	// registration details
	classID:          Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
						
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsICommandLineHandler]),
	
	// State variables
	_encryption_in_progress: false,
	_encryption_in_progress_system_idle: false,
	_encryption_stopped_because_system_no_longer_idle: false,
	_ignorePrefChange: false,
	_last_processing_time: 0, 
	_no_master_password_check: false,
	_processing_while_idle: false,
	_sessionStore_windows_restored_backup: -1,
	_sessionStore_windows_restored: -1,
	_sessionManager_windows_restored: -1,
	_sessionManager_windows_loaded: 0,
	_startup_process_state: 0,
	_startup_timer_processing: false,
	_system_idle: false, 
	_TMP_protectedtabs_warnOnClose: null,
	_warnOnQuit: null,
	_warnOnClose: null,
	_need_to_restore_browser_startup_page: false,  // This is set if we change browser.startup.page from 3 to 1 during startup or shutdown
	_backupTimerCheckDone: false,
	
	// Timers
	mTimer: null,
	mStartupTimer: null,
	
	/* nsICommandLineHandler */
	handle : function clh_handle(cmdLine)
	{
		log("SessionManagerHelperComponent: Processing Command line arguments", "INFO");
		// Find and remove the *.session command line argument and save it to a shared variable
		let data = cmdLine.state;
		let found = false;
		try {
			let i=0;
			while (i<cmdLine.length) {
				let name = cmdLine.getArgument(i);
				if (/^.*\.session$/.test(name)) {
					// Try using absolute path first and if that doesn't work, search for the file in the session folder
					var file = null;
					try {
						file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
						file.initWithPath(name);
					}
					catch (ex) {
						file = null;
					}
					if (!file) {
						file = SessionIo.getSessionDir(name);
					}
					if (file && file.exists() && file.isFile()) {
						cmdLine.removeArguments(i,i);
						found = true;
						// strip off path if specified
						data = data + "\n" + file.path;
					}
					else {
						i++;
						log("SessionManagerHelperComponent: Command line specified session file not found or is not valid - " + name, "ERROR");
					}
				}
				else i++;
			}
		}
		catch (ex) {
			logError(ex);
		}
		if (found) {
			SharedData._temp_restore = data;
		}
	},
	
	// observer
	observe: function(aSubject, aTopic, aData)
	{
		let os = Services.obs;
		
		//dump(aTopic + "\n");
		log("SessionManagerHelperComponent observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "command-line-startup":
			this.handle(aSubject.QueryInterface(Ci.nsICommandLine));
			break;
		// This is only sent in Firefox 19 and earlier, Firefox 20 and up doesn't send notifications when enabling/disabling private browsing
		// or when changing permanent private browsing setting.
		case "private-browsing-change-granted":
			this.handlePrivacyChange(aSubject, aData);
			break;
		case "profile-after-change":
			// check if Session Manager was just re-enabled or re-installed and fix the browser startup preference so 
			// Session Manager works if the browser preference is to show windows and tabs from last time.
			if (PreferenceManager.get(SM_DISABLED_OR_UNINSTALLED, false)) {
				PreferenceManager.delete(SM_DISABLED_OR_UNINSTALLED);
				let page = PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
				let resume_once = PreferenceManager.get("browser.sessionstore.resume_session_once", false, true);
				log("page = " + page + ", resume_once = " + resume_once, "DATA");
				if (!resume_once && (page == 3) && PreferenceManager.get(SM_STARTUP_PREFERENCE)) {
					this._need_to_restore_browser_startup_page = true;
					PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
				}
			}
			
			// Register for other notifications
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			os.addObserver(this, "sessionstore-windows-restored", false);
			os.addObserver(this, "profile-change-teardown", false);
			os.addObserver(this, "private-browsing-change-granted", false);
			os.addObserver(this, "sessionmanager:windows-restored", false);
			os.addObserver(this, "sessionstore-browser-state-restored", false);
			os.addObserver(this, "sessionmanager:window-loaded", false);
			os.addObserver(this, "sessionmanager:startup-process-finished", false);
		
			try
			{
				// Call the PreferenceManager Module's initialize procedure
				PreferenceManager.initialize();
				
				// Call the gSessionManager Module's initialize procedure
				gSessionManager.initialize();
			}
			catch (ex) { logError(ex); }
			break;
		case "sessionstore-state-finalized":
			// Firefox 20 and up reads in the session data aynchronously at browser startup so wait until it's ready
			os.removeObserver(this, aTopic);
			try
			{
				this._hande_crash_deferred();
			}
			catch (ex) { logError(ex); }
		case "final-ui-startup":
			os.removeObserver(this, aTopic);
			try
			{
				// This will remove the "_autosave_values" preference if browser's crash recovery is disabled
				// and browser didn't restart.  For Firefox 19 and earlier it will be done here.  For Firefox 20 and up
				// this will listen for the "sessionstore-state-finalized" notifications and do it there.
				this._handle_crash();
			}
			catch (ex) { logError(ex); }
			
			// stuff to handle preference file saving
			this.mTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			os.addObserver(this, "quit-application-requested", false);
			os.addObserver(this, "quit-application-granted", false);
			// The following two notifications, added in Firefox, occur when the last browser window closes, but the application isn't actually quitting.  
			os.addObserver(this, "browser-lastwindow-close-requested", false);
			os.addObserver(this, "browser-lastwindow-close-granted", false);
			os.addObserver(this, "sessionmanager-preference-save", false);
			os.addObserver(this, "sessionmanager:restore-startup-preference", false);
			os.addObserver(this, "sessionmanager:ignore-preference-changes", false);
			os.addObserver(this, "sessionmanager:encryption-change", false);
			
			// Observe startup preference
			PreferenceManager.observe(BROWSER_STARTUP_PAGE_PREFERENCE, this, false, true);
			
			// Listen for disabling or uninstalling
			try {
				AddonManager.addAddonListener({
					onUninstalling: function(addon) {
						if (addon.id == "{1280606b-2510-4fe0-97ef-9b5a22eafe30}") {
							beingUninstalled = true;
							PreferenceManager.set(SM_DISABLED_OR_UNINSTALLED, true);
							log("SessionManagerHelperComponent: Session Manager will uninstalled on restart");
						}
					},
					onDisabling: function(addon) {
						if (addon.id == "{1280606b-2510-4fe0-97ef-9b5a22eafe30}") {
							beingDisabled = true;
							PreferenceManager.set(SM_DISABLED_OR_UNINSTALLED, true);
							log("SessionManagerHelperComponent: Session Manager will disabled on restart");
						}
					},
					onOperationCancelled: function(addon) {
						if (addon.id == "{1280606b-2510-4fe0-97ef-9b5a22eafe30}") {
							beingUninstalled = (addon.pendingOperations & AddonManager.PENDING_UNINSTALL) != 0;
							beingDisabled = (addon.pendingOperations & AddonManager.PENDING_DISABLE) != 0;
							if (!beingUninstalled && !beingDisabled) 
								PreferenceManager.delete(SM_DISABLED_OR_UNINSTALLED);
							log("SessionManagerHelperComponent: Session Manager " + (beingDisabled ? "uninstall" : "disable") + " cancelled");
						}
					}
				});
			} catch (ex) { logError(ex); }			
			break;
		case "sessionmanager:encryption-change":
			var data = aData.split(" ");
			this._encryption_in_progress = (data[0] == "start");
			if (this._encryption_in_progress) {
				EncryptionManager.changeEncryption(data[1]);
			}
			
			// Set idle encryption flag, if system currently idle and starting encrypting, clear it otherwise
			this._encryption_in_progress_system_idle = this._encryption_in_progress && this._system_idle;
			
			// update SQL cache when encryption is done or if startup processing was interupted resume it
			if (!this._encryption_in_progress && !this._encryption_stopped_because_system_no_longer_idle) {
				if (this._startup_process_state < HIGHEST_STARTUP_PROCESSING_VALUE)
					this._process_next_async_periodic_function();
				else
					SQLManager.changeEncryptionSQLCache();
			}
			break;
		case "sessionmanager:window-loaded":
			// When Session Manager has finished processing the "onLoad" event for the same number of windows that
			// SessionStore reported was restored, then tell all the browser widnows that the initial session has been restored.
			this._sessionManager_windows_loaded = this._sessionManager_windows_loaded + 1;
			this._check_for_window_restore_complete();
			break;
		case "sessionstore-browser-state-restored":
			// Just log this for now to see if we can use it for anything, it gets sent after all browser windows
			// are restored when calling setBrowserState or when using restore last session item under history menu.  
			// It does not get called when restoring individual windows (setWindowState) or at browser startup.
			break;
		case "sessionstore-windows-restored":
			// Currently this is only called once per browsing session.  Don't unregister it in case
			// user runs on a Mac where closing all windows ends browsing session, but doesn't exit browser.
			//os.removeObserver(this, aTopic);
			
			// Startup backup timer (if applicable) - do this here to prevent trying to save before windows are actually opened or loaded.
			if (!this._backupTimerCheckDone) {
				this._backupTimerCheckDone = true;
				gSessionManager.checkBackupTimer();
			}
			
			// only process if Session Manager isn't loading crashed or backup session
			if (!SharedData._crash_session_filename && !SharedData._restoring_backup_session && !SharedData._restoring_autosave_backup_session)
			{
				// Get how many windows SessionStore restored so Session Manager knows how many loaded windows to wait for before
				// processing the initial restore.  Every window except last one will "load" before this notification occurs so 
				// check for restored equals loaded here as well.
				try {
					// On initial SessionStore load, the number of restored windows will be equal to the number of browser windows
					this._sessionStore_windows_restored = Utils.getBrowserWindows().length;
					this._check_for_window_restore_complete();
				}
				catch (ex) { logError(ex); }
			}
			break;
		case "sessionmanager:windows-restored":
			this._sessionManager_windows_restored = aData;
			// If SessionStore already notified us of loaded windows, adjust the loaded window count to compensate
			if (this._sessionStore_windows_restored != -1) {
				this._sessionManager_windows_restored -= this._sessionStore_windows_restored;
				this._sessionStore_windows_restored = -1;
			}	
			if (this._sessionStore_windows_restored_backup != -1) {
				this._sessionManager_windows_restored -= this._sessionStore_windows_restored_backup;
				this._sessionStore_windows_restored_backup = -1;
			}
			this._check_for_window_restore_complete();
			break;
		case "sessionmanager:startup-process-finished":
			// If processing kicked off because system was idle and no longer idle, don't do anything
			if (this._system_idle || !this._processing_while_idle) {
				// Don't let idle processing happen at the same time that the startup timer processing happens.
				if (aData == "startup_timer")
					this._startup_timer_processing = true;
			
				// If encryption change detected while caching sessions, handle encryption processing first
				// then resume caching.
				if ((aData == "encryption_change_detected") && !this._no_master_password_check) {
					if (PasswordManager.enterMasterPassword()) {
						this._processing_while_idle = false;
						var folder = (this._startup_process_state == 3) ? Utils._string("deleted_sessions_folder") : "";
						Services.obs.notifyObservers(null, "sessionmanager:encryption-change", "start " + folder);
					}
					else {
						Utils.cryptError(Utils._string("encryption_processing_failure"));
						this._no_master_password_check = true;
						this._process_next_async_periodic_function();
					}
				}
				else
					this._process_next_async_periodic_function();
			}
			else {
				// Since callback indicated there was an encryption change, make sure we do encryption processing on next idle
				this._encryption_stopped_because_system_no_longer_idle = (aData == "encryption_change_detected");
				this._processing_while_idle = false;
			}
			break;
		case "sessionstore-state-read":
			os.removeObserver(this, aTopic);
			try 
			{
				this._check_for_crash(aSubject);
			}
			catch (ex) { logError(ex); }
			break;
		case "sessionmanager-preference-save":
			// Save preference file after one 1/4 second to delay in case another preference changes at same time as first
			this.mTimer.cancel();
			this.mTimer.initWithCallback({
				notify:function (aTimer) { Services.prefs.savePrefFile(null); }
			}, 250, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case "sessionmanager:restore-startup-preference":
			os.removeObserver(this, aTopic);
			this._ignorePrefChange = true;
			try 
			{
				// Restore browser startup preference if Session Manager previously saved it, otherwise backup current browser startup preference
				if (PreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
					PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, PreferenceManager.get(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 1), true);
				}
				else {
					// Restore saved browser backup page
					if (this._need_to_restore_browser_startup_page) {
						this._need_to_restore_browser_startup_page = false;
						this._ignorePrefChange = true;
						PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, 3, true);
						this._ignorePrefChange = false;
					}
					PreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true));
				}
			}
			catch (ex) { logError(ex); }
			this._ignorePrefChange = false;
			break;
		case "sessionmanager:ignore-preference-changes":
			this._ignorePrefChange = (aData == "true");
			break;
		// quitting or closing last browser window
		case "browser-lastwindow-close-requested":
		case "quit-application-requested":
			this.handleQuitApplicationRequest(aSubject, aTopic, aData);
			break;
		case "browser-lastwindow-close-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				PreferenceManager.set(BROWSER_WARN_ON_QUIT, this._warnOnQuit, true);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				PreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, this._warnOnClose, true);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				PreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, this._TMP_protectedtabs_warnOnClose, true);
			}
			break;
		case "quit-application-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				PreferenceManager.set(BROWSER_WARN_ON_QUIT, this._warnOnQuit, true);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				PreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, this._warnOnClose, true);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				PreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, this._TMP_protectedtabs_warnOnClose, true);
			}
			os.removeObserver(this, "sessionmanager:startup-process-finished");
			os.removeObserver(this, "sessionmanager:windows-restored");
			os.removeObserver(this, "sessionstore-browser-state-restored");
			os.removeObserver(this, "sessionmanager:encryption-change");
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, "sessionmanager:ignore-preference-changes");
			os.removeObserver(this, "quit-application-requested");
			os.removeObserver(this, "browser-lastwindow-close-requested");
			os.removeObserver(this, "browser-lastwindow-close-granted");
			os.removeObserver(this, aTopic);
			
			// Remove preference observer
			PreferenceManager.unobserve(BROWSER_STARTUP_PAGE_PREFERENCE, this, true);
			
			// If encryption change is in progress, stop it.
			if (this._encryption_in_progress) {
				EncryptionManager.stop();
			}
			
			// Remove watch for when system is idle
			var idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
			idleService.removeIdleObserver(this, IDLE_TIME);
			
			// Delete Session Manager closed window and log files when add-on is uninstalled (keep session files)
			// TODO: Add prompt asking to delete session files
			if (beingUninstalled) {
				// Delete log file
				deleteLogFile(true);
			
				// If using SessionStore closed windows, delete our closed window list
				if (PreferenceManager.get("use_SS_closed_window_list"))
					SessionIo.clearUndoData("window", true);
			}
			break;
		case "profile-change-teardown":
			// Get page (or set to 3 if changed on restart)
			let page = this._need_to_restore_browser_startup_page ? 3 : PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			// If Session Manager is handling startup, save the current startup preference and then set it to home page
			// otherwise clear the saved startup preference
			if (!beingDisabled && !beingUninstalled && (page == 3) && PreferenceManager.get(SM_STARTUP_PREFERENCE)) {
				PreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 3);
				PreferenceManager.delete(BROWSER_STARTUP_PAGE_PREFERENCE, true);
			}
			else if (PreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
				PreferenceManager.delete(OLD_BROWSER_STARTUP_PAGE_PREFERENCE);
				// If changed because of a restart, change it back (solely for disable/uninstall).  
				if (this._need_to_restore_browser_startup_page)
					PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, 3, true);
			}
			break;
		case "nsPref:changed":
			switch(aData) 
			{
				case BROWSER_STARTUP_PAGE_PREFERENCE:
					// Handle case where user changes browser startup preference
					if (!this._ignorePrefChange) this._synchStartup();
					break;
			}
			break;
		case "idle":
			// Called when system is idle (check if already idle just in case since this broke in the past)
			if (!this._system_idle) {
				this._system_idle = true;
				this._do_idle_processing();
			}
			break;
		// "back" is used prior to Firefox 16, "active" is used afterwards.
		case "active":
		case "back":
			// Called when system is no longer idle
			this._system_idle = false;
			// If encryption change is in progress and it was kicked off when system was idle, stop it.
			if (this._encryption_in_progress_system_idle) {
				this._encryption_stopped_because_system_no_longer_idle = true;
				EncryptionManager.stop();
			}
			break;
		}
	},

	/* ........ private methods .............. */

	// This will send out notifications to Session Manager windows when the number of loaded windows equals the number of
	// restored windows.  If SessionStore is restoring the windows or no windows are being restored, this happens once.
	// If Session Manager is restoring a backup or crash file, it will trigger twice, only do the notification part the second time.
	_check_for_window_restore_complete: function sm_check_for_window_restore_complete()
	{
		log("_check_for_window_restore_complete: SessionStore windows restored = " + this._sessionStore_windows_restored + 
		    ", Session Manager windows restored = " + this._sessionManager_windows_restored + ", SessionManager windows loaded = " + this._sessionManager_windows_loaded, "DATA");

		let sessionstore_restored = (this._sessionManager_windows_loaded == this._sessionStore_windows_restored);
		let sessionmanager_restored = (this._sessionManager_windows_loaded == this._sessionManager_windows_restored);
		if (sessionstore_restored || sessionmanager_restored) {
			// Stop counting loaded windows and reset count
			SharedData._countWindows = false;
			this._sessionManager_windows_loaded = 0;
			if (sessionstore_restored) {
				this._sessionStore_windows_restored_backup = this._sessionStore_windows_restored;
				this._sessionStore_windows_restored = -1;
			}
			if (sessionmanager_restored)
				this._sessionManager_windows_restored = -1;
			Services.obs.notifyObservers(null, "sessionmanager:initial-windows-restored", null); 
			
			// Save window sessions from crashed session in the background if necessary and not in private browsing mode
			// Note that in Firefox 20 and up, the browser will never be in Private Browsing Mode (only windows can be private) so it
			// will always save crashed window sessions since private window sessions can't be loaded.
			if (SharedData._save_crashed_autosave_windows && SharedData._crash_backup_session_file && !Utils.isPrivateBrowserMode()) {
				let window = Utils.getMostRecentWindow();
				if (window) {
					SharedData._screen_width = window.screen.width;
					SharedData._screen_height = window.screen.height;
				}
			
				// Save crashed windows
				SessionIo.saveCrashedWindowSessions();
				SharedData._screen_width = null;
				SharedData._screen_height = null;
				// Don't save again if this is called again
				SharedData._save_crashed_autosave_windows = false;
				log("SessionManagerHelperComponent _check_for_window_restore_complete: Open Window Sessions at time of crash saved.", "TRACE");
			}

			// Add watch for when system is idle for at least a minute
			var idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
			idleService.addIdleObserver(this, IDLE_TIME);
			
			// Kick off startup processing or start timer to run processing (depending on flag), only done once per run
			if (!this._startup_process_state && PROCESS_AT_STARTUP)
				// process next function
				this._process_next_async_periodic_function();
			else {
				// Start a timer to force running of background processing after 10 minutes if system never goes idle
				this.mStartupTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				this.mStartupTimer.initWithCallback({
					notify:function (aTimer) { Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", "startup_timer"); }
				}, STARTUP_TIMER, Ci.nsITimer.TYPE_ONE_SHOT);
			}
			
		}
	},
	
	_do_idle_processing: function() {
			// Cancel startup timer if it hasn't already fired
			if (this.mStartupTimer) {
				this.mStartupTimer.cancel();
				this.mStartupTimer = null
			}
			
			// if Startup timer expired and is currently processing exit
			if (this._startup_timer_processing)
				return;
	
			// Don't do anything if encryption change already in progress or already doing periodic processing
			if (this._encryption_in_progress || this._processing_while_idle)
				return;
				
			let time = Date.now();
			let do_encryption_change = this._encryption_stopped_because_system_no_longer_idle;
			this._encryption_stopped_because_system_no_longer_idle = false;
			// If there was an encryption change detected and we never finished processing it, then continue encryption change processing.
			// Otherwise continue the periodic processing if in the middle or it or haven't run periodic processing in 24 hours.
			if (do_encryption_change)
				Services.obs.notifyObservers(null, "sessionmanager:encryption-change", "start");
			else if ((this._startup_process_state < HIGHEST_STARTUP_PROCESSING_VALUE) || (this._last_processing_time + PERIODIC_TIME < time)) {
				if ((this._last_processing_time + PERIODIC_TIME < time) && (this._startup_process_state >= HIGHEST_STARTUP_PROCESSING_VALUE))
					this._startup_process_state = 0;
				this._processing_while_idle = true;
				this._process_next_async_periodic_function();
			}
	},
	
	// This handles startup procesing, but stages it so it doesn't all happen at once.
	_process_next_async_periodic_function: function() {
		this._startup_process_state++;
		log("Startup processing = " + this._startup_process_state, "TRACE");
		switch(this._startup_process_state) {
		case 1:
			// remove old deleted sessions
			SessionIo.purgeOldDeletedSessions(true);
			var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			timer.initWithCallback({
				notify:function (aTimer) { Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", null); }
			}, 0, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case 2:
			// Cache sessions
			SessionIo.cacheSessions();
			break;
		case 3:
			// Cache deleted sessions
			SessionIo.cacheSessions(Utils._string("deleted_sessions_folder"));
			break;
		case 4:
			// If using SQL cache and not yet created, populate SQL cache otherwise check cache.  If not using it delete it.
			if (PreferenceManager.get("use_SQLite_cache"))
				SQLManager.checkSQLCache();
			else
				SQLManager.removeSessionFromSQLCache();
			this._no_master_password_check = false;
			this._processing_while_idle = false;
			this._startup_timer_processing = false;
			this._last_processing_time = Date.now();
			break;
		}
	},

	// This will remove the "_autosave_values" preference if browser's crash recovery is disabled
	// and browser didn't restart.  For Firefox 19 and earlier it will be done here.  For Firefox 20 and up
	// this will listen for the "sessionstore-state-finalized" notifications and do it in _hande_crash_deferred.
	_handle_crash: function sm_handle_crash()
	{
//		log("resume_from_crash = " + PreferenceManager.get("browser.sessionstore.resume_from_crash", false, true) + ", resume_session_once = " +
//		    PreferenceManager.get("browser.sessionstore.resume_session_once", false, true));
	
		// Don't do anything if Crash Recovery is enabled or restarted
		if (PreferenceManager.get("browser.sessionstore.resume_from_crash", false, true) || 
		    PreferenceManager.get("browser.sessionstore.resume_session_once", false, true))
			return;
	
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		
		// onceInitialized only exists in Firefox 20 and up, where we need to wait
		if (sessionStartup && sessionStartup.onceInitialized) 
			Services.obs.addObserver(this, "sessionstore-state-finalized", false);
		else
			this._hande_crash_deferred();
	},
	
	// Called to actually handle to process of checking sessionStartup.sessionType to see if browser restarted.  In Firefox 20
	// and up this is called from "sessionstore-state-finalized" notifications to prevent breaking async loading of sessionstore.js file.
	_hande_crash_deferred: function sm__hande_crash_deferred() {
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
	
//		log("sessionStart doing restore = " + (sessionStartup && sessionStartup.doRestore()));
	
		// Only remove if didn't restart
		if (sessionStartup && sessionStartup.doRestore()) 
			return;
			
		log("SessionManager: Removing '_autosave_values' preference", "INFO");
		PreferenceManager.delete("_autosave_values");
	},
	
	// This will check to see if there was a crash and if so put up the crash prompt 
	// to allow the user to choose a session to restore. 
	_check_for_crash: function sm_check_for_crash(aStateDataString)
	{
		let initialState;
		try {
			// parse the session state into JS objects
			initialState = Utils.JSON_decode(aStateDataString.QueryInterface(Ci.nsISupportsString).data, true);
		}
		catch (ex) { 
			logError(ex);
			return;
		} 
    
		let lastSessionCrashed =
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
		
		log("SessionManagerHelperComponent:_check_for_crash: Last Crashed = " + lastSessionCrashed, "DATA");
		if (lastSessionCrashed) {
			SharedData._browserCrashed = true;
			let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
			// default to recovering
			params.SetInt(0, 0);
			Services.ww.openWindow(null, "chrome://sessionmanager/content/restore_prompt.xul", "_blank", "chrome,modal,centerscreen,titlebar", params);
			if (params.GetInt(0) == 1) aStateDataString.QueryInterface(Ci.nsISupportsString).data = "";
			else if (initialState.session) {
				// if not using built-in crash prompt, make sure it doesn't prompt for tabs
				if (!PreferenceManager.get("use_browser_crash_prompt", false)) {
					// don't prompt for tabs if checkbox not checked
					delete(initialState.session.lastUpdate);
					delete(initialState.session.recentCrashes);
					aStateDataString.QueryInterface(Ci.nsISupportsString).data = Utils.JSON_encode(initialState);
				}
			}
		}
		initialState = null;
	},

	// Make sure that the browser and Session Manager are on the same page with regards to the startup preferences
	_synchStartup: function sm_synchStartup()
	{
		let browser_startup = PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);

		// Ignore any preference changes made in this function
		this._ignorePrefChange = true;
		
		// If browser handling startup, disable Session Manager startup and backup startup page
		// otherwise set Session Manager to handle startup and restore browser startup setting
		if (browser_startup > Constants.STARTUP_PROMPT) {
			PreferenceManager.set(SM_STARTUP_PREFERENCE, 0);
			PreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, browser_startup);
		}
		else {
			PreferenceManager.set(SM_STARTUP_PREFERENCE, (browser_startup == Constants.STARTUP_PROMPT) ? 1 : 2);
			PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, PreferenceManager.get(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 1), true);
		}

		// Resume listening to preference changes
		this._ignorePrefChange = false;
	},
	
	// This is only called in Firefox 19 and earlier, Firefox 20 and up doesn't send notifications when enabling/disabling private browsing
	// or when changing permanent private browsing setting.  Also the autoStarted flag isn't used in Firefox 20 and up as
	// automatically started private window mode can only change on a restart (PrivateBrowsingUtils.permanentPrivateBrowsing is used instead).
	handlePrivacyChange: function sm_handlePrivacyChange(aSubject, aData)
	{
		switch(aData) {
		case "enter":
			try {
				// backup the current browser state and privacy auto-start setting
				SharedData.mBackupState = Utils.SessionStore.getBrowserState();
				SharedData.mAutoPrivacy = Utils.isAutoStartPrivateBrowserMode();
				log("SessionManagerHelperComponent: observer autoStarted = " + SharedData.mAutoPrivacy, "DATA");
				
				// Save off current autosave data
				SharedData._pb_saved_autosave_values = PreferenceManager.get("_autosave_values", null);
			}
			catch(ex) { 
				logError(ex);
			}
			
			// Only save if entering private browsing mode manually (i.e. not automatically on browser startup)
			// Use the mTimer variable since it isn't set until final-ui-startup.
			if (this.mTimer) {
				// Close current autosave session or make an autosave backup (if not already in private browsing mode)
				if (!SessionIo.closeSession(false,true)) {
					// If autostart or disabling history via options, make a real backup, otherwise make a temporary backup
					if (Utils.isAutoStartPrivateBrowserMode()) {
						SessionIo.backupCurrentSession(true);
					}
					else if (PreferenceManager.get("autosave_session")) {
						SessionIo.autoSaveCurrentSession(true); 
					}
				}
				// Close all open window sessions and force them to save despite being "in" private browsing.
				SharedData.mAboutToEnterPrivateBrowsing = true;
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				Services.obs.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
				SharedData.mAboutToEnterPrivateBrowsing = false;
			}
			
			break;
		case "exit":
			// If browser not shutting down (aSubject.data not set to true), clear the backup state otherwise set mShutDownInPrivateBrowsingMode flag
			aSubject.QueryInterface(Ci.nsISupportsPRBool);
			if (aSubject.data) {
				SharedData.mShutDownInPrivateBrowsingMode = true;
				log("SessionManagerHelperComponent: observer mShutDownInPrivateBrowsingMode = " + SharedData.mShutDownInPrivateBrowsingMode, "DATA");
			}
			else {
				SharedData.mBackupState = null;
			}
			break;
		}
	},
	
	handleQuitApplicationRequest: function(aSubject, aTopic, aData)
	{
		// If quit already canceled, just return
		if (aSubject.QueryInterface(Ci.nsISupportsPRBool) && aSubject.data) return;
		
		if (beingUninstalled) {
			// TODO: put up prompt asking if preferences should be deleted
			log("Session Manager is being uninstalled", "INFO");
		}
		
		// If private browsing mode don't allow saving - This is never set in Firefox 20 and up as individual windows are set as private
		try {
			if (Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).privateBrowsingEnabled) return;
		} catch(ex) {}
		
		let backup = PreferenceManager.get(SM_BACKUP_SESSION_PREFERENCE);

		// If browser is restarting and the warnOnRestart preference is set, make sure it will display if browser is set to
		// show windows and tabs from last time and session manager is handling startup.
		if (aData == "restart" && PreferenceManager.get(BROWSER_WARN_ON_RESTART, null, true)) {
			let page =PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			if ((page == 3) && PreferenceManager.get(SM_STARTUP_PREFERENCE)) {
				this._need_to_restore_browser_startup_page = true;
				this._ignorePrefChange = true;
				PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
				this._ignorePrefChange = false;
				log("SessionManagerHelperComponent:handleQuitApplicationRequest - Updating preferences so restart display warning prompt", "INFO");
			}
		}
		// If not restarting and set to prompt, disable FF's quit prompt
		else if ((aData != "restart") && (backup == 2)) {
			let window = Services.wm.getMostRecentWindow("navigator:browser");
			if ((backup == 2) && ((aTopic == "quit-application-requested") || PreferenceManager.get(SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE))) {

				// Do session prompt here and then save the info in an Application Storage variable for use in
				// the shutdown procsesing in sessionmanager.js
				let watcher = Services.ww;
				// if didn't already shut down
				log("SessionManagerHelperComponent SharedData.mAlreadyShutdown = " + SharedData.mAlreadyShutdown, "DATA");
				if (!SharedData.mAlreadyShutdown) {

					// shared variables
					let params = null;
					
					let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		
					params = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2).QueryInterface(Ci.nsIWritablePropertyBag);
					params.setProperty("promptType", "confirmEx");
					params.setProperty("title",      bundle.GetStringFromName("sessionManager"));
					params.setProperty("text",       bundle.GetStringFromName("preserve_session"));
					params.setProperty("checkLabel", bundle.GetStringFromName("prompt_not_again"));
					params.setProperty("checked",    false);

					// Resuming current if restarting, Firefox is set to restore last session or Session Manager is set to resume last session.  If Session Manager
					// is resuming current, display "quit and restore" instead of "quit and save" since that's what it does.
					let resume_current = PreferenceManager.get("browser.sessionstore.resume_session_once", false, true) ||
															 ((PreferenceManager.get(SM_STARTUP_PREFERENCE) == 0) && (PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true) == 3));
					let resume_current_sm = ((PreferenceManager.get(SM_STARTUP_PREFERENCE) == 2) && (PreferenceManager.get(SM_RESUME_SESSION_PREFERENCE) == Constants.BACKUP_SESSION_FILENAME));
		
					if (resume_current || resume_current_sm) {
						// If browser is resuming, display save and quit.  If Session Manager is resuming display save and restore.
						if (resume_current)
							params.setProperty("button0Label", bundle.GetStringFromName("save_quit"));			// 1st button (returns 0)
						else
							params.setProperty("button0Label", bundle.GetStringFromName("save_and_restore"));	// 1st button (returns 0)
						params.setProperty("button2Label", bundle.GetStringFromName("quit"));				// 2nd button (returns 2)
						params.setProperty("button1Label", bundle.GetStringFromName("cancel"));				// 3rd button (returns 1)
					}
					else {
						params.setProperty("button3Label", bundle.GetStringFromName("save_quit"));			// 1st button (returns 3)
						params.setProperty("button0Label", bundle.GetStringFromName("quit"));				// 2nd button (returns 0)
						params.setProperty("button2Label", bundle.GetStringFromName("save_and_restore"));	// 3rd button (returns 2)
						params.setProperty("button1Label", bundle.GetStringFromName("cancel")); 			// 4th button (returns 1);
					}
					
					watcher.openWindow(window, "chrome://global/content/commonDialog.xul", "_blank", "centerscreen,chrome,modal,titlebar", params);
					let results = params.getProperty("buttonNumClicked");
					let checkbox_checked = params.getProperty("checked");
						
					// If cancel pressed, cancel shutdown and return;
					if (results == 1) {
						aSubject.QueryInterface(Ci.nsISupportsPRBool);
						aSubject.data = true;
						return;
					}
					
					// At this point the results value doesn't match what the
					// backupCurrentSession function in sessionmanager.js expects which is
					// the Save & Quit to be 0, Quit to be 1 and Save & Restore to be 2, so tweak the values here.
					switch (results) {
						// Save & Quit when four buttons displayed
						case 3:
							results = 0;
							break;
						// Quit (4 buttons) or Save & Quit (3 buttons)
						case 0:
							results = (resume_current || resume_current_sm) ? 0 : 1;
							break;
						case 2:
							results = (resume_current || resume_current_sm) ? 1 : 2;
					}
					
					// If checkbox checked
					if (checkbox_checked)
					{
						switch (results) {
							case 2:  // Save & Restore
								PreferenceManager.set(SM_RESUME_SESSION_PREFERENCE, Constants.BACKUP_SESSION_FILENAME);
								PreferenceManager.set(SM_STARTUP_PREFERENCE, 2);
								break;
							case 1: // Quit
								// If currently resuming previous session, don't
								if (resume_current_sm)
									PreferenceManager.set(SM_STARTUP_PREFERENCE, 0);
								break;
						}
						PreferenceManager.set(SM_BACKUP_SESSION_PREFERENCE, (results == 1)?0:1);
					}
							
					SharedData.mShutdownPromptResults = results;
					
					// Disable prompt in browser
					let prefValue = PreferenceManager.get(BROWSER_WARN_ON_QUIT, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._warnOnQuit) != "boolean") {
							this._warnOnQuit = prefValue;
						}
						PreferenceManager.set(BROWSER_WARN_ON_QUIT, false, true);
					}
					// Disable prompt in tab mix plus if it's running
					prefValue = PreferenceManager.get(BROWSER_TABS_WARN_ON_CLOSE, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._warnOnClose) != "boolean") {
							this._warnOnClose = prefValue;
						}
						PreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, false, true);
					}
					prefValue = PreferenceManager.get(TMP_PROTECTED_TABS_WARN_ON_CLOSE, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._TMP_protectedtabs_warnOnClose) != "boolean") {
							this._TMP_protectedtabs_warnOnClose = prefValue;
						}
						PreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, false, true);
					}
				}
			}
		}
		
		// Work around for Firefox not calling "close" event for Windows
		if ((aTopic == "browser-lastwindow-close-requested") || (aData == "lastwindow"))
			Services.obs.notifyObservers(null, "sessionmanager:last-window-closed", null);
	}
};

// Register Component
var NSGetFactory = XPCOMUtils.generateNSGetFactory([SessionManagerHelperComponent]);
