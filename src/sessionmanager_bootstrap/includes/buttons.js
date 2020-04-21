/* ***** BEGIN LICENSE BLOCK *****
* Version: MIT/X11 License
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
* THE SOFTWARE.
*
* Contributor(s):
* Dmitry Gutov <dgutov@yandex.ru> (Original Author)
* Erik Vold <erikvvold@gmail.com>
* Michael Kraft <morac99-firefox2@yahoo.com>
*
* ***** END LICENSE BLOCK ***** */

var australis = false;
try {
  Components.utils.import("resource:///modules/CustomizableUI.jsm");
  australis = true;
}
catch(ex) {}

(function(global) {
  let positions = {};
  
  /*
   * Assigns position that will be used by `restorePosition`
   * if the button is not found on any toolbar's current set.
   * If `beforeID` is null, or no such item is found on the toolbar,
   * the button will be added to the end.
   * @param beforeID ID of the element before which the button will be inserted.
   */
  global.setDefaultPosition = function(buttonID, toolbarID, beforeID) {
    positions[buttonID] = [toolbarID, beforeID];
  };
  
  /*
   * Restores the button's saved position.
   * @param {XULDocument} doc - XUL window document.
   * @param {XULElement} button - button element or array of button elements.
   */
  global.restorePosition = function(doc, button) {
    function $(sel, all)
      doc[all ? "querySelectorAll" : "getElementById"](sel);
  
    // If array of button, add them all at once in correct order
    if (Array.isArray(button)) {
      let pendingAdds = [];
      for (let i=0; i < button.length; i++) {
        let params = findRestoreLocation(doc, button[i]);
        // If new install, just add the button, otherwise save to add later
        if (params.newInstall)
          performRestore(doc, button[i], params);
        else 
          pendingAdds.push({buttonIdx: i, params: params});
      }
      if (pendingAdds.length > 0) {
        // sort so rightmost buttons get added first
        pendingAdds = pendingAdds.sort(function(a,b) {
          return a.params.idx > b.params.idx;
        });
        for (let i=0; i < pendingAdds.length; i++)
          performRestore(doc, button[pendingAdds[i].buttonIdx], pendingAdds[i].params);
      }
    }
    else {
      let params = findRestoreLocation(doc, button);
      performRestore(doc, button, params);
    }
  }

  function findRestoreLocation(doc, button) {
    if (australis)
      return findRestoreLocationNew(button);
    else
      return findRestoreLocationOld(doc, button);
  }
  
  /* 
   * Find restore location for Australis 
   */
  function findRestoreLocationNew(button) {
    let area = null, idx = null, newInstall = false;
    
    let placement = CustomizableUI.getPlacementOfWidget(button.id);
    if (placement) {
      area = placement.area;
      idx = placement.position;
    }
    else if (button.id in positions) {
      // saved position not found, using the default one, if any
      let [areaID, beforeID] = positions[button.id];
      let placement = CustomizableUI.getPlacementOfWidget(beforeID);
      if (placement) {
        area = placement.area;
        idx = placement.position - 1;
        if (idx < 0) 
          idx = 0;
      }
      else if (CustomizableUI.getAreaType(areaID) != null)
        area = areaID;
        
      newInstall = true;
    }

    return { area: area, idx: idx, newInstall: newInstall };
  }
  
  /* 
   * Find restore location in non-Australis 
   */
  function findRestoreLocationOld(doc, button) {
    function $(sel, all)
      doc[all ? "querySelectorAll" : "getElementById"](sel);

    let toolbar, currentset, idx, newInstall = false,
        toolbars = $("toolbar", true);
    for (let i = 0; i < toolbars.length; ++i) {
      let tb = toolbars[i];
      currentset = tb.getAttribute("currentset").split(",");
      idx = currentset.indexOf(button.id);
      if (idx != -1) {
        toolbar = tb;
        break;
      }
    }
    
    // saved position not found, using the default one, if any
    if (!toolbar && (button.id in positions)) {
      let [tbID, beforeID] = positions[button.id];
      toolbar = $(tbID);
      [currentset, idx] = persist(doc, toolbar, button.id, beforeID);
      newInstall = true;
    }

    return { toolbarId: (toolbar ? toolbar.id : null), currentset: currentset, idx: idx, newInstall: newInstall };
  }
  
  /* 
   * Perform restore
   */
  function performRestore(doc, button, aParams) {
    if (australis)
      performRestoreNew(doc, button, aParams);
    else
      performRestoreOld(doc, button, aParams);
  }
  
  /* 
   * Perform restore in Australis 
   */
  function performRestoreNew(doc, button, aParams) {
    function $(sel, all)
      doc[all ? "querySelectorAll" : "getElementById"](sel);

    // Add to Toolbar palette
    ($("navigator-toolbox") || $("mail-toolbox")).palette.appendChild(button);

    let area = aParams.area, idx = aParams.idx, newInstall = aParams.newInstall;
    
    if (area) {
      CustomizableUI.addWidgetToArea(button.id, area, idx);
      CustomizableUI.ensureWidgetPlacedInWindow(button.id, doc.defaultView);

      // remove from positions so doesn't keep getting added in new windows
      delete positions[button.id];
    }
  };
  
  /* 
   * Perform restore in non-Australis 
   */
  function performRestoreOld(doc, button, aParams) {
    function $(sel, all)
      doc[all ? "querySelectorAll" : "getElementById"](sel);

    // Add to Toolbar palette
    ($("navigator-toolbox") || $("mail-toolbox")).palette.appendChild(button);

    let toolbar = (aParams.toolbarId ? $(aParams.toolbarId) : null), currentset = aParams.currentset, 
      idx = aParams.idx, newInstall = aParams.newInstall;
    
    if (toolbar) {
      // If using add-on toolbar and it's hidden, show it
      if ((toolbar.id == "addon-bar") && (toolbar.getAttribute("collapsed") == "true"))
        toolbar.setAttribute("collapsed", "false");

      let before = null;
      if (idx != -1) {
        // Need to get ids for separators so can insert in front of them if need be.
        let separators = toolbar.getElementsByTagName("toolbarseparator");
        let j=0;
        for (let i =0; ((i < currentset.length) && (j < separators.length)); ++i) 
          if (currentset[i] == "separator")
            currentset[i] = separators[j++].id

        // inserting the button before the first item in `currentset`
        // after `idx` that is present in the document
        for (let i = idx + 1; i < currentset.length; ++i) {
          before = $(currentset[i]);
          if (before) 
            break;
        }
      }
      toolbar.insertItem(button.id, before);
      if (newInstall) {
        toolbar.setAttribute("currentset", toolbar.currentSet);
        doc.persist(toolbar.id, "currentset");
      }

      // remove from positions so doesn't keep getting added in new windows
      delete positions[button.id];
    }
  };

  function persist(document, toolbar, buttonID, beforeID) {
    let currentset = toolbar.currentSet.split(","),
        idx = (beforeID && currentset.indexOf(beforeID)) || -1;
    if (idx != -1) {
      currentset.splice(idx, 0, buttonID);
    } else {
      currentset.push(buttonID);
    }
    return [currentset, idx];
  }
})(this);
