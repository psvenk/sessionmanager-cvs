"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

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

const HIGHEST_STARTUP_PROCESSING_VALUE = 4;
const IDLE_TIME = 20; // How many seconds to wait before system is considered idle.  Can be low since processing will stop when no longer idle
const PERIODIC_TIME = 86400000;  // Do background processing every 24 hours (when idle)
const STARTUP_TIMER = 600000; // Time (10 minutes) to wait for system to go idle before forcing background processing to start

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "gSessionManager", "chrome://sessionmanager/content/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "EncryptionManager", "chrome://sessionmanager/content/modules/encryption_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PasswordManager", "chrome://sessionmanager/content/modules/password_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "chrome://sessionmanager/content/modules/sql_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CrashMonitor", "resource://gre/modules/CrashMonitor.jsm");

// Used to override toString function of startup_process_state
function startup_process_state(aValue) {
	let value = new Number(aValue);
	value.__proto__.toString = function() {
		switch(this.valueOf()) {
			case 1:
				return "Removing old deleted sessions";
				break;
			case 2:
				return "Caching sessions";
				break;
			case 3:
				return "Caching deleted sessions";
				break;
			case 4:
				return "Checking SQL Cache";
				break;
		}        
	}
	return value;
}

var browserAlreadyActive = false;
var shuttingDown = false;

exports.initializeHelper = function(aBrowserStartup) {
	
	SessionManagerHelper.initialize(aBrowserStartup);
	
	unload(function() { 
		this._final_shutdown(false);
	}.bind(SessionManagerHelper));
};

// Session Manager's helper "class".  It handles the following:
// 1. Clearing autosave preference on a crash if crash recovery is disabled
// 2. Putting up the crash prompt
// 3. Kick off the initial window restored processing when SessionStore restores all windows at startup
// 4. Force saving of the preference file upon notification
// 5. Handles syncing the Firefox and Session Manager startup preferences.  
// 6. Handles saving and restoring browser startup preference at startup and shutdown (if need be).
// 7. Handles displaying the Session Manager shut down prompt and overriding the browser and Tab Mix Plus's prompts.
// 8. Prevent shutdown when encryption change is in progress
// 9. Check for when initial window load is complete at startup to kick off saving crashed windows (if needed) and caching sessions.
//
let SessionManagerHelper = {
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference, Ci.nsIObserver]),
	
	// State variables
	_australis_crash: false,
	_encryption_in_progress: false,
	_encryption_in_progress_system_idle: false,
	_encryption_stopped_because_system_no_longer_idle: false,
	_ignorePrefChange: false,
	_last_processing_time: 0, 
	_no_master_password_check: false,
	_observingIdle: false,
	_processing_while_idle: false,
	_sessionStore_windows_restored_backup: -1,
	_sessionStore_windows_restored: -1,
	_sessionManager_windows_restored: -1,
	_sessionManager_windows_loaded: 0,
	_startup_process_state: new startup_process_state(0),
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
	
	// observer
	observe: function(aSubject, aTopic, aData)
	{
		let os = Services.obs;
		
		//dump(aTopic + "\n");
		log("SessionManagerHelper observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "sessionstore-state-finalized":
			// Firefox reads in the session data aynchronously at browser startup so wait until it's ready
			os.removeObserver(this, aTopic);
			try
			{
				this._handle_crash_deferred();
			}
			catch (ex) { logError(ex); }
		case "final-ui-startup":
			os.removeObserver(this, aTopic);
			this._final_startup(true);
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
						var folder = (this._startup_process_state == 3) ? Utils.deletedSessionsFolder : "";
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
				// Only restore it if it's valid.
				if (PreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
					let old_startup = PreferenceManager.get(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 1);
					if (old_startup >= 0)
						PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, old_startup, true);
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
			
			// Save the last window session data before it closes
			Services.obs.notifyObservers(null, "sessionmanager:last-window-closed", null);
			
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

			this._final_shutdown(true);
			break;
		case "profile-change-teardown":
			// Get page (or set to 3 if changed on restart)
			let page = this._need_to_restore_browser_startup_page ? 3 : PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			// If Session Manager is handling startup, save the current startup preference and then set it to home page
			// otherwise clear the saved startup preference
			if ((page == 3) && PreferenceManager.get(SM_STARTUP_PREFERENCE)) {
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
		case "active":
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

	initialize: function(aBrowserStartup) {
		// Register for other notifications
		let os = Services.obs;
		if (aBrowserStartup) {
			os.addObserver(this, "final-ui-startup", true);
			os.addObserver(this, "sessionstore-state-read", true);
		}	
		else {
			// check if Session Manager was just re-enabled or re-installed and fix the browser startup preference so 
			// Session Manager works if the browser preference is to show windows and tabs from last time.
			let page = PreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			let resume_once = PreferenceManager.get("browser.sessionstore.resume_session_once", false, true);
			log("SessionManagerHelper: page = " + page + ", resume_once = " + resume_once, "DATA");
			if (!resume_once && (page == 3) && PreferenceManager.get(SM_STARTUP_PREFERENCE)) {
				this._need_to_restore_browser_startup_page = true;
				PreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			}
			
			// Set number of "restored" windows to current number of windows so kick off processing to
			// restore window sessions will work correctly if upgraded or downgraded, otherwise just set browser as active.
			if (SharedData.justStartedUpDowngraded)
				this._sessionManager_windows_restored = Utils.getBrowserWindows().length;
			else 
				browserAlreadyActive = true;
			
			this._final_startup(false);
			// Check to see if backup timer should be started if addon enable after browswer already started
			this._backupTimerCheckDone = true;
			gSessionManager.checkBackupTimer();
		}

		os.addObserver(this, "sessionstore-windows-restored", true);
		os.addObserver(this, "profile-change-teardown", true);
		os.addObserver(this, "sessionmanager:windows-restored", true);
		os.addObserver(this, "sessionstore-browser-state-restored", true);
		os.addObserver(this, "sessionmanager:window-loaded", true);
		os.addObserver(this, "sessionmanager:startup-process-finished", true);
	},
	
	_final_startup: function(aBrowserStartup) {
		if (aBrowserStartup) {
			try
			{
				// This will remove the "_autosave_values" preference if browser's crash recovery is disabled
				// and browser didn't restart.  For Firefox this will listen for the
				// "sessionstore-state-finalized" notifications and do it there.
				this._handle_crash();
				
				// Australis (Firefox 29 and up) uses a different mechanism for detecting crashes.  Register to 
				// received the results here so hopefully it will be available by the time "sessionstore-state-finalized"
				// notification comes in.  CrashMonitor is only available after "profile-after-change" fires.
				try {
					CrashMonitor.previousCheckpoints.then(checkpoints => {
						log("SessionManagerHelper:initialize: Crash Monitor result returned: " + JSON.stringify(checkpoints), "DATA");
						this._australis_crash = checkpoints && !checkpoints["sessionstore-final-state-write-complete"];
					});
				} catch (ex) { logError(ex); }
			}
			catch (ex) { logError(ex); }
		}
		
		// stuff to handle preference file saving
		this.mTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		let os = Services.obs;
		os.addObserver(this, "quit-application-requested", true);
		os.addObserver(this, "quit-application-granted", true);
		// The following two notifications, added in Firefox, occur when the last browser window closes, but the application isn't actually quitting.  
		os.addObserver(this, "browser-lastwindow-close-requested", true);
		os.addObserver(this, "browser-lastwindow-close-granted", true);
		os.addObserver(this, "sessionmanager-preference-save", false);
		os.addObserver(this, "sessionmanager:restore-startup-preference", true);
		os.addObserver(this, "sessionmanager:ignore-preference-changes", true);
		os.addObserver(this, "sessionmanager:encryption-change", true);
		
		// Observe startup preference
		PreferenceManager.observe(BROWSER_STARTUP_PAGE_PREFERENCE, this, true, true);
	},
	
	_final_shutdown: function(aBrowserShutdown) {
		shuttingDown = true;
	
		// cancel preference saving timer if set
		if (this.mTimer) {
			this.mTimer.cancel();
			this.mTimer = null;
		}
		
		// cancel startup timer if set
		if (this.mStartupTimer) {
			this.mStartupTimer.cancel();
			this.mStartupTimer = null;
		}
	
		// Remove observers
		let observed = ["final-ui-startup", "sessionstore-state-read", "sessionstore-windows-restored", 
										"sessionmanager:windows-restored", "sessionstore-browser-state-restored",
										"sessionmanager:window-loaded", "sessionmanager:startup-process-finished",
										"quit-application-requested", "quit-application-granted", "browser-lastwindow-close-requested",
										"browser-lastwindow-close-granted", "sessionmanager-preference-save", "sessionmanager:restore-startup-preference",
										"sessionmanager:ignore-preference-changes", "sessionmanager:encryption-change", "sessionstore-state-finalized"];
										
		// Don't remove profile-change-teardown observer if shutting browser down						
		if (!aBrowserShutdown)
			observed.push("profile-change-teardown");
										
		for (let i in observed) {
			try {
				Services.obs.removeObserver(this, observed[i]);
			}
			catch(ex) {}
		}
		PreferenceManager.unobserve(BROWSER_STARTUP_PAGE_PREFERENCE, this, true);
		
		// If exitting browser, clear the old browser startup preference since we don't need it except on browser startup
		if (!aBrowserShutdown && PreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) 
			PreferenceManager.delete(OLD_BROWSER_STARTUP_PAGE_PREFERENCE);

		// If encryption change is in progress, stop it.
		if (this._encryption_in_progress) {
			EncryptionManager.stop();
		}
		
		// Remove watch for when system is idle
		var idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
		idleService.removeIdleObserver(this, IDLE_TIME);
	},

	// This will send out notifications to Session Manager windows when the number of loaded windows equals the number of
	// restored windows.  If SessionStore is restoring the windows or no windows are being restored, this happens once.
	// If Session Manager is restoring a backup or crash file, it will trigger twice, only do the notification part the second time.
	_check_for_window_restore_complete: function sm_check_for_window_restore_complete()
	{
		log("_check_for_window_restore_complete: SessionStore windows restored = " + this._sessionStore_windows_restored + 
		    ", Session Manager windows restored = " + this._sessionManager_windows_restored + ", SessionManager windows loaded = " + this._sessionManager_windows_loaded, "DATA");

		let sessionstore_restored = (this._sessionManager_windows_loaded == this._sessionStore_windows_restored);
		let sessionmanager_restored = (this._sessionManager_windows_loaded == this._sessionManager_windows_restored);
		if (browserAlreadyActive || sessionstore_restored || sessionmanager_restored) {
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
			
			// Save window sessions from crashed session in the background if necessary unless permanent private browsing mode is enabled.
			if (SharedData._save_crashed_autosave_windows && SharedData._crash_backup_session_file && !Utils.isAutoStartPrivateBrowserMode()) {
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
				log("SessionManagerHelper _check_for_window_restore_complete: Open Window Sessions at time of crash saved.", "TRACE");
			}

			// Add watch for when system is idle for at least a minute if not already added
			if (!this._observingIdle) {
				let idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
				idleService.addIdleObserver(this, IDLE_TIME);
				this._observingIdle = true;
			
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
		if (shuttingDown)
			return;
	
		this._startup_process_state++;
		log("Startup processing = " + this._startup_process_state.toString(), "TRACE");
		switch(this._startup_process_state) {
		case 1:
			// remove old deleted sessions
			SessionIo.purgeOldDeletedSessions(true);
			Utils.runAsync(function() {
				Services.obs.notifyObservers(null, "sessionmanager:startup-process-finished", null); 
			});
			break;
		case 2:
			// Cache sessions
			SessionIo.cacheSessions();
			break;
		case 3:
			// Cache deleted sessions
			SessionIo.cacheSessions(Utils.deletedSessionsFolder);
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
	// and browser didn't restart.  For Firefox this this will listen for the 
	// "sessionstore-state-finalized" notifications and do it in _hande_crash_deferred.
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
		
		// onceInitialized only exists in Firefox, where we need to wait
		if (sessionStartup && sessionStartup.onceInitialized) 
			Services.obs.addObserver(this, "sessionstore-state-finalized", true);
		else
			this._handle_crash_deferred();
	},
	
	// Called to actually handle to process of checking sessionStartup.sessionType to see if browser restarted.
	_handle_crash_deferred: function sm__handle_crash_deferred() {
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
			if (initialState && initialState._JSON_decode_error) {
				logError(initialState._JSON_decode_error);
				return;
			}
		}
		catch (ex) { 
			logError(ex);
			return;
		} 
		
		let lastSessionCrashed = 
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
			
		// Check Australis crash monitor if there is no state
		if (typeof lastSessionCrashed == "undefined") {
			lastSessionCrashed = this._australis_crash;
		}
			 
		log("SessionManagerHelper:_check_for_crash: Last Crashed = " + lastSessionCrashed, "DATA");
		if (lastSessionCrashed) {
			SharedData._browserCrashed = true;
			let preventBrowserRecover = this._restorePrompt(initialState);
			if (preventBrowserRecover) 
				aStateDataString.QueryInterface(Ci.nsISupportsString).data = null;
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

	_restorePrompt: function sm_restorePrompt(aState) 
	{
		log("restorePrompt start", "INFO");
		
		// default count variable
		let preventBrowserRecover = false;
		let countString = "";
    let encodedState = null;
		
		let session = null, backupFile = null, count = null;
		// hiddenDOMWindow should exist in all version of Firefox and SeaMonkey so get screen width and height from that.
		let win = Services.appShell.hiddenDOMWindow;
		let	screensize = win ? (win.screen.width + "x" + win.screen.height) : null;
				
		// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
		if (aState)
		{
			try {
        encodedState = Utils.JSON_encode(aState);
				let time = (aState.session && aState.session.lastUpdate) ? new Date(aState.session.lastUpdate) : new Date();
				let name = Utils.getFormattedName("", time, Utils._string("crashed_session"));
				count = Utils.getCount(aState);
				session = Utils.nameState("timestamp=" + time.getTime() + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + 
						Utils._string("backup_sessions") + (screensize ? ("\tscreensize=" + screensize) : "") + "\n" + encodedState, name);
				backupFile = SessionIo.getSessionDir(Constants.BACKUP_SESSION_FILENAME, true);
				
				if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
			}
			catch(ex) { 
				logError(ex); 
			}
		}

		let encrypt_sessions = PreferenceManager.get("encrypt_sessions", false);
		// actually save the crashed session. Do this now so hopefully it will be finished saving if user tries to load it later.
		if (session && backupFile) {
			SessionIo.writeFile(backupFile, session, function(aResults) {
				// Update tab tree if it's open
				if (Components.isSuccessCode(aResults)) 
					Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
			});
			SharedData._crash_backup_session_file = backupFile.leafName;
			if (encrypt_sessions) SharedData._encrypt_file = backupFile.leafName;
		}
		
		// Don't show crash prompt if user doesn't want it.
		let show_crash_prompt = !PreferenceManager.get("use_browser_crash_prompt", false);
		
		let values = { name: "*", addCurrentSession: true, ignorable: false, count: countString }
		// Store crash session in the shutdown state variable temporarily
		SharedData.mShutdownState = aState;
		let fileName = show_crash_prompt?(Utils.prompt(Utils._string("recover_session"), Utils._string("recover_session_ok"), values)?values.name:""):"";
		SharedData.mShutdownState = null;
		if (fileName != "*")
		{
			if (fileName)
			{
				SharedData._recovering = { fileName: fileName, sessionState: values.sessionState };
			}
			else if (!PreferenceManager.get("save_window_list", false))
			{
				SessionIo.clearUndoData("window", true);
			}
			if (show_crash_prompt) 
				preventBrowserRecover = true; // don't recover the crashed session
		}
		
		log("restorePrompt: _encrypt_file = " + SharedData._encrypt_file, "DATA");

		// If browser is set to clear history on shutdown, then it won't restore crashes so do that ourselves
		let privacy = PreferenceManager.get("privacy.sanitize.sanitizeOnShutdown", false, true) && PreferenceManager.get("privacy.clearOnShutdown.history", false, true);
		let restore_autosave = false;
		
		// If recovery current session and user chose specific tabs or browser won't do the restore
		if ((fileName == "*") && (privacy || values.sessionState)) {
			// if recovering current session, recover it from our backup file
			fileName = backupFile.leafName;
			preventBrowserRecover = true; // don't recover the crashed session
			SharedData._recovering = { fileName: fileName, sessionState: values.sessionState };
			restore_autosave = privacy && !values.sessionState;
		}
			
		log("restorePrompt: _recovering = " + (SharedData._recovering ? SharedData._recovering.fileName : "null"), "DATA");
		
		let autosave_values = Utils.parseAutoSaveValues(PreferenceManager.get("_autosave_values", null));
		let autosave_filename = restore_autosave ? null : autosave_values.filename;
		// If not recovering last session or recovering last session, but selecting tabs, always save autosave session
		// Note that if the crashed session was an autosave session, it won't show up as a choice in the crash prompt so 
		// the user can never choose it.
		if (autosave_filename && (fileName != "*"))
		{
			log("restorePrompt: Saving autosave file: "  + autosave_filename, "DATA");
			
			// delete autosave preferences
			PreferenceManager.delete("_autosave_values");

			// Clear any stored auto save session preferences
			Utils.getAutoSaveValues();
			
			// encrypt if encryption enabled
			if (encrypt_sessions) {
				encodedState = Utils.decryptEncryptByPreference(encodedState);
			}
			
			if (encodedState) {
				let time = (aState.session && aState.session.lastUpdate) ? new Date(aState.session.lastUpdate) : new Date();
				let autosave_time = isNaN(autosave_values.time) ? 0 : autosave_values.time;
				let autosave_state = Utils.nameState("timestamp=" + time.getTime() + "\nautosave=session/" + autosave_time +
																											 "\tcount=" + count.windows + "/" + count.tabs + (autosave_values.group ? ("\tgroup=" + autosave_values.group) : "") +
																											 (screensize ? ("\tscreensize=" + screensize) : "") + "\n" + encodedState, autosave_values.name);
				SessionIo.writeFile(SessionIo.getSessionDir(autosave_filename), autosave_state, function(aResults) {
					// Update tab tree if it's open
					if (Components.isSuccessCode(aResults)) 
						Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
				});
			}
		}
		
		// If browser is not doing the restore, save any autosave windows
		if (preventBrowserRecover)
			SharedData._save_crashed_autosave_windows = true;

		// Don't prompt for a session again if user cancels crash prompt
		SharedData._no_prompt_for_session = true;
		log("restorePrompt end", "INFO");
		
		return preventBrowserRecover;
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
	
	handleQuitApplicationRequest: function(aSubject, aTopic, aData)
	{
		// If quit already canceled, just return
		if (aSubject.QueryInterface(Ci.nsISupportsPRBool) && aSubject.data) return;
		
		// If private browsing is permanent don't allow saving
		try {
			if (Utils.isAutoStartPrivateBrowserMode()) 
				return;
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
				log("SessionManagerHelper:handleQuitApplicationRequest - Updating preferences so restart display warning prompt", "INFO");
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
				log("SessionManagerHelper SharedData.mAlreadyShutdown = " + SharedData.mAlreadyShutdown, "DATA");
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
		
		// Work around for Firefox not calling "close" event for Windows.  Note that if browser
		// is set to prompt when closing window, this gets sent before the prompt, so close can be canceled.
		// Currently I'm only reading this on quit-application-requested with the a data value of "lastwindow",
		// meaning the last browser window is closing and there are no other open windows or toolbars open.
		// I handle the case of the last browser window being closed with other windows opened by observing
		// "browser-lastwindow-close-granted" which occurs after the user allows the window to close.
		if (aData == "lastwindow")
			Services.obs.notifyObservers(null, "sessionmanager:last-window-closed", null);
	},
};
