"use strict";

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

var panes = ["paneMain","panePrivacy","navigator_pane"];

exports.loadOptionsSanitizeWindow = function(window, aWinType, sanitizeLabel, sanitizeAccesskey) {

	var gSessionManager_preferencesOverlay = {
		mSanitizePreference: "privacy.item.extensions-sessionmanager",
		currentStartupValue: 0,
		needToRestorePrefs: false,
		isOptions: false,  // True if options window opened, false if sanitize opened

		init: function() {
			this.isOptions = true;
		
			// BrowserPreferences = Firefox, prefDialog = SeaMonkey
			var prefWindow = window.document.getElementById('BrowserPreferences') || window.document.getElementById('prefDialog');
			if (prefWindow)
			{
				// Old versions of SeaMonkey use difference pane name than newer ones
				if (Services.appinfo.name.toUpperCase() == "SEAMONKEY") {
					if (window.document.getElementById("privatedata_pane"))
						panes.push("privatedata_pane");
					else
						panes.push("security_pane");
				}
			
				// Add event handlers for when panes load in Firefox/SeaMonkey or run if pane already loaded
				for (var i in panes) {
					let pane = window.document.getElementById(panes[i]);
					if (pane) {
						if (pane._loaded)
							this.onPaneLoad(panes[i]);
						else
							pane.addEventListener("paneload", this.onPaneLoad_proxy, false);
					}
				}
			}
		},
		
		onPaneLoad_proxy: function (aEvent) {
			gSessionManager_preferencesOverlay.onPaneLoad(aEvent.target.id);
		},
		
		onPaneLoad: function (aPaneID) {
			var elem = window.document.getElementById(aPaneID);
			elem.removeEventListener("paneload", this.onPaneLoad_proxy, false);
			switch (aPaneID) {
				case "paneMain":
				case "navigator_pane":
					this.onPaneMainLoad();
					break;
				case "panePrivacy":
				case "security_pane":
				case "privatedata_pane":
					this.onPanePrivacyLoad(aPaneID);
					break;
			}
		},

	/* ........ paneMain .............. */
		onPaneMainLoad: function (aPaneID) {
			// Firefox = browserStartupPage, SeaMonkey = startupPage
			var startMenu = window.document.getElementById("browserStartupPage") || window.document.getElementById("startupPage");
			var height = 0;
			if (startMenu) {
				var startup = PreferenceManager.get("startup", 0);
				var menuitem = startMenu.appendItem(Utils._string("startup_load"), Constants.STARTUP_LOAD);
				menuitem.setAttribute("id","sessionmananager_menu_load");
				height = height + parseInt(window.getComputedStyle(menuitem, null).height);
				menuitem = startMenu.appendItem(Utils._string("startup_prompt"), Constants.STARTUP_PROMPT);
				menuitem.setAttribute("id","sessionmananager_menu_prompt");
				height = height + parseInt(window.getComputedStyle(menuitem, null).height);
				// Actually set preference so browser will pick up if user changes it
				if (startup) {
					// Save current value
					this.currentStartupValue = window.document.getElementById("browser.startup.page").valueFromPreferences;
				
					// Tell Session Manager Helper Component to ignore preference change below
					Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "true");
					window.document.getElementById("browser.startup.page").valueFromPreferences = ((startup == 1) ? Constants.STARTUP_PROMPT : Constants.STARTUP_LOAD);
					Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "false");
					
					// Listen for window closing in case user cancels without applying changes
					this.needToRestorePrefs = true;
				}
			}
			
			// SeaMonkey needs window size to be fixed since the radio buttons take up space
			if (window.document.getElementById("startupPage")) {
				if (!isNaN(height)) window.innerHeight = window.innerHeight + height;
			}
		 },

	/* ........ panePrivacy .............. */

		onPanePrivacyLoad: function (aPaneID)	{
			// The Clear Now button only exists in SeaMonkey
			var clearNowBn = window.document.getElementById("clearDataNow");
			if (clearNowBn) { 
				clearNowBn.addEventListener("command", this.tryToSanitize, false);
				// SeaMonkey needs to have Session Manager added directly to preferences window
				// Old versions of SeaMonkey use security_pane, new versions use privatedata_pane
				if ((aPaneID == "security_pane") || (aPaneID == "privatedata_pane")) {
					this.addMenuItem(aPaneID);
				}
			}
		},

	/* ....... Sanitizing funnctions ....... */
		addItems: function() {
			this.addMenuItem();
			this.addSanitizeItem();
		},

		addSanitizeItem: function () {
			var sessionManagerItem = {
				clear : function() {
					try {
						SessionIo.sanitize(this.range);
					} catch (ex) {
						logError(ex);
					}
				},
				get canClear() {
					return true;
				},
				willClear: false
			}
			
			// Firefox
			if (typeof window.Sanitizer == 'function') {
				// Sanitizer will execute this
				window.Sanitizer.prototype.items['extensions-sessionmanager'] = sessionManagerItem;
			}
			// SeaMonkey
			else if (typeof window.Sanitizer == 'object') {
				// Sanitizer will execute this
				window.Sanitizer.items['extensions-sessionmanager'] = sessionManagerItem;
			}

			// don't leak
			sessionManagerItem = null;
			
			// Try to fix window height now or do it later if listbox is collapsed;
			var itemList = window.document.getElementById("itemList");
			if (itemList) {
				if (itemList.collapsed) { 
					var detailsExpander = window.document.getElementById("detailsExpander");
					if (detailsExpander)
						detailsExpander.addEventListener("command", this.fixWindowHeight, true);
				}
				else
					this.fixWindowHeight();
			}
		},
		
		fixWindowHeight: function(aEvent) {
			if (aEvent) {
				var detailsExpander = window.document.getElementById("detailsExpander");
				if (detailsExpander)
					detailsExpander.removeEventListener("command", gSessionManager_preferencesOverlay.fixWindowHeight, true);
			}
			
			// fix window height so we can see our entry
			var smlb = window.document.getElementById("sessionmanager_listbox");
			if (smlb) {
				// Since other addons might insert their own check boxes above us, make sure we are visible.
				var index;
				for (var i=0; i<smlb.parentNode.children.length; i++) {
					if (smlb.parentNode.children[i] == smlb) {
						index = i + 1;
						break;
					}
				}
			
				var currentHeight = smlb.parentNode.boxObject.height;
				var boxHeight = smlb.parentNode.firstChild.boxObject.height;
			
				// Display our checkbox and any added above us if we aren't already displayed (in case other addons have the same idea)
				if (currentHeight < (boxHeight * index)) {
					smlb.parentNode.height = currentHeight + boxHeight * (index - 6);
				}
				
				window.sizeToContent();
			}
		},

		addMenuItem: function (aPaneID) {
			var isSeaMonkey = (Services.appinfo.name.toUpperCase() == "SEAMONKEY");
			var doc = (isSeaMonkey && (typeof(aPaneID) != "undefined")) ? window.document.getElementById(aPaneID) : window.document;
			var prefs = doc.getElementsByTagName('preferences')[0];
			var checkboxes = doc.getElementsByTagName('checkbox')
			var listboxes = doc.getElementsByTagName('listitem');
			var lastCheckbox = (checkboxes.length) ? checkboxes[checkboxes.length -1] : null;
			var lastListbox = (listboxes.length) ? listboxes[listboxes.length -1] : null;
			if (lastCheckbox || lastListbox) 
			{
				var pref = null;
				// Firefox only since SeaMonkey does not have separate preferences for on demand and on shutdown sanitation.
				if (!isSeaMonkey) {
					if (window.location == "chrome://browser/content/sanitize.xul") {
						// Preference for "Clear Recent History" window (tools menu)
						this.mSanitizePreference = "privacy.cpd.extensions-sessionmanager";
					}
					else {
						// Preference from "Settings for Clearing History" window (privacy options)
						this.mSanitizePreference = "privacy.clearOnShutdown.extensions-sessionmanager";
					}
				}

				// SeaMonkey Sanitize.xul window does not contain preferences 
				// When add-on is disabled, we don't remove the preference since it causes a memory leak doing so
				// so make sure preference isn't already in window before adding it.
				if (prefs && !window.document.getElementById(this.mSanitizePreference)) {
					pref = window.document.createElement('preference');
					pref.setAttribute('id', this.mSanitizePreference);
					pref.setAttribute('name', this.mSanitizePreference);
					pref.setAttribute('type', 'bool');
					prefs.appendChild(pref);
				}
				
				if (lastListbox) {
					var listitem = window.document.createElement('listitem');
					listitem.setAttribute('label', sanitizeLabel);
					listitem.setAttribute('id', "sessionmanager_listbox");
					listitem.setAttribute('type', 'checkbox');
					listitem.setAttribute('accesskey', sanitizeAccesskey);
					listitem.setAttribute('preference', this.mSanitizePreference);
					listitem.addEventListener("command", this.confirm, true);
					if (typeof(window.gSanitizePromptDialog) == 'object') {
						listitem.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
					}
					lastListbox.parentNode.appendChild(listitem);
				}
				else if (lastCheckbox) {
					var check = window.document.createElement('checkbox');
					check.setAttribute('label', sanitizeLabel);
					check.setAttribute('name', "extensions-sessionmanager");  // For SeaMonkey
					check.setAttribute('id', "sessionmanager_checkbox");
					check.setAttribute('accesskey', sanitizeAccesskey);
					check.setAttribute('preference', this.mSanitizePreference);
					check.addEventListener("command", this.confirm, true);
					if (typeof(window.gSanitizePromptDialog) == 'object') {
						check.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
					}
				
					// For Firefox, don't create a new row when there's only one checkbox in row.
					if ((lastCheckbox.parentNode.localName == "row") && (lastCheckbox.parentNode.childNodes.length != 1)) {
						var newRow = window.document.createElement('row');
						newRow.setAttribute("id", "sessionmanager-newrow");
						newRow.appendChild(check);
						lastCheckbox.parentNode.parentNode.appendChild(newRow);
					}
					else {
						lastCheckbox.parentNode.appendChild(check);
					}
				}

				// If user is setting preference for clearing on shutdown (SeaMonkey only uses one preference so include it if preferences exist)  
				if (pref && (isSeaMonkey || this.mSanitizePreference == "privacy.clearOnShutdown.extensions-sessionmanager")) 
					pref.updateElements();
			}
		},

		// This function is only ever called in SeaMonkey
		tryToSanitize: function () {
			try {
				var promptOnSanitize = Services.prefs.getBoolPref("privacy.sanitize.promptOnSanitize");
			} catch (e) { promptOnSanitize = true;}

			// if promptOnSanitize is true we call gSessionManager_Sanitizer.sanitize from SeaMonkey Sanitizer
			if (promptOnSanitize)
				return false;

			try {
				var sanitizeSessionManager = Services.prefs.getBoolPref("privacy.item.extensions-sessionmanager");
			} catch (e) { sanitizeSessionManager = false;}

			if (!sanitizeSessionManager)
				return false;

			SessionIo.sanitize();
			return true;
		},

		confirm: function (aEvent) {
			if (!aEvent.target.checked) return;

			var timeframe = window.document.getElementById("sanitizeDurationChoice");
			var txt = Utils._string("delete_all_confirm") + (timeframe ? (" - " + timeframe.label) : "");
		
			var okay = Services.prompt.confirmEx(null, Utils._string("sessionManager"), txt, 
												Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1,
												null, null, null, null, {});
			aEvent.target.checked = !okay;
		},
		
		onUnload: function() {
			// If options window
			if (this.isOptions) {
				// BrowserPreferences = Firefox, prefDialog = SeaMonkey
				var prefWindow = window.document.getElementById('BrowserPreferences') || window.document.getElementById('prefDialog');
				if (prefWindow)
				{
					// Add event handlers for when panes load in Firefox/SeaMonkey
					for (var i in panes) {
						let pane = window.document.getElementById(panes[i]);
						if (pane) pane.removeEventListener("paneload", this.onPaneLoad_proxy, false);
					}
				}

				if (this.needToRestorePrefs) {
					if (window.document.getElementById("browser.startup.page").valueFromPreferences <= Constants.STARTUP_PROMPT) {
						//dump("restoring preference\n");
						// Tell Session Manager Helper Component to ignore preference change below
						Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "true");
						window.document.getElementById("browser.startup.page").valueFromPreferences = this.currentStartupValue;
						Services.obs.notifyObservers(null, "sessionmanager:ignore-preference-changes", "false");
					}
				}
				
				// The Clear Now button only exists in SeaMonkey
				var clearNowBn = window.document.getElementById("clearDataNow");
				if (clearNowBn) 
					clearNowBn.removeEventListener("command", this.tryToSanitize, false);
			}
			// sanitize window
			else 
			{
				// Firefox
				if (typeof window.Sanitizer == 'function') {
					// Remove session manager functions from Sanitzier
					delete window.Sanitizer.prototype.items['extensions-sessionmanager'];
				}
				// SeaMonkey
				else if (typeof window.Sanitizer == 'object') {
					// Remove session manager functions from Sanitzier asynchronously otherwise it will be removed before read
					Utils.runAsync(function () {
						delete window.Sanitizer.items['extensions-sessionmanager'];
					});
				}
				
				var detailsExpander = window.document.getElementById("detailsExpander");
				if (detailsExpander)
					detailsExpander.removeEventListener("command", this.fixWindowHeight, true);
					
				// Make it so the check box won't be checked the next time the user manually goes to clear 
				// recent history in Firefox
				if (this.mSanitizePreference == "privacy.cpd.extensions-sessionmanager")
					PreferenceManager.set("privacy.cpd.extensions-sessionmanager", false, true);
			}
			
			// Remove any added items - Removing preference element will cause window to leak so just let it go away on it's
			// own when window is closed. It doesn't hurt anything since there's no way to change it after removing visible element.
			var items = ["sessionmanager-newrow", "sessionmanager_checkbox", "sessionmanager_listbox", 
									 "sessionmananager_menu_load", "sessionmananager_menu_prompt"];
			for (var i in items) {
				var item = window.document.getElementById(items[i]);
				if (item)
					item.parentNode.removeChild(item);
			}
		}
	};
	
	switch(aWinType) {
		case "SANITIZE":
			gSessionManager_preferencesOverlay.addItems.bind(gSessionManager_preferencesOverlay)();
			break;
		case "OPTIONS":
			gSessionManager_preferencesOverlay.init.bind(gSessionManager_preferencesOverlay)();
			break;
	}
		
	unload(function() { gSessionManager_preferencesOverlay.onUnload() }.bind(gSessionManager_preferencesOverlay), window);
}