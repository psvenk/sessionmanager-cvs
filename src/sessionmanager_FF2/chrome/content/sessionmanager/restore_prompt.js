"use strict";

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "resource://sessionmanager/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "resource://sessionmanager/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "resource://sessionmanager/modules/utils.jsm");

var restorePrompt = function() {
	log("restorePrompt start", "INFO");
	
	// default count variable
	var countString = "";
	
	var session = null, backupFile = null, state = null, count = null;
	var	screensize = screen.width + "x" + screen.height;
			
	// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
	var file = SessionIo.getProfileFile("sessionstore.js");
	
	// If file does not exist, try looking for SeaMonkey's sessionstore file
	if (!file.exists()) {
		file = SessionIo.getProfileFile("sessionstore.json");
	}
	
	if (file.exists())
	{
		try {
			var name = Utils.getFormattedName("", new Date(file.lastModifiedTime), Utils._string("crashed_session"));
			state = SessionIo.readFile(file);
			count = Utils.getCount(state);
			session = Utils.nameState("timestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + Utils._string("backup_sessions") + "\tscreensize=" + screensize + "\n" + state, name);
			backupFile = SessionIo.getSessionDir(Constants.BACKUP_SESSION_FILENAME, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			logError(ex); 
		}
	}
	
	// Don't show crash prompt if user doesn't want it.
	var show_crash_prompt = !PreferenceManager.get("use_browser_crash_prompt", false);
	
	var params = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
	params.SetInt(0, 0);
			
	var values = { name: "*", addCurrentSession: true, ignorable: false, count: countString }
	var fileName = (show_crash_prompt && location.search != "?cancel")?(Utils.prompt(Utils._string("recover_session"), Utils._string("recover_session_ok"), values)?values.name:""):"";
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
		if (show_crash_prompt) params.SetInt(0, 1); // don't recover the crashed session
	}
	
	let encrypt_sessions = PreferenceManager.get("encrypt_sessions", false);
	// actually save the crashed session
	if (session && backupFile) {
		SessionIo.writeFile(backupFile, session);
		SharedData._crash_backup_session_file = backupFile.leafName;
		if (encrypt_sessions) SharedData._encrypt_file = backupFile.leafName;
	}
	
	log("restorePrompt: _encrypt_file = " + SharedData._encrypt_file, "DATA");

	// If browser is set to clear history on shutdown, then it won't restore crashes so do that ourselves
	var privacy = PreferenceManager.get("privacy.sanitize.sanitizeOnShutdown", false, true) && PreferenceManager.get("privacy.clearOnShutdown.history", false, true);
	var restore_autosave = false;
	
	// If recovery current session and user chose specific tabs or browser won't do the restore
	if ((fileName == "*") && (privacy || values.sessionState)) {
		// if recovering current session, recover it from our backup file
		fileName = backupFile.leafName;
		params.SetInt(0, 1); // don't recover the crashed session
		SharedData._recovering = { fileName: fileName, sessionState: values.sessionState };
		restore_autosave = privacy && !values.sessionState;
	}
		
	log("restorePrompt: _recovering = " + (SharedData._recovering ? SharedData._recovering.fileName : "null"), "DATA");
	
	var autosave_values = PreferenceManager.get("_autosave_values", "").split("\n");
	var autosave_filename = restore_autosave ? null : autosave_values[0];
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
		
		log("Saving crashed autosave session " + autosave_filename, "DATA");
		var temp_state = SessionIo.readFile(file);
		// encrypt if encryption enabled
		if (encrypt_sessions) {
			temp_state = Utils.decryptEncryptByPreference(temp_state);
		}
		
		if (temp_state) {
			var autosave_time = isNaN(autosave_values[3]) ? 0 : autosave_values[3];
			var autosave_state = Utils.nameState("timestamp=" + file.lastModifiedTime + "\nautosave=session/" + autosave_time +
																										 "\tcount=" + count.windows + "/" + count.tabs + (autosave_values[2] ? ("\tgroup=" + autosave_values[2]) : "") +
																										 "\tscreensize=" + screensize + "\n" + temp_state, autosave_values[1]);
			SessionIo.writeFile(SessionIo.getSessionDir(autosave_filename), autosave_state);
		}
	}
	
	// If browser is not doing the restore, save any autosave windows
	if (params.GetInt(0) == 1)
		SharedData._save_crashed_autosave_windows = true;

	// Don't prompt for a session again if user cancels crash prompt
	SharedData._no_prompt_for_session = true;
	log("restorePrompt end", "INFO");
};
		
restorePrompt();
window.close();
