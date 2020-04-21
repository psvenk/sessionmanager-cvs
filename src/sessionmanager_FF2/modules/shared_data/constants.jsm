"use strict";

this.EXPORTED_SYMBOLS = ["Constants"];

this.Constants = {
	AUTO_SAVE_SESSION_NAME: "autosave.session",
	AUTO_SAVE_SESSION_REGEXP: /^autosave(-[1-9](\d)*)*\.session$/,
	BACKUP_SESSION_FILENAME: "backup.session",
	BACKUP_SESSION_REGEXP: /^(backup|autosave)(-[1-9](\d)*)*\.session$/,
	CLOSED_WINDOW_FILE: "sessionmanager.dat",
	SESSION_EXT: ".session",
	SESSION_REGEXP: /^\[SessionManager v2\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window\/?\d*)\tcount=([1-9][0-9]*)\/([0-9]*)(\tgroup=([^\t\n\r]+))?(\tscreensize=(\d+)x(\d+))?\n/m,
	SESSION_SQL_FILE: "sessionmanager.sqlite",
	STARTUP_PROMPT: -11,
	STARTUP_LOAD: -12,
};

Object.freeze(this.Constants);