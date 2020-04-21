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
 * The Original Code is Speak Words.
 *
 * The Initial Developer of the Original Code is The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Edward Lee <edilee@mozilla.com>
 *   Erik Vold <erikvvold@gmail.com>
 *   Michael Kraft <morac99-firefox2@yahoo.com>
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

const NORMAL = 0, LAST = 1;

/**
 * Save callbacks to run when unloading. Optionally scope the callback to a
 * container, e.g., window. Provide a way to run all the callbacks.
 *
 * @usage unload(): Run all callbacks and release them.
 *
 * @usage unload(callback): Add a callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @return [function]: A 0-parameter function that undoes adding the callback.
 *
 * @usage unload(callback, container, after) Add a scoped callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @param [node] container: Remove the callback when this container unloads.
 * @param [boolean] last: Unload after other unloaders that don't set this parameter
 * @return [function]: A 0-parameter function that undoes adding the callback.
 */
exports.unload = function unload(callback, container, last) {
  // Initialize the double array of unloaders on the first usage
  let unloaders = unload.unloaders;
  if (unloaders == null)
    unloaders = unload.unloaders = [[],[]];

  // Calling with no arguments runs all the unloader callbacks
  if (callback == null) {
		// combine normal and last arrays into one array with last being last
		unloaders = unloaders[NORMAL].concat(unloaders[LAST]);
    unloaders.slice().forEach(function(unloader) unloader());
    unloaders.length = 0;
    return;
  }

  // The callback is bound to the lifetime of the container if we have one
  if (container != null) {
    // Remove the unloader when the container unloads
    container.addEventListener("unload", unloader, false);

    // Wrap the callback to additionally remove the unload listener
    let origCallback = callback;
    callback = function(aEvent) {
      container.removeEventListener("unload", unloader, false);
      removeUnloader();
      origCallback(aEvent);
    }
  }

  // Wrap the callback in a function that ignores failures
  function unloader(aEvent) {
    try {
      callback(aEvent);
    }
    catch(ex) { Components.utils.reportError(ex + "\n" + ex.stack); }
  }
  unloaders[last ? LAST : NORMAL].push(unloader);

  // Provide a way to remove the unloader
  function removeUnloader() {
		for (let i=NORMAL; i<LAST; i++) {
			let index = unloaders[i].indexOf(unloader);
			if (index != -1)
				unloaders[i].splice(index, 1);
		}
  }
  return removeUnloader;
}
