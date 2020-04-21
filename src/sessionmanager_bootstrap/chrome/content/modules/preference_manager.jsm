"use strict";

this.EXPORTED_SYMBOLS = ["PreferenceManager"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "chrome://sessionmanager/content/modules/sql_manager.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");

Cu.import("chrome://sessionmanager/content/modules/shared_data/addonInfo.jsm");

// Constants
const OLD_PREFERENCE_ROOT = "extensions.sessionmanager.";
const PREFERENCE_ROOT = AddonInfo.prefBranch;
const SM_UUID = "{1280606b-2510-4fe0-97ef-9b5a22eafe30}";
const FIRST_URL = "http://sessionmanager.mozdev.org/history.html";
const FIRST_URL_DEV = "http://sessionmanager.mozdev.org/changelog.xhtml";
const DO_NOT_IMPORT_EXPORT = ["_autosave_values","_backup_autosave_values"];

// temporary variables for when doing import/export
let currentVersion, importFileName, exportFileName;

//
// API functions
//
this.PreferenceManager = {
	getAllPrefs: function() {
		return Private.getAllPrefs();
	},
	
	has: function(aName, aUseRootBranch) {
		return Private.has(aName, aUseRootBranch);
	},

	get: function(aName, aDefault, aUseRootBranch) {
		return Private.get(aName, aDefault, aUseRootBranch);
	},
	
	set: function(aName, aValue, aUseRootBranch) {
		return Private.set(aName, aValue, aUseRootBranch);
	},
	
	delete: function(aName, aUseRootBranch) {
		return Private.delete(aName, aUseRootBranch);
	},
	
	resetWarningPrompts: function()
	{
		return Private.resetWarningPrompts();
	},
	
	import: function() {
		return Private.import();
	},
	
	export: function() {
		return Private.export();
	},
	
	observe: function(aPrefName, aObserver, aOwnsWeak, aUseRootBranch) {
		return Private.observe(aPrefName, aObserver, aOwnsWeak, aUseRootBranch);
	},

	unobserve: function(aPrefName, aObserver, aUseRootBranch) {
		return Private.unobserve(aPrefName, aObserver, aUseRootBranch);
	},
  
	getHomePageGroup: function() {
		return Private.getHomePageGroup();
	},
	
	getInstantApply: function() {
		return Private.getInstantApply();
	}
},


// Don't allow changing
Object.freeze(PreferenceManager);

//	
// private functions
//
let Private = {

	smPreferenceBranch: null,

	// This two functions only exists to prevent Mozilla's validation from wrongly flagging
	// this add-on as writing browser preferences. If not for that there is a much easier
	// way to get SeaMonkey Home Page group preferences.
	getHomePageGroup: function() {
		var homePage = Services.prefs.getComplexValue("browser.startup.homepage",Ci.nsISupportsString);
		var children = Services.prefs.getChildList("browser.startup.homepage.");
		
		for (let i=0; i < children.length; i++) {
			try {
				if  (!isNaN(parseInt(children[i].substring(children[i].lastIndexOf(".") + 1))))
					homePage += '\n' + Services.prefs.getComplexValue(children[i],Ci.nsISupportsString).data;
			} catch(e) {}
		}
		return homePage;
	},
	
	getInstantApply: function() {
		var result = false;
		try {
			result = Services.prefs.getBoolPref("browser.preferences.instantApply");
		} catch(ex) {};
		return result;
	},

	getAllPrefs: function() {
		let count = {}, prefs = [];
		let children = this.smPreferenceBranch.getChildList("",count);
		for (let i=0; i < children.length; i++) {
			prefs.push({ name: children[i], value: this.get(children[i]) });
		}
		return prefs;
	},

	has: function(aName, aUseRootBranch) 
	{
		let pb = (aUseRootBranch)?Services.prefs:this.smPreferenceBranch;
		return pb.prefHasUserValue(aName);
	},

	get: function(aName, aDefault, aUseRootBranch) 
	{
		let value = (typeof aDefault == "undefined") ? "" : aDefault;
	
		try
		{
			let pb = (aUseRootBranch)?Services.prefs:this.smPreferenceBranch;
			switch (pb.getPrefType(aName))
			{
				case pb.PREF_STRING:
					// handle unicode values
					value = pb.getComplexValue(aName,Ci.nsISupportsString).data
					break;
				case pb.PREF_BOOL:
					value = pb.getBoolPref(aName);
					break;
				case pb.PREF_INT:
					value = pb.getIntPref(aName);
					break;
			}
		}
		catch (ex) { }
		return value;
	},

	set: function(aName, aValue, aUseRootBranch) 
	{
		let forceSave = this.checkForForceSave(aName, aValue, aUseRootBranch);
		
		try {
			let pb = (aUseRootBranch)?Services.prefs:this.smPreferenceBranch;
			switch (typeof aValue)
			{
				case "string":
					// handle unicode values
					var str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
					str.data = aValue;
					pb.setComplexValue(aName,Ci.nsISupportsString, str);
					break;
				case "boolean":
					pb.setBoolPref(aName, aValue);
					break;
				case "number":
					pb.setIntPref(aName, Math.floor(aValue));
					break;
			}
			if (forceSave) Services.obs.notifyObservers(null,"sessionmanager-preference-save",null);
		} 
		catch(ex) { logError(ex); }
	},

	delete: function(aName, aUseRootBranch) 
	{
		let pb = (aUseRootBranch)?Services.prefs:this.smPreferenceBranch;
		if (pb.prefHasUserValue(aName)) 
			pb.clearUserPref(aName);
	},
	
	// Delete warning prompt preferences which have the format of "no_....._prompt"
	resetWarningPrompts: function()
	{
		let prefs = this.getAllPrefs();
		if (prefs.length) {
			prefs = prefs.filter(function(element, index, array) {
				return element.name.match(/no_(.*)_prompt/);
			});
			prefs.forEach(function(pref) {
				this.delete(pref.name);
			}, this);
		}
	},
	
	import: function()
	{
		let file = this.chooseFile(false);
		if (!file) return;
	
		// save current version 
		currentVersion = this.get("version", "");
		importFileName = file.leafName;
	
		// Read preference file
		SessionIo.asyncReadFile(file, function(aInputStream, aStatusCode) {this.import_callback(aInputStream, aStatusCode)}.bind(this));
	},
	
	import_callback: function(aInputStream, aStatusCode) {
		let prefsString, reason;  
		let success = false;
		
		if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
			// Read the session file from the stream and process and return it to the callback function
			try {
				prefsString = NetUtil.readInputStreamToString(aInputStream, aInputStream.available(), { charset : "UTF-8" } );
				success = true;
			}	
			catch(ex) { 
				reason = ex;
				logError(ex); 
			}
		}
		else {
			reason = new Components.Exception(importFileName, aStatusCode, Components.stack.caller);
			logError(reason);
		}

		importFileName = null;
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		
		if (success) {
			let prefs = JSON.parse(prefsString);
			if (prefs.length) {
				for (let i=0; i<prefs.length; i++) {
					// If not in do not import list, import it
					if (DO_NOT_IMPORT_EXPORT.indexOf(prefs[i].name) == -1)
						this.set(prefs[i].name, prefs[i].value);
				}
			}
		
			this.updatePreferences2(currentVersion, this.get("version"), true);
			// update options window for preferences that don't automatically update window
			window.updateSpecialPreferences();
			window.disableApply();
		}
		
		currentVersion = null;
		// put up alert
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("import_successful") :  (bundle.GetStringFromName("import_failed") + " - " + reason);
		Services.prompt.alert(window, bundle.GetStringFromName("import_prompt"), text);
	},
	
	export: function()
	{
		let file = this.chooseFile(true);
		if (!file) return;

		exportFileName = file.leafName;
		
		let reason;
		try {
			let prefs = this.getAllPrefs();
			if (prefs.length) {
			
				let myprefs = [];
				for (let i=0; i<prefs.length; i++) {
					// If not in do not export list, export it
					if (DO_NOT_IMPORT_EXPORT.indexOf(prefs[i].name) == -1)
						myprefs.push({ name: prefs[i].name, value: prefs[i].value });
				}
				let prefsString = JSON.stringify(myprefs);
				
				SessionIo.writeFile(file, prefsString, this.export_callback);
				return;
			}
		}
		catch(ex) { 
			reason = ex;
			logError(ex); 
		}
		
		exportFileName = null;
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = bundle.GetStringFromName("export_failed") + " - " + reason;
		Services.prompt.alert(window, bundle.GetStringFromName("export_prompt"), text);
	},
	
	export_callback: function(aStatusCode) {
		let reason;  
		let success = false;
		
		if (Components.isSuccessCode(aStatusCode)) {
			success = true;
		}	
		else {
			reason = new Components.Exception(exportFileName, aStatusCode, Components.stack.caller);
			logError(reason);
		}
		
		exportFileName = null;
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("export_successful") :  (bundle.GetStringFromName("export_failed") + " - " + reason);
		Services.prompt.alert(window, bundle.GetStringFromName("export_prompt"), text);
	},

	// Use Preference Service for observing instead of FUEL because FUEL's preference observer is not working - Bug 488587
	observe: function(aPrefName, aObserver, aOwnsWeak, aUseRootBranch)
	{
		(aUseRootBranch ? Services.prefs : this.smPreferenceBranch).addObserver(aPrefName, aObserver, aOwnsWeak);
	},

	unobserve: function(aPrefName, aObserver, aUseRootBranch)
	{
		try {
			((aUseRootBranch)?Services.prefs:this.smPreferenceBranch).removeObserver(aPrefName, aObserver);
		}
		catch(ex) { logError(ex); }
	},
	
	//
	// Private Functions
	//

	initialize: function()
	{
		// Read in default preference values
		this.readDefaultPrefs();

		log("PreferenceManager initialize start", "TRACE");
		
		this.smPreferenceBranch = Services.prefs.getBranch(PREFERENCE_ROOT).QueryInterface(Ci.nsIPrefBranch2);
		
		// Move preference root to correct location if it's wrong
		this.movePreferenceRoot();

		// Convert sessions to Firefox 3.5+ format if never converted them
		SharedData.convertFF3Sessions = this.get("lastRanFF3", true);
		this.set("lastRanFF3", false);
	
		// Make sure resume_session is not null.  This could happen in 0.6.2.  It should no longer occur, but 
		// better safe than sorry.
		if (!this.get("resume_session")) {
			this.set("resume_session", Constants.BACKUP_SESSION_FILENAME);
			if (this.get("startup") == 2)
				this.set("startup",0);
		}

		// This updates preference in case of an update.
		this.updatePreferences();
		
		// Put up saving warning if private browsing mode permanently enabled.
		if (Utils.isAutoStartPrivateBrowserMode()) {
			if (!this.get("no_private_browsing_prompt", false)) {
				let dontPrompt = { value: false };
				Services.prompt.alertCheck(null, Utils._string("sessionManager"), Utils._string("private_browsing_warning"), Utils._string("prompt_not_again"), dontPrompt);
				if (dontPrompt.value)
				{
					this.set("no_private_browsing_prompt", true);
				}
			}
		}
	},
	
	readDefaultPrefs: function() {
		// Load default preferences and set up properties for them
		let defaultBranch = Services.prefs.getDefaultBranch(PREFERENCE_ROOT);
		let scope =
		{
			pref: function(pref, value)
			{
				if (pref.substr(0, PREFERENCE_ROOT.length) != PREFERENCE_ROOT)
				{
					Cu.reportError(new Error("Ignoring default preference " + pref + ", wrong branch."));
					return;
				}
				pref = pref.substr(PREFERENCE_ROOT.length);
	
				try {
					switch (typeof value) {
						case "boolean":
							defaultBranch.setBoolPref(pref, value);
							break;
						case "object":
							value = JSON.stringify(value);
						case "number":
							// This will never be true if fall through from object
							if (Math.round(value) == value) {
								defaultBranch.setIntPref(pref, value);
								break;
							}
						case "string":
							let str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
							str.data = value;
							defaultBranch.setComplexValue(pref, Ci.nsISupportsString, str);
							break;
					}
				}
				catch(ex) {
					Cu.reportError(ex);
				}
			}
		};
		Services.scriptloader.loadSubScript(AddonInfo.addonRoot + "defaults/prefs.js", scope);
	},
	
	// Certain preferences should be force saved in case of a crash
	checkForForceSave: function(aName, aValue, aUseRootBranch)
	{
		let names = [ "_autosave_values" ];
		
		for (let i=0; i<names.length; i++) {
			if (aName == names[i]) {
				let currentValue = this.get(aName, null, aUseRootBranch);
				return (currentValue != aValue);
			}
		}
		return false;
	},

	// Move preferences from old preference branch to new standard one that uses extension GUID
	movePreferenceRoot: function()
	{
		// If old values exist
		if (this.has(OLD_PREFERENCE_ROOT + "version"), true) {
			let prefBranch = Services.prefs.getBranch(OLD_PREFERENCE_ROOT);
			let count = {};
			let children = prefBranch.getChildList("",count);
			for (let i=0; i < children.length; i++) {
				try {
					if (this.has(OLD_PREFERENCE_ROOT + children[i], true)) {
						this.set(PREFERENCE_ROOT + children[i], this.get(OLD_PREFERENCE_ROOT + children[i],null,true));
						prefBranch.clearUserPref(children[i]);
					}
				} catch(ex) {
					logError(ex);
				}
			}
		}
	},

	// Pick file to save/load preferences
	// aSave true = save
	// aSave false = load
	chooseFile: function(aSave)
	{
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let nsIFilePicker = Ci.nsIFilePicker;
		let filepicker = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		
		filepicker.init(window, bundle.GetStringFromName((aSave ? "export" : "import") + "_prompt"), (aSave ? nsIFilePicker.modeSave : nsIFilePicker.modeOpen));
		filepicker.appendFilter(bundle.GetStringFromName("settings_file_extension_description"), "*." + bundle.GetStringFromName("session_manager_settings_file_extension"));
		filepicker.defaultString = bundle.GetStringFromName("default_settings_file_name");
		filepicker.defaultExtension = bundle.GetStringFromName("settings_file_extension");
			if (!aSave) filepicker.appendFilters(nsIFilePicker.filterAll);
		var ret = filepicker.show();
		if (ret == nsIFilePicker.returnOK || ret == nsIFilePicker.returnReplace) {
			return filepicker.file;
		}
		else return null;
	},
	
	updatePreferences: function() {
		let oldVersion = this.get("version", "");
		let newVersion = AddonInfo.version;
		
		if (this.updatePreferences2(oldVersion, newVersion)) {
			// Set flag to display message on update if preference set to true
			if (this.get("update_message", true)) {
				// If development version, go to development change page
				let dev_version = (/pre\d*/.test(newVersion));
				SharedData._displayUpdateMessage = (dev_version ? FIRST_URL_DEV : FIRST_URL) + "?oldversion=" + oldVersion + "&newversion=" + newVersion;
			}
		}
		
		log("PreferenceManager initialize end", "TRACE");
	},

	// When aNotTrueUpdate is set to true, don't fix anything but preferenes since we're not actually doing an update from
	// an old version of Session Mananger.
	updatePreferences2: function(oldVersion, newVersion, aNotTrueUpdate) {
		if (oldVersion != newVersion)
		{
			// If this is an actual update of Session Manager, check if we need to update session data files
			if (!aNotTrueUpdate) {
		
				// Fix the closed window data if it's encrypted
				if ((Services.vc.compare(oldVersion, "0.6.4.2") < 0) && !this.get("use_SS_closed_window_list")) {
					// if encryption enabled
					if (this.get("encrypt_sessions")) {
						let windows = SessionIo.getClosedWindows_SM();
						
						// if any closed windows
						if (windows.length) {
							// force a master password prompt so we don't waste time if user cancels it, if user cancels three times 
							// simply delete the stored closed windows
							let count = 4;
							while (--count && !PasswordManager.enterMasterPassword());

							let okay = true;
							let exception = null;
							if (count) {
								windows.forEach(function(aWindow) {
									aWindow.state = Utils.decrypt(aWindow.state, true, true);
									aWindow.state = Utils.decryptEncryptByPreference(aWindow.state, true);
									if (!aWindow.state || (typeof(aWindow.state) != "string")) {
										okay = false;
										exception = aWindow.state;
										return;
									}
								}, this);
								if (okay) {
									SessionIo.storeClosedWindows_SM(windows);
								}
							}
							else {
								okay = false;
							}
							if (!okay) {
								if (exception) Utils.cryptError(exception, true);
								// delete closed windows
								SessionIo.storeClosedWindows_SM([]);
							}
						}
					}
				}
				
				// Cached data changed (now cache history) so re-create cache file if enabled
				if ((Services.vc.compare(oldVersion, "0.7.7pre20110826") <= 0) && (this.get("use_SQLite_cache"))) 
					SQLManager.rebuildCache();

				// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
				if (Services.vc.compare(oldVersion, "0.6.2.1") < 0) {
					let RDF = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
					let ls = Cc["@mozilla.org/rdf/datasource;1?name=local-store"].getService(Ci.nsIRDFDataSource);
					let rdfNode = RDF.GetResource("chrome://sessionmanager/content/options/options.xul#sessionmanagerOptions");
					let arcOut = ls.ArcLabelsOut(rdfNode);
					while (arcOut.hasMoreElements()) {
						let aLabel = arcOut.getNext();
						if (aLabel instanceof Ci.nsIRDFResource) {
							let aTarget = ls.GetTarget(rdfNode, aLabel, true);
							ls.Unassert(rdfNode, aLabel, aTarget);
						}
					}
					ls.QueryInterface(Ci.nsIRDFRemoteDataSource).Flush();
				}
							
				// Add backup sessions to backup group
				if (Services.vc.compare(oldVersion, "0.6.2.8") < 0) {
					let sessions = SessionIo.getSessions();
					sessions.forEach(function(aSession) {
						if (aSession.backup) {
							SessionIo.group(aSession.fileName, Utils._string("backup_sessions"));
						}
					}, this);
				}
				
				// Version 0.6.9 had a bug in it which would corrupt old session format files so fix them.
				if (Services.vc.compare(oldVersion, "0.6.9") == 0) {
					SharedData._fix_newline = true;
					SharedData.convertFF3Sessions = true;
				}
				
				// Format changed for _autosave_values and _backup_autosave_values preferences
				// Since these are temporary preferences, we don't import/export them so don't bother checking unless upgrading
				if (Services.vc.compare(oldVersion, "0.9.8") <= 0) {
					for (var i=0; i<2; i++) {
						let values = this.get(i ? "_autosave_values" : "_backup_autosave_values");
						if (values) {
							values = values.split("\n");
							if (values.length == 4)
								this.set((i ? "_autosave_values" : "_backup_autosave_values"), Utils.mergeAutoSaveValues(values[0], values[1], values[2], values[3]));
						}
					}
				}
			}

			// these aren't used anymore
			if (Services.vc.compare(oldVersion, "0.6.2.5") < 0) this.delete("_no_reload");
			if (Services.vc.compare(oldVersion, "0.7.6") < 0) this.delete("disable_cache_fixer");
			if (Services.vc.compare(oldVersion, "0.9.7.5") < 0) this.delete("work_around_mozilla_addon_sdk_bug");

			// This preference is no longer a boolean so delete it when updating to prevent exceptions.
			if (Services.vc.compare(oldVersion, "0.7.7pre20110824") <= 0) this.delete("leave_prompt_window_open");
			
			// Newer versions don't automatically append "sessions" to user chosen directory so
			// convert existing preference to point to that folder.
			if (Services.vc.compare(oldVersion, "0.7") < 0) {
				if (this.get("sessions_dir", null)) {
					let dir = SessionIo.getUserDir("sessions");
					this.set("sessions_dir", dir.path)
				}
			}
			
			if (!aNotTrueUpdate)
				this.set("version", newVersion);
		}
		return oldVersion != newVersion;
	},
}

// Initialize
Private.initialize();
