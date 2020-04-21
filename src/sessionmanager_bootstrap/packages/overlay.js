var {Cc, Ci, Cu} = require("chrome");

var overlay_loaded = false;
var windows_already_loaded = [];
var overlay = {};

var {loadBrowserWindow} = require("browserWindowOverlay");
var {loadOptionsSanitizeWindow} = require("preferenceSanitizeOverlay");

/**
 * Provesses overlay document data and initializes overlay property.
 */
function processOverlay(/**Element*/ root) {
	// Remove whitespace text nodes and comments
	let walker = root.ownerDocument.createTreeWalker(
		root, Ci.nsIDOMNodeFilter.SHOW_TEXT | Ci.nsIDOMNodeFilter.SHOW_COMMENT,
		{ acceptNode: function(node) { return Ci.nsIDOMNodeFilter.FILTER_ACCEPT; } }, false
	);
	let whitespaceNodes = [];
	while (walker.nextNode()) 
		whitespaceNodes.push(walker.currentNode);

	for (let i = 0; i < whitespaceNodes.length; i++)
		whitespaceNodes[i].parentNode.removeChild(whitespaceNodes[i]);

	// Put overlay elements into appropriate fields
	while (root.firstElementChild)
	{
		let child = root.firstElementChild;

		if (child.getAttribute("id"))
			overlay[child.getAttribute("id")] = child;
		root.removeChild(child);
	}
	
	overlay_loaded = true;
	
	// apply overlay to windows that already loaded
	while (windows_already_loaded.length) {
		let {window, caller} = windows_already_loaded.pop();
		caller(window);
	}
};

exports.loadOverlay = function() {
	let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIJSXMLHttpRequest);
	request.mozBackgroundRequest = true;
	request.open("GET", "chrome://sessionmanager/content/sessionmanager.xul");
	request.addEventListener("load", function(event)
	{
		if (disabled)
			return;
			
		processOverlay(request.responseXML.documentElement);
	}.bind(this), false);
	request.send(null);
};

exports.applyOptionsOverlay = function(window) {
	if (overlay_loaded) {
		loadOptionsSanitizeWindow(window, "OPTIONS", overlay["sessionmanager-sanitize-label"].getAttribute("label"),
		                          overlay["sessionmanager-sanitize-label"].getAttribute("accesskey"));
	}
	else {
		// Window loaded before we were ready so process it when finished loading overlay
		windows_already_loaded.push({window: window, caller: applyOptionsOverlay});
	}
};

exports.applySanitizeOverlay = function(window) {
	if (overlay_loaded) {
		loadOptionsSanitizeWindow(window, "SANITIZE", overlay["sessionmanager-sanitize-label"].getAttribute("label"),
		                          overlay["sessionmanager-sanitize-label"].getAttribute("accesskey"));
	}
	else {
		// Window loaded before we were ready so process it when finished loading overlay
		windows_already_loaded.push({window: window, caller: applySanitizeOverlay});
	}
};

exports.applyOverlay = function(window) {
	if (overlay_loaded) {
		loadBrowserWindow(window, overlay);
	}
	else {
		// Window loaded before we were ready so process it when finished loading overlay
		windows_already_loaded.push({window: window, caller: applyOverlay});
	}
};


