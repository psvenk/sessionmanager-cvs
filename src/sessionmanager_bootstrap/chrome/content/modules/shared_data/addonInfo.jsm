var EXPORTED_SYMBOLS = ["AddonInfo"];

var AddonInfo = {
	get prefBranch() {
		return Private.prefBranch;
	},
	get id() {
		return Private.id;
	},
	get version() {
		return Private.version;
	},
	get addonRoot() {
		return Private.addonRoot;
	},
	// array of params and preference branch string
	set addonData(aAddonData) {
		Private.prefBranch = aAddonData[1];
		Private.id = aAddonData[0].id;
		Private.version = aAddonData[0].version;
		Private.addonRoot = aAddonData[0].resourceURI.spec;
		Object.freeze(Private);
	},
};

let Private = {
	prefBranch: "",
	id: "",
	version: 0,
	addonRoot: null
};