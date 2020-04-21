"use strict";

this.EXPORTED_SYMBOLS = ["SharedData"];

this.SharedData = {
	// Used to store copy of data on shutdown
	mTitle: null,								// Window title
	old_mTitle: null,						// Original window title
	mClosingWindowState: null,	// Temporary holder for last closed window's state value
	mShutdownState: null, 	 		// Shutdown session state
	mProfileDirectory: null,		// Profile directory
	_screen_width: null,				// Screen width
	_screen_height: null,				// Screen height
	
	// Flags
	_browserCrashed: false,											// Browser detected a crash
	_browserWindowDisplayed: false,							// Initial browser window has opened
	_countWindows: true,												// When true, a "sessionmanager:window-loaded" notification will be sent when a window is opened.  Used to count window opened at startup.
	_displayUpdateMessage: null,								// URL of web site to display on addon update
	_fix_newline: false,  											// This is used to fix converted sessions corrupted by 0.6.9.  Will only ever be set once.
	_initialized: false,												// Session Mananger initialized
	_no_prompt_for_session: false,							// Do not prompt for session when this flag is set (used to prevent double prompting)
	_restart_requested: false, 									// Set to true if browser is restarting
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

	//
	// Private Browsing data - Only used in Firefox 19 and earlier as Firefox 20 and up has per-window private browsing
	//
	mAboutToEnterPrivateBrowsing: false,		// This forces window sessions to save and stay open.  It gets set when about to enter private 
																					// browsing mode upon receipt of the "private-browsing-change-granted" notification
																					// to allow windows to be saved since the isPrivateBrowserMode() function will return true at that point,
																					// even though the browser technically is not in private browsing.  The flag is immediately cleared after the
																					// windows are saved. 
	mAutoPrivacy: false,										// Set to true if entering permanent private browsing mode
	mBackupState: null,											// Contains the browser state prior to entering private browsing mode
	mShutDownInPrivateBrowsingMode: false,	// Set to true if the browser exits while in private browsing mode
	
	// private temporary values
	_crash_backup_session_file: null,		// On a crash, this is the name of the backup file that was created from the browser crash data
	_crash_session_filename: null,			// Backup of file name of session file user chose to restore after a crash
	_encrypt_file: null,								// The same as _crash_backup_session_file if the backup crash file needs to be encrypted
	_pb_saved_autosave_values: null,		// Used to store current autosave session info (name, etc) when entering Private Browsing Mode (Firefox 19 and earlier) so it can be restored later
	_recovering: null,									// Object containing file name and selected tabs of session file user chose to restore after a crash
	_temp_restore: null,								// Contains a list of session files specified on the command line (or by double clicking session file) for restoring

	// The file names of current active window sessions
	mActiveWindowSessions: [],
	
	// AutoSave Session values
	_autosave_filename: null,		// File name
	_autosave_name: null,				// Session Name
	_autosave_group: null,			// Group
	_autosave_time: 0,					// save time
	
	// Session Prompt Data - Used to pass and return data from the Session Prompt window
	sessionPromptData: null,
	sessionPromptReturnData: null,
};