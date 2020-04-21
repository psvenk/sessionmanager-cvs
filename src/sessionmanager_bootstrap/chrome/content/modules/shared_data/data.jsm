"use strict";

this.EXPORTED_SYMBOLS = ["SharedData"];

this.SharedData = {
	// Used to store copy of data on shutdown
	mTitle: null,								// Window title
	old_mTitle: null,						// Original window title
	mClosingWindowState: null,	// Temporary holder for last closed window's state value
	mClosingAutoWindowState: null,	// Temporary holder for auto-save window's state value (work around for Firefox bug 1255578)
	mShutdownState: null, 	 		// Shutdown session state
	_screen_width: null,				// Screen width
	_screen_height: null,				// Screen height
	
	// Flags
	_browserCrashed: false,											// Browser detected a crash
	_browser_restarting: false, 								// Set to true if browser is restarting
	_browserWindowDisplayed: false,							// Initial browser window has opened
	_countWindows: true,												// When true, a "sessionmanager:window-loaded" notification will be sent when a window is opened.  Used to count window opened at startup.
	_displayUpdateMessage: null,								// URL of web site to display on addon update
	_fix_newline: false,  											// This is used to fix converted sessions corrupted by 0.6.9.  Will only ever be set once.
	_no_prompt_for_session: false,							// Do not prompt for session when this flag is set (used to prevent double prompting)
	_restore_requested: false, 									// Set to true if browser will restore window/tabs next time it starts.
	_restoring_autosave_backup_session: false,	// Set to true when restoring an autosave session that was closed when browser quit at browser startup
	_restoring_backup_session: false,						// Set to true when restoring an backup session that was closed when browser quit at browser startup
	_running: false,														// Session Mananger is "running", i.e. it has done it's first window processing
	_save_crashed_autosave_windows: false,			// Triggers saving window sessions from the browser crash data
	_stopping: false,														// Browser is quiting (quit has been granted)
	convertFF3Sessions: false, 									// Flag to trigger searching for older Firefox 3 formatted sessions.  Will only ever be set once.
	mAlreadyShutdown: false,										// Set to true if last window closed, triggered Session Manager shutdown processing
	mEncryptionChangeInProgress: false,					// An encryption change is in progress when this is set.
	mShutdownPromptResults: -1,									// Stores the result of the backup session prompt put up because of a "browser-lastwindow-close-requested" or "quit-application-requested" notification.
	savingTabTreeVisible: false,								// Used to indicate whether or not saving tab tree needs to be updated
	tabMixPlusEnabled: false,										// Tab Mix Plus has been detected as installed and enabled
	panoramaExists: false,										  // Panorama is being moved to an add-on so use this flag to indicate whether it exists or not.
	justStartedUpDowngraded: true,							// Set to true, if application just started or upgraded or downgraded add-on.
	upgradingOrDowngrading: false,							// Set to true, when the application is disabling to upgrade or downgrade
	privateTabsEnabled: false,									// Private Tabs addon has been detected as installed and enabled
	tabGroupsEnabled: false,					// Tab Groups addon has been detected as installed and enabled

	// private temporary values
	_crash_backup_session_file: null,		// On a crash, this is the name of the backup file that was created from the browser crash data
	_crash_session_filename: null,			// Backup of file name of session file user chose to restore after a crash
	_encrypt_file: null,								// The same as _crash_backup_session_file if the backup crash file needs to be encrypted
	_recovering: null,									// Object containing file name and selected tabs of session file user chose to restore after a crash
	_temp_restore: null,								// Contains a list of session files specified on the command line (or by double clicking session file) for restoring

	// Window Session values
	mActiveWindowSessions: [],					// Array of booleans of active window sessions, indexed by file name
	mWindowSessionData: [],							// Array of active window session data indexed by __SessionManagerWindowId (window.__SSi)
	
	
	// AutoSave Session values
	_autosave: {
		filename: null,		// File name
		name: null,				// Session Name
		group: null,			// Group
		time: 0,					// save time
	},
	
	// Session Prompt Data - Used to pass and return data from the Session Prompt window
	sessionPromptData: null,
	sessionPromptReturnData: null,
};

// Set the flags indicating whether or not Tab Mix Plus, Private Tabs and Tab Groups are active.  This is a callback so it is set asynchronously
(function() {
  var o = {};
	var watchAddons = ["{dc572301-7619-498c-a57d-39143191b318}", "privateTab@infocatcher", "tabgroups@quicksaver"];
	Components.utils.import("resource://gre/modules/Services.jsm", o);
	Components.utils.import("resource://gre/modules/AddonManager.jsm", o);
	o.AddonManager.getAddonsByIDs(watchAddons, function(addons) {
		for (let i in addons) {
			if (addons[i]) {
				switch(addons[i].id) {
					// Tab Mix Plus
					case "{dc572301-7619-498c-a57d-39143191b318}":
						SharedData.tabMixPlusEnabled = addons[i] && addons[i].isActive;
						// This might not be necessary as this appears to be set by the time windows load, but it doesn't hurt.
						o.Services.obs.notifyObservers(null, "sessionmanager:shared-data-tmp-set", null);
						break;
					// Private Tabs
					case "privateTab@infocatcher":
						SharedData.privateTabsEnabled = addons[i] && addons[i].isActive;
						break;
					// Tab Groups
					case "tabgroups@quicksaver":
						SharedData.tabGroupsEnabled = addons[i] && addons[i].isActive;
						break;
				}
			}
		}
	});
})(this);
