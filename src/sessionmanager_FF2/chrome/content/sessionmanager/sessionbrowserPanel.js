/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the nsSessionStore component.
 *
 * The Initial Developer of the Original Code is
 * Simon Bünzli <zeniko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 * Morac <morac99-firefox@yahoo.com> - Modified for use with Session Manager
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "resource://sessionmanager/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "EncryptionManager", "resource://sessionmanager/modules/encryption_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "resource://sessionmanager/modules/utils.jsm");

var gSessionManagerSessionBrowserPanel = {

	gPanel: null,
	gTabTree: null,
	gWinLabel: null,
	gSessionTree: null,
	gStateObject: null,
	gTreeData: null,
	gCurrentName: null,
	
	// Don't want user to select anything so if something is selected, clear it.
	onSessionTreeSelect: function() {
		this.gTabTree.view.selection.clearSelection();
	},
	
	restoreSelection: function() {
		// In Firefox "hidden" attribute for tab group items to "_hidden" for persisting.  We can't persist "hidden" 
		// since that's explicitly set to true for SeaMonkey. Do this here so we don't need to use a DOM Mutation event
		// which is not allowed.
		if (Application.name.toUpperCase() == "FIREFOX") {
			var tabgroup = document.getElementById("tabgroup_panel");
			var hidden = document.getElementById("hidden_panel");
			hidden.setAttribute("_hidden", hidden.getAttribute("hidden"));
			tabgroup.setAttribute("_hidden", tabgroup.getAttribute("hidden"));
		}
	
		// Restore previously selected row
		if (gSessionManagerSessionPrompt.gLastSelectedRow != null) {
			gSessionManagerSessionPrompt.gSessionTree.view.selection.select(gSessionManagerSessionPrompt.gLastSelectedRow);
		}
		else {
			gSessionManagerSessionPrompt.gSessionTree.view.selection.clearSelection();
		}
	},
	
	// Check to see if panel should even open
	checkForOpen: function(aTree, aEvent) {
		if ((aEvent.target.nodeName == "treechildren") && gSessionManagerSessionPrompt.gParams.autoSaveable && (aTree.currentIndex >= 0)) {
			var elem = gSessionManagerSessionPrompt.gTabTreeBox.hidden ? gSessionManagerSessionPrompt.gSessionTree : gSessionManagerSessionPrompt.gTabTreeBox;
			document.getElementById("sessionContentPanel").openPopup(elem, (gSessionManagerSessionPrompt.gTabTreeBox.hidden ? "after_start" : "overlap"), 3, 0, false, false);
		}
	},
	
	initTreeView: function() {
		// Initialize common values
		if (!this.gTabTree) {
			this.gPanel = document.getElementById("sessionContentPanel");
			this.gTabTree = document.getElementById("tabTreePanel");
			this.gWinLabel = this.gTabTree.getAttribute("_window_label");
		}

		var state = null
	
		this.treeView.initialize();
		
		var filename = gSessionManagerSessionPrompt.gSessionTreeData[gSessionManagerSessionPrompt.gSessionTree.currentIndex].fileName
		
		state = SessionIo.readSessionFile(SessionIo.getSessionDir(filename));
		if (!state)
		{
			Utils.ioError();
			return;
		}

		if (!Constants.SESSION_REGEXP.test(state))
		{
			Utils.sessionError();
			return;
		}
		state = state.split("\n")[4];

		// Decrypt first, then evaluate
		state = Utils.decrypt(state);
		if (!state) return;
		state = Utils.JSON_decode(state);
		if (!state || state._JSON_decode_failed) return;

		// Save new state
		this.gStateObject = state;
		
		// Tab groups only exist in Firefox
		if (Application.name.toUpperCase() == "FIREFOX") {
			var tabgroup = document.getElementById("tabgroup_panel");
			var hidden = document.getElementById("hidden_panel");
			var hidden_hidden = hidden.getAttribute("_hidden");
			var tabgroup_hidden = tabgroup.getAttribute("_hidden");
			tabgroup.hidden = (tabgroup_hidden == "true");
			hidden.hidden = (hidden_hidden == "true");
			tabgroup.removeAttribute("ignoreincolumnpicker");
			hidden.removeAttribute("ignoreincolumnpicker");
		}
		
		// Create or re-create the Tree
		this.createTree();
		
		var width = parseInt(window.getComputedStyle(gSessionManagerSessionPrompt.gTabTree, null).width);
		var height = parseInt(window.getComputedStyle(gSessionManagerSessionPrompt.gTabTree, null).height);
		width = (isNaN(width) || width < 200) ? window.innerWidth : width;
		height = (isNaN(height) || height < 200) ? 200 : height;
//			this.gPanel.sizeTo(window.innerWidth, (isNaN(sessionTreeHeight) ? 200 : sessionTreeHeight));
		this.gPanel.sizeTo(width, height);
	},

	createTree: function() {
	
		this.gStateObject.windows.forEach(function(aWinData, aIx) {
			var windowSessionName = null;
			// Try to find tab group nanes if they exists, 0 is the default group and has no name
			var tab_groups = { 0:"" };
			if (aWinData.extData && aWinData.extData["tabview-group"]) {
				var tabview_groups = Utils.JSON_decode(aWinData.extData["tabview-group"], true);
				if (tabview_groups && !tabview_groups._JSON_decode_failed) {
					for (var id in tabview_groups) {
						tab_groups[id] = tabview_groups[id].title;
					}
				}
			}
			var winState = {
				label: this.gWinLabel.replace("%S", (aIx + 1)),
				open: true,
				ix: aIx,
				tabGroups: tab_groups
			};
			winState.tabs = aWinData.tabs.map(function(aTabData) {
				var entry = aTabData.entries[aTabData.index - 1] || { url: "about:blank" };
				var iconURL = aTabData.attributes && aTabData.attributes.image || null;
				// if no iconURL, look in pre Firefox 3.1 storage location
				if (!iconURL && aTabData.xultab) {
					iconURL = /image=(\S*)(\s)?/i.exec(aTabData.xultab);
					if (iconURL) iconURL = iconURL[1];
				}
				// Try to find tab group ID if it exists, 0 is default group
				var groupID = 0;
				if (aTabData.extData && aTabData.extData["tabview-tab"]) {
					var tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
					if (tabview_data && !tabview_data._JSON_decode_failed) 
						groupID = tabview_data.groupID;
				}
				// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
				// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
				// use the work around for https.
				if (/^https:/.test(iconURL))
					iconURL = "moz-anno:favicon:" + iconURL;
				return {
					label: entry.title || entry.url,
					url: entry.url,
					src: iconURL,
					hidden: aTabData.hidden,
					group: groupID,
					groupName: winState.tabGroups[groupID] || (groupID ? groupID : ""),
					parent: winState
				};
			});
			this.gTreeData.push(winState);
			for each (var tab in winState.tabs)
				this.gTreeData.push(tab);
		}, this);
		
		// Set tree display view if not already set, otherwise just update tree
		if (!this.treeView.treeBox) this.gTabTree.view = this.treeView;
		else {
			this.gTabTree.treeBoxObject.rowCountChanged(0, this.treeView.rowCount);
		}
		//preselect first row
		//this.gTabTree.view.selection.select(0);
	},

	// Tree controller

	treeView: {
		_atoms: {},
		_getAtom: function(aName)
		{
			if (!this._atoms[aName]) {
				var as = Cc["@mozilla.org/atom-service;1"].getService(Ci.nsIAtomService);
				this._atoms[aName] = as.getAtom(aName);
			}
			return this._atoms[aName];
		},

		treeBox: null,
		selection: null,

		get rowCount()                     { return gSessionManagerSessionBrowserPanel.gTreeData.length; },
		setTree: function(treeBox)         { this.treeBox = treeBox; },
		getCellText: function(idx, column) { 
			if (column.id == "locationPanel") 
				return gSessionManagerSessionBrowserPanel.gTreeData[idx].url ? gSessionManagerSessionBrowserPanel.gTreeData[idx].url : "";
			
			else if (column.id == "hidden_panel") 
				return gSessionManagerSessionBrowserPanel.gTreeData[idx].hidden ? "     *" : "";
			else if (column.id == "tabgroup_panel") 
				return gSessionManagerSessionBrowserPanel.gTreeData[idx].groupName || "";
			else return gSessionManagerSessionBrowserPanel.gTreeData[idx].label; 
		},
		isContainer: function(idx)         { return "open" in gSessionManagerSessionBrowserPanel.gTreeData[idx]; },
		getCellValue: function(idx, column){},
		isContainerOpen: function(idx)     { return gSessionManagerSessionBrowserPanel.gTreeData[idx].open; },
		isContainerEmpty: function(idx)    { return false; },
		isSeparator: function(idx)         { return false; },
		isSorted: function()               { return false; },
		isEditable: function(idx, column)  { return false; },
		getLevel: function(idx)            { return this.isContainer(idx) ? 0 : 1; },

		getParentIndex: function(idx) {
			if (!this.isContainer(idx))
				for (var t = idx - 1; t >= 0 ; t--)
					if (this.isContainer(t))
						return t;
			return -1;
		},

		hasNextSibling: function(idx, after) {
			var thisLevel = this.getLevel(idx);
			for (var t = after + 1; t < gSessionManagerSessionBrowserPanel.gTreeData.length; t++)
				if (this.getLevel(t) <= thisLevel)
					return this.getLevel(t) == thisLevel;
			return false;
		},

		toggleOpenState: function(idx) {
			if (!this.isContainer(idx))
				return;
			var item = gSessionManagerSessionBrowserPanel.gTreeData[idx];
			if (item.open) {
				// remove this window's tab rows from the view
				var thisLevel = this.getLevel(idx);
				for (var t = idx + 1; t < gSessionManagerSessionBrowserPanel.gTreeData.length && this.getLevel(t) > thisLevel; t++);
				var deletecount = t - idx - 1;
				gSessionManagerSessionBrowserPanel.gTreeData.splice(idx + 1, deletecount);
				this.treeBox.rowCountChanged(idx + 1, -deletecount);
			}
			else {
				// add this window's tab rows to the view
				var toinsert = gSessionManagerSessionBrowserPanel.gTreeData[idx].tabs;
				for (var i = 0; i < toinsert.length; i++)
					gSessionManagerSessionBrowserPanel.gTreeData.splice(idx + i + 1, 0, toinsert[i]);
				this.treeBox.rowCountChanged(idx + 1, toinsert.length);
			}
			item.open = !item.open;
			this.treeBox.invalidateRow(idx);
		},

		getCellProperties: function(idx, column, prop) {
			if (column.id == "titlePanel") 
				prop.AppendElement(this._getAtom(this.getImageSrc(idx, column) ? "icon" : "noicon"));
			if (this.getCellText(idx, this.treeBox.columns.getColumnFor(document.getElementById("hidden_panel"))))
				prop.AppendElement(this._getAtom("disabled"));
		},

		getRowProperties: function(idx, prop) {},

		getImageSrc: function(idx, column) {
			if (column.id == "titlePanel")
				return gSessionManagerSessionBrowserPanel.gTreeData[idx].src || null;
			return null;
		},

		initialize: function() {
			var count;
			if (gSessionManagerSessionBrowserPanel.gTreeData) count = this.rowCount;
			delete gSessionManagerSessionBrowserPanel.gTreeData;
			gSessionManagerSessionBrowserPanel.gTreeData = [];
			if (this.treeBox && count)
				this.treeBox.rowCountChanged(0, -count);
		},

		getProgressMode : function(idx, column) { },
		cycleHeader: function(column) { },
		cycleCell: function(idx, column) { },
		selectionChanged: function() { },
		performAction: function(action) { },
		performActionOnCell: function(action, index, column) { },
		getColumnProperties: function(column, prop) { }
	}
}
