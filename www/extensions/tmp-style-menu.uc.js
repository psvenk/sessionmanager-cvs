/* :::::::: TMP style context-menu for Session Manager (rev 0.4.1.0.0) ::::::::::::::: */

gSessionManager.onTMPStylePopupShow = function(aPopup) {
	var item = this.__get(aPopup, "start-separator").nextSibling;
	while (item.hasAttribute("oncommand"))
	{
		if (/\("([^"]+)/.test(item.getAttribute("oncommand")))
		{
			item.setAttribute("_session", RegExp.$1);
			if (RegExp.$1 == this.mPref_resume_session)
			{
				item.style.fontWeight = "bold";
			}
			item.setAttribute("contextmenu", "sessionmanager-TMPStyleContextMenu");
			item.addEventListener("click", function(aEvent) {
				if (aEvent.button == 2)
				{
					document.getElementById("sessionmanager-TMPStyleContextMenu")._opener = this;
				}
			}, false);
		}
		item = item.nextSibling;
	}
};
gSessionManager.onTMPStylePopupHide = function() {
	var popup = document.getElementById("sessionmanager-TMPStyleContextMenu");
	if (popup.boxObject.height > 0)
	{
		popup.hidePopup();
	}
};

gSessionManager.__load = function(aSession) {
	var oldOverwrite = this.mPref_overwrite;
	this.mPref_overwrite = true;
	this.load(aSession);
	this.mPref_overwrite = oldOverwrite;
};
gSessionManager.__loadAppend = function(aSession) {
	var state = this.readSessionFile(this.getSessionDir(aSession));
	var newWindow = /^\[Window2/m.test(state) || this.getBrowserWindows().length > 1;
	this.load(aSession, (newWindow)?"newwindow":"append");
};
gSessionManager.__replace = function(aSession) {
	this.save(this.mSessionCache[aSession].name, aSession);
};
gSessionManager.__replaceWindow = function(aSession) {
	this.saveWindow(this.mSessionCache[aSession].name, aSession);
};
gSessionManager.__rename = function(aSession) {
	var values = { name: aSession, text: this.mSessionCache[aSession].name };
	if (!this.prompt(this._string("rename_session"), this._string("rename_session_ok"), values, this._string("rename2_session")))
	{
		return;
	}
	var file = this.getSessionDir(values.name);
	var filename = this.makeFileName(values.text);
	var newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
	
	try
	{
		this.writeFile(newFile || file, this.nameState(this.readSessionFile(file), values.text));
		if (newFile)
		{
			if (this.mPref_resume_session == file.leafName)
			{
				this.setPref("resume_session", filename);
			}
			this.delFile(file);
		}
	}
	catch (ex)
	{
		this.ioError(ex);
	}
};
gSessionManager.__remove = function(aSession) {
	// comment the following line out for no delete confirmation prompt
	if (this.mPromptService.confirm(window, this.mTitle, "Do you really want to delete this session?"))
		this.remove(aSession);
};
gSessionManager.__startup = function(aSession) {
	this.setPref("resume_session", aSession);
};

gSessionManager.__get = function(aPopup, a_id) {
	return aPopup.getElementsByAttribute("_id", a_id)[0] || null;
};
gSessionManager.__closeAllMenus = function(aMenu) {
	try
	{
		aMenu.parentNode.hidePopup();
		aMenu.parentNode.parentNode.parentNode.hidePopup();
	}
	catch (ex) { }
};

gSessionManager.initTMPStylePopup = function(aToolbarOnly) {
	function prepare(aPopup)
	{
		aPopup.addEventListener("popupshowing", function() { gSessionManager.onTMPStylePopupShow(this); }, false);
		aPopup.addEventListener("popuphiding", function() { gSessionManager.onTMPStylePopupHide(); }, false);
		var separator = gSessionManager.__get(aPopup, "separator");
		separator.nextSibling.hidden = separator.nextSibling.nextSibling.hidden = true;
	}
	
	if (!aToolbarOnly)
	{
		prepare(document.getElementById("sessionmanager-menu").firstChild);
	}
	var menu = document.getElementById("sessionmanager-toolbar");
	if (menu)
	{
		prepare(menu.firstChild);
	}
};

(function() {
	gSessionManager.initTMPStylePopup();
	
	function createItem(aLabel, aCommand)
	{
		var item = document.createElement("menuitem");
		
		item.setAttribute("label", aLabel);
		item.setAttribute("_command", aCommand);
		
		return item;
	}
	
	var popup = document.createElement("popup");
	
	popup.setAttribute("id", "sessionmanager-TMPStyleContextMenu");
	popup.setAttribute("oncommand", "gSessionManager.__closeAllMenus(this._opener); event.stopPropagation(); gSessionManager['__' + event.originalTarget.getAttribute('_command')](this._opener.getAttribute('_session'));");
	popup.setAttribute("onpopuphiding", "setTimeout(function(aPopup) { gSessionManager.__closeAllMenus(aPopup._opener); delete aPopup._opener; }, 0, this);");
	
	popup.appendChild(createItem("Load (Replace Current Session)", "load"));
	popup.appendChild(createItem("Load (Append To Current Session)", "loadAppend"));
	popup.appendChild(document.createElement("menuseparator"));
	popup.appendChild(createItem("Replace With Current Session", "replace"));
	popup.appendChild(createItem("Replace With Current Window", "replaceWindow"));
	popup.appendChild(document.createElement("menuseparator"));
	popup.appendChild(createItem("Rename Session...", "rename"));
	popup.appendChild(createItem("Delete Session...", "remove"));
	popup.appendChild(document.createElement("menuseparator"));
	popup.appendChild(createItem("Set As Startup Session", "startup"));
	
	document.getElementById("mainPopupSet").appendChild(popup);
})();

eval("BrowserToolboxCustomizeDone = " + BrowserToolboxCustomizeDone.toString().replace("{", "$& gSessionManager.initTMPStylePopup(true);"));
document.getElementById("navigator-toolbox").customizeDone = BrowserToolboxCustomizeDone;
