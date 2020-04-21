"use strict";

// import into the namespace
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
XPCOMUtils.defineLazyServiceGetter(this, "secret_decoder_ring_service", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "deleteLogFile", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "openLogFile", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "isLogFile", "chrome://sessionmanager/content/modules/logger.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionConverter", "chrome://sessionmanager/content/modules/session_convert.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SQLManager", "chrome://sessionmanager/content/modules/sql_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

// logging level - should match what's in logger_backend.jsm
const logging_level = { STATE: 1, TRACE: 2, DATA: 4, INFO: 8, EXTRA: 16, ERROR: 32 };

var originalOverwriteLabel = null;
var keyNames=[];
var keysInitialized = false;
var gLocaleKeys;
var buttonsDisabled = false;
var gPlatformKeys = new Object();

var observer = {
  observe: function(aSubject, aTopic, aData) {
    log("options.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
    switch (aTopic)
    {
    case "xul-overlay-merged":
      // refresh value so menu selector displays correct value
      _("browserStartupPage").value = _("browserStartupPage").value;
      break;
    case "sessionmanager:encryption-change":
      _("encrypt_sessions").disabled = (aData == "start");
      break;
    case "sessionmanager:sql-cache-updating":
      _("rebuild_cache_button").disabled = (aData == "true") || !_("preference.use_SQLite_cache").valueFromPreferences;
      _("use_sql_cache").disabled = (aData == "true");
      break;
    case "sessionmanager:sql-cache-updated":
      _("rebuild_cache_button").disabled = !_("preference.use_SQLite_cache").valueFromPreferences;
      _("use_sql_cache").disabled = false;
      break;
    case "nsPref:changed":
      switch (aData)
      {
      case "extensions.tabmix.singleWindow":
        if (PreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
          _("overwrite").label = Utils._string("overwrite_tabs");
          _("open_as_tabs").style.visibility = "collapse";
        }
        else {
          _("overwrite").label = originalOverwriteLabel;
          _("open_as_tabs").style.visibility = "visible";
        }
        break;
      case "append_by_default":
        changeOverwriteLabel(_("preference.append_by_default").valueFromPreferences);
        break;
      case "use_SS_closed_window_list":
        checkClosedWindowList(_("preference.use_SS_closed_window_list").valueFromPreferences);
        break;
      case "encrypt_sessions":
        var encrypting = _("preference.encrypt_sessions").valueFromPreferences;
        _("encrypted_only").hidden = !encrypting;
        
        // When animating preferences the window can get cut off so just refresh the window size here
        if (encrypting && PreferenceManager.get("browser.preferences.animateFadeIn", false, true))
          window.sizeToContent();
        break;
      case "logging":
        updateLogCheckboxes(_("preference.logging").valueFromPreferences);
        break;
      case "logging_level":
        readLogLevel();
        break;
      case "hide_tools_menu":
        _("show_icon_in_menu").disabled = _("preference.hide_tools_menu").valueFromPreferences;
        break;
      case "use_SQLite_cache":
        _("rebuild_cache_button").disabled = true;
        _("use_sql_cache").disabled = true;
        break;
      }
      break;
    }
  }
};

var onLoad = function(aEvent) {
  this.removeEventListener("load", onLoad, false);
  this.addEventListener("unload", onUnload, false);
  
  // Overlay specific Firefox or SeaMonkey settings
  let overlayURL;
  switch(Services.appinfo.name) {
    case "Firefox":
      overlayURL = "chrome://sessionmanager/content/options/ff-options.xul";
      break;
    case "SeaMonkey":
      overlayURL = "chrome://sessionmanager/content/options/sm-options.xul";
      break;
  }
  if (overlayURL) 
    document.loadOverlay(overlayURL, observer);

  // listen for encryption change start/stop
  Services.obs.addObserver(observer, "sessionmanager:encryption-change", false);
  Services.obs.addObserver(observer, "sessionmanager:sql-cache-updated", false);
  Services.obs.addObserver(observer, "sessionmanager:sql-cache-updating", false);
  PreferenceManager.observe("", observer, false);
  if (SharedData.tabMixPlusEnabled)
    PreferenceManager.observe("extensions.tabmix.singleWindow", observer, false, true);

  // If instant Apply is on, hide the apply button
  if (PreferenceManager.getInstantApply()) {
    document.documentElement.getButton("extra1").style.visibility = "collapse";
  }
  
  // Restore selected indexes
  _("generalPrefsTab").selectedIndex = _("preference.options_selected_tab").valueFromPreferences;
  
  // Only show preserve app tabs if app tabs exists (Firefox)
  if (Services.appinfo.name != "Firefox") {
    _("preserve_app_tabs").parentNode.style.visibility = "collapse";
  }
  
  // Only show option to restore hidden tabs if default value exists for it
  if (_("browser.sessionstore.restore_hidden_tabs").defaultValue == null) {
    _("restore_hidden_tab").style.visibility = "collapse";
  }

  // Firefox uses on demand setting, SeaMonkey still uses old concurrent tab setting
  if (_("browser.sessionstore.restore_on_demand").defaultValue == null) {
    _("restore_on_demand").style.visibility = "collapse";
  }
  if (_("browser.sessionstore.max_concurrent_tabs").defaultValue == null) {
    _("concurrent_tabs").style.visibility = "collapse";
  }

  // Only show option to limit tab histroy to restore if default value exists for it
  if (_("browser.sessionstore.max_serialize_back").defaultValue == null) {
    _("back_button_keep_box").style.visibility = "collapse";
  }
  if (_("browser.sessionstore.max_serialize_forward").defaultValue == null) {
    _("forward_button_keep_box").style.visibility = "collapse";
  }
  
  // Hide mid-click preference if Tab Mix Plus or Tab Clicking Options is enabled
  var browser = Services.wm.getMostRecentWindow("navigator:browser");
  if ((browser && typeof(browser.tabClicking) != "undefined") || SharedData.tabMixPlusEnabled) {
    _("midClickPref").style.visibility = "collapse";
  }
  
  if (SharedData.tabMixPlusEnabled && PreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
    _("overwrite").label = Utils._string("overwrite_tabs");
    _("open_as_tabs").style.visibility = "collapse";
  }
  
  // Disable Apply Button by default
  document.documentElement.getButton("extra1").disabled = true;
  
  // Disable encryption button if change in progress
  _("encrypt_sessions").disabled = SharedData.mEncryptionChangeInProgress;
  
  // Disable show icon in menu button if menu hidden
  _("show_icon_in_menu").disabled = _("preference.hide_tools_menu").valueFromPreferences;
  
  // Disabled enabled button based on checkbox
  _("rebuild_cache_button").disabled = !_("preference.use_SQLite_cache").valueFromPreferences || SQLManager.changingEntireSQLCache;
  _("use_sql_cache").disabled = SQLManager.changingEntireSQLCache;
  
  // Disable backup every text field if disabled
  _('backup_every').disabled = !_("preference.backup_every").valueFromPreferences;

  updateSpecialPreferences();
  
  // Change styling if in permanent private browsing mode
  updatePrivateBrowsing();
  
  // If animating the height appears to be calculated wrong, so adjust it in that case
  // This also takes care of OS X issues
  if (PreferenceManager.get("browser.preferences.animateFadeIn", false, true))
    adjustContentHeight();
    
  // Hide/show the encrypt only checkbox based on state of encryption checkbox
  // Done after adjusting content height so height is correct
  _("encrypted_only").hidden = !_("encrypt_sessions").checked;
};

var onUnload = function(aEvent) {
  this.removeEventListener("unload", onUnload, false);
  Services.obs.removeObserver(observer, "sessionmanager:encryption-change");    
  Services.obs.removeObserver(observer, "sessionmanager:sql-cache-updated");
  Services.obs.removeObserver(observer, "sessionmanager:sql-cache-updating");
  PreferenceManager.unobserve("", observer);
  if (SharedData.tabMixPlusEnabled)
    PreferenceManager.unobserve("extensions.tabmix.singleWindow", observer, true);
  _("preference.options_selected_tab").valueFromPreferences = _("generalPrefsTab").selectedIndex;
};

// Preferences that can change are here so we can update options window
function updateSpecialPreferences(aUpdateSessionsOnly) {
  // hide/show menus for startup options
  startupSelect(_("startupOption").selectedIndex = _("preference.startup").valueFromPreferences);

  // Populate select session list and select previously selected session
  var resume_session = _("resume_session");
  var sessions = SessionIo.getSessions();
  // remove any existing items
  resume_session.removeAllItems();
  resume_session.appendItem(Utils._string("startup_resume"), Constants.BACKUP_SESSION_FILENAME, "");
  var maxWidth = window.getComputedStyle(_("startEndGroupbox"), null).width;
  sessions.forEach(function(aSession) {
    if ((aSession.fileName != Constants.AUTO_SAVE_SESSION_NAME) && (aSession.fileName != Constants.BACKUP_SESSION_FILENAME))
    {
      var elem = resume_session.appendItem(aSession.name, aSession.fileName, "");
      elem.setAttribute("maxwidth", maxWidth);
      elem.setAttribute("crop", "center");
    }
  }, this);
  // if no restore value, select previous browser session
  resume_session.value = _("preference.resume_session").value || Constants.BACKUP_SESSION_FILENAME;
  
  // current load session no longer there
  if (resume_session.selectedIndex == -1) {
    resume_session.value ="";
    _("preference.resume_session").valueFromPreferences = resume_session.value;
    // change option to none if select session was selected
    if (_("startupOption").selectedIndex==2) {
      startupSelect(_("startupOption").selectedIndex = 0);
      _("preference.startup").valueFromPreferences = _("startupOption").selectedIndex;
    }
  }
  
  if (!aUpdateSessionsOnly) {
    // Update displayed options based on preference
    checkClosedWindowList(_("preference.use_SS_closed_window_list").valueFromPreferences);
    
    // Change overwrite label to tabs if append to window as tab preference set
    originalOverwriteLabel = _("overwrite").label;
    changeOverwriteLabel(_("preference.append_by_default").valueFromPreferences);
  
    // Initialize and read keys
    initKeys()
    
    // Update Logging Level checkboxes
    readLogLevel();
    
    // Enable/Disable log checkboxes
    updateLogCheckboxes(_("enable_logging").checked);
  }
};

var _disable = Utils.setDisabled;

function readMaxClosedUndo(aID)
{
  switch (aID) {
    case "max_closed":
      var value = _("preference.max_closed_undo").value;
      _disable(_("save_window_list"), value == 0);
      return value;
      break;
    case "max_closed_SS":
      var value = _("browser.sessionstore.max_windows_undo").value;
      _disable(_("save_closed_windows"), value == 0);
      _disable(document.getElementsByAttribute("control", "save_closed_windows")[0], value == 0);
      return value;
      break;
  }
  
  return 0;
}

function readMaxTabsUndo()
{
  var value = _("browser.sessionstore.max_tabs_undo").value;
  
  _disable(_("save_closed_tabs"), value == 0);
  _disable(document.getElementsByAttribute("control", "save_closed_tabs")[0], value == 0);
  
  return value;
}

function promptClearUndoList(aType)
{
  var max_tabs_undo = _("max_tabs").value;
  
  Utils.clearUndoListPrompt(aType);
  
  _("max_tabs").value = max_tabs_undo;
};

function readInterval()
{
  return _("browser.sessionstore.interval").value / 1000;
}

function writeInterval()
{
  return Math.round(parseFloat(_("interval").value) * 1000 || 0);
}

function readPrivacyLevel()
{
  var value = _("browser.sessionstore.privacy_level").value;
  
  _disable(_("postdata"), value > 1);
  _disable(document.getElementsByAttribute("control", "postdata")[0], value > 1);
  
  return value;
}

function logLevelUpdate() {
  // If instant apply on, apply immediately
  if (PreferenceManager.getInstantApply()) {
    setLogLevel();
  }
  else enableApply();
}

function setLogLevel() {
  var logLevel = 0;
  var logCB = document.getElementsByAttribute("class", "logLevel");
  for (var i=0; i < logCB.length; i++) {
    logLevel = logLevel | (logCB[i].checked ? logging_level[logCB[i].getAttribute("_logLevel")] : 0);
  };
  
  _("preference.logging_level").valueFromPreferences = logLevel;
}

function readLogLevel() {
  var logLevel = _("preference.logging_level").valueFromPreferences;
  var logCB = document.getElementsByAttribute("class", "logLevel");
  for (var i=0; i < logCB.length; i++) {
    logCB[i].checked = ((logLevel & logging_level[logCB[i].getAttribute("_logLevel")]) > 0);
  };
}

function updateLogCheckboxes(checked) {
  var boxes = _("loggingCategories").getElementsByTagName("checkbox");
  for (var i = 0; i < boxes.length; i++) {   
    boxes[i].disabled = !checked;
  }
  
  // Use actual preference for buttons since we don't want them enabled for logging is enabled
  var noLogFile = !_("preference.logging").valueFromPreferences && !isLogFile();
  _("open_log_button").disabled = noLogFile;
  _("delete_log_button").disabled = noLogFile;
}

function doDeleteLogFile() {
  deleteLogFile();
  
  _("open_log_button").disabled = !_("preference.logging").valueFromPreferences;
  _("delete_log_button").disabled = !_("preference.logging").valueFromPreferences;
}

function _(aId)
{
  return document.getElementById(aId);
}

function selectSessionDir() {
  var nsIFilePicker = Components.interfaces.nsIFilePicker;
  var filepicker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);

  filepicker.init(window, Utils._string("choose_dir"), nsIFilePicker.modeGetFolder);
  filepicker.appendFilters(nsIFilePicker.filterAll);
  var ret = filepicker.show();
  if (ret == nsIFilePicker.returnOK) {
    _("preference.sessions_dir").value = filepicker.file.path;
  }
}    

function defaultSessionDir() {
  _("preference.sessions_dir").value = '';
}

function checkEncryption(aState) {
  try {
    // force a master password prompt so we don't waste time if user cancels it
    secret_decoder_ring_service.encryptString("");
  }
  catch (ex) {
    Utils.cryptError(Utils._string("change_encryption_fail"));
    return !aState;
  }
  _("encrypted_only").hidden = !aState;
  
  // When animating preferences the window can get cut off so just refresh the window size here
  if (aState && PreferenceManager.get("browser.preferences.animateFadeIn", false, true))
    window.sizeToContent();
  
  return aState;
}

function checkEncryptOnly(aState) {
  if (aState && !_("preference.encrypted_only").valueFromPreferences) {
    if (!Services.prompt.confirm(window, SharedData.mTitle, Utils._string("encrypt_only_confirm"))) {
      aState = false;
    }
  }
  
  return aState;
}

function changeOverwriteLabel(aChecked) {
  _("overwrite").label = aChecked ? Utils._string("overwrite_tabs") : originalOverwriteLabel;
}

function checkClosedWindowList(aChecked) {
  // Hide the option to not clear the list of closed windows on shutdown if we are using the built in closed windows
  var builtin = aChecked && (_("closed_window_list").style.visibility != "collapse");
  
  _("save_window_list").style.visibility = builtin ? "collapse" : "visible";
  _("max_closed").style.visibility = builtin ? "collapse" : "visible";
  _("max_closed_SS").style.visibility = builtin ? "visible" : "collapse";
  _("closed_windows_menu").style.visibility = builtin ? "visible" : "collapse";
}

function startupSelect(index) {
  // hide/display corresponding menus 
  _("browserStartupPage").style.visibility = (index != 0)?"collapse":"visible";
  _("preselect").style.visibility = (index != 1)?"collapse":"visible";
  _("resume_session").style.visibility = (index != 2)?"collapse":"visible";
  //if (index == 1) _("resume_session").style.visibility = "hidden";
  
  // If instant apply on, apply immediately
  if (PreferenceManager.getInstantApply()) {
    setStartValue();
  }
}

function setStartValue() {
  _("preference.startup").valueFromPreferences = _("startupOption").selectedIndex;
}

function savePrefs() {
  var prefs = document.getElementsByTagName('preference');
  for (var i=0; i<prefs.length; i++) {
    prefs[i].valueFromPreferences = prefs[i].value;
  }
  saveSpecialPrefs();
  
  // Disable Apply Button
  document.documentElement.getButton("extra1").disabled = true;
} 

function saveSpecialPrefs() {
  setStartValue();
  setLogLevel();
  saveKeyConfig();
}

function enableApply() {
  document.documentElement.getButton("extra1").disabled = false;
}

function disableApply() {
  document.documentElement.getButton("extra1").disabled = true;
}

function goHelp() {
  var link = "http://sessionmanager.mozdev.org/options.html#";
  
  switch (document.documentElement.currentPane) {
    case (_("mainPrefPane")):
      switch (_("generalPrefsTab").selectedIndex) {
        case 0:
          link = link + "startup";
          break;
        case 1:
          link = link + "saving";
          break;
        case 2:
          link = link + "display";
          break;
        case 3:
          link = link + "keyboard";
          break;
      }
      break;
    case (_("undoclosePrefPane")):
      link = link + "undo";
      break;
    case (_("advancedPrefPane")):
      link = link + "advanced";
      break;
    case (_("sessionstorePrefPane")):
      link = link + "sessionstore";
      break;
    case (_("loggingPrefPane")):
      link = link + "logging";
      break;
  }
  
  openLink(link);
}

function openLink(url) {
  var top = Services.wm.getMostRecentWindow("navigator:browser");
           
  if (!top) window.open(url, "", "");
  else {
    // Is current tab blank or already on help page.
    var tBrowser = top.getBrowser();
    var location = Utils.getCurrentTabTitle(top);
    var currBlank = false;
    var index = location.indexOf("#");
    var baseLocation = (index == -1)? location : location.substring(0,index);
    index = url.indexOf("#");
    var baseURL = (index == -1)? url : url.substring(0,index);
    currBlank = (location == "about:blank") || (location == "about:newtab") || (baseLocation == baseURL);
                   
    if (currBlank) tBrowser.loadURI(url);
    else {
      var tab = tBrowser.addTab(url);
      tBrowser.selectedTab = tab;
    }
  }
}

// Localize strings aren't used when the initial height is used to calculate the size of the context-box
// and preference window.  The height is calculated correctly once the window is drawn, but the context-box
// and preference window heights are never updated.
// To fix this, we need to explicitly set the height style of any element with a localized string that is more 
// than one line (the descriptions).  This will correct the heights when the panes are selected.
function adjustContentHeight() {
  var largestAdjustedPaneHeight = 0;
  var largestUnadjustedPaneHeight = 0; 

  // Calculate the size of a single line (thanks to Nils Maier - maierman@web.de)
  var singleLine = Array.reduce(document.querySelectorAll("prefpane label"), function(c, e) {
    var h = parseFloat(getComputedStyle(e, null).height);
    if (h > 1) { // Do not want hidden stuff!
      return Math.min(h, c);
    }
    return c;
  }, 26); 
  
  // For each pane, calculate the real size of the pane (with the multiline descriptions)
  for (var i=0; i < document.documentElement.preferencePanes.length; i++) {
    var pane = document.documentElement.preferencePanes[i];
    var descriptions = pane.getElementsByTagName('description');
    var adjustHeight = 0;  // extra height caused by multiline descriptions
    for (var j=0; j<descriptions.length; j++) {
      var height = window.getComputedStyle(descriptions[j], null).height;
      if (height != "auto") {
        descriptions[j].style.height = height;
        // Adjust height by how many extra lines all the descriptions take up
        adjustHeight += parseFloat(height) - singleLine;
      }
    }
    
    // Calculate new adjusted current pane height.  
    adjustHeight = pane.contentHeight + adjustHeight;
    
    // Keep track of the largest adjusted and non-adjusted pane heights
    largestAdjustedPaneHeight = Math.max(largestAdjustedPaneHeight, adjustHeight);
    largestUnadjustedPaneHeight = Math.max(largestUnadjustedPaneHeight, pane.contentHeight);
  }
  
  // When animating the window needs to be resized to take into account the changes to the description height and
  // then shrunk since the opening pane is sized to the largest pane height which is wrong.
  window.sizeToContent();
  
  // If encrypted only checkbox is hidden need to tweak the height 
  var encrypted_groupbox_height = parseFloat(window.getComputedStyle(_("encrypted_only").parentNode, null).height) / 2;
  var currentPane = document.documentElement.currentPane;
/*  Old adjusting that didn't work correctly
  var adjuster = (!_("encrypt_sessions").checked) ? (largestUnadjustedPaneHeight - encrypted_groupbox_height - largestAdjustedPaneHeight) : largestUnadjustedPaneHeight;
  window.innerHeight -= (adjuster - currentPane.contentHeight);
*/
  var adjuster = (!_("encrypt_sessions").checked) ? (window.innerHeight - currentPane.contentHeight - encrypted_groupbox_height) : 0;
  window.innerHeight += adjuster;
}

// Key stuff - originally comes from keyconfig add-on
function initKeys() {
  if (!keysInitialized) {
    for (var property in KeyEvent) {
      keyNames[KeyEvent[property]] = property.replace("DOM_","");
    }
    keyNames[8] = "VK_BACK";

    gLocaleKeys = document.getElementById("localeKeys");

    var platformKeys = document.getElementById("platformKeys");
    gPlatformKeys.shift = platformKeys.getString("VK_SHIFT");
    gPlatformKeys.meta  = platformKeys.getString("VK_META");
    gPlatformKeys.alt   = platformKeys.getString("VK_ALT");
    gPlatformKeys.ctrl  = platformKeys.getString("VK_CONTROL");
    gPlatformKeys.sep   = platformKeys.getString("MODIFIER_SEPARATOR");
    switch (PreferenceManager.get("ui.key.accelKey", 0, true)){
      case 17:  gPlatformKeys.accel = gPlatformKeys.ctrl; break;
      case 18:  gPlatformKeys.accel = gPlatformKeys.alt; break;
      case 224: gPlatformKeys.accel = gPlatformKeys.meta; break;
      default:  gPlatformKeys.accel = (window.navigator.platform.search("Mac") == 0 ? gPlatformKeys.meta : gPlatformKeys.ctrl);
    }
    keysInitialized = true;
  }
  
  readKeyConfig();
}

function clearKey(element) {
  element.previousSibling.value = "";
  element.previousSibling.key = "";
  
  if (PreferenceManager.getInstantApply()) {
    saveKeyConfig();
  }
  else enableApply();
}

function readKeyConfig() {
  var keys = Utils.JSON_decode(_("preference.keys").valueFromPreferences, true);
  if (!keys._JSON_decode_failed) {
  
    var keyBoxes = _("key_rows").getElementsByTagName("textbox");
    for (var i=0; i < keyBoxes.length; i++) {
      var keyname = keyBoxes[i].id.replace(/_key/,"");
      keyBoxes[i].value = (keys[keyname]) ? getFormattedKey(keys[keyname].modifiers,keys[keyname].key,keys[keyname].keycode) : "";
      keyBoxes[i].key = keys[keyname];
    }
  }
}

function saveKeyConfig() {
  var keys = {};
  
  var keyBoxes = _("key_rows").getElementsByTagName("textbox");
  for (var i=0; i < keyBoxes.length; i++) {
    if (keyBoxes[i].key) {
      keys[keyBoxes[i].id.replace(/_key/,"")] = keyBoxes[i].key;
    }
  }
  
  _("preference.keys").valueFromPreferences = Utils.JSON_encode(keys);
}

function getFormattedKey(modifiers,key,keycode) {
  if(modifiers == "shift,alt,control,accel" && keycode == "VK_SCROLL_LOCK") return "";
  if(key == "" || (!key && keycode == "")) return "";

  var val = "";
  if(modifiers) val = modifiers
    .replace(/^[\s,]+|[\s,]+$/g,"").split(/[\s,]+/g).join(gPlatformKeys.sep)
    .replace("alt",gPlatformKeys.alt)
    .replace("shift",gPlatformKeys.shift)
    .replace("control",gPlatformKeys.ctrl)
    .replace("meta",gPlatformKeys.meta)
    .replace("accel",gPlatformKeys.accel)
    +gPlatformKeys.sep;
  if(key)
    val += key;
  if(keycode) try {
    val += gLocaleKeys.getString(keycode)
  } catch(e){val += gStrings.unrecognized.replace("$1",keycode);}

  return val;
}

function keyPress(element, event) {
  var modifiers = [];
  if(event.altKey) modifiers.push("alt");
  if(event.ctrlKey) modifiers.push("control");
  if(event.metaKey) modifiers.push("meta");
  if(event.shiftKey) modifiers.push("shift");

  // prevent key commands without a modifier or with only 1 modifier, but not CTRL
  if ((modifiers.length == 0) || ((modifiers.length == 1) && (modifiers[0] != "control"))) {
    // Allow tab, shift-tab, escape, enter/return and F1 (help)
    if ((event.keyCode != KeyEvent.DOM_VK_TAB) && (event.keyCode != KeyEvent.DOM_VK_ESCAPE) && 
        (event.keyCode != KeyEvent.DOM_VK_RETURN)  && (event.keyCode != KeyEvent.DOM_VK_F1)) {
      event.preventDefault();
      event.stopPropagation(); 
      
      // clear on delete or backspace
      if ((event.keyCode == KeyEvent.DOM_VK_BACK_SPACE) ||  (event.keyCode == KeyEvent.DOM_VK_DELETE))
        clearKey(element.nextSibling);
    }
  
    return;
  }

  event.preventDefault();
  event.stopPropagation(); 
    
  modifiers = modifiers.join(" ");

  var key = null; var keycode = null;
  if (event.charCode) key = String.fromCharCode(event.charCode).toUpperCase();
  else { keycode = keyNames[event.keyCode]; if(!keycode) return;}

  var keyvalue = getFormattedKey(modifiers,key,keycode);
  
  // check if duplicate key
  var keyBoxes = _("key_rows").getElementsByTagName("textbox");
  for (var i=0; i < keyBoxes.length; i++) {
    if (keyBoxes[i].value == keyvalue) return;
  }
  
  element.value = getFormattedKey(modifiers,key,keycode);
  element.key = { modifiers: modifiers, key: key, keycode: keycode };
  
  if (PreferenceManager.getInstantApply()) {
    saveKeyConfig();
  }
  else enableApply();
}

// Disable buttons and labels to prevent accesskey from kicking off when ALT is pressed.
// Only start disabling if ALT pressed, but keep disabling until keys released.
function disableButtons(aEvent) {
  var disable = (aEvent.type == "keydown") && (aEvent.keyCode == KeyEvent.DOM_VK_ALT);
  var enable = (aEvent.type == "keyup");
  
  var buttons = document.documentElement.getElementsByTagName("button");
  var labels = _("key_rows").getElementsByTagName("label");
  
  if (disable && !buttonsDisabled) {
    buttonsDisabled = true;
    for (var i=0; i < buttons.length; i++) buttons[i].disabled = true;
    document.documentElement.getButton("help").disabled = true;
    for (var i=0; i < labels.length; i++) {
      // save old attribute
      labels[i].setAttribute("saved_accesskey", labels[i].getAttribute("accesskey"));
      labels[i].removeAttribute("accesskey");
    }
  }
  else if (enable && buttonsDisabled) {
    buttonsDisabled = false;
    for (var i=0; i < buttons.length; i++) buttons[i].disabled = false;
    document.documentElement.getButton("help").disabled = false;
    for (var i=0; i < labels.length; i++) {
      // save old attribute
      labels[i].setAttribute("accesskey", labels[i].getAttribute("saved_accesskey"));
      labels[i].removeAttribute("saved_accesskey");
    }
  }
}

function updatePrivateBrowsing() {
  checkPrivateBrowsing(_("backup_session"));
  checkPrivateBrowsing(_("resume_session"));
}

function checkPrivateBrowsing(aElem) {
  var warn = (aElem.id == "backup_session" && (aElem.value != 0)) || ((aElem.id == "resume_session") && (aElem.value == Constants.BACKUP_SESSION_FILENAME));

  if (warn && Utils.isAutoStartPrivateBrowserMode()) {
    aElem.setAttribute("warn", "true");
    aElem.setAttribute("tooltiptext", Utils._string("private_browsing_warning"));
  }
  else {
    aElem.removeAttribute("warn");
    aElem.removeAttribute("tooltiptext");
  }
}

// Disable periodic backup if time specified is invalid
function checkBackupTime(time) {
  if (!(parseInt(time) > 0)) {
    _("backup_every_cb").checked = false;
    _("preference.backup_every").value = false;
    _("backup_every").value = 0;
    _("preference.backup_every_time").value = 0;
    _("backup_every").disabled = true;
  }
}

window.addEventListener("load", onLoad, false);
