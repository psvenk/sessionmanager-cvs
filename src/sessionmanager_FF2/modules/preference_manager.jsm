"use strict";

this.EXPORTED_SYMBOLS = ["PreferenceManager"];

const Cc = Components.classes;
const Ci = Components.interfaces;

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "logError", "resource://sessionmanager/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");

// Lazily define services
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}

// Constants
const OLD_PREFERENCE_ROOT = "extensions.sessionmanager.";
const PREFERENCE_ROOT = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.";
const SM_UUID = "{1280606b-2510-4fe0-97ef-9b5a22eafe30}";

var smPreferenceBranch = null;
var _initialized = false;

//
// API functions
//

this.PreferenceManager = {

	// Call this as a function instead of running internally because it needs to run before the session_manager module's initialize function
	initialize: function()
	{
		if (!_initialized) {
			smPreferenceBranch = Services.prefs.getBranch(PREFERENCE_ROOT).QueryInterface(Ci.nsIPrefBranch2);
			movePreferenceRoot();
			_initialized = true;
		}
	},
	
	getAllPrefs: function() {
		let count = {}, prefs = [];
		let children = smPreferenceBranch.getChildList("",count);
		let regex = new RegExp(PREFERENCE_ROOT + "(.*)");
		for (let i=0; i < children.length; i++) {
			try {
				let pref = Application.prefs.get(PREFERENCE_ROOT + children[i]);
				let match = pref.name.match(regex);
				if (match) {
					prefs.push({ name: match[1], value: pref.value });
				}
			} catch(ex) {
				logError(ex);
			}
		}
		return prefs;
	},

	has: function(aName, aUseRootBranch) 
	{
		return Application.prefs.has((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName);
	},

	get: function(aName, aDefault, aUseRootBranch) 
	{
		let value = (typeof aDefault == "undefined") ? "" : aDefault;
	
		// calling from background threads causes a crash, so use nsiPrefBranch in that case - Bug 565445
		if (Services.tm.isMainThread) {
			value = Application.prefs.getValue((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName, value);
		}
		else {
			try
			{
				let pb = (aUseRootBranch)?Services.prefs:smPreferenceBranch;
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
		}
		return value;
	},

	set: function(aName, aValue, aUseRootBranch) 
	{
		let forceSave = checkForForceSave(aName, aValue, aUseRootBranch);
		
		try {
			Application.prefs.setValue((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName, aValue);
			if (forceSave) Services.obs.notifyObservers(null,"sessionmanager-preference-save",null);
		} 
		catch(ex) { logError(ex); }
	},

	delete: function(aName, aUseRootBranch) 
	{
		let pref = Application.prefs.get((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName);
		if (pref && pref.modified) {
			pref.reset();
		}
	},
	
	// Delete warning prompt preferences which have the format of "no_....._prompt"
	resetWarningPrompts: function(aExtensions)
	{
		let extensions = Application.extensions ? Application.extensions : aExtensions;
		if (!extensions) {
			if (typeof(Application.getExtensions) == "function") {
				Application.getExtensions(PreferenceManager.resetWarningPrompts);
			}
			return;
		}
	
		let prefs = extensions.get(SM_UUID).prefs.all;
		if (prefs.length) {
			prefs = prefs.filter(function(element, index, array) {
				return element.name.match(/no_(.*)_prompt/);
			});
			prefs.forEach(function(pref) {
				pref.reset();
			});
		}
	},
	
	import: function()
	{
		let file = chooseFile(false);
		if (!file) return;
	
		// save current version 
		let currentVersion = this.get("version", "");
	
		let prefsString = "";  
		let success = true;
		let reason = "";
		try {
			let fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);  
			let cstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);  
			fstream.init(file, -1, 0, 0);  
			cstream.init(fstream, "UTF-8", 0, 0); // you can use another encoding here if you wish  

			let (str = {}) {  
				let read = 0;  
				do {   
					read = cstream.readString(0xffffffff, str); // read as much as we can and put it in str.value  
					prefsString += str.value;  
				} while (read != 0);  
			}  
			cstream.close(); // this closes fstream  		
		
			let prefs = JSON.parse(prefsString);
			if (prefs.length) {
				for (let i=0; i<prefs.length; i++) {
					this.set(prefs[i].name, prefs[i].value);
				}
			}
		} 
		catch(ex) { 
			success = false;
			reason = ex;
			logError(ex); 
		}
		
		// Correct any inconsistencies do to updating restoring old version number (see session_manager.jsm::checkForUpdate
		let restoreVersion = this.get("version", "");
		// these aren't used anymore so delete if they exist
		if (Services.vc.compare(restoreVersion, "0.6.2.5") < 0) this.delete("_no_reload");
		if (Services.vc.compare(restoreVersion, "0.7.6") < 0) this.delete("disable_cache_fixer");
		if (Services.vc.compare(restoreVersion, "0.9.7.5") < 0) this.delete("work_around_mozilla_addon_sdk_bug");
		// New version doesn't automatically append "sessions" to user chosen directory so
		// convert existing preference to point to that folder.
		if (Services.vc.compare(restoreVersion, "0.7") < 0) {
			if (this.get("sessions_dir", null)) {
				let dir = SessionIo.getUserDir("sessions");
				this.set("sessions_dir", dir.path)
			}
		}
		this.set("version", currentVersion);
		
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		
		// update options window for preferences that don't automatically update window
		if (success) {
			window.updateSpecialPreferences();
			window.disableApply();
		}

		// put up alert
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("import_successful") :  (bundle.GetStringFromName("import_failed") + " - " + reason);
		Services.prompt.alert(window, bundle.GetStringFromName("import_prompt"), text);
	},
	
	export: function(aExtensions)
	{
		let extensions = Application.extensions ? Application.extensions : aExtensions;
		if (!extensions) {
			if (typeof(Application.getExtensions) == "function") {
				Application.getExtensions(PreferenceManager.export);
			}
			return;
		}
	
		let file = chooseFile(true);
		if (!file) return;
	
		let success = true;
		let reason = "";
		try {
			let prefs = extensions.get(SM_UUID).prefs.all;
			if (prefs.length) {
			
				let myprefs = [];
				for (let i=0; i<prefs.length; i++) {
					myprefs.push({ name: prefs[i].name, value: prefs[i].value });
				}
				let prefsString = JSON.stringify(myprefs);
				
				// file is nsIFile, prefsString is a string
				let foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);

				foStream.init(file, 0x02 | 0x08 | 0x20, -1, 0); 
				// write, create, truncate
				// 664 = u:rwx, g:rw, u:r

				// if you are sure there will never ever be any non-ascii text in data you can 
				// also call foStream.writeData directly
				let converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
				converter.init(foStream, "UTF-8", 0, 0);
				converter.writeString(prefsString);
				converter.flush();
				converter.close(); // this closes foStream			
			}
		}
		catch(ex) { 
			success = false;
			reason = ex;
			logError(ex); 
		}
		
		let window = Services.wm.getMostRecentWindow("SessionManager:Options");
		let bundle = Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("export_successful") :  (bundle.GetStringFromName("export_failed") + " - " + reason);
		Services.prompt.alert(window, bundle.GetStringFromName("export_prompt"), text);
	},

	// Use Preference Service for observing instead of FUEL because FUEL's preference observer is not working - Bug 488587
	observe: function(aPrefName, aObserver, aOwnsWeak, aUseRootBranch)
	{
		(aUseRootBranch ? Services.prefs : smPreferenceBranch).addObserver(aPrefName, aObserver, aOwnsWeak);
	},

	unobserve: function(aPrefName, aObserver, aUseRootBranch)
	{
		try {
			((aUseRootBranch)?Services.prefs:smPreferenceBranch).removeObserver(aPrefName, aObserver);
		}
		catch(ex) { logError(ex); }
	}
}

// Don't allow changing
Object.freeze(PreferenceManager);

//	
// private functions
//

// Certain preferences should be force saved in case of a crash
function checkForForceSave(aName, aValue, aUseRootBranch)
{
	let names = [ "_autosave_values" ];
	
	for (let i=0; i<names.length; i++) {
		if (aName == names[i]) {
			let currentValue = PreferenceManager.get(aName, null, aUseRootBranch);
			return (currentValue != aValue);
		}
	}
	return false;
}

// Move preferences from old preference branch to new standard one that uses extension GUID
function movePreferenceRoot()
{
	// If old values exist
	if (Application.prefs.has(OLD_PREFERENCE_ROOT + "version")) {
		let prefBranch = Services.prefs.getBranch(OLD_PREFERENCE_ROOT);
		let count = {};
		let children = prefBranch.getChildList("",count);
		for (let i=0; i < children.length; i++) {
			try {
				let pref = Application.prefs.get(OLD_PREFERENCE_ROOT + children[i]);
				if (pref && pref.modified) {
					Application.prefs.setValue(PREFERENCE_ROOT + children[i], pref.value);
					pref.reset();
				}
			} catch(ex) {
				logError(ex);
			}
		}
	}
}

// Pick file to save/load preferences
// aSave true = save
// aSave false = load
function chooseFile(aSave)
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
}