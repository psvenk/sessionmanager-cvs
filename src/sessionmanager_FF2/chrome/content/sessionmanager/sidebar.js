"use strict";

// Create a namespace so as not to polute the global namespace
(function() {
let obj = {};

// import the session_manager.jsm into the namespace
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(obj, "SharedData", "resource://sessionmanager/modules/shared_data/data.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");

// use the namespace
obj.gSessionManagerSidebarObject = {

onLoad: function() {
	this.removeEventListener("load", onLoad, false);
	this.addEventListener("unload", onUnload, false);
	
	// for updating session list
	document.getElementById('session_tree').view = treeView;	
		
	// update list on notification
	//Services.obs.addObserver(this, "sessionmanager-list-update", false);
},	

onUnload: function() {
	this.removeEventListener("unload", onUnload, false);
	//Services.obs.removeObserver(this, "sessionmanager-list-update");
},

treeView: {
	defaultChildData: {
		backupFolder: { container: true, open: false, childCount: 0 },
		backupSeparator: { separator: true, row: 1 }
	},
	childData: null,
	visibleData: null,
	
	treeBox: null,
	selection: null,

	get rowCount()                     { return this.visibleData.length; },
	setTree: function(treeBox)         { this.treeBox = treeBox; },
	getCellText: function(idx, column) { return this.visibleData[idx]; },
	isContainer: function(idx)         { return this.childData[this.visibleData[idx]].container; },
	isContainerOpen: function(idx)     { return this.childData[this.visibleData[idx]].open; },
	isContainerEmpty: function(idx)    { return this.childData[this.visibleData[idx]].childCount; },
	isSeparator: function(idx)         { return this.childData[this.visibleData[idx]].separator; },
	isSorted: function()               { return false; },
	isEditable: function(idx, column)  { return false; },

	getImageSrc: function(idx, column) {},
	getProgressMode : function(idx,column) {},
	getCellValue: function(idx, column) {},
	cycleHeader: function(col, elem) {},
	selectionChanged: function() {},
	cycleCell: function(idx, column) {},
	performAction: function(action) {},
	performActionOnCell: function(action, index, column) {},
	getRowProperties: function(idx, column, prop) {},
	getCellProperties: function(idx, column, prop) {},
	getColumnProperties: function(column, element, prop) {},
	
	getParentIndex: function(idx) {
		if (this.isContainer(idx)) return -1;
		for (var t = idx - 1; t >= 0 ; t--) {
			if (this.isContainer(t)) return t;
		}
	},
	
	getLevel: function(idx) {
		if (this.isContainer(idx)) return 0;
		return 1;
	},
	
	hasNextSibling: function(idx, after) {
		var thisLevel = this.getLevel(idx);
		for (var t = idx + 1; t < this.visibleData.length; t++) {
			var nextLevel = this.getLevel(t)
			if (nextLevel == thisLevel) return true;
			else if (nextLevel < thisLevel) return false;
		}
	},

	updateList: function() {
		if (!this.allowUpdate) return;
		this.allowUpdate = false;
		var sessions = obj.SessionIo.getSessions();

		// clear out existing items from tree
		var children = document.getElementById("sessions");
		var backups = document.getElementById("backup_sessions");

		while (backups.childNodes.length) backups.removeChild(backups.childNodes[0]);
		while (children.childNodes.length > 2) children.removeChild(children.childNodes[2]);

		// Reset tree view data to default, keep backup container open status.
		if (treeView.childData) treeView.defaultChildData.backupFolder.open = treeView.childData.backupFolder.open;
		delete(treeView.childData);
		delete(treeView.visibleData);
		treeView.childData = treeView.defaultChildData;
		treeView.visibleData = [];
				
		// Build the tree items from session list
		sessions.forEach(function(aSession, aIx) {
			var treeitem = document.createElement("treeitem");
			var treerow = document.createElement("treerow");
			var name = document.createElement("treecell");
			var windowCount = document.createElement("treecell");
			var tabCount = document.createElement("treecell");
			
			// Properties are used for CSS dispaly stuff
			var property = "";
			if (aSession.autosave) {
				property = property + aSession.autosave + " ";
			}
			if ((sessions.latestBackUpTime == aSession.timestamp) || (sessions.latestTime == aSession.timestamp)) {
				property = property + "latest ";
			}
			if ((aSession.fileName == obj.SharedData._autosave_filename) || (obj.SharedData.mActiveWindowSessions[aSession.fileName])) {
				property = property + "disabled";
			}
			if (property) name.setAttribute("properties", property);
			
			name.setAttribute("label", aSession.name);
			windowCount.setAttribute("label", aSession.windows);
			tabCount.setAttribute("label", aSession.tabs);
			
			treerow.appendChild(name);
			treerow.appendChild(windowCount);
			treerow.appendChild(tabCount);
			
			treeitem.appendChild(treerow);
			
			if (aSession.backup) backups.appendChild(treeitem);
			else children.appendChild(treeitem);
			
			// Add session filename to TreeView data for easy lookup
			treeView.childData[aSession.name] = { filename: aSession.fileName, backup: aSession.backup  };
			if (aSession.backup) {
				treeView.childData.backupFolder.childCount++;
				// if backup Folder not in display list, add it and the separator
				if (!treeView.visibleData.backupFolder) {
					treeView.visibleData.unshift("backupSeparator");
					treeView.visibleData.unshift("backupFolder");
				}
				if (treeView.childData.backupFolder.open) {
					treeView.visibleData.splice(treeView.childData.backupSeparator.row++, 0, aSession.name);
				}
			}
			else {
				treeView.visibleData.push(aSession.name);
			}
		});
		
		document.getElementById("backup_container").hidden = (backups.childNodes.length == 0);
		document.getElementById("backup_separator").hidden = (backups.childNodes.length == 0);
		
		this.allowUpdate = true;
	},
	
	handleEvent: function(aEvent) {
		// ignore non-enter key presses and right clicks
		if (((aEvent.type == "keypress") && (aEvent.keyCode != KeyEvent.DOM_VK_RETURN)) ||
				((aEvent.type == "click") && (aEvent.button == 2))) {
			return;
		}
		
		var index = document.getElementById("session_tree").currentIndex;
		var filename = treeView.getCellText(index);
		dump("index = " + index + ", filename = " + filename + "\n");
		
		//this.obj.SessionIo.load(filename, (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey || event.metaKey)?"append":"");
	}
}
}
// Define a window.obj object
/*
if(!window.com) window.com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={
	gSessionManagerSidebarObject: obj.gSessionManagerSidebarObject
}
*/

window.addEventListener("load", obj.gSessionManagerSidebarObject.onLoad, false);
	
})()