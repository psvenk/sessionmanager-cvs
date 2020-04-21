const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SharedData", "chrome://sessionmanager/content/modules/shared_data/data.jsm");


// Command Line Hanlder component.  It handles searching command line arguments for sessions to load
let CommandLineHandlerComponent = {
	// registration details
	classID:           Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
	contractID:        "@morac/sessionmanager-commandline-handler;1",
	classDescription:  "Session Manager Commandline Handler",
	_xpcom_categories: [{
		category: "command-line-handler",
		entry: "m-sessionmanager"
	}],
						
	// nsIFactory interface implementation
	createInstance: function(outer, iid)
	{
		if (outer)
			throw Cr.NS_ERROR_NO_AGGREGATION;
		return this.QueryInterface(iid);
	},
						
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsICommandLineHandler, Ci.nsIFactory]),
	
	init: function()
	{
		let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
		registrar.registerFactory(this.classID, this.classDescription, this.contractID, this);

		for (let i in this._xpcom_categories)
			XPCOMUtils.categoryManager.addCategoryEntry(this._xpcom_categories[i].category, this._xpcom_categories[i].entry, this.contractID, false, true);

		unload((function()
		{
			for (let i in this._xpcom_categories)
				XPCOMUtils.categoryManager.deleteCategoryEntry(this._xpcom_categories[i].category, this._xpcom_categories[i].entry, false);

			// This needs to run asynchronously, see bug 753687
			Services.tm.currentThread.dispatch(function()
			{
				registrar.unregisterFactory(this.classID, this);
			}.bind(this), Ci.nsIEventTarget.DISPATCH_NORMAL);
		}).bind(this));
	},
	
	/* nsICommandLineHandler */
	handle : function clh_handle(cmdLine)
	{
		log("SessionManagerHelper: Processing Command line arguments", "INFO");
		// Find and remove the *.session command line argument and save it to a shared variable
		let data = cmdLine.state;
		let found = false;
		try {
			let i=0;
			while (i<cmdLine.length) {
				let name = cmdLine.getArgument(i);
				if (/^.*\.session$/.test(name)) {
					// Try using absolute path first and if that doesn't work, search for the file in the session folder
					var file = null;
					try {
						file =  new FileUtils.File(name);
					}
					catch (ex) {
						file = null;
					}
					if (!file) {
						file = SessionIo.getSessionDir(name);
					}
					if (file && file.exists() && file.isFile()) {
						cmdLine.removeArguments(i,i);
						found = true;
						// strip off path if specified
						data = data + "\n" + file.path;
					}
					else {
						i++;
						log("SessionManagerHelper: Command line specified session file not found or is not valid - " + name, "ERROR");
					}
				}
				else i++;
			}
		}
		catch (ex) {
			logError(ex);
		}
		if (found) {
			SharedData._temp_restore = data;
		}
	},
};

CommandLineHandlerComponent.init();