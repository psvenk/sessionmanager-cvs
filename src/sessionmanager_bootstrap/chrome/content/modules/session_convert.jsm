"use strict";

/*
 * This file contains conversion routines for converting from SessionSaver and TMP session formats to
 * Session Manager session format.  
 * Portions of the following code as marked were originally written by onemen, rue and pike
 */

this.EXPORTED_SYMBOLS = ["SessionConverter"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const report = Components.utils.reportError;

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "secret_decoder_ring_service", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");
 
// import the session_manager modules
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

this.SessionConverter = {
	convertTMP: function(aFileUri, aSilent) {
		if (aFileUri) {
			gConvertTMPSession.init(true);
			if (!gConvertTMPSession.convertFile(aFileUri, aSilent) && !aSilent) {
				gConvertTMPSession._prompt.alert(null, Utils._string("sessionManager"), Utils._string("ss_none"));
			}
			gConvertTMPSession.cleanup();
		}
		else
			gConvertTMPSession.init();
	},
	convertSessionSaver: function() {
		gSessionSaverConverter.init();
	},
	convertToLatestSessionFormat: function(aFile, aState) {
		return oldFormatConverter.convertToLatestSessionFormat(aFile, aState);
	},
	decodeOldFormat: function(aIniString, moveClosedTabs) {
		return oldFormatConverter.decodeOldFormat(aIniString, moveClosedTabs);
	}
}

// Don't allow changing
Object.freeze(SessionConverter);

/*
 * Code to convert from SessionSaver 0.2 format to Session Manager format
 * Original code by Morac except where indicated otherwise
 */

var gSessionSaverConverter = {
	
	sessionList: null,
	sessions: null,
	
	// Only preselect all for initial conversion
	selectAll: true,
	
	exportFileExt: "ssv", exportFileMask: "*.ssv",
	prefBranch:      'sessionsaver.',
	prefBranchStatic:      'static.', // all manually captured sessions
	prefBranchWindows:    'windows.', // the "live" capture of the current session
	staticBranchDefault:  'default.', // the default manual-session
	D : ["  ", "| "," |", " ||"], // new-style
	
	init: function() {
		var chromeWin = Services.wm.getMostRecentWindow("navigator:browser");
		if (!chromeWin) {
			Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("no_browser_windows"));
			return;
		}
		
		// if encrypting, force master password and exit if not entered
		try {
			if (PreferenceManager.get("encrypt_sessions")) 
				secret_decoder_ring_service.encryptString("");
		}
		catch(ex) {
			Utils.cryptError(Utils._string("encrypt_fail2"));
			return;
		}

		this.rootBranch    = Services.prefs.getBranch(null);
		this.Branch        = Services.prefs.getBranch(this.prefBranch);
		this.staticBranch  = Services.prefs.getBranch(this.prefBranch + this.prefBranchStatic);
		this.windowBranch  = Services.prefs.getBranch(this.prefBranch + this.prefBranchWindows);
		
		var aObj = {}, aObj2 = {}; 
		this.staticBranch.getChildList("", aObj);
		this.windowBranch.getChildList("", aObj2);
		
		if (aObj.value || aObj2.value) {
			var okay = true;
			var skip = false;
			if ((this.Branch.getPrefType("SM_Converted") == 128) && 
				 this.Branch.getBoolPref("SM_Converted")) {
				skip = true;
				this.selectAll = false;
				if (this.confirm(Utils._string("ss_convert_again"))) okay = false;
				
			}
			if (okay) {
				if (skip || !this.confirm(Utils._string("ss_confirm_convert"))) {
					var data = this.createSessionData();
					this.findValidSession(data,true);
					this.Branch.setBoolPref("SM_Converted", true);
				}
			}
			
			// check if SessionSaver installed and if so don't offer to delete data
			if (!chromeWin.SessionSaver && !this.confirm(Utils._string("ss_confirm_archive"))) {
				if (this.exportSession(chromeWin)) {
					try{ this.Branch.deleteBranch(""); } 
					catch(e) { Services.prompt.alert(null,Utils._string("sessionManager"), "Removed Fail: "+e); }
				}
			}
		}
		else {
			if (!this.confirm(Utils._string("ss_confirm_import"))) this.importSession(chromeWin);
		}
		this.rootBranch = null;
		this.Branch = null;
		this.staticBranch = null;
		this.windowBranch = null;
	},

	confirm: function (aMsg) {
		return Services.prompt.confirmEx(null,
										 Utils._string("sessionManager"),
										 aMsg,
										 (Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0)
										+ (Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1),
										 null, null, null, null, {});
	},
	
	get _sessions() {
		return gSessionSaverConverter.sessionList;
	},
	
	getSessions :function() {
		return gSessionSaverConverter.sessionList;
	},
	
	convertSession: function(client, zHash) {
		var i, j, m, SessionData = [], failedList = "\n";
		for (m in zHash.asName) {
			var name = zHash.asName[m];
			var zorder = client[m + ".zorder"].split(",");
			SessionData[name] = { cookies: (client[m + ".cookies"]?client[m + ".cookies"].split("  |"):null), windows:[] };
			for (i in zorder) {
				if (zorder[i] && client[(m + "." + zorder[i])]) SessionData[name].windows[i] = client[(m + "." + zorder[i])];
			}
		}
			
		this.sessionList = [];
		this.sessions = [];
		for (i in SessionData) {
			try {
				var windows = SessionData[i].windows;
				var totalTabCount = 0;
				var jsWindows = [];
			
				for (j in windows) {
					var session = windows[j].split(this.D[0]); // get stored window-session from data
					if (session.length < 8) return;   // bad session data since no tabs so exit
				
					var win = { tabs:[], width: session[1], height: session[2], screenX: session[3],
								screenY: session[4], selected: parseInt(session[6] + 1), 
								sizemode: ((session[9]=="1")?"maximized":"normal"), _closedTabs:[] };

					var chromeProperties = session[5].split("");
					var hidden = "";
					if (chromeProperties[0]=="0") win.hidden = win.hidden = "menubar"; 
					if (chromeProperties[1]=="0") win.hidden = win.hidden = ",toolbar"; 
					if (chromeProperties[2]=="0") win.hidden = win.hidden = ",locationbar";
					if (chromeProperties[3]=="0") win.hidden = win.hidden = ",personalbar";
					if (chromeProperties[4]=="0") win.hidden = win.hidden = ",statusbar"; 
					if (chromeProperties[5]=="0") win.hidden = win.hidden = ",scrollbars";
					if (hidden!="") win.hidden = hidden;
								
					var tabCount = parseInt(session[7]);
					totalTabCount = totalTabCount + tabCount;
					var sessionTabs = session[8].split(this.D[3]);;
				
					var tabs = win.tabs;
					for (var k=0; k < tabCount; k++) {
						var tabData = { entries: [], index: 0 };
						this.convertTab(sessionTabs[k], tabData);
						tabs.push(tabData);
					}
				
					jsWindows.push(win);
				}
				
				if (jsWindows.length) {
					var cookies = SessionData[i].cookies;
					if (cookies) {
						var jsCookies = { count:0 };
						for (j in cookies) {
							var cookie = cookies[j].match(/^([^ ]+) (.+)$/);
							if ((cookie && cookie[1] && cookie[2])) {
								jsCookies["domain" + ++jsCookies.count] = cookie[1];
								jsCookies["value" + jsCookies.count] = cookie[2];
							}
						}
						jsWindows[0].cookies = jsCookies;
					}
			
					this.sessions[i] = { windows: jsWindows, selectedWindow: 1 };
			
					var sessionListItem = { name: i, fileName: i, autosave: false, windows: jsWindows.length, tabs: totalTabCount, group: "[SessionSaver]" };
					this.sessionList.push(sessionListItem);
				}
				else {
					failedList = failedList + "\n" + i;
				}
			}
			catch(ex) { 
				failedList = failedList + "\n" + i + " - " + ex;	
			}
		}
		
		if (failedList != "\n") {
			Services.prompt.alert(null,Utils._string("sessionManager"), Utils._string("ss_failed")+failedList);
		}
		
		if (!this.sessionList.length) {
			Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("ss_none"));
			return;
		}
		
		var sessions = Utils.selectSession(Utils._string("ss_select"), Utils._string("ss_convert"), 
													 { multiSelect: true, selectAll: this.selectAll }, gSessionSaverConverter.getSessions);
		if (sessions) {
			sessions = sessions.split("\n");
			sessions.forEach(function (aSession) {
				var session = this.sessionList.filter(function(element,index,array) { return (element.name == aSession); });
				if (session.length) {
					var date = new Date();
					var aName = Utils.getFormattedName("[ SessionSaver ] " + aSession, date);
					var file = SessionIo.getSessionDir(Utils.makeFileName(aName), true);
					var state = "[SessionManager v2]\nname=" + aName + "\ntimestamp=" + Date.now() + "\nautosave=false\tcount=" + 
								 session[0].windows + "/" + session[0].tabs + "\tgroup=[SessionSaver]\n" + 
								 Utils.decryptEncryptByPreference(Utils.JSON_encode(this.sessions[aSession]));
					SessionIo.writeFile(file, state, function(aResults) {
						// Update tab tree if it's open
						if (Components.isSuccessCode(aResults))
							Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
					});
				}
			}, this);
		
			Services.prompt.alert(null,Utils._string("sessionManager"),
					((sessions.length>1)?Utils._string("ss_converted_many"):Utils._string("ss_converted_one"))+":\n\n. . ."+sessions.join("\n. . ."));
		}
		delete(this.sessionList);
		delete(this.sessions);
	},
	
	knownProps: {x:0,p:0,q:0,f:0,a:0,i:0,s:0,z:0},
	contentTypeRe:   /^(Content-Type: )([^\r\n]+)((\r\n){1,2}|\r|\n)/m,  
	contentLengthRe: /^(Content-Length: )([^\r\n]+)((\r\n){1,2}|\r|\n)/m,
	
	convertTab: function(sessionTab, tabData) {
		// tab-properties
		var tabSession  = sessionTab.split(this.D[2]); // XXX (below) for tabs with nothing captured (eg. link->newtab failed) there's nothing to iterate, so we need to check 'tabSession[propPoint-1]' as a condition
		for (var propPoint=tabSession.length, propName;  tabSession[propPoint-1] && (propName=tabSession[propPoint-1].charAt(0));  propPoint--) if (propName=='z') break; else if (!propName in this.knownProps) tabSession.splice(propPoint++,1); // forwards-compatible, always
		var postData    = (tabSession[0].charAt(0) == "p") ? tabSession.shift().slice(1) : null; // post-data,        if any (nightly 26)
		var postDataII  = (tabSession[0].charAt(0) == "q") ? tabSession.shift().slice(1) : null; // post-data.ii,     if any (nightly 29)
		if (postDataII) postData = postDataII;
		var frameData   = (tabSession[0].charAt(0) == "f") ? tabSession.shift().slice(1) : null; // frame-data,     if any (nightly 27)
		var selectData  = (tabSession[0].charAt(0) == "s") ? tabSession.shift().slice(1) : null; // select-data,    if any (nightly 28)
		var inputData   = (tabSession[0].charAt(0) == "i") ? tabSession.shift().slice(1) : null; // input-data,     if any (nightly 28)
		var areaData    = (tabSession[0].charAt(0) == "a") ? tabSession.shift().slice(1) : null; // textarea-data,  if any (nightly 28)
		var propData    = (tabSession[0].charAt(0) == "x") ? tabSession.shift().slice(1) : null; // extra tab/docshell props, if any (nightly 29.iii)
		if (tabSession[0].charAt(0) != "z") tabSession.splice(0, 0, "z1.0"); // add text-zoom if not stored (history-string will be in slot[1])
		tabData.zoom    = parseFloat( tabSession[0].substr(1, tabSession.shift().length-1) ); // text-zoom (nightly 13)
		var activeIndex = parseInt( tabSession.shift() );
		tabData.index   = activeIndex + 1;
		var tabHistory  = tabSession/*.slice(0)*/; // the entire rest of our "session-array" is tab history

		var frameText = [];		
		for (var i=0; i < tabHistory.length; i++) {
			var history = tabHistory[i].split(this.D[1]);
			var entry = { url: history[1], scroll:history[0] };
			
			// active index - Session Saver does not postdata and frames for session history
			if (i == activeIndex) {
				// frames
				if (frameData) {
					entry.children = [];
					var frameData = frameData.split(':');
					var textKeys ={'i':"input",'a':"textarea"};
					for (var f = 0; f < frameData.length; f++) {
						frameData[f]=frameData[f].split(",");
						var url = unescape(frameData[f][0]);
						var id = unescape(frameData[f][3]);
						var name = (frameData[f].length>4)?unescape(frameData[f][4]):id;
						var scroll = parseInt(frameData[f][1]) + "," + parseInt(frameData[f][2]);
						var text = (frameData[f].length>5 && frameData[f][5]!='')?unescape(frameData[f][5]).split(" "):null;
						var postDataFrame = (frameData[f].length>6 && frameData[f][6]!='')?unescape(frameData[f][6]):null;						
						if (text && text.length>0) { 
							var t, key, textObj={}; 
							while ((t=text.shift())) key=textKeys[t.charAt(0)], textObj[key] = t.slice(1); 
							text = (textObj.input?textObj.input:"") + ((textObj.input && textObj.textarea)?":":"") + (textObj.textarea?textObj.textarea:""); 
							if (text) frameText.push(text);
						}
						
						var child = { url: url, scroll: scroll };
						if (postData) child.postData = postDataFrame;
						entry.children.push(child);
					}
				}
					
				// postdata
				if (postData) {
					entry.postdata_b64 = btoa(postData);
				}
			}
			
			tabData.entries.push(entry);
		}
		
		var textData = "";
		if (areaData) areaData = areaData.split(":");
		if (inputData) {
			inputData = inputData.split(":");
			if (areaData) inputData = inputData.concat(areaData);
		}
		else inputData = areaData;
		if (inputData) {
			for (var i=0; i<inputData.length; i++) {
				var text = inputData[i].split(",,");
				if (text[0] && text[1]) textData = textData + ((textData)?" ":"") + text[1] + "=" + text[0];
			}
		}
		if (frameText) {
			// form text for frames is stored with parent but tagged with frame number
			for (var i=0; i<frameText.length; i++) {
				frameText[i] = frameText[i].split(":");
				for (var j=0; j<frameText[i].length; j++) {
					var text = frameText[i][j].split(",,");
					if (text[0] && text[1]) textData = textData + ((textData)?" ":"") + i + "|" + text[1] + "=" + text[0];
				}
			}			
		}
		if (textData) tabData.text = textData;
	},

	//
	// The following code comes from the SessionSaver 0.2d extension originally coded by rue and Pike
	// Modified by Morac to simplify and allow conversion to Session Manager format
	//
	
	/*
	 * The following functions allow importing of current Session Saver data in preferences
	 */
		
	importSession: function (window) {
		var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
		var stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		var streamIO = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
		var validFile = false;
			
		fp.init(window, "Select a File", fp.modeOpen);
		var ext = this.exportFileExt, mask = this.exportFileMask;
		fp.appendFilter("SessionSaver Session",mask);
		fp.defaultExtension = ext;
		
		if (fp.show() != fp.returnCancel) {
			stream.init(fp.file, 0x01, 292, null);
			streamIO.init(stream);
			var data = streamIO.read(stream.available());
			streamIO.close(); stream.close();
			this.findValidSession(data, true);
		}
	},
	
	findValidSession: function(data, shouldConvert) {
		// convert and \r \r\n to \n so that we can handle new lines.  Note postdata will also be converted so 
		// we need to take that into account
		data = data.replace(/\r\n?/g, "\n");
		var resArrayAll = data.split("\n"), res, resultHash = {}, extraLines = "", lastHash;
		while ((res=resArrayAll.shift()) != null ) {
			var lineParse = res.match(/^([s|c|i|a|b] .+)   (.+)/m);
			if (lineParse) {
				resultHash[lineParse[1]] = lineParse[2];
				if (lastHash && extraLines) resultHash[lastHash] = resultHash[lastHash] + extraLines;
				extraLines = ""; 
				lastHash = lineParse[1];
			}
			else extraLines = extraLines + Utils.EOL + res;
		}
		var client={};
		var d =new Date(), curDate =(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var m;
		var s2Prefix=this.prefBranch+this.prefBranchStatic+"Main-Session_From_Archive_("+curDate+")."; // -> Main-Session From Archive (10.25.05)
		for (var n in resultHash) {
			var keyPair = n.match(/^([^ ]) ([^ ]+)/); if (!keyPair) {continue;} else var key=keyPair[1], name=keyPair[2];
			switch(key) {
				case "s": 
					if (name.indexOf(this.prefBranch + this.prefBranchWindows) == 0) {
						name = name.substring(this.prefBranch.length + this.prefBranchWindows.length);
					}
					client[s2Prefix+name] = resultHash[n]; 
					break;
				case "c": 
					client[name] = resultHash[n]; 
					break;   
			}
		}
		var zorderRe = /^(.*)\.zorder$/i, zei, zHash={asArray:[],asName:{}}; // [******. hehe -rue]
		for (m in client) {  
			if (zei=m.match(zorderRe)) { 
				var name=zei[1], mName = name.replace(this.prefBranch+this.prefBranchStatic,""); 
				var mName=mName.replace(/_/g," "); 
				zHash.asArray.push(mName),zHash.asName[name]=mName; 
			}   
		} 

		if (shouldConvert) {
			var sessionCnt = zHash.asArray.length;
			if (sessionCnt==0) return Services.prompt.alert(Utils._string("ss_none")); 
			this.convertSession(client,zHash);
		}
		
		return zHash;
	},

	/*
	 * The following functions allow exporting of current Session Saver data in preferences
	 */
	createSessionData: function() { // returns a single string, of the relevant prefs
		var d=new Date(),  curMonth=d.getMonth()+1,  curDate=(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var currName = this.prefBranch+this.prefBranchStatic+"default_("+curDate+")";
		var prefArrayAll = [];
		var prefConverter = { keyed:{}, hashed:{a:Ci.nsIPrefBranch.PREF_INT, b:Ci.nsIPrefBranch.PREF_BOOL, c:Ci.nsIPrefBranch.PREF_STRING}, retrieve:{a:"getIntPref",b:"getBoolPref",c:"getCharPref"} };
		var h = prefConverter.hashed; 
		for (var n in h) prefConverter.keyed[h[n]]=n; 
		var prefsToPush = ["sessionsaver.static.","sessionsaver.windows."];
		var push; 
		while ((push=prefsToPush.shift())) {
			var prefName, childArray = this.rootBranch.getChildList(push, {}); // array of pref-names, off this particular branch
			while ((prefName=childArray.shift())) {
				if (prefName.match(/^sessionsaver\.static\.sync_backup\./i)) {continue;}
				var key = prefConverter.keyed[ this.rootBranch.getPrefType(prefName) ];
				var getPrefAsType = prefConverter.retrieve[key];
				prefArrayAll.push((prefName.match(/^sessionsaver\.static/i)?key:"s")+" "+prefName+"   "+this.rootBranch[getPrefAsType](prefName)); }
		}
		return prefArrayAll.join("\n");
	},
		
	exportSession: function(window) {
		var d=new Date(),  curMonth=d.getMonth()+1,  curDate=(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var data = this.createSessionData();
		if (!data) {
			alert("There wasn't any Session Saver session-data to export!");
			return false;
		}
		var zHash = this.findValidSession(data,false);
		// make sure all newlines are set to OS default.
		data = data.replace(/\r\n?/g, "\n");
		data = data.replace(/\n/g, Utils.EOL);
		var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
		var filestream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		var buffered   = Cc["@mozilla.org/network/buffered-output-stream;1"].createInstance(Ci.nsIBufferedOutputStream);
		var binstream  = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream); 
		
		fp.init(window, "Select a File", fp.modeSave);
		var ext = this.exportFileExt, mask = this.exportFileMask;
		fp.appendFilter("SessionSaver Session",mask);
		fp.defaultExtension = ext;
		var sessionCnt  = zHash.asArray.length;
		var wordSpacer  = (curMonth >  9 && sessionCnt >  9) ? "":" ";
		var prefsTxt    = (curMonth < 10 && sessionCnt < 10) ? "+prefs":"+pref";
		if (sessionCnt > 1)
			var mainTxt = "("+sessionCnt+" sessions"+wordSpacer+prefsTxt+")"+" "+curDate; // "exports":"export" -> "sessions":"session"
		else
			mainTxt = zHash.asArray[0].slice(0,27); //31); //12)
		fp.defaultString  = mainTxt+"."+ext;
	
		if (fp.show() != fp.returnCancel) {
			if (fp.file.exists()) fp.file.remove(true);
			if (fp.file.exists()) {
				alert("The Export failed: try using a unique, or new, filename.");
				return false;
			}
			fp.file.create(fp.file.NORMAL_FILE_TYPE, 438);
	
			filestream.init(fp.file, 0x02 | 0x08, 420, 0);
			buffered.init(filestream, 64 * 1024);
			binstream.setOutputStream(buffered);
			binstream.writeBytes(data,data.length);
			binstream.close(), buffered.close();
			filestream.close(); 
		}
		return true;
	}
}

/********************************************************************************************************************
 *  Routines to convert from Tab Mix Plus session format to Session Manager format.
 *  Original code by Morac except where indicated otherwise
 ********************************************************************************************************************/

var gConvertTMPSession = {
	
	sessionList: null,
	
	// Only preselect all for initial conversion
	selectAll: true,

	init: function(aSetupOnly) {
		this.RDFService = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
		this.RDFResource = Ci.nsIRDFResource;
		
		var chromeWin = Services.wm.getMostRecentWindow("navigator:browser");
		if (!chromeWin) {
			Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("no_browser_windows"));
			return;
		}

		// if encryption, force master password and exit if not entered
		try {
			if (PreferenceManager.get("encrypt_sessions"))
				secret_decoder_ring_service.encryptString("");
		}
		catch(ex) {
			Utils.cryptError(Utils._string("encrypt_fail2"));
			this.RDFService = null;
			this.RDFResource = null;
			return;
		}
		
		if (!SharedData.tabMixPlusEnabled) {
			Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("tmp_no_install"));
			return;
		}
		else {
			this.SessionManager = chromeWin.TabmixSessionManager;
			this.convertSession = chromeWin.TabmixConvertSession;
			this.gSessionPath = chromeWin.TabmixSessionManager.gSessionPath
			if (!aSetupOnly && !this.convertFile()) {
				if (!this.confirm(Utils._string("tmp_no_default"))) {
					this.pickFile(chromeWin);
				}
			}
		}

		if (!aSetupOnly) {
			this.RDFService = null;
			this.RDFResource = null;
		}
	},
	
	cleanup: function() {
		this.RDFService = null;
		this.RDFResource = null;
	},
		
	//
	// The following code comes from the Tab Mix Plus extension originally coded by onemen
	// Modified by Morac to allow user to choose which sessions to convert
	// 
	// Note: These functions call Tab Mix Plus functions and as such are dependent on TMP
	//
	
	// Not currently used
	pickFile: function(window) {
		var file = null;
		const nsIFilePicker = Ci.nsIFilePicker;
		var fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
		fp.init(window, "Select session.rdf file to convert", nsIFilePicker.modeOpen);
		fp.defaultString="session.rdf";
		fp.appendFilter("RDF Files", "*.rdf");
		fp.appendFilter("Session Files", "*session*.*");
		fp.appendFilters(nsIFilePicker.filterText | nsIFilePicker.filterAll);

		if (fp.show() != nsIFilePicker.returnOK)
			return;

		file = fp.fileURL.spec;
		try {
			if (!this.convertFile(file)) {
				Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("ss_none"));
			}
		} catch (ex) {
			report(ex);
		}
	},
	
	confirm: function (aMsg) {
		return Services.prompt.confirmEx(null,
									Utils._string("sessionManager"),
									aMsg,
									(Services.prompt.BUTTON_TITLE_YES * Services.prompt.BUTTON_POS_0)
									+ (Services.prompt.BUTTON_TITLE_NO * Services.prompt.BUTTON_POS_1),
									null, null, null, null, {});
	},
	
	convertFile: function (aFileUri, aInitialConvert) {
		var sessions;
		var tmpDATASource;
		if (aFileUri) {
			try {
				tmpDATASource = this.SessionManager.DATASource;
				this.SessionManager.DATASource = this.RDFService.GetDataSourceBlocking(aFileUri);
				sessions = this.SessionManager.getSessionList();
			} catch (e) { // corrupted session.rdf
				this.SessionManager.DATASource = tmpDATASource;
				report(e);
			}
		}
		else
			sessions = this.SessionManager.getSessionList();

		var msg;
		if (!sessions) {
			if (tmpDATASource) this.SessionManager.DATASource = tmpDATASource;
			return false;
		}
		var rv = 0;
		if (!aInitialConvert) {
			if(this.SessionManager.nodeHasArc("rdf:gSessionManager", "status")) {
				this.selectAll = false;
				rv = this.confirm(Utils._string("ss_convert_again"));
			}
			else {
				this.SessionManager.setLiteral("rdf:gSessionManager", "status", "converted");
				this.SessionManager.saveStateDelayed();
			}
		}
		if (rv == 0) {
			try {
				this.doConvert(sessions);
			}
			catch(ex) { report(ex) };
		}

		if (tmpDATASource) this.SessionManager.DATASource = tmpDATASource;
			
		return true;
	},
	
	getSessions: function() {
		return gConvertTMPSession.sessionList;
	},

	doConvert: function (sessions) {
		var sessionsPath = sessions.path.push(this.gSessionPath[3]);
		var sessionsName = sessions.list.push("Crashed Session");
		var _count = 0;
		
		this.sessionList = [];
		var matchArray;
		for (var i in sessions.list) {
			var nameExt = this.SessionManager.getLiteralValue(sessions.path[i], "nameExt");
			if (nameExt) {
				var winCount="", tabCount="";
				// get window and tab counts
				if (matchArray = /(((\d+) W, )?(\d+) T)/m.exec(nameExt)) {
					winCount = matchArray[3] ? matchArray[3] : "1";
					tabCount = matchArray[4] ? matchArray[4] : "";
				}
		
				var sessionListItem = { name: unescape(sessions.list[i]), fileName: sessions.list[i], autosave: false, windows: winCount, tabs: tabCount, group: "[Tabmix]" };
				this.sessionList.push(sessionListItem);
			}
		}
		var sessionsToConvert = Utils.selectSession(Utils._string("ss_select"), 
																Utils._string("ss_convert"), 
																{ multiSelect: true, selectAll: this.selectAll }, 
																gConvertTMPSession.getSessions
															 );   
		delete this.sessionList;
		if (!sessionsToConvert) return;
		sessionsToConvert = sessionsToConvert.split("\n");
		var convert = [sessions.list.length];
		for (var i = 0; i < sessions.list.length; i++ ) {
			convert[i] =  (sessionsToConvert.indexOf(sessions.list[i]) != -1)
		}

		var matchArray;
		for (var i = 0; i < sessions.path.length; i++ ) {
			if (!convert[i]) continue;
			var sessionState = this.convertSession.getSessionState(sessions.path[i]);

			// get timestamp from nameExt property
			var dateString = "", fileDate, winCount="0", tabCount="0";
			var nameExt = this.SessionManager.getLiteralValue(sessions.path[i], "nameExt");
			if (nameExt) {
				var date = nameExt.substr(nameExt.length - 20, 10);
				var time = nameExt.substr(nameExt.length - 9, 8);
				fileDate = " (" + date.split("/").join("-") + ")";
				dateString = " (" + date.split("/").join("-") + " " + time.substr(0, time.length - 3) + ")";
				var _time = time.split(":");
				var timestamp = new Date(date).valueOf() + 3600*_time[0] + 60*_time[1] + 1*_time[2];
				
				// get window and tab counts
				if (matchArray = /(((\d+) W, )?(\d+) T)/m.exec(nameExt)) {
					winCount = matchArray[3] ? matchArray[3] : "1";
					tabCount = matchArray[4] ? matchArray[4] : "";
				}
			}
			var sessionName = unescape(sessions.list[i]);
			var name = sessionName + dateString;
			var fileName = Utils.makeFileName("Tabmix - " + sessionName + fileDate);

			_count += this.save(sessionState, timestamp, name, fileName, winCount, tabCount);
		}

		var msg;
		if (_count == 0) {
			Services.prompt.alert(null, Utils._string("sessionManager"), Utils._string("tmp_unable"));
			return;
		}
		var msg = (_count > 1)?(_count + " " + Utils._string("tmp_many")):Utils._string("tmp_one");
		Services.prompt.alert(null, Utils._string("sessionManager"), msg);
	},
	
	save: function (aSession, aTimestamp, aName, aFileName, winCount, tabCount) {
		if (aSession.windows.length == 0)
			return false;

		if (!aSession.session)
			aSession.session = { state:"stop" };
		var oState = "[SessionManager v2]\nname=" + aName + "\ntimestamp=" + aTimestamp + "\nautosave=false\tcount=" +
					 winCount + "/" + tabCount + "\tgroup=[Tabmix]\n" + 
					 Utils.decryptEncryptByPreference(Utils.JSON_encode(aSession));
		var file = SessionIo.getSessionDir(Utils.makeFileName(aName));
		try {
			var file = SessionIo.getSessionDir(aFileName, true);
			SessionIo.writeFile(file, oState, function(aResults) {
				// Update tab tree if it's open
				if (Components.isSuccessCode(aResults))
					Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
			});
		}
		catch (ex) {
			report(ex);
			return false;
		}
		return true;
	}
}

var oldFormatConverter = {
	convertedFiles : [],    // files already converted
	
/* ........ Conversion functions .............. */

	convertEntryToLatestSessionFormat: function(aEntry)
	{
		// Convert Postdata
		if (aEntry.postdata) {
			aEntry.postdata_b64 = btoa(aEntry.postdata);
		}
		delete aEntry.postdata;
	
		// Convert owner
		if (aEntry.ownerURI) {
			let uriObj = Services.io.newURI(aEntry.ownerURI, null, null);
			let owner = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager).getCodebasePrincipal(uriObj);
			try {
				let binaryStream = Cc["@mozilla.org/binaryoutputstream;1"].
								   createInstance(Ci.nsIObjectOutputStream);
				let pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
				pipe.init(false, false, 0, 0xffffffff, null);
				binaryStream.setOutputStream(pipe.outputStream);
				binaryStream.writeCompoundObject(owner, Ci.nsISupports, true);
				binaryStream.close();

				// Now we want to read the data from the pipe's input end and encode it.
				let scriptableStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
				scriptableStream.setInputStream(pipe.inputStream);
				let ownerBytes = scriptableStream.readByteArray(scriptableStream.available());
				// We can stop doing base64 encoding once our serialization into JSON
				// is guaranteed to handle all chars in strings, including embedded
				// nulls.
				aEntry.owner_b64 = btoa(String.fromCharCode.apply(null, ownerBytes));
			}
			catch (ex) { logError(ex); }
		}
		delete aEntry.ownerURI;
	
		// convert children
		if (aEntry.children) {
			for (var i = 0; i < aEntry.children.length; i++) {
				//XXXzpao Wallpaper patch for bug 514751
				if (!aEntry.children[i].url)
					continue;
				aEntry.children[i] = this.convertEntryToLatestSessionFormat(aEntry.children[i]);
			}
		}
		
		return aEntry;
	},
	
	convertTabToLatestSessionFormat: function(aTab)
	{
		// Convert XULTAB to attributes
		if (aTab.xultab) {
			if (!aTab.attributes) aTab.attributes = {};
			// convert attributes from the legacy Firefox 2.0/3.0 format
			let matchArray;
			aTab.xultab.split(" ").forEach(function(aAttr) {
				if (matchArray = /^([^\s=]+)=(.*)/.exec(aAttr)) {
					aTab.attributes[matchArray[1]] = matchArray[2];
				}
			}, this);
		}
		delete aTab.xultab;

		// Convert text data
		if (aTab.text) {
			if (!aTab.formdata) aTab.formdata = {};
			let textArray = aTab.text ? aTab.text.split(" ") : [];
			let matchArray;
			textArray.forEach(function(aTextEntry) {
				if (matchArray = /^((?:\d+\|)*)(#?)([^\s=]+)=(.*)$/.exec(aTextEntry)) {
					let key = matchArray[2] ? "#" + matchArray[3] : "//*[@name='" + matchArray[3] + "']";
					aTab.formdata[key] = matchArray[4];
				}
			});
		}
		delete aTab.text;
		
		// Loop and convert entries
		aTab.entries.forEach(function(aEntry) {
			aEntry = this.convertEntryToLatestSessionFormat(aEntry);
		}, this);
		
		return aTab;
	},
	
	convertWindowToLatestSessionFormat: function(aWindow)
	{
		// Loop tabs
		aWindow.tabs.forEach(function(aTab) {
			aTab = this.convertTabToLatestSessionFormat(aTab);
		}, this);
		
		// Loop closed tabs
		if (aWindow._closedTabs) {
			aWindow._closedTabs.forEach(function(aTab) {
				aTab.state = this.convertTabToLatestSessionFormat(aTab.state);
			}, this);
		}
		return aWindow;
	},

	convertToLatestSessionFormat: function(aFile, aState)
	{
		log("Converting " + aFile.leafName + " to latest format", "TRACE");
		
		if (this.convertedFiles.indexOf(aFile.leafName) != -1)
			throw new Error("File already converted, not doing so again.  Likely contains string ',\"text\":' somewhere.");
			
		this.convertedFiles.push(aFile.leafName);
		
		let state = aState.split("\n");
		// decrypt if encrypted, do not decode if in old format since old format was not encoded
		state[4] = Utils.decrypt(state[4], true);
		
		// convert to object
		state[4] = Utils.JSON_decode(state[4], true);
		
		// Loop and convert windows
		state[4].windows.forEach(function(aWindow) {
			aWindow = this.convertWindowToLatestSessionFormat(aWindow);
		}, this);

		// Loop and convert closed windows
		if (state[4]._closedWindows) {
			state[4]._closedWindows.forEach(function(aWindow) {
				aWindow = this.convertWindowToLatestSessionFormat(aWindow);
			}, this);
		}
		
		// replace state
		state[4] = Utils.JSON_encode(state[4]);
		state[4] = Utils.decryptEncryptByPreference(state[4], true, true);
		state = state.join("\n");
		
		// Make a backup of old session in case something goes wrong
		try {
			if (aFile.exists()) 
			{
				let newFile = aFile.clone();
				SessionIo.moveToFolder(newFile, Utils._string("older_format_sessions_folder"));
			}
		}	
		catch (ex) { 
			logError(ex); 
		}
		
		// Save session
		SessionIo.writeFile(aFile, state, function(aResults) {
			// Update tab tree if it's open
			if (Components.isSuccessCode(aResults))
				Services.obs.notifyObservers(null, "sessionmanager:update-session-tree", null);
		});

		return state;
	},

	decodeOldFormat: function(aIniString, moveClosedTabs)
	{
		let rootObject = {};
		let obj = rootObject;
		let lines = aIniString.split("\n");
	
		for (let i = 0; i < lines.length; i++)
		{
			try
			{
				if (lines[i].charAt(0) == "[")
				{
					obj = this.ini_getObjForHeader(rootObject, lines[i]);
				}
				else if (lines[i] && lines[i].charAt(0) != ";")
				{
					this.ini_setValueForLine(obj, lines[i]);
				}
			}
			catch (ex)
			{
				throw new Error("Error at line " + (i + 1) + ": " + ex.description);
			}
		}
	
		// move the closed tabs to the right spot
		if (moveClosedTabs == true)
		{
			try
			{
				rootObject.windows.forEach(function(aValue, aIndex) {
					if (aValue.tabs && aValue.tabs[0]._closedTabs)
					{
						aValue["_closedTabs"] = aValue.tabs[0]._closedTabs;
						delete aValue.tabs[0]._closedTabs;
					}
				}, this);
			}
			catch (ex) {}
		}
	
		return rootObject;
	},

	ini_getObjForHeader: function(aObj, aLine)
	{
		let matchArray;
		let names = aLine.split("]")[0].substr(1).split(".");
	
		for (let i = 0; i < names.length; i++)
		{
			if (!names[i])
			{
				throw new Error("Invalid header: [" + names.join(".") + "]!");
			}
			if (matchArray = /(\d+)$/.exec(names[i]))
			{
				names[i] = names[i].slice(0, -matchArray[1].length);
				let ix = parseInt(matchArray[1]) - 1;
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || [];
				aObj = aObj[ix] = aObj[ix] || {};
			}
			else
			{
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || {};
			}
		}
	
		return aObj;
	},

	ini_setValueForLine: function(aObj, aLine)
	{
		let ix = aLine.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aLine + "!");
		}
	
		let value = aLine.substr(ix + 1);
		if (value == "true" || value == "false")
		{
			value = (value == "true");
		}
		else if (/^\d+$/.test(value))
		{
			value = parseInt(value);
		}
		else if (value.indexOf("%") > -1)
		{
			value = decodeURI(value.replace(/%3B/gi, ";"));
		}
		
		let name = this.ini_fixName(aLine.substr(0, ix));
		if (name == "xultab")
		{
			//this.ini_parseCloseTabList(aObj, value);
		}
		else
		{
			aObj[name] = value;
		}
	},

	// This results in some kind of closed tab data being restored, but it is incomplete
	// as all closed tabs show up as "undefined" and they don't restore.  If someone
	// can fix this feel free, but since it is basically only used once I'm not going to bother.
	ini_parseCloseTabList: function(aObj, aCloseTabData)
	{
		let matchArray;
		let ClosedTabObject = {};
		let ix = aCloseTabData.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aCloseTabData + "!");
		}
		let serializedTabs = aCloseTabData.substr(ix + 1);
		serializedTabs = decodeURI(serializedTabs.replace(/%3B/gi, ";"));
		let closedTabs = serializedTabs.split("\f\f").map(function(aData) {
			if (matchArray = /^(\d+) (.*)\n([\s\S]*)/.exec(aData))
			{
				return { name: matchArray[2], pos: parseInt(matchArray[1]), state: matchArray[3] };
			}
			return null;
		}).filter(function(aTab) { return aTab != null; }).slice(0, PreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true));

		closedTabs.forEach(function(aValue, aIndex) {
			closedTabs[aIndex] = this.decodeOldFormat(aValue.state, false)
			closedTabs[aIndex] = closedTabs[aIndex].windows;
			closedTabs[aIndex] = closedTabs[aIndex][0].tabs;
		}, this);

		aObj["_closedTabs"] = [];

		closedTabs.forEach(function(aValue, aIndex) {
			aObj["_closedTabs"][aIndex] = Utils.JSON_decode({ state : Utils.JSON_encode(aValue[0]) });
		}, this);
	},

	ini_fixName: function(aName)
	{
		switch (aName)
		{
			case "Window":
				return "windows";
			case "Tab":
				return "tabs";
			case "Entry":
				return "entries";
			case "Child":
				return "children";
			case "Cookies":
				return "cookies";
			case "uri":
				return "url";
			default:
				return aName;
		}			
	},
}