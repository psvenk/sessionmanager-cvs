"use strict";

this.EXPORTED_SYMBOLS = ["SQLManager"];

const Ci = Components.interfaces;

// Get lazy getter functions from XPCOMUtils and Services
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");

// Session Manager modules
XPCOMUtils.defineLazyModuleGetter(this, "Constants", "chrome://sessionmanager/content/modules/shared_data/constants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PasswordManager", "chrome://sessionmanager/content/modules/password_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionIo", "chrome://sessionmanager/content/modules/session_file_io.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");

// 
// SQL Manager exported object
//
this.SQLManager = {
	get changingEntireSQLCache() {
		return Private.changingEntireSQLCache;
	},

	// Reads the passed session or all session files and builds or updates an SQL cache of those sessions windows and tabs.
	// aSessionFileName can be either a string or an array of strings.
	addSessionToSQLCache: function(aWipeDataBaseFirst, aSessionFileName) {
		return Private.addSessionToSQLCache(aWipeDataBaseFirst, aSessionFileName);
	},

	// Change encryption for SQL cache
	changeEncryptionSQLCache: function(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted) {
		return Private.changeEncryptionSQLCache(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted);
	},
	
	changeSQLCacheSetting: function() {
		return Private.changeSQLCacheSetting();
	},
	
	// verify that SQL cache is not corrupt, if it is rebuild it.  If it's not
	// continue to checkSQLCache2 which will verify data is up to date and that
	// there isn't an encryption/decryption mismatch.
	checkSQLCache: function() {
		return Private.checkSQLCache();
	},
	
	// Read the cache file (if it exists) and call the callback function with the results
	// Returns true if cache file exists or false otherwise
	readSessionDataFromSQLCache: function(aCallback, aSessionFileName, aCheckForPartialEncryption) {
		return Private.readSessionDataFromSQLCache(aCallback, aSessionFileName, aCheckForPartialEncryption);
	},
	
	rebuildCache: function() {
		return Private.rebuildCache();
	},
	
	// aSessionFileName can be either a string or an array of strings.
	removeSessionFromSQLCache: function(aSessionFileName, aDoNotNotfiy) {
		return Private.removeSessionFromSQLCache(aSessionFileName, aDoNotNotfiy);
	},
}

let Private = {
	changingEntireSQLCache: false,
	mDBConn: null,
	lockedForRebuild: false,
	alreadyDeletedAllSessions: false,
	SQLDataCacheTime:0,
	SQLDecryptedDataCache: {},
	callbackTimer: null,
	buildStatementQueue: [],
	
	// Reads the passed session or all session files and builds or updates an SQL cache of those sessions windows and tabs.
	// aSessionFileName can be either a string or an array of strings.
	addSessionToSQLCache: function(aWipeDataBaseFirst, aSessionFileName) {
		if (!PreferenceManager.get("use_SQLite_cache"))
			return;

		if (PreferenceManager.get("encrypt_sessions") && !PasswordManager.enterMasterPassword()) {
			Utils.cryptError(Utils._string("encryption_sql_failure"));
			Private.changingEntireSQLCache = false;
			Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "false");
			return true;
		}

		log("Caching " + (aSessionFileName ? JSON.stringify(aSessionFileName) : "all sessions") + " into SQL file.", "INFO");
		
		let date = new Date();
		let begin = date.getTime();

		var statement_callback = {
			handleResult: function(aResultSet) {
			},

			handleError: function(aError) {
				log("Error adding to or updating SQL cache file", "ERROR");
				logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Creation/update of SQL cache file canceled or aborted!");
					
				let date = new Date();
				let end = date.getTime();
				log("Cached " + (aSessionFileName ? JSON.stringify(aSessionFileName) : "all sessions") + " into SQL file in " + (end - begin) + " ms", "INFO");

				// Update cache time if encrypted, otherwise delete the decoded
				Private.updateDecryptedCacheTime();
				Private.changingEntireSQLCache = false;
				
				Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
			}
		}
		
		this.buildStatement(statement_callback, null, aWipeDataBaseFirst, aSessionFileName);
	},
	
	// Build the statement for adding session and changing encryption.  If aDataArray is set, encryption
	// is changing so just use that data, otherwise get sessions
	buildStatement: function(aCallbackObject, aDataArray, aWipeDataBaseFirst, aSessionFileName) {
		// If the processing timer is enabled, queue the request for later.
		if (this.callbackTimer) {
			this.buildStatementQueue.push(function () { this.buildStatement(aCallbackObject, aDataArray, aWipeDataBaseFirst, aSessionFileName) }.bind(this));
			return;
		}
	
		let readSessionFile = false;
		let timestamps = {};
		
		// If adding sessions, get the sessions based on aSessionFileName
		if (!aDataArray) {
			readSessionFile = true;
			let regexp = null;
			if (aSessionFileName) {
				// build regular expression, escaping all special characters
				let escaped_name;
				if (Array.isArray(aSessionFileName)) {
					for (var i=0; i<aSessionFileName.length; i++)
						escaped_name = (i != 0) ? ("|" + aSessionFileName[i]) : aSessionFileName;
				}
				else if (typeof (aSessionFileName) == "string") 
					escaped_name = aSessionFileName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
					
				regexp = new RegExp("^" + escaped_name + "$");
			}
			
			aDataArray = SessionIo.getSessions(regexp,null,true);
		}
		else {
			// Get new timestamps if changing encryption
			let sessions = SessionIo.getSessions();
			sessions.forEach(function(aSession) {
				timestamps[aSession.fileName] = aSession.timestamp;
			});
		}
	
		let mDBConn, statement, params;
		if (aDataArray.length) {
			// create or open the SQL cache file
			mDBConn = this.getSQLDataBase();
			if (!mDBConn)
				return;
				
			// Add or update existing values
			statement = mDBConn.createStatement(
				"INSERT OR REPLACE INTO sessions (filename, name, groupname, timestamp, autosave, windows, tabs, backup, state) " +
				"VALUES ( :filename, :name, :groupname, :timestamp, :autosave, :windows, :tabs, :backup, :state )"
			);
			params = statement.newBindingParamsArray();
		}
		
		var timer_callback = {
			found_session: false,
			notify: function(timer) {
				let session, tab_data;
				try {
					session = aDataArray.pop();
				}
				catch(ex) { 
					logError(ex);
					session = null;
				};
				if (session && PreferenceManager.get("use_SQLite_cache")) {
					let tab_data = session.state;
					// If adding session, read session data from disk
					if (readSessionFile) {
						let file = SessionIo.getSessionDir(session.fileName);
						// read session files without doing extra processing (faster)
						let state = SessionIo.readSessionFile(file, false, null, true)
						if (state) 
							if (Constants.SESSION_REGEXP.test(state))
								state = state.split("\n")
						
						// Get session data, return if no session data
						if (state[4]) {
							let data = Private.getWindowAndTabData(state[4]);
							if (data)
								tab_data = Utils.JSON_encode(data);
							else
								return;
						}
					}
					
					// Just replace whatever's there since the filename is unique
					let bp = params.newBindingParams();
					bp.bindByName("filename", session.fileName);
					bp.bindByName("name", session.name);
					bp.bindByName("groupname", session.group);
					bp.bindByName("timestamp", readSessionFile ? session.timestamp : timestamps[session.fileName]);
					bp.bindByName("autosave", session.autosave);
					bp.bindByName("windows", session.windows);
					bp.bindByName("tabs", session.tabs);
					bp.bindByName("backup", session.backup ? 1 : 0);
					// ENCRYPTING SLOWS THINGS DOWN EXPONENTIALLY
					bp.bindByName("state", Utils.decryptEncryptByPreference(tab_data, true, true));
					params.addParams(bp);
					
					// If encryption on, save decrypted session data
					if (PreferenceManager.get("encrypt_sessions"))
						Private.SQLDecryptedDataCache[session.fileName] = tab_data;
						
					this.found_session = true;						
				}
				else {
					Private.callbackTimer.cancel();
					Private.callbackTimer = null;
					if (this.found_session && PreferenceManager.get("use_SQLite_cache")) {
						statement.bindParameters(params);
						if (aWipeDataBaseFirst) {
							log("Deleting existing sessions from SQL Cache file first","INFO");
							let statement1 = mDBConn.createStatement("DELETE FROM sessions; VACUUM; REINDEX");
							mDBConn.executeAsync([statement1, statement],2,aCallbackObject);
						}
						else
							statement.executeAsync(aCallbackObject);
					}
					statement.finalize();
					
					// If any more buildstatement calls queued run them
					if (Private.buildStatementQueue.length) {
						let newFunCall = Private.buildStatementQueue.shift();
						Utils.runAsync(newFunCall, Private);
					}
				}
			}
		}
		
		if (aDataArray.length) {
			// Use a timer to prevent GUI lockup which can occur when processing a lot of data (especially encrypted data)
			this.callbackTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			this.callbackTimer.initWithCallback(timer_callback, (PreferenceManager.get("encrypt_sessions") ? 100 : 50), Ci.nsITimer.TYPE_REPEATING_SLACK);
		}
		else {
			log("No sessions to cache");
			this.removeSessionFromSQLCache(aSessionFileName)
		}
	},
	
	// Change encryption for SQL cache
	changeEncryptionSQLCache: function(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted) {
		if (!PreferenceManager.get("use_SQLite_cache"))
			return;

		if (!aTabData) {
		
			// force a master password prompt so we don't waste time if user cancels it
			if (!PasswordManager.enterMasterPassword()) 
			{
				Utils.cryptError(Utils._string("encryption_sql_failure"));
				return;
			}
		
			let date = new Date();
			this.begin = date.getTime();
			this.changingEntireSQLCache = true;
			Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "true");
			this.readSessionDataFromSQLCache(Private.changeEncryptionSQLCache);
		}
		else {
			// If already in correct encryption state or decryption failed, exit
			if (aFailedToDecrypt) {
				Private.changingEntireSQLCache = false;
				Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "false");
				return;
			}
				
			if (!aIsPartiallyEncrypted && (aIsThereAnyEncryptedData == PreferenceManager.get("encrypt_sessions"))) {
				Private.changingEntireSQLCache = false;
				Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "false");
				return;
			}
	
			var statement_callback = {
				handleResult: function(aResultSet) {
				},

				handleError: function(aError) {
					log("Error changing encryption of SQL cache file", "ERROR");
					logError(aError);
				},

				handleCompletion: function(aReason) {
					if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
						logError("Changing encryption of SQL cache file canceled or aborted!");
					let date = new Date();
					let end = date.getTime();
					log("Encryption change of SQL file took " + (end - Private.begin) + " ms", "INFO");
					
					// Update cache time if encrypted, otherwise delete the decoded
					Private.updateDecryptedCacheTime();
					Private.changingEntireSQLCache = false;
					Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "false");
				}
			};
			
			Private.buildStatement(statement_callback, aTabData);
		}
	},
	
	changeSQLCacheSetting: function() {
		this.changingEntireSQLCache = true;
		if (!PreferenceManager.get("use_SQLite_cache")) {
			Private.removeSessionFromSQLCache();
		}
		else {
			this.alreadyDeletedAllSessions = false;
			Private.rebuildCache();
		}
	},
	
	// verify that SQL cache is not corrupt, if it is rebuild it.  If it's not
	// continue to checkSQLCache2 which will verify data is up to date and that
	// there isn't an encryption/decryption mismatch.
	checkSQLCache: function() {
		log("Checking SQL Cache integrity and freshness", "INFO");
		
		if (SessionIo.getSessions().length == 0) {
			log("No sessions, removing cache file", "INFO");
			this.removeSessionFromSQLCache();
			return;
		}
	
		let mDBConn = this.getSQLDataBase();
		if (!mDBConn) {
			logError("SQL Database could not be opened.");
			return;
		}
		
		// Do an integrity check, if fail re-create database
		let statement = mDBConn.createStatement("PRAGMA integrity_check");
		statement.executeAsync({
			results: "",
		
			handleResult: function(aResultSet) {
				for (let row = aResultSet.getNextRow(); row; row = aResultSet.getNextRow()) {
					this.results = row.getResultByIndex(0);
				}
			},

			handleError: function(aError) {
					log("Error checking integrity of SQL", "ERROR");
					logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Integrity check of SQL canceled or aborted!");
					
				log("Integrity check of SQL cache done.", "INFO");
				
				let rebuild = false;
				// If not okay, rebuild SQL database, otherwise check to see if number of sessions match
				if (this.results != "ok") {
					rebuild = true;
				}
				else {
					try {
						Private.readSessionDataFromSQLCache(Private.checkSQLCache2, null, true);
					}
					catch(ex) {
						rebuild = true;
					}
				}
				
				if (rebuild == true) {
						logError("SQL Database corrupt, rebuilding");
						
						var callback = {
							complete: function() {
								let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
								file.append(Constants.SESSION_SQL_FILE);
								SessionIo.delFile(file, true, true);
								Private.lockedForRebuild = false;
								Private.addSessionToSQLCache();
							}
						};
						
						Private.lockedForRebuild = true;
						mDBConn.asyncClose(callback);
				}
			}
		});
		statement.finalize();
	},

	checkSQLCache2: function(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted) {
		// This should never happen since we can't fail when checking for partial encryption, but check anyway in case I change it in future.
		if (aFailedToDecrypt)
			return;
	
		// See if there's any updated, missing or extra sessions
		let sessions = SessionIo.getSessions();
		let index, filename, filenames_of_updated_sessions = [], filenames_of_existing_sessions = [];
		// Loop through all the current sessions and mark any missing sessions or ones with
		// mismatched timestamps as needing to be updated (or added). 
		for (var i=0; i<sessions.length; i++) {
			// Create list of filenames that exist
			filenames_of_existing_sessions.push(sessions[i].fileName);
			
			// found session in both SQL file and sessions folder
			if ((index = aFileNames.indexOf(sessions[i].fileName)) != -1) {
				// timestamps don't match so needs updating.
				if (aTabData[index].timestamp != sessions[i].timestamp)
					filenames_of_updated_sessions.push(aFileNames[index]);
			}
			else
				filenames_of_updated_sessions.push(sessions[i].fileName);
		}

		// Remove all filenames that are in aFilesNames, but not in filenames_of_existing_sessions (i.e. don't exist)
		let filenames_of_removed_sessions = aFileNames.filter(function(aFileName) {
			return (filenames_of_existing_sessions.indexOf(aFileName) == -1);
		});
		
		log("Adding/Updating: " + filenames_of_updated_sessions, "EXTRA");
		log("Removing: " + filenames_of_removed_sessions, "EXTRA");
		
		if (filenames_of_updated_sessions.length)
			Private.addSessionToSQLCache(false, filenames_of_updated_sessions);
		// At this point anything left in aFileNames are sessions that don't exist and can be removed.
		if (filenames_of_removed_sessions.length) 
			Private.removeSessionFromSQLCache(filenames_of_removed_sessions);
		
		// If there's an encryption mismatch, fix that now
		if (aIsPartiallyEncrypted || (aIsThereAnyEncryptedData != PreferenceManager.get("encrypt_sessions"))) {
			log("SQL cache encryption doesn't match encryption setting, fixing", "INFO");
			Private.changeEncryptionSQLCache();
		}
		
		// Compact and reindex the SQL file now as well to keep things quick.
		Private.vacuumSQLCache();
	},
	
	getSQLDataBase: function(aDoNotCreate, aSilent) {
		// If database is being deleted because it is corrupt, return nothing
		if (this.lockedForRebuild)
			return false;
	
		// If Database already open, just return it
		if (this.mDBConn && this.mDBConn.connectionReady) {
			return this.mDBConn;
		}
	
		// Open SQL file and connect to it
		let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
		file.append(Constants.SESSION_SQL_FILE);
		
		let already_exists = file.exists();
		
		// If not creating and file doesn't exist, return false
		if (aDoNotCreate && !already_exists)
			return false;

		// Fix issue where someone deleted Services.storage by unloading and reloading Services
		if (typeof Services.storage == "undefined") {
			Components.utils.unload("resource://gre/modules/Services.jsm");
			Components.utils.import("resource://gre/modules/Services.jsm");
		}
		
		try {
			this.mDBConn = Services.storage.openDatabase(file); 
		}
		catch(ex) {
			if (!aSilent)
				Utils.ioError(ex, Constants.SESSION_SQL_FILE);
			else
				logError(ex);
				
			return false;
		}
		
		// If there's no session table and we don't want to create one exit
		let table_exists = this.mDBConn.tableExists("sessions");
		if (aDoNotCreate && !table_exists) {
			this.mDBConn.close();
			this.mDBConn = null;
			return false;
		}
		
		try {
			this.mDBConn.setGrowthIncrement(1 * 1024 * 1024, "");
		}
		catch(ex) {
			// Will throw if there's very little disk space left
			logError(ex);
		}

		if (!aDoNotCreate && !table_exists) {
			try {
				this.mDBConn.createTable("sessions", "filename TEXT PRIMARY KEY, name TEXT, groupname TEXT, timestamp INTEGER," +
														"autosave TEXT, windows INTEGER, tabs INTEGER, backup INTEGER, state BLOB");
			}
			catch(ex) {
				if (!aSilent)
					Utils.ioError(ex, Constants.SESSION_SQL_FILE);
				else
					logError(ex);
			}
		}
		
		return this.mDBConn;
	},
			
	// Giving state data returns an objec containing the Tab titles and and URLs
	getWindowAndTabData: function(aState) {
		let sessionData = [];
		let data_found = false;
		let state = Utils.decrypt(aState, true);
		if (state) {
			state = Utils.JSON_decode(state, true);
			if (!state._JSON_decode_failed) {
				// Loop windows
				state.windows.forEach(function(aWindow, aIx) {
					let tabData = [];

					// Try to find tab group nanes if they exists, 0 is the default group and has no name
					var tab_groups = { 0:"" };
					if (aWindow.extData && aWindow.extData["tabview-group"]) {
						var tabview_groups = Utils.JSON_decode(aWindow.extData["tabview-group"], true);
						if (tabview_groups && !tabview_groups._JSON_decode_failed) {
							for (var id in tabview_groups) {
								tab_groups[id] = tabview_groups[id].title;
							}
						}
					}
					
					// Loop tabs
					aWindow.tabs.forEach(function(aTab) {
						// Add tabs that have at least one valid entry
						let index = parseInt(aTab.index) - 1;

						// Try to find tab group ID if it exists, 0 is default group
						var groupID = 0;
						if (aTab.extData && aTab.extData["tabview-tab"]) {
							var tabview_data = Utils.JSON_decode(aTab.extData["tabview-tab"], true);
							if (tabview_data && !tabview_data._JSON_decode_failed) 
								groupID = tabview_data.groupID;
						}

						// This includes all tab history entries
						if (aTab.entries) {
							let history = [];
							aTab.entries.forEach(function(aEntry, aIndex) {
								history.push({ title: (aEntry.title ? aEntry.title : "about:blank"), url: (aEntry.url ? aEntry.url : "about:blank"), current: (index == aIndex)});
							});
							// If no history, then just add a blank tab 
							if (!history.length) {
								history.push({ title: "about:blank", url: "about:blank", current: true });
							}
							tabData.push({ history: history, index: (isNaN(index) ? "0" : index), hidden: aTab.hidden,
														 tab_group_id: groupID, tab_group_name: ((tab_groups[groupID]) || groupID || "") });
							data_found = true;
						}
					});
					sessionData.push({ tab_groups: tab_groups, tabData: tabData });
				});
			}
		}
		return data_found ? sessionData : null;
	},

	// Read the cache file (if it exists) and call the callback function with the results
	// Returns true if cache file exists or false otherwise
	readSessionDataFromSQLCache: function(aCallback, aSessionFileName, aCheckForPartialEncryption) {
		let mDBConn = this.getSQLDataBase(true, true);
		if (!mDBConn)
			return false;

		// Get a new file handler since lastModifiedTime will be the time when the file was opened.
		let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
		file.append(Constants.SESSION_SQL_FILE);
		//log("read: " + Private.SQLDataCacheTime + ", " + file.lastModifiedTime);
		let read_decrypted_cache_data = (Private.SQLDataCacheTime == file.lastModifiedTime);
	
		// Select all rows, but remove duplicates.  There shouldn't be any dupes, but this also orders the results
		let statement = mDBConn.createStatement("SELECT ALL * FROM sessions" + (aSessionFileName ? " WHERE filename = :name" : ""));
		if (aSessionFileName)
			statement.params.name = aSessionFileName;
		
		statement.executeAsync({
			tabData: [], 
			fileNames: [],
			
			// When checking for partial encryption at startup we don't want to needlessly through up the password
			// prompt since we don't really care about the data itself.  So just return the encrypted data at that point.
			// Make sure not to cache it though.
			
			// Results come in multiple times per statement so store all the tab data until complete.  Attempting
			// to do any processing in here which prompts the user will result in handleCompletion firing before
			// handleResult exits, so just store all the data as is and do encryption processing in handleCompletion.
			handleResult: function(aResultSet) {
				for (let row = aResultSet.getNextRow(); row; row = aResultSet.getNextRow()) {
					this.tabData.push({ fileName: row.getResultByName("filename"), name: row.getResultByName("name"),
												 group: row.getResultByName("groupname"), timestamp: row.getResultByName("timestamp"),
												 autosave: row.getResultByName("autosave"), windows: row.getResultByName("windows"),
												 tabs: row.getResultByName("tabs"), backup: row.getResultByName("backup"),
												 state: row.getResultByName("state")});
					this.fileNames.push(row.getResultByName("filename"));
				}
			},

			handleError: function(aError) {
					log("Error reading session data from SQL file", "ERROR");
					logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED) {
					logError("Reading from SQL file canceled or aborted!");
					return;
				}
				else
					log("Reading from SQL cache file done" + (aSessionFileName ? (" for " + aSessionFileName) : "."), "INFO");
					
				let do_not_decrypt = aCheckForPartialEncryption && PasswordManager.isMasterPasswordRequired();

				// Do encryption handling here.  It's less efficient, but it's the only thing that works
				let data_encrypted = null, partial_encryption = false, decrypted_data_cached = false;
				let checked_master_password = false, failed_to_decrypt = false;
				for (var i=0; i<this.tabData.length; i++) {
					// if checking for partial encryption, stop checking once we that it's partially encrypted
					if (aCheckForPartialEncryption && !partial_encryption) {
						let old_data_encrypted = data_encrypted;
						data_encrypted = data_encrypted || (this.tabData[i].state.indexOf(":") == -1);
						if ((old_data_encrypted != null) && (old_data_encrypted != data_encrypted)) {
							partial_encryption = true;
						}
					}
					else
						data_encrypted = data_encrypted || (this.tabData[i].state.indexOf(":") == -1);
						
					// If data is encrypted and not simply checking cache, prompt for master password once. If user cancels, give up
					if (data_encrypted) {
						// If we have stored decrypted data and the cache hasn't changed just use that
						if (read_decrypted_cache_data) {
							this.tabData[i].state = Private.SQLDecryptedDataCache[this.tabData[i].fileName];
						}
						else if (!do_not_decrypt) {
							if (!checked_master_password) {
								checked_master_password = true;
								if (!PasswordManager.enterMasterPassword()) {
									Utils.cryptError(Utils._string("encryption_sql_failure"));
									failed_to_decrypt = true;
									break;
								}
							}
							this.tabData[i].state = Utils.decrypt(this.tabData[i].state, true);
							Private.SQLDecryptedDataCache[this.tabData[i].fileName] = this.tabData[i].state;
							decrypted_data_cached = true;
						}
					}
				}
				
				// If cached decrypted data, store the sql cache file time
				if (decrypted_data_cached)
					Private.SQLDataCacheTime = file.lastModifiedTime
				if (read_decrypted_cache_data)
					log("Read from decrypted memory cache" + (aSessionFileName ? (" for " + aSessionFileName) : "."), "INFO");
				
				// Send the results to caller if callback requested (use slice so cache doesn't get modified if user changes values)
				if (typeof aCallback == "function") 
					aCallback(this.tabData.slice(), this.fileNames.slice(), failed_to_decrypt, data_encrypted, partial_encryption);
			}
		});			
		
		statement.finalize();
		return true;
	},
	
	rebuildCache: function() {
		Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updating", "true");
		this.changingEntireSQLCache = true;
		this.addSessionToSQLCache(true);
	},
	
	// aSessionFileName can be either a string or an array of strings.
	removeSessionFromSQLCache: function(aSessionFileName, aDoNotNotfiy) {
		let removeAll = false;
		// If caching is disabled always delete all cached sessions when asked to remove a specific session
		if (!PreferenceManager.get("use_SQLite_cache")) {
			// If already deleted don't do it again
			if (this.alreadyDeletedAllSessions)
				return true;
				
			this.alreadyDeletedAllSessions = true;
			removeAll = true;
		}
	
		let mDBConn = this.getSQLDataBase(true);
		if (!mDBConn) {
			this.changingEntireSQLCache = false;
			Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
			return false;
		}
			
		let statement;
		if (aSessionFileName && !removeAll) {
			statement = mDBConn.createStatement("DELETE FROM sessions WHERE filename = :filename");
			if ((Array.isArray && Array.isArray(aSessionFileName)) || (!Array.isArray && (typeof aSessionFileName == "object"))) {
				let params = statement.newBindingParamsArray();
				for (var i=0; i<aSessionFileName.length; i++) {
					let bp = params.newBindingParams();
					bp.bindByName("filename", aSessionFileName[i]);
					params.addParams(bp);
					delete this.SQLDecryptedDataCache[aSessionFileName[i]]
				}
				statement.bindParameters(params);
			}
			else if (typeof (aSessionFileName) == "string") {
				statement.params.filename = aSessionFileName;
				delete this.SQLDecryptedDataCache[aSessionFileName]
			}
		}
		else {
			statement = mDBConn.createStatement("DELETE FROM sessions; VACUUM; REINDEX");
			this.SQLDataCacheTime = 0;
			this.SQLDecryptedDataCache = {};
		}
		
		log("Deleting " + ((aSessionFileName && !removeAll) ? JSON.stringify(aSessionFileName) : "all sessions") + " from SQL cache.", "INFO");
		
		try {
			statement.executeAsync({
				handleResult: function(aResultSet) {
				},

				handleError: function(aError) {
						log("Error deleting session from SQL", "ERROR");
						logError(aError);
				},

				handleCompletion: function(aReason) {
					if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
						logError("Deleteing from SQL canceled or aborted!");
						
					log("Deleted " + ((aSessionFileName && !removeAll) ? JSON.stringify(aSessionFileName) : "all sessions") + " from SQL cache.", "INFO");
					
					// Update cache time if encrypted, otherwise delete the decoded
					Private.updateDecryptedCacheTime();
					
					if (!aDoNotNotfiy) {
						Private.changingEntireSQLCache = false;
						Services.obs.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
					}
				}
			});
		}
		catch(ex) {
			logError(ex);
		}
		statement.finalize();
		// If option to use cache turned off, close the database
		if (!PreferenceManager.get("use_SQLite_cache")) {
			mDBConn.asyncClose();
		}
	},

	// Keep decrypted data in memory to prevent needlessly decrypting over and over again
	updateDecryptedCacheTime: function() 
	{
		// Update cache time if encrypted and already built, otherwise delete the decoded data
		if (PreferenceManager.get("encrypt_sessions") && this.SQLDataCacheTime != 0) {
			// Get a new file handler since lastModifiedTime will be the time when the file was opened.
			let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
			file.append(Constants.SESSION_SQL_FILE);
			this.SQLDataCacheTime = file.lastModifiedTime;
			//log("update:" + this.SQLDataCacheTime + ", " + file.lastModifiedTime);
		}
		else {
			this.SQLDataCacheTime = 0;
			this.SQLDecryptedDataCache = {};
		}
	},
	
	// compact and reindex database to keep things quick
	vacuumSQLCache: function()
	{
		// Open SQL file and connect to it
		let mDBConn = this.getSQLDataBase(true, true);
		if (!mDBConn)
			return;

		let statement = mDBConn.createStatement("VACUUM; REINDEX");
		statement.executeAsync({
			handleResult: function(aResultSet) {
			},

			handleError: function(aError) {
					log("Error vaccuming SQL file", "ERROR");
					logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Vacuuming SQL canceled or aborted!");
					
				// Update cache time if encrypted, otherwise delete the decoded
				Private.updateDecryptedCacheTime();
			}
		});			
		statement.finalize();
	},
	
	unload: function() 
	{
		if (Private.callbackTimer) {
			Private.callbackTimer.cancel();
			Private.callbackTimer = null;
		}
		
		// Clear buildStatement queue
		Private.buildStatementQueue.length = 0;
	
		if (Private.mDBConn && Private.mDBConn.connectionReady) {
			Private.mDBConn.asyncClose();
		}
		
		delete Private.SQLDecryptedDataCache;
	},
}

Object.freeze(SQLManager);

// Send unload function to bootstrap.js
let subject = { wrappedJSObject: Private.unload };
Services.obs.notifyObservers(subject, "session-manager-unload", null);
