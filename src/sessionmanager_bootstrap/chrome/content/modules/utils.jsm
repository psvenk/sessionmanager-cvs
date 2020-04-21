"use strict";

this.EXPORTED_SYMBOLS = ["Utils"];
            
const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

const INVALID_FILENAMES = ["CON", "PRN", "AUX", "CLOCK$", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4",
               "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4",
               "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];


// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionStore", "resource:///modules/sessionstore/SessionStore.jsm");
XPCOMUtils.defineLazyGetter(this, "SM_BUNDLE", function() { return Services.strings.createBundle("chrome://sessionmanager/locale/sessionmanager.properties"); });

XPCOMUtils.defineLazyServiceGetter(this, "secret_decoder_ring_service", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils", "resource://gre/modules/PrivateBrowsingUtils.jsm");

// This only exists in Firefox, so define our own lazy getter to set it to null if it doesn't exist instead of throwing an exception
XPCOMUtils.defineLazyGetter(this, "RecentWindow", function() {
  XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow", "resource:///modules/RecentWindow.jsm");
  try {
    return RecentWindow;
  }
  catch(ex) {
    return null
  }
});

// Reference to main thread for putting up alerts when not in main thread
var mainAlertThread = function(aText) {
  this.text = aText;
};
mainAlertThread.prototype = {
  run: function() {
    Services.prompt.alert(Utils.getMostRecentWindow(), SharedData.mTitle, this.text);
  },
  QueryInterface: function(iid) {
    if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
      return this;
    }
    throw  new Components.Exception("Interface not supported", Cr.NS_ERROR_NO_INTERFACE, Components.stack.caller);
  }
};

this.Utils = {

  // 
  // Name functions
  //
  
  nameState: function(aState, aName)
  {
    if (!/^\[SessionManager v2\]/m.test(aState))
    {
      return "[SessionManager v2]\nname=" + aName.replace(/\t/g, " ") + "\n" + aState;
    }
    return aState.replace(/^(\[SessionManager v2\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName.replace(/\t/g, " "); });
  },

  getFormattedName: function(aTitle, aDate, aFormat)
  {
    function cut(aString, aLength)
    {
      return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
    }
    function toISO8601(aDate, format)
    {
      if (format) {
        return aDate.toLocaleFormat(format);
      }
      else {
        return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
      }
    }
    function pad2(a) { return (a < 10)?"0" + a:a; }
    
    return (aFormat || PreferenceManager.get("name_format")).split("%%").map(function(aPiece) {
      return aPiece.replace(/%(\d*)([tdm])(\"(.*)\")?/g, function($0, $1, $2, $3, $4) {
        $0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate, $4):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
        return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
      });
    }).join("%");
  },

  makeFileName: function(aString)
  {
    // Make sure we don't replace spaces with _ in filename since tabs become spaces
    aString = aString.replace(/\t/g, " ");
    
    // Reserved File names under Windows so add a "_" to name if one of them is used
    if (INVALID_FILENAMES.indexOf(aString) != -1) aString += "_";
    
    // Don't allow illegal characters for Operating Systems:
    // NTFS - <>:"/\|*? or ASCII chars from 00 to 1F
    // FAT - ^
    // OS 9, OS X and Linux - :
    return aString.replace(/[<>:"\/\\|*?^\x00-\x1F]/g, "_").substr(0, 64) + Constants.SESSION_EXT;
//    return aString.replace(/[^\w ',;!()@&+=~\x80-\xFE-]/g, "_").substr(0, 64) + Constants.SESSION_EXT;
  },
  
  //
  // Browser Privacy Functions
  //
  
  // Per Window private browsing only exists in Firefox, but functions exist in SeaMonkey so okay to call them.
  isPrivateWindow: function(aWindow) 
  {
    if (aWindow)
      return PrivateBrowsingUtils.isWindowPrivate(aWindow);
    else 
      return this.isAutoStartPrivateBrowserMode();
  },

  isAutoStartPrivateBrowserMode: function()
  {
    // Private Browsing Mode is only available in Firefox - In Firefox the PrivateBrowsingUtils.permanentPrivateBrowsing is 
    // used instead and changing the auto privacy setting will require a browser restart.  SeaMonkey includes
    // PrivateBrowsingUtils.permanentPrivateBrowsing, but it always returns false.
    return PrivateBrowsingUtils.permanentPrivateBrowsing;
  },
  
  // 
  // Browser Window Functions
  //
  
  // Get title of current tab if there is one
  getCurrentTabTitle: function(aWindow) {
    let title = null;
    if (aWindow != null) {
      for (let i=0; i<aWindow.gBrowser.tabs.length; i++) {
        log("Utils.getCurrentTabTitle: " + i + ", " + aWindow.gBrowser.tabs[i].getAttribute("visuallyselected") + ", " + aWindow.gBrowser.tabs[i].linkedBrowser.contentTitle, "EXTRA");
        if (aWindow.gBrowser.tabs[i].getAttribute("visuallyselected") == "true") {
          title = aWindow.gBrowser.tabs[i].linkedBrowser.contentTitle;
          break;
        }
      }
    }
    return title;
  },
  
  openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
  {
    if (!aArgument || typeof aArgument == "string")
    {
      let argString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      argString.data = aArgument || "";
      aArgument = argString;
    }
    
    return Services.ww.openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
  },
  
  // This will get the most recent window of type aType.  If the aOpenWindowFlag flag is set
  // then a window will be created if not found.  If the aAllowPrivate flag is used then
  // either a private or non-private window will be returned, otherwise any window will be returned.
  getMostRecentWindow: function(aType, aOpenWindowFlag, aAllowPrivate)
  {
    let window = null;
    if (Services.tm.isMainThread) {
      let options = {};
      if ((typeof aAllowPrivate) == "boolean")
        options.privacy = aAllowPrivate;
      if (RecentWindow && (aType == "navigator:browser"))
        // Recent Window only checks for private windows, if privacy option is specifically set to true or false
        // otherwise it returns the first window found
        window = RecentWindow.getMostRecentBrowserWindow(options);
      else
        window = Services.wm.getMostRecentWindow(aType ? aType : null);
    }
    else {
      log("Sanity Check Failure: getMostRecentWindow() called from background thread - this would have caused a crash.", "EXTRA");
    }
    if (aOpenWindowFlag && !window) {
      window = this.openWindow(PreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
    }
    return window;
  },
  
  getBrowserWindows: function()
  {
    let windowsEnum = Services.wm.getEnumerator("navigator:browser");
    let windows = [];
    
    while (windowsEnum.hasMoreElements())
    {
      windows.push(windowsEnum.getNext());
    }
    
    return windows;
  },
  
  // This will return the window with the matching SessionStore __SSi value if it exists
  getWindowBySSI: function(window__SSi) 
  {
    let windows = Utils.getBrowserWindows();
    for (var i=0; i<windows.length; i++)
    {
      if (windows[i].__SSi == window__SSi)
        return windows[i];
    }
    return null;
  },

//
// ........ User Prompts .............. 
//

  openSessionExplorer: function() {
    this.openWindow(
      "chrome://sessionmanager/content/sessionexplorer.xul",
//      "chrome://sessionmanager/content/places/places.xul",
      "chrome,titlebar,resizable,dialog=yes",
      {},
      this.getMostRecentWindow()
    );
  },
  
  prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
  {
    // Use existing dialog window if not modal
    let dialog = Services.wm.getMostRecentWindow("SessionManager:SessionPrompt");
    
    // For some reason someone got two startup prompts, this will prevent that
    if (dialog && !SharedData._running) {
      if (!dialog.gSessionManagerSessionPrompt.modal)
        dialog.close();
      else
        dialog.setTimeout(function() { dialog.focus(); }, 1000);
        return;
    }
  
    let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
    aValues = aValues || {};

    // Modal if startup or crash prompt or if there's a not a callback function
    let window = SharedData._running ? this.getMostRecentWindow("navigator:browser") : null;
    let modal = !SharedData._running || !aValues.callbackData;
    //let modal = !SharedData._running || !aValues.callbackData || aValues.callbackData.oneWindow;
    
    // Clear out return data and initialize it
    SharedData.sessionPromptReturnData = null;

    SharedData.sessionPromptData = {
      // strings
      acceptExistingLabel: aAcceptExistingLabel || "",
      acceptLabel: aAcceptLabel,
      callbackData: aValues.callbackData || null,
      crashCount: aValues.count || "",
      defaultSessionName: aValues.text || "",
      filename: aValues.name || "",
      sessionLabel: aSessionLabel,
      textLabel: aTextLabel || "",
      // booleans
      addCurrentSession: aValues.addCurrentSession,
      allowNamedReplace: aValues.allowNamedReplace,
      append_replace: aValues.append_replace,
      autoSaveable: aValues.autoSaveable,
      grouping: aValues.grouping,
      ignorable: aValues.ignorable,
      multiSelect: aValues.multiSelect,
      preselect: aValues.preselect,
      remove: aValues.remove,
      selectAll: aValues.selectAll,
      startupPrompt: aValues.startupPrompt,
      modal: modal,
      startup: !SharedData._running,
      // override function
      getSessionsOverride: aValues.getSessionsOverride,
    };
    
    // Initialize return data if modal.  Don't initialize if not modal because that can result in a memory leak since it might
    // not be cleared
    if (modal) SharedData.sessionPromptReturnData = {};
    
    if (dialog && !modal)
    {
      dialog.focus();
      dialog.gSessionManagerSessionPrompt.drawWindow();
      return;
    }
    // Set dialog to no to prevent hang when E10s is enabled - see https://bugzilla.mozilla.org/show_bug.cgi?id=1130098
    // That simply hides the minimize and maximize toolbar icons, so it's not terrible
    this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,resizable,dialog=no" + (modal?",modal":""), 
                    params, window);
      
    if (params.GetInt(0)) {
      aValues.append = SharedData.sessionPromptReturnData.append;
      aValues.append_window = SharedData.sessionPromptReturnData.append_window;
      aValues.autoSave = SharedData.sessionPromptReturnData.autoSave;
      aValues.autoSaveTime = SharedData.sessionPromptReturnData.autoSaveTime;
      aValues.group = SharedData.sessionPromptReturnData.groupName;
      aValues.name = SharedData.sessionPromptReturnData.filename;
      aValues.text = SharedData.sessionPromptReturnData.sessionName;
      aValues.sessionState = SharedData.sessionPromptReturnData.sessionState;
      SharedData.sessionPromptReturnData.sessionState = null;
    }
    aValues.ignore = SharedData.sessionPromptReturnData ? SharedData.sessionPromptReturnData.ignore : null;

    // Clear out return data
    SharedData.sessionPromptReturnData = null;
    
    return params.GetInt(0);
  },
  
  // the aOverride variable in an optional callback procedure that will be used to get the session list instead
  // of the default getSessions() function.  The function must return an array of sessions where a session is an
  // object containing:
  //    name    - This is what is displayed in the session select window
  //    fileName  - This is what is returned when the object is selected
  //    windows   - Window count (optional - if omited won't display either window or tab count)
  //    tabs    - Tab count (optional - if omited won't display either window or tab count)
  //    autosave  - Will cause item to be bold (optional)
  //      group       - Group that session is associated with (optional)
  //
  // If the session list is not formatted correctly a message will be displayed in the Error console
  // and the session select window will not be displayed.
  //
  selectSession: function(aSessionLabel, aAcceptLabel, aValues, aOverride)
  {
    let values = aValues || {};
    
    if (aOverride) values.getSessionsOverride = aOverride;
    
    if (this.prompt(aSessionLabel, aAcceptLabel, values))
    {
      return values.name;
    }
    
    return null;
  },
  
  // 
  // Alert and Error functions
  //
  
  // This will always put up an alert prompt in the main thread
  threadSafeAlert: function(aText) {
    if (Services.tm.isMainThread) {
      Services.prompt.alert(this.getMostRecentWindow(), SharedData.mTitle, aText);
    }
    else {
      let mainThread = Services.tm.mainThread;
      mainThread.dispatch(new mainAlertThread(aText), mainThread.DISPATCH_NORMAL);
    }
  },
  
  // For exceptions with a location, generate the call stack
  getCallStack: function(aLocation) {
    if (!aLocation || (aLocation == null))
      return null;
      
    let stack = aLocation;
    let text = stack.toString();
    // If there is a call stack, log that as well
    while (stack = stack.caller) {
      text += "\n" + stack.toString();
    }
    return text;
  },

  // Put up error prompt
  error: function(aException, aString, aExtraText) {
    let location = "";
    if (aException) {
      logError(aException);
      location = aException.stack || this.getCallStack(aException.location) || (aException.fileName || aException.filename + ":" + aException.lineNumber);
    }
  
    this.threadSafeAlert(SM_BUNDLE.formatStringFromName(aString, [(aException)?(aException.message + "(" +
        aException.name + ")" + (aExtraText ? ("\n\n" + aExtraText) : "") + "\n\n" + location):SM_BUNDLE.GetStringFromName("unknown_error")], 1));
  },

  ioError: function(aException, aText)
  {
    this.error(aException, "io_error", aText);
  },

  sessionError: function(aException, aText)
  {
    this.error(aException, "session_error", aText);
  },

  cryptError: function(aException, notSaved)
  {
    let text;
    if (aException.message) {
      if (aException.message.indexOf("decryptString") != -1) {
        if (aException.result != Cr.NS_ERROR_NOT_AVAILABLE) {
          text = this._string("decrypt_fail1");
        }
        else {
          text = this._string("decrypt_fail2");
        }
      }
      else {
        text = notSaved ? this._string("encrypt_fail2") : this._string("encrypt_fail");
      }
    }
    else text = aException;
    this.threadSafeAlert(text);
  },
  
  //
  // Encryption functions
  //
  
  decrypt: function(aData, aNoError, doNotDecode)
  {
    // If nothing passed in, nothing returned
    if (!aData)
      return null;
      
    // Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
    // The encryptString function cannot handle non-ASCII data so encode it first and decode the results
    if (aData.indexOf(":") == -1)
    {
      try {
        aData = secret_decoder_ring_service.decryptString(aData);
        if (!doNotDecode) aData = decodeURIComponent(aData);
      }
      catch (ex) { 
        logError(ex);
        if (!aNoError) this.cryptError(ex); 
        // encrypted file corrupt, return false so as to not break things checking for aData.
        if (ex.result != Cr.NS_ERROR_NOT_AVAILABLE) { 
          return false;
        }
        return null;
      }
    }
    return aData;
  },

  // This function will encrypt the data if the encryption preference is set.
  // It will also decrypt encrypted data if the encryption preference is not set.
  decryptEncryptByPreference: function(aData, aSilent, aReturnOriginalStateOnError)
  {
    // Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
    // The encryptString function cannot handle non-ASCII data so encode it first and decode the results
    let encrypted = (aData.indexOf(":") == -1);
    try {
      if (PreferenceManager.get("encrypt_sessions") && !encrypted)
      {
        aData = secret_decoder_ring_service.encryptString(encodeURIComponent(aData));
      }
      else if (!PreferenceManager.get("encrypt_sessions") && encrypted)
      {
        aData = decodeURIComponent(secret_decoder_ring_service.decryptString(aData));
      }
    }
    catch (ex) { 
      if (!aSilent) {
        if (!encrypted && PreferenceManager.get("encrypted_only")) {
          this.cryptError(ex, true);
          return null;
        }
        else this.cryptError(ex);
      }
      else {
        logError(ex);
        if (!aReturnOriginalStateOnError)
          return ex;
      }
    }
    return aData;
  },
  
  //
  // Undo list handling
  //

  clearUndoListPrompt: function(aType)
  {
    let dontPrompt = { value: false };
    let prompttext = (aType == "tab") ? "clear_tab_list_prompt" : ((aType == "window") ? "clear_window_list_prompt" : "clear_list_prompt");
    if (PreferenceManager.get("no_" + prompttext) || Services.prompt.confirmEx(null, SharedData.mTitle, this._string(prompttext), Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0 + Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
    {
      Private.clearUndoList(aType);
      if (dontPrompt.value)
      {
        PreferenceManager.set("no_" + prompttext, true);
      }
    }
  },

  getNoUndoData: function(aLoad, aMode)
  {
    return aLoad ? { tabs: (!PreferenceManager.get("save_closed_tabs") || ((PreferenceManager.get("save_closed_tabs") == 1) && (aMode != "startup"))),
                     windows: (!PreferenceManager.get("save_closed_windows") || (PreferenceManager.get("save_closed_windows") == 1 && (aMode != "startup"))) }
                 : { tabs: (PreferenceManager.get("save_closed_tabs") < 2), windows: (PreferenceManager.get("save_closed_windows") < 2) };
  },
  
  //
  // AutoSave Functions
  //

  parseAutoSaveValues: function(aValues) {
    return aValues ? JSON.parse(aValues) : {};
  },

  // Read Autosave values from preference and store into global variables
  // aValues - window session values
  // aWindow - window (for window session)
  // aDoNotNotify - boolean indicate whether to send "sessionmanager:update-window-session" notification or not (used for calls from browserWindowOver to prevent recursion)
  getAutoSaveValues: function(aValues, aWindow, aDoNotNotify)
  {
    let values = this.parseAutoSaveValues(aValues);
    log("getAutoSaveValues: aWindow = " + (aWindow ? this.getCurrentTabTitle(aWindow) : "null") + ", aValues = " + JSON.stringify(values) + ", aDoNotNotify = " + aDoNotNotify, "EXTRA");
    if (aWindow) {
      let window_session = this.mergeAutoSaveValues(values.filename, values.name, values.group, values.time);
      
      // Update window SessionStore values - Deleting will fail if window is closed, but that's okay because
      // we need it for when Firefox restores session data at startup anyway.  Session Manager will remove it
      // when loading a normal session in most cases except for a crash or loading last session.
      try {
        if (values.filename) 
          this.SessionStore.setWindowValue(aWindow, "_sm_window_session_values", window_session);
        else if (!SharedData.upgradingOrDowngrading) {
          // Don't delete window values when upgrading or downgrading addon.
          // Deleting doesn't trigger saving to sessionstore.js (Firefox bug 510965), so write a blank dummy value and then delete
          this.SessionStore.setWindowValue(aWindow, "_sm_window_session_values", "{}");
          this.SessionStore.deleteWindowValue(aWindow, "_sm_window_session_values");
        }
      }
      catch(ex) {
        // log it so we can tell when things aren't working.  Don't log exceptions in deleteWindowValue
        // because it throws an exception if value we are trying to delete or window doesn't exist. Since we are 
        // deleting the value, we don't care if it doesn't exist.
        if (ex.message.indexOf("deleteWindowValue") == -1) logError(ex);
      }
      
      // start/stop window timer
      if (!aDoNotNotify)
        Services.obs.notifyObservers(aWindow, "sessionmanager:update-window-session", window_session);
    }
    else {
      SharedData._autosave.filename = values.filename;
      SharedData._autosave.name = values.name;
      SharedData._autosave.group = values.group;
      SharedData._autosave.time = isNaN(values.time) ? 0 : values.time;
    }

    // Update tab tree if it's open
    Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
  },

  // Merge autosave variables into a a string
  mergeAutoSaveValues: function(filename, name, group, time)
  {
    return JSON.stringify({ filename: filename, name: name, group: group, time: (isNaN(time) ? 0 : time) });
  },

  updateAutoSaveSessions: function(aOldFileName, aNewFileName, aNewName, aNewGroup) 
  {
    let updateTitlebar = false;
    
    // auto-save session
    if (SharedData._autosave.filename == aOldFileName) 
    {
      log("updateAutoSaveSessions: autosave change: aOldFileName = " + aOldFileName + ", aNewFileName = " + aNewFileName + ", aNewName = " + aNewName + ", aNewGroup = " + aNewGroup, "DATA");
      // rename or delete?
      if (aNewFileName) {
        PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aNewFileName, aNewName, SharedData._autosave.group, SharedData._autosave.time));
        updateTitlebar = true;
      }
      else if (aNewName) {
        PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, aNewName, SharedData._autosave.group, SharedData._autosave.time));
      }
      else if (aNewGroup) {
        PreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, SharedData._autosave.name, aNewGroup, SharedData._autosave.time));
      }
      else {
        PreferenceManager.set("_autosave_values","");
        updateTitlebar = true;
      }
    }
    
    // window sessions
    Services.obs.notifyObservers(null, "sessionmanager:update-window-session", 
      JSON.stringify({oldFileName: aOldFileName, newFileName: aNewFileName, newName: aNewName, newGroup: aNewGroup})
    );
    
    // Update titlebars
    if (updateTitlebar) Services.obs.notifyObservers(null, "sessionmanager:updatetitlebar", null);
  },
  
  //
  // Auxiliary Functions
  //

  // count windows and tabs
  getCount: function(aState)
  {
    let windows = 0, tabs = 0;
    
    try {
      let state = (typeof aState == "string") ? this.JSON_decode(aState) : aState;
      state.windows.forEach(function(aWindow) {
        windows = windows + 1;
        tabs = tabs + aWindow.tabs.length;
      });
    }
    catch (ex) { logError(ex); };

    return { windows: windows, tabs: tabs };
  },
  
  _string: function(aName)
  {
    return SM_BUNDLE.GetStringFromName(aName);
  },

  setDisabled: function(aObj, aValue)
  {
    if (!aObj) return;
    // Run asynchronously because sometimes setting the disabled attribute doesn't work otherwise
    Utils.runAsync(function(value) {
      if (value) this.setAttribute("disabled", "true");
      else this.removeAttribute("disabled");
    }, aObj, aValue);
  },
  
  isCmdLineEmpty: function(aWindow)
  {
    if (Services.appinfo.name.toUpperCase() != "SEAMONKEY") {
      try {
        // Use the defaultArgs, unless SessionStore was trying to resume or handle a crash.
        // This handles the case where the browser updated and SessionStore thought it was supposed to display the update page, so make sure we don't overwrite it.
        let defaultArgs = (this.SessionStartup.doRestore()) ? 
                          Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).startPage :
                          Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).defaultArgs;
        if (aWindow.arguments && aWindow.arguments[0] && aWindow.arguments[0] == defaultArgs) {
          aWindow.arguments[0] = null;
        }
        return !aWindow.arguments || !aWindow.arguments[0];
      }
      catch(ex) {
        logError(ex);
        return false;
      }
    }
    else {
      let startPage = "about:blank";
      if (PreferenceManager.get("browser.startup.page", 1, true) == 1) {
        startPage = Private.SeaMonkey_getHomePageGroup();
      }
      return "arguments" in aWindow && aWindow.arguments.length && (aWindow.arguments[0] == startPage);
    }
  },
  
  //
  // Utilities
  //
  
  // Queues the callback function on the current thread to run it asynchronously.
  // Any additional parameters to this function are passed as parameters to the callback.
  runAsync: function(/**Function*/ callback, /**Object*/ thisPtr)
  {
    let params = Array.prototype.slice.call(arguments, 2);
    let runnable = {
      run: function()
      {
        callback.apply(thisPtr, params);
      }
    };
    Services.tm.currentThread.dispatch(runnable, Ci.nsIEventTarget.DISPATCH_NORMAL);
  },
  
  // Decode JSON string to javascript object - use JSON if built-in.
  JSON_decode: function(aStr, noError) {
    let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
    try {
      // JSON can't parse when string is wrapped in parenthesis, it shouldn't but older versions of Firefox wrapped
      // JSON data in parenthesis, so simply removed them if they are there.
      if (aStr.charAt(0) == '(')
        aStr = aStr.slice(1, -1);
    
      // Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so any sessions saved
      // with that version or earlier will fail here.  I used to try to eval in sandbox these, but that's not safe
      // so try to fix the actual session if possible.
      try {
        jsObject = JSON.parse(aStr);
      }
      catch (ex) {
        // All the following will attempt to convert an invalid JSON file into a valid one.  This is based off of old session
        // files that I had lying aroudn that had been saved years ago.  This fixed all of them, but it's possible there's
        // a session out there that won't get corrected.  The good news is that this is sessions that are from over 2 years ago
        // so hopefully it's not a big issue.  Also the user can always go back to an older version of Session Manager and load 
        // and resave the session.  If a session can be fixed, it will automatically be resaved so this should
        // only happen once per "bad" session.  Note Firefox itself still does an eval if it can't read a session, but apparently
        // addons aren't allowed to do so.
        
        // Needed for sessions saved under old versions of Firefox to prevent a JSON failure since Firefox bug 387859 was fixed in Firefox 4.
        if (/[\u2028\u2029]/.test(aStr)) {
          aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {return "\\u" + $0.charCodeAt(0).toString(16)});
        }

        // Try to wrap all JSON properties with quotes.  Replace wrapped single quotes with double quotes.  Don't wrap single quotes
        // inside of data.  
        aStr = aStr.replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'?([^'":{}\[\]//]+)'?/gi, function(str, p1, p2, p3, p4, offset, s) { 
          return (p1 + '"' + p4.substr(0, p4.length - ((p4[p4.length-1] == "'") ? 1 : 0)) + '"').replace("'\"",'"',"g");
        });
        // Fix any escaped single quotes as those will cause a problem.
        aStr = aStr.replace(/([^\\])'(:)/g,'$1"$2').replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'/g,'$1"').replace("\\'","'","g");
        // Try to remove any escaped unicode characters as those also cause problems
        aStr = aStr.replace(/\\x([0-9|A-F]{2})/g, function (str, p1) {return String.fromCharCode(parseInt("0x" + p1)).toString(16)});
        // Find and fix issue with things like rgb(#,#,#) getting messed up with inserted quotes
        aStr = aStr.replace(/[a-z,A-Z]+\(\d+\s*,\s*\"\d+\s*,\s*\"\d+\)\"\"/g, function (str) { return str.replace(/\"/g,"") });

        // Hopefully at this point we have valid JSON, here goes nothing. :)
        jsObject = JSON.parse(aStr);
        if (jsObject)
          jsObject._fixed_bad_JSON_data = true;
      }
    }
    catch(ex) {
      jsObject._JSON_decode_error = ex;
      if (!noError) this.sessionError(ex);
    }
    return jsObject;
  },
  
  // Encode javascript object to JSON string - use JSON if built-in.
  JSON_encode: function(aObj) {
    let jsString = null;
    try {
      jsString = JSON.stringify(aObj);
    }
    catch(ex) {
      this.sessionError(ex);
    }
    return jsString;
  },
  
  get SessionStore() {
    try {
      // Try returning SessionStore.jsm which exists in recent versions of Firefox
      return SessionStore;
    } catch(ex) {
      // If it fails return older version
      return Private.SessionStore;
    }
  },
  
  get SessionStartup() {
    return Private.SessionStartup;
  },
  
  get deletedSessionsFolder() {
    let preferredFolder = PreferenceManager.get("deleted_sessions_folder_name");
    return preferredFolder ? preferredFolder : this._string("deleted_sessions_folder");
  },
  
  get EOL() {
    return Private.EOL;
  },
}

// Freeze the Utils object
Object.freeze(Utils);

let Private = { 
  _EOL: null,
  _SessionStore: null,
  _SessionStartup: null,
  
  get EOL() {
    if (!this._EOL) 
      this._EOL = /win|os[\/_]?2/i.test(Services.appinfo.OS)?"\r\n":"\n";
      
    return this._EOL;
  },

  get SessionStore() {
    if (!this._SessionStore) {
      // Firefox or SeaMonkey
      let sessionStore = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
      if (sessionStore) 
        this._SessionStore = sessionStore.getService(Ci.nsISessionStore);
    }
    return this._SessionStore;
  },
  
  get SessionStartup() {
    if (!this._SessionStartup) {
      // Firefox or SeaMonkey
      let sessionStart = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
      if (sessionStart)
        this._SessionStartup = sessionStart.getService(Ci.nsISessionStartup);
    }
    return this._SessionStartup;
  },
  
  clearUndoList: function(aType)
  {
    let window = Utils.getMostRecentWindow("navigator:browser");
  
    if ((aType != "window") && window) {
      while (this.SessionStore.getClosedTabCount(window)) this.SessionStore.forgetClosedTab(window, 0);
    }

    if (aType != "tab") {
      if (PreferenceManager.get("use_SS_closed_window_list")) {
        // use forgetClosedWindow command if available (not in SeaMonkey), otherwise use hack
        if (typeof this.SessionStore.forgetClosedWindow == "function") {
        while (this.SessionStore.getClosedWindowCount()) this.SessionStore.forgetClosedWindow(0);
        }
        else if (window) {
          let state = { windows: [ {} ], _closedWindows: [] };
          this.SessionStore.setWindowState(window, Utils.JSON_encode(state), false);
        }
      }
      else {
        SessionIo.clearUndoData("window");
      }
    }
    
    if (window) {
      // the following forces SessionStore to save the state to disk which isn't done for some reason.
      this.SessionStore.setWindowValue(window, "SM_dummy_value","1");
      this.SessionStore.deleteWindowValue(window, "SM_dummy_value");
    }
    
    Services.obs.notifyObservers(null, "sessionmanager:update-undo-button", null);
  },
  
  SeaMonkey_getHomePageGroup: function()
  {
    return PreferenceManager.getHomePageGroup();
  },
}
