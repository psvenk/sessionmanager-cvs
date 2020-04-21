this.EXPORTED_SYMBOLS = ["TabGroupManager"];
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
// Logger object - use same module file
XPCOMUtils.defineLazyModuleGetter(this, "log", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "logError", "chrome://sessionmanager/content/modules/logger.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Utils", "chrome://sessionmanager/content/modules/utils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PreferenceManager", "chrome://sessionmanager/content/modules/preference_manager.jsm");
XPCOMUtils.defineLazyGetter(this, "SessionStore", function() { return Utils.SessionStore; }); 
XPCOMUtils.defineLazyModuleGetter(this, "Rect", "resource://gre/modules/Geometry.jsm");
this.TabGroupManager = {
	// Parameters are current window to process and existing tab group data
	// The function will update the group data to make sure it is unique
	fixTabGroups: function(aWinData, tab_group_data, aBrowserWindow) {
		return Private.fixTabGroups(aWinData, tab_group_data, aBrowserWindow);
	},
	
	// Panorama will not restore tab groups correctly if there are matching group ids, but mismatching tab ids.  
	// This forces TabView to reconnect the tabs to the correct group after a restore.
	// Currently if a tab is not in a group, it will get added to active group which isn't correct, need to fix that.
	forceTabReconnections:function(aWindow, aTabsState, aReplacingWindow) {
		return Private.forceTabReconnections(aWindow, aTabsState, aReplacingWindow);
	},
	
	// Gets the specified window's tab group data
	getTabGroupData: function(aWindow) {
		return Private.getTabGroupData(aWindow);
	},
	// Remote Tab groups which contain no tabs
	removeEmptyTabGroups:function(aWinData) {
		return Private.removeEmptyTabGroups(aWinData);
	},
	
	// Update the specified window's tab group data
	updateTabGroupData: function(aWindow, tab_group_data) {
		return Private.updateTabGroupData(aWindow, tab_group_data);
	}
};
// Freeze the TabGroupManager object. We don't want anyone to modify it.
Object.freeze(TabGroupManager);
let Private = {
	// The function will update the SessionStore group data to make sure each tab group has a unique id.
	// aWinData = Window state data of session being loaded (i.e. groups to load)
	// tab_group_data = Current tab group data of existing browser window (i.e. existing groups)
	// aBrowserWindow = set to the browser window for the first browser window, null for all other windows
	fixTabGroups: function(aWinData, tab_group_data, aBrowserWindow) {
		// Remove empty tab groups from session data and return the resulting groups data.  If no groups simply return.
		let return_data = this.removeEmptyTabGroups(aWinData);
		if (!return_data)
			return null;
		let [session_tab_groups, session_tab_group] = return_data;
		if (!session_tab_group || !session_tab_groups)
			return null;
		// If user doesn't want us to mess with tab groups, don't.
		if (PreferenceManager.get("do_not_fix_tabgroups", false)) {
			tab_group_data = { tabview_groups : session_tab_groups, tabview_group : session_tab_group };
		}
		// If no existing tab groups store sessions's tab groups otherwise merge the data
		else if (!tab_group_data) {
			// For first window if tabs aren't in a group, put them in a new group to prevent existing tabs
			// being merged into loaded group
			if (aBrowserWindow) {
				log("No existing Tab Group in first window so creating new Tab Group" , "EXTRA");
				let id = session_tab_groups.nextID++;
				session_tab_groups.totalNumber++;
				// Add new group (use a 400x300 box for no special reason)
				session_tab_group[id] = { "bounds":{"left":15,"top":5,"width":300,"height":400},"userSize":null,"title":"", "id": id };
				
				// update window's tabview-tab data to include new group and flag tabs as needed to be reconnected
				let tabs = aBrowserWindow.gBrowser.tabs;
				let pinned_tabs = 0;
				for (var i=0; i<tabs.length; i++) {
					// if not pinned
					if (!tabs[i].pinned) {
						try {
							SessionStore.setTabValue(tabs[i], "tabview-tab", JSON.stringify({"groupID": id }));
							// Hide the tab
							tabs[i].setAttribute("hidden",true);
						}
						catch(ex) {
							logError(ex);
						}
					}
				}
				// Select the active groupID tab (which should be the selected tab) once the session loads
				let selectedIndex = tabs.length + aWinData.selected - 1;
				aBrowserWindow.addEventListener("SSWindowStateReady", function _sm_select(aEvent) { 
					this.removeEventListener("SSWindowStateReady", _sm_select, false);
					this.gBrowser.tabContainer.selectedIndex = selectedIndex;
				}, false); 
			}
			tab_group_data = { tabview_groups : session_tab_groups, tabview_group : session_tab_group };
		}
		else {
			// Update nextID
			tab_group_data.tabview_groups.nextID = Math.max(session_tab_groups.nextID, tab_group_data.tabview_groups.nextID)
			// Find currently existing Tab Group Names
			let tab_group_name_mapping = {};
			for (var id in tab_group_data.tabview_group) {
				if (tab_group_data.tabview_group[id].title)
					tab_group_name_mapping[tab_group_data.tabview_group[id].title] = id;
			}
			// Change group id numbers in loaded session tab groups if need be
			for (var id in session_tab_group) {
				// if group id already exists, choose a different id.  If group name already exists, use that group id
				if (tab_group_data.tabview_group[id] || tab_group_name_mapping[session_tab_group[id].title]) {
					let new_id = -1;
					
					// If tab names match, use that group id otherwise get a new group id
					if (tab_group_name_mapping[session_tab_group[id].title])
						new_id = tab_group_name_mapping[session_tab_group[id].title];
					else if (tab_group_data.tabview_group[id])
						new_id = tab_group_data.tabview_groups.nextID++;
					// only update if not already in the right group
					if (new_id != -1) {
						tab_group_data.tabview_group[new_id] = session_tab_group[id];
						tab_group_data.tabview_group[new_id].id = new_id;
						
						// update tabview-tab data
						aWinData.tabs.forEach(function(aTabData) {
							if (aTabData.extData && aTabData.extData["tabview-tab"]) {
								let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
								if (tabview_data && !tabview_data._JSON_decode_failed) {
									if (tabview_data.groupID == id) {
										// update id and save
										tabview_data.groupID = new_id;
										aTabData.extData["tabview-tab"] = Utils.JSON_encode(tabview_data);
									}
								}
							}
						});
					}
				}
				else {
					tab_group_data.tabview_group[id] = session_tab_group[id];
				}
			}
			// Update total number
			tab_group_data.tabview_groups.totalNumber = Object.keys(tab_group_data.tabview_group).length;
		}
		return tab_group_data;
	},
	
	// Make sure none of the tab groups overlap each other in the Tab View UI
	fixOverlappingTabGroups: function(aTabview_ui, tabview_group) {
		if (!aTabview_ui) 
			return;
		let tabview_ui = Utils.JSON_decode(aTabview_ui, true);
		// tabview_ui.pageBounds should always exist if tabview_ui exists, but I've gotten a report that it does not. Doesn't hurt to check.
		if (!tabview_ui || tabview_ui._JSON_decode_failed || !tabview_ui.pageBounds)
			return;
			
		let groups = [];
		for (var id in tabview_group) {
			groups.push({id: id, bounds: new Rect(tabview_group[id].bounds.left, tabview_group[id].bounds.top, 
			                                  tabview_group[id].bounds.width, tabview_group[id].bounds.height)});
		}
		
		function overlaps(i) {
			return groups.some(function(group, index) {
				if (index == i) // can't overlap with yourself.
					return false;
				return groups[i].bounds.intersects(group.bounds);
			});
		}
		
		// find if any groups overlap
		let overlap = false;
		for (var i in groups) {
			if (overlaps(i)) {
				overlap = true;
				break;
			}
		}
		
		// if overlap just tile all groups because it's easier. 
		if (overlap) {
			let column_number = Math.ceil(Math.sqrt(groups.length));
			let new_height = Math.floor((tabview_ui.pageBounds.height - tabview_ui.pageBounds.top) / column_number);
			let new_width = Math.floor((tabview_ui.pageBounds.width - tabview_ui.pageBounds.left) / column_number);
			let new_x = tabview_ui.pageBounds.left;
			let new_y = tabview_ui.pageBounds.top;
			
			for (var i in groups) {
				tabview_group[groups[i].id].bounds.left = new_x;
				tabview_group[groups[i].id].bounds.top = new_y;
				tabview_group[groups[i].id].bounds.width = new_width;
				tabview_group[groups[i].id].bounds.height = new_height;
				tabview_group[groups[i].id].userSize = null;
				
				new_x += new_width;
				if (new_x + new_width > tabview_ui.pageBounds.width) {
					new_x = tabview_ui.pageBounds.left;
					new_y += new_height;
				}
			}
		}
	},
	
	// On a Session load, SessionStore will send a SSWindowStateBusy notification on the call to setWindowState or setBrowserState
	// and send a SSWindowStateReady notification when the restore is complete.  If the TabView UI has been initialized, on the 
	// SSWindowStateReady notification, groupitems.js::reconstitute() will go through all existing group items and look for any
	// "close" any where the group id no longer exists in the loaded session data.  Closing involves marking any orphaned tab items
	// to "reconnect" to the proper group or simply get added to the current active group or first group in the session data.
	// See http://mxr.mozilla.org/mozilla-central/source/browser/components/tabview/groupitems.js#2153
	//
	// Unfortunately, since it's not acting on group items and not actual tabs, it will move a tab to an existing group
	// if that group exists in the new session data, but that tab isn't in it.  This can cause tabs to move to the wrong group.
	// See https://bugzilla.mozilla.org/show_bug.cgi?id=705964 (TabItems remain in wrong group on session restore)
	// which isn't close to be fixed.
	// 
	// To work around this, we go through the session data and mark any tab which has a group id that does not match the session's 
	// tab group as needing to be "reconnected". This will cause the tab to be connected to the correct group.
	// Unfortunately tabs which aren't grouped, will get added to the active group, but there's not much that can be done about that.
	forceTabReconnections:function(aWindow, aTabsState) {
		let groupIDByTabNumber = [];
		aTabsState.forEach(function(aTabData, aIndex) {
			if (aTabData.extData && aTabData.extData["tabview-tab"]) {
				let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
				if (tabview_data && !tabview_data._JSON_decode_failed) {
					groupIDByTabNumber[aIndex] = tabview_data.groupID;
				}
			}
		});
	
		try {
			let tabs = aWindow.gBrowser.tabs;
			for (var i=0; i<tabs.length; i++) {
				if (tabs[i]._tabViewTabItem) {
					let tabView = tabs[i]._tabViewTabItem;
					if (tabView && tabView.parent && (tabView.parent.id != groupIDByTabNumber[i])) {
						tabView._reconnected = false;
						log("forceTabReconnections: Forced tab " + i + " to reconnect as groupIDs did not match.", "EXTRA");
					}
					else 
						log("forceTabReconnections: Tab " + i + " is not in a tab group.", "EXTRA");
				}
			}
		} 
		catch(ex) {
			logError(ex);
		}
	},
	
	// Gets the specified window's tab group data
	getTabGroupData: function(aWindow) {
		// Grab existing tab group info from browser window.
		let tab_group_data, tabview_groups, tabview_group;
		try {
			tabview_groups = SessionStore.getWindowValue(aWindow, "tabview-groups");
			tabview_group = SessionStore.getWindowValue(aWindow, "tabview-group");
		} catch(ex) {
			logError(ex);
		}
		if (tabview_groups && tabview_group) {
			tabview_groups = Utils.JSON_decode(tabview_groups);
			tabview_group = Utils.JSON_decode(tabview_group);
			if (tabview_groups && !tabview_groups._JSON_decode_failed && tabview_group && !tabview_group._JSON_decode_failed)
				tab_group_data = { tabview_groups: tabview_groups, tabview_group: tabview_group };
		}
		return tab_group_data;
	},
	
	// Remote Tab groups which contain no tabs
	removeEmptyTabGroups: function(aWinData) {
		let session_tab_groups, session_tab_group;
		// Get tabview-groups data
		if (aWinData.extData && aWinData.extData["tabview-groups"]) {
			session_tab_groups = Utils.JSON_decode(aWinData.extData["tabview-groups"], true);
		}
		if (!session_tab_groups || session_tab_groups._JSON_decode_failed )
			return null;
		if (aWinData.extData && aWinData.extData["tabview-group"]) {
			session_tab_group = Utils.JSON_decode(aWinData.extData["tabview-group"], true);
		}
		if (!session_tab_group || session_tab_group._JSON_decode_failed )
			return null;
			
		// find tab groups in use
		let tab_groups_in_use = [];
		aWinData.tabs.forEach(function(aTabData) {
			if (aTabData.extData && aTabData.extData["tabview-tab"]) {
				let tabview_data = Utils.JSON_decode(aTabData.extData["tabview-tab"], true);
				if (tabview_data && !tabview_data._JSON_decode_failed) {
					if (tab_groups_in_use.indexOf(tabview_data.groupID) == -1)
						tab_groups_in_use.push(tabview_data.groupID);
				}
			}
		});
			
		// remove tab groups that don't have a corresponding tab
		let deleted_count = 0;
		for (var id in session_tab_group) {
			if (tab_groups_in_use.indexOf(parseInt(id)) == -1) {
				delete session_tab_group[id];
				deleted_count++;
			}
		};
		
		if (deleted_count) {
			if (deleted_count == parseInt(session_tab_groups.totalNumber)) {
				session_tab_group = null;
				session_tab_groups = null;
				delete aWinData.extData["tabview-groups"];
				delete aWinData.extData["tabview-group"];
			}
			else {
				// update total group count
				session_tab_groups.totalNumber = parseInt(session_tab_groups.totalNumber) - deleted_count;
				// if active group removed, switch to new active group
				if (tab_groups_in_use.indexOf(session_tab_groups.activeGroupId) == -1)
					session_tab_groups.activeGroupId = tab_groups_in_use[0];
				// save new tab group data
				aWinData.extData["tabview-groups"] = Utils.JSON_encode(session_tab_groups);
				aWinData.extData["tabview-group"] = Utils.JSON_encode(session_tab_group);
			}
		}
		return [session_tab_groups,session_tab_group];
},
	
	// Update the specified window's tab group data
	updateTabGroupData: function(aWindow, tab_group_data) {
		if (tab_group_data) {
			if (!aWindow.extData) 
				aWindow.extData = {};
			this.fixOverlappingTabGroups(aWindow.extData["tabview-ui"], tab_group_data.tabview_group);
			aWindow.extData["tabview-groups"] = Utils.JSON_encode(tab_group_data.tabview_groups);
			aWindow.extData["tabview-group"] = Utils.JSON_encode(tab_group_data.tabview_group);
		}
	}
}