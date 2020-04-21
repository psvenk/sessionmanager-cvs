/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const LOG_ENABLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

var australis = false;
try {
  Components.utils.import("resource:///modules/CustomizableUI.jsm");
  australis = true;
}
catch(ex) {}

XPCOMUtils.defineLazyModuleGetter(this, "AddonManager", "resource://gre/modules/AddonManager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

var disabled = true;
var id, upgradeTimer;
const PREFBRANCH = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.";
const Private_Tabs_Addon = "privateTab@infocatcher";

/* Includes a javascript file with loadSubScript
*
* @param src (String)
* The url of a javascript file to include.
*/
(function(global) global.include = function include(src) {
  var o = {};
  Components.utils.import("resource://gre/modules/Services.jsm", o);
  try {
    var uri = o.Services.io.newURI(
        src, null, o.Services.io.newURI(__SCRIPT_URI_SPEC__, null, null));
    o.Services.scriptloader.loadSubScript(uri.spec, global);
  }
  catch(ex) {
    Components.utils.reportError(ex + " - " + src);
  }
})(this);

/* Imports a commonjs style javascript file with loadSubScrpt
 * 
 * @param src (String)
 * The url of a javascript file.
 */
(function(global) {
  var modules = {};
  global.require = function require(src) {
    if (modules[src]) return modules[src];
    var scope = {require: global.require, exports: {}};
    var tools = {};
    Cu.import("resource://gre/modules/Services.jsm", tools);
    var baseURI = tools.Services.io.newURI(__SCRIPT_URI_SPEC__, null, null);
    try {
      var uri = tools.Services.io.newURI(
          "packages/" + src + ".js", null, baseURI);
      tools.Services.scriptloader.loadSubScript(uri.spec, scope);
    } catch (e) {
			try {
				var uri = tools.Services.io.newURI(src, null, baseURI);
				tools.Services.scriptloader.loadSubScript(uri.spec, scope);
			}
			catch(ex) {
				Components.utils.reportError(ex + " - " + src);
			}
    }
    return modules[src] = scope.exports;
  }
})(this);

include("includes/buttons.js");

var {unload} = require("unload");
var {runOnLoad, runOnWindows, watchWindows, watchHiddenWindow} = require("window-utils");
var {loadOverlay, applyOverlay, applyOptionsOverlay, applySanitizeOverlay} = require("overlay");
var {initializeHelper} = require("SessionManagerHelper");

// Listen for unloader notifications
var observer = {
	observe: function(aSubject, aTopic, aData)
	{
		switch (aTopic) {
		case "session-manager-unload":
			if ((typeof aSubject == "object") && (typeof aSubject.wrappedJSObject == "function"))
				unload(aSubject.wrappedJSObject, null, aData == "LAST");
			break;
		}
	},
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference, Ci.nsIObserver])
};

// Listen for addon enable and disable events (for Private Tab and Tab Groups enable/disable)
var AddonListener = {
	setAddOnState: function(aId, aEnabled) {
		let scope = {};
		Cu.import("chrome://sessionmanager/content/modules/shared_data/data.jsm", scope);
		switch(aId) {
			case "privateTab@infocatcher":
				scope.SharedData.privateTabsEnabled = aEnabled;
				break;
			case "tabgroups@quicksaver":
				scope.SharedData.tabGroupsEnabled = aEnabled;
				scope.SharedData.panoramaExists = aEnabled;
				Services.obs.notifyObservers(null, "sessionmanager:tag-group-change", null);
				break;
		}
	},
	
	onEnabled: function(addon) {
		this.setAddOnState(addon.id, true);
	},
	
	onDisabled: function(addon) {
		this.setAddOnState(addon.id, false);
	}
};

var widgetListener = {
	onWidgetAfterDOMChange: function(aNode, aNextNode, aContainer, aWasRemoval) {
		if (!aWasRemoval && (aNode.id == "sessionmanager-toolbar" || aNode.id == "sessionmanager-undo"))
			Services.obs.notifyObservers(aNode.ownerDocument.defaultView, "sessionmanager:toolbar-button-added", aNode.id);
	}
};


function watchForUpgrade(promptWindow) {
	
	let smInstall;

	// Observer to listen for updating Session Manager and set flag and prevent update
	var installListener = {
		onInstallStarted: function(install) {
			if (install.existingAddon && (install.existingAddon.id == id)) {
				log("Session Manager tried to update while session prompt window was opened.", "TRACE");
				smInstall = install;
				return false;
			}
		}
	};
	
	// wait for prompt window to unload
	unload(function() {
		// stop listening for addon installs
		AddonManager.removeInstallListener(installListener);
	
		// cancel timer if already started
		if (upgradeTimer) {
			upgradeTimer.cancel();
			upgradeTimer = null;
		}
	
		// If tried to upgrade while prompt window was open, kick off upgrade timer
		if (smInstall) {
			log("Session Manager will update in 30 seconds.", "TRACE");
			// set 30 second timer
			upgradeTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			upgradeTimer.initWithCallback({
				notify:function (aTimer) { 
					log("Session Manager updating now.", "TRACE");
					smInstall.install(); 
					upgradeTimer = null;
				}
			}, 30000, Ci.nsITimer.TYPE_ONE_SHOT);
		}
	}, promptWindow);
	
	AddonManager.addInstallListener(installListener)
}

function unloadModules() { 
	Cu.unload("chrome://sessionmanager/content/modules/encryption_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/logger.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/logger_backend.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/password_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/preference_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/session_convert.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/session_data_processing.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/session_file_io.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/session_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/sql_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/tab_group_manager.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/utils.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/shared_data/addonInfo.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/shared_data/constants.jsm");
	Cu.unload("chrome://sessionmanager/content/modules/shared_data/data.jsm");
}

function install(params, reason) {}
function uninstall(params, reason) {
	if (reason == ADDON_UNINSTALL) {
		// remove preferences when uninstalling
		Services.prefs.deleteBranch(PREFBRANCH);
		
		// Remove any leftover files
		let scope = {};
		Cu.import("resource://gre/modules/FileUtils.jsm",scope);

		let filesToDelete = ["sessionmanager_log.txt", "sessionmanager.dat", "sessionmanager.sqlite"];
		for (var i in filesToDelete) {
			try {
				let file = scope.FileUtils.getFile("ProfD", [filesToDelete[i]]);
				if (file.exists())
					file.remove(false);
			}
			catch(ex) { Components.utils.reportError(ex); }
		}
		
		// TODO: Add prompt asking to delete session files
	}
}

function startup(params, reason)
{
	// If logging is enabled, wrap everything in a try/catch to find errors
	if (Services.prefs.prefHasUserValue(LOG_ENABLE_PREFERENCE_NAME) && 
	    Services.prefs.getBoolPref(LOG_ENABLE_PREFERENCE_NAME)) {
		try {
			startup2(params, reason);
		}
		catch(ex) {
			Components.utils.reportError(ex);
			logError(ex);
		}
	}
	else startup2(params, reason);
}

function startup2(params, reason)
{
	disabled = false;
	id = params.id;
	
	// Listen for addons being enabled/disabled
	AddonManager.addAddonListener(AddonListener);
	
	// Watch for prompt window to prevent updates if Session Prompt window is open
	watchWindows(watchForUpgrade, "SessionManager:SessionPrompt");
	
	// If installing set default button position to the nav-bar before the location
	if (reason == ADDON_INSTALL) {
		setDefaultPosition("sessionmanager-toolbar", "nav-bar", "home-button");
		setDefaultPosition("sessionmanager-undo", "nav-bar", "home-button");
	};

	let scope = {};
	// Read in shared data and set TMP enabled value
	Cu.import("chrome://sessionmanager/content/modules/shared_data/data.jsm", scope);
	scope.SharedData._running = (reason != APP_STARTUP);
	scope.SharedData.justStartedUpDowngraded = (reason == APP_STARTUP) || (reason == ADDON_UPGRADE) || (reason == ADDON_DOWNGRADE);
	
	// Store Addon info
	Cu.import("chrome://sessionmanager/content/modules/shared_data/addonInfo.jsm", scope);
	scope.AddonInfo.addonData = [params, PREFBRANCH];
	
	// Add observer for unload notifications
	Services.obs.addObserver(observer, "session-manager-unload", true);

	// Read in default prefs and initialize Preferences.
	Cu.import("chrome://sessionmanager/content/modules/preference_manager.jsm", scope);
	
	initializeHelper(reason == APP_STARTUP);
	
	let stylesheets = ["chrome://sessionmanager/skin/sessionmanager.css", "chrome://sessionmanager/skin/tabWin.css"];
	if (Services.appinfo.name == "SeaMonkey")
		stylesheets.push("chrome://sessionmanager/skin/sm_sessionmanager.css", "chrome://sessionmanager/skin/tabWinSM.css");
	
	// Add unload functions
	unload(function() { 
		if (australis) 
			CustomizableUI.removeListener(widgetListener);
		// If options window open, close it
		let win = Services.wm.getMostRecentWindow("SessionManager:Options");
		if (win)
			win.close();
		// If session prompt window open, close it
		win = Services.wm.getMostRecentWindow("SessionManager:SessionPrompt");
		if (win)
			win.close();
		Services.obs.removeObserver(observer, "session-manager-unload"); 
		// Unload stylesheets
		for (let i in stylesheets) {
			let sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
			let uri = Services.io.newURI(stylesheets[i], null, null);
			if (sss.sheetRegistered(uri, sss.USER_SHEET))
				sss.unregisterSheet(uri, sss.USER_SHEET);	
		}
		Services.strings.flushBundles();
	});

	// Australis uses widget listener
	if (australis) 
		CustomizableUI.addListener(widgetListener);
	
	// Load Style Sheets
	for (let i in stylesheets) {
		let sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
		let uri = Services.io.newURI(stylesheets[i], null, null);
		sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
	}

	// Read in window overlay
	loadOverlay();
	
	// Watch for existing and newly opened windows
	watchWindows(applyOverlay, "navigator:browser");
	
	// Overlay hidden window on Macs - not avaialable on startup so need to add watcher
	// Services.appShell doesn't exist in older versions of Firefox/SeaMonkey so use nsIAppShellService
	let appShell = Services.appShell || Cc["@mozilla.org/appshell/appShellService;1"].getService(Ci.nsIAppShellService);
	if (appShell.applicationProvidedHiddenWindow) {
		watchHiddenWindow(applyOverlay);
	}
	
	// Watch for options window
	watchWindows(applyOptionsOverlay, (Services.appinfo.name == "SeaMonkey") ? "mozilla:preferences" : "Browser:Preferences");
	
	// Watch for santize window
	watchWindows(applySanitizeOverlay, "", "SanitizeDialog");
	
	// Listen for command line parameters
	require("comandlineHandler");
}

function shutdown(params, reason)
{
	disabled = true;

	// If upgrade timer, started cancel it
	if (upgradeTimer) {
		upgradeTimer.cancel();
		upgradeTimer = null;
	}
	
	// Stop listening for addons being enabled/disabled
	AddonManager.removeAddonListener(AddonListener)
	
	// Don't bother unloading if shutting down
	if (reason == APP_SHUTDOWN)
		return;

	let scope = {};
	Cu.import("chrome://sessionmanager/content/modules/shared_data/data.jsm", scope);
	scope.SharedData.upgradingOrDowngrading = (reason == ADDON_UPGRADE) || (reason == ADDON_DOWNGRADE);

	unload();
	
	// If not upgrading/downgrading make sure autosave session preference is cleared
	if ((reason != ADDON_UPGRADE) && (reason != ADDON_DOWNGRADE)) {
		let scope = {};
		Cu.import("chrome://sessionmanager/content/modules/preference_manager.jsm", scope);
		scope.PreferenceManager.delete("_autosave_values");
	}
	
	// Unload modules after all other unloaders have run
	unloadModules();
}