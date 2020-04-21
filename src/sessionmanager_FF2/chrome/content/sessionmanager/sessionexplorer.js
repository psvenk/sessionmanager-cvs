"use strict";

// Create a namespace so as not to polute the global namespace
(function() {
let obj = {};

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "SessionIo", "resource://sessionmanager/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(obj, "Utils", "resource://sessionmanager/modules/utils.jsm");

// use the namespace
obj.gSessionManagerSessionExplorer = {

	dumpnl: function(msg) {
		dump(msg + "\n");
	},

	sessionTreeView: {
		treeBox: null,
		selection: null,
		rowCount: 0,

		sessions: null,
		sessionExpanded: [],
		childRow: {
			autosave: "",
			windows: "",
			tabs: "",
			timestamp: "",
			name: "Window names here"
		},
		atom_latest: null,
		atom_autosave: null,

		setData: function(data) {
			this.sessions = data;
			for (var i = 0; i < data.length; ++i) {
				this.sessionExpanded[i] = false;
			}
			this.rowCount = data.length;
			obj.gSessionManagerSessionExplorer.dumpnl("rowCount = " + data.length)
			var aserv=Components.classes["@mozilla.org/atom-service;1"]
				.getService(Components.interfaces.nsIAtomService);
			this.atom_latest = aserv.getAtom("latest");
			this.atom_autosave = aserv.getAtom("autosave");
			if (this.treebox)
				this.treebox.invalidate();
		},
		setTree: function(treeBox) {
			gSessionManagerSessionExplorer.dumpnl("setTree(" + treeBox + ")");
			this.treeBox = treeBox;
		},
		getRowWhere: function(predicate) {
			idx = 0;
			for (var i = 0; i < this.sessions.length; ++i) {
				var tmp = {idx: idx, index: i, isContainer: true, data: this.sessions[i]};
				if (predicate(tmp))
					return tmp;
				if (this.sessionExpanded[i]) {
					++idx;
					var tmp = {idx: idx, isContainer: false, data: this.childRow};
					if (predicate(tmp))
						return tmp;
				}
				++idx;
			}
			obj.gSessionManagerSessionExplorer.dumpnl("getRowWhere: NOT FOUND")
			return {};
		},
		getRow: function(idx) {
			for (var i = 0; i < this.sessions.length; ++i) {
				if (idx-- == 0)
					return {index: i, isContainer: true, data: this.sessions[i]};
				if (this.sessionExpanded[i] && idx-- == 0)
					return {isContainer: false, data: this.childRow};
			}
			obj.gSessionManagerSessionExplorer.dumpnl("getRow: NOT FOUND")
			return {};
		},
		getCellText: function(idx, column) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("getCellText(" + idx + ", " + column.index + ")");
			var row = this.getRow(idx);
			var session = row.data;
			switch (column.index) {
				case 0: return "";
				case 1: return session.windows;
				case 2: return session.tabs;
				case 3:
					if (row.isContainer)
						return obj.gSessionManagerSessionExplorer.yyyy_mm_dd_hh_mm(new Date(session.timestamp));
					return session.timestamp;
				case 4: return session.name;
			}
			return "?";
		},
		getCellProperties: function(idx, column, prop) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("getCellProperties(" + idx + ", " + column.index + ")");
			var session = this.getRow(idx).data;
			if (this.sessions.latestName == session.name)
				prop.AppendElement(this.atom_latest);
			if (column.index == 0 && session.autosave == "session")
				prop.AppendElement(this.atom_autosave);
		},
		isContainer: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isContainer(" + idx + ")");
			return this.getRow(idx).isContainer;
		},
		isContainerOpen: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isContainerOpen(" + idx + ")");
			return this.sessionExpanded[this.getRow(idx).index];
		},
		isContainerEmpty: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isContainerEmpty(" + idx + ")");
			return false;
		},
		isSeparator: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isSeparator(" + idx + ")");
			return false;
		},
		isSorted: function() {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isSorted()");
			return false;
		},
		isEditable: function(idx, column) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("isEditable(" + idx + ", ", column + ")");
			return false;
		},
		getParentIndex: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("getParentIndex(" + idx + ")");
			if (this.isContainer(idx)) return -1;
			return idx - 1;
		},
		getLevel: function(idx) {
	//		obj.gSessionManagerSessionExplorer.dumpnl("getLevel(" + idx + ")");
			if (this.isContainer(idx)) return 0;
			return 1;
		},
		hasNextSibling: function(idx, after) {
			var row = this.getRow(idx);
			if (!row.isContainer)
				return false;
			return row.index < this.sessions.length - 1;
		},
		toggleOpenState: function(idx) {
			var row = this.getRow(idx);
			if (!row.isContainer)
				return;
			var isOpen = this.sessionExpanded[row.index];
			if (this.sessionExpanded[row.index])
				--this.rowCount;
			else
				++this.rowCount;

			this.treeBox.rowCountChanged(idx + 1, isOpen?-1:1);
			this.sessionExpanded[row.index] = !isOpen;
		},

		getImageSrc: function(idx, column) {},
		getProgressMode : function(idx,column) {},
		getCellValue: function(idx, column) {},
		cycleHeader: function(col, elem) {},
		selectionChanged: function() {},
		cycleCell: function(idx, column) {},
		performAction: function(action) {},
		performActionOnCell: function(action, index, column) {},
		getColumnProperties: function(column, element, prop) {},
		getRowProperties: function(idx, prop) {}
	},


	zerofill: function(x, w) {
		return ("0000000000" + x).slice(-w);
	},

	yyyy_mm_dd_hh_mm: function(d) {
		return (
			this.zerofill(d.getFullYear(),4) + "-" +
			this.zerofill(d.getMonth(),2) + "-" +
			this.zerofill(d.getDate(),2) + " " +
			this.zerofill(d.getHours(),2) + ":" +
			this.zerofill(d.getMinutes(),2)
		);
	},

	getSelectedSession: function() {
		var tree = document.getElementById("sessiontree");
	//	var view = tree.view;
		var view = this.sessionTreeView;
		var row = view.getRow(tree.currentIndex);
		if (row.isContainer)
			return row.data;
		return view.getRow(tree.currentIndex-1).data;
	},

	//
	// Prompt handling
	//
	stdMode: function() {
		document.getElementById("stdMode").setAttribute("disabled", false);

		var ok_button = document.getElementById("ok_button");
		ok_button.removeEventListener("command", ok_button.my_listener, false);

		document.getElementById("key_input_mode_cancel")
			.setAttribute("disabled", "true");

		document.getElementById("sessiontree").focus();

		document.getElementById("prompt").setAttribute("hidden", "true");
	},

	onTextboxInput: function() {
		var sessions = this.sessionTreeView.sessions;
		var ok_button = document.getElementById("ok_button");
		var input = document.getElementById("text_box").value;
		for (var i = 0; i < sessions.length; ++i)
			if (sessions[i].name == input) {
				ok_button.setAttribute("disabled", "true");
				return;
			}
		ok_button.setAttribute("disabled", "false");
	},

	inputMode: function(label, ok_func, initial_value) {
		document.getElementById("stdMode").setAttribute("disabled", true);

		var ok_button = document.getElementById("ok_button");
		ok_button.setAttribute("label", label);
		ok_button.addEventListener("command", ok_func, false);
		ok_button.my_listener = ok_func;

		document.getElementById("key_input_mode_cancel")
			.setAttribute("disabled", "false");

		document.getElementById("prompt").setAttribute("hidden", "false");

		var text_box = document.getElementById("text_box");
		text_box.value = initial_value? initial_value : this.getSelectedSession().name;
		text_box.focus();
	},

	onCancel: function() {
		this.stdMode();
	},

	//
	// Cmd handlers
	//

	onCmdOpen: function(mode) {
		obj.SessionIo.load(window.opener, this.getSelectedSession().fileName, mode);
	},

	onCmdRenameOK: function() {
		var new_name = document.getElementById("text_box").value; 
		this.dumpnl(
			"rename '" + this.getSelectedSession().fileName + "' -> '" +
			new_name + "'"
		);
		obj.SessionIo.rename(this.getSelectedSession().fileName, new_name);
		// TODO: There needs to be a delay or callback here since rename returns before file is written to disk
		this.sessionTreeView.setData(obj.SessionIo.getSessions());

		// select the renamed row again
		var r = this.sessionTreeView.getRowWhere(
			function(row){return row.data.name==new_name}
		);
		this.sessionTreeView.selection.select(r.idx);

		this.stdMode();
	},

	onCmdRename: function(label) {
		this.inputMode(label, this.onCmdRenameOK);
	},

	onCmdDelete: function() {
		this.dumpnl("delete " + this.getSelectedSession().fileName);
		obj.SessionIo.remove(this.getSelectedSession().fileName);
		this.sessionTreeView.setData(obj.SessionIo.getSessions());
		document.getElementById("sessiontree").focus();
	},

	onCmdSaveOK: function() {
		alert("save as " + document.getElementById("text_box").value + " (not implemented yet)");
	},

	onCmdSave: function() {
		var name = obj.Utils.getFormattedName(
			window.opener.content.document.title || "about:blank",
			new Date()
		);
		this.inputMode("Save", this.onCmdSaveOK, name);
	},

	onCmdSaveWindowOK: function() {
		alert("save window as " + document.getElementById("text_box").value + " (not implemented yet)");
	},

	onCmdSaveWindow: function() {
		var name = obj.Utils.getFormattedName(
			window.opener.content.document.title || "about:blank",
			new Date()
		);
		this.inputMode("Save Window", this.onCmdSaveWindowOK, "Window: " + name);
	},

	onCmdOpenFolder: function() {
		gSessionManager.openFolder();
	},

	isColumnCropped: function(tree, col) {
		var treebox = tree.boxObject;
		treebox.QueryInterface(Components.interfaces.nsITreeBoxObject);

		//var treebox = col.nsITreeColumns.nsITreeBoxObject;
		//var tree = ??

		for (var i = 0; i < tree.view.rowCount; ++i) {
			if (treebox.isCellCropped(i, col))
				return true;
		}
		return false;
	},

	// There must be a better way!!!
	autoFitColumn: function(tree, col) {
		var treebox = tree.boxObject;
		treebox.QueryInterface(Components.interfaces.nsITreeBoxObject);

		// this works for me...
		col.element.setAttribute("width", 93);
		return;

		var min_width = 0;
		while (this.isColumnCropped(tree, col)) {
			min_width = col.width;
			col.element.setAttribute("width", 2 * col.width);
			// sigh, without this alert the width isn't updated...
			alert("");
		}
		var max_width = col.width;

		// find the optimal width by binary search
		var w;
		while (min_width < max_width) {
			w = Math.round((min_width + max_width) / 2);
			col.element.setAttribute("width", w);

			// sigh, without this alert the width isn't updated...
			alert("");

			if (this.isColumnCropped(tree, col))
				min_width = w + 1;
			else
				max_width = w - 1;
		}
		if (min_width != max_width) this.dumpnl(min_width + "!=" + max_width);

		col.element.setAttribute("width", min_width);
	},

	onLoad: function() {
		window.addEventListener("unload", obj.gSessionManagerSessionExplorer.onUnload, false);

		this.sessionTreeView.setData(obj.SessionIo.getSessions());
		document.getElementById("sessiontree").view = this.sessionTreeView;
		var tree = document.getElementById("sessiontree");

		this.autoFitColumn(tree, tree.columns.getColumnAt(3));
		
		tree.view.selection.select(0);
		tree.focus();
	},

	onUnload: function() {
		obj.gSessionManagerSessionExplorer.dumpnl("unloaded");
	}
}

// Define a window.com.morac.SessionManagerAddon object
if(!window.com) window.com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={
	gSessionManagerSessionExplorer: obj.gSessionManagerSessionExplorer
}

})()