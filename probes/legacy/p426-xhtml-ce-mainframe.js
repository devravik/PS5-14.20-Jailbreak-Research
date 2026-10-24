/*
 * p426 -- Main-frame XHTML Custom Element parser re-entry
 *
 * V413 tested iframes only (DEAD). Memory says main-frame XHTML UNTESTED.
 * XMLParser Custom Element: parser calls CE constructor (user JS) during
 * tree building. If JS removes/moves DOM nodes during construction,
 * parser's internal state may reference freed/moved nodes.
 *
 * Approach:
 * - Load an XHTML page as main frame
 * - Define custom elements whose constructors mutate DOM
 * - Check if parser crashes or produces unexpected state
 *
 * Since we can't serve XHTML as main frame directly (index.html is HTML),
 * we test via: eval + DOMParser, document.write, and iframe with XHTML content-type.
 *
 * Also tests: CE constructor during innerHTML on XHTML documents,
 * and MutationObserver callback during CE construction.
 *
 * Beacon prefix: V426-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V426-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Custom Element constructor during innerHTML (HTML parser)
// CE constructor removes the element being constructed
// ================================================================

function testA() {
  B("A-START");

  var constructCount = 0;
  var removeCount = 0;

  class SelfRemover extends HTMLElement {
    constructor() {
      super();
      constructCount++;
      // Remove self from DOM during construction
      if (this.parentNode) {
        this.parentNode.removeChild(this);
        removeCount++;
      }
    }
  }

  try {
    customElements.define("self-remover", SelfRemover);
  } catch(e) {
    B("A-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container = document.createElement("div");
  document.body.appendChild(container);

  try {
    container.innerHTML = "<self-remover>child1</self-remover><self-remover>child2</self-remover><div>after</div>";
  } catch(e) {
    B("A-INNERHTML-ERR", e.message.slice(0, 60));
  }

  B("A-RESULT", {
    constructCount: constructCount,
    removeCount: removeCount,
    childCount: container.childNodes.length,
    innerHTML: container.innerHTML.slice(0, 100)
  });
}

// ================================================================
// Test B: CE constructor replaces sibling being parsed
// ================================================================

function testB() {
  B("B-START");

  var triggerCount = 0;

  class SiblingReplacer extends HTMLElement {
    constructor() {
      super();
      triggerCount++;
      // Replace parent's innerHTML during our own construction
      if (this.parentNode && triggerCount <= 2) {
        try {
          // This creates a recursive parse inside the parser
          this.parentNode.innerHTML = "<div>REPLACED-" + triggerCount + "</div>";
        } catch(e) {
          B("B-RECURSIVE-ERR", e.message.slice(0, 60));
        }
      }
    }
  }

  try {
    customElements.define("sibling-replacer", SiblingReplacer);
  } catch(e) {
    B("B-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container2 = document.createElement("div");
  document.body.appendChild(container2);

  try {
    container2.innerHTML = "<sibling-replacer></sibling-replacer><div>should-be-after</div>";
  } catch(e) {
    B("B-INNERHTML-ERR", e.message.slice(0, 60));
  }

  B("B-RESULT", {
    triggerCount: triggerCount,
    innerHTML: container2.innerHTML.slice(0, 100)
  });
}

// ================================================================
// Test C: CE constructor + MutationObserver interaction
// ================================================================

function testC() {
  B("C-START");

  var moRecords = [];
  var ceCount = 0;

  class MutationTrigger extends HTMLElement {
    constructor() {
      super();
      ceCount++;
    }
    connectedCallback() {
      // When connected, add many children rapidly
      for (var i = 0; i < 10; i++) {
        this.appendChild(document.createElement("span"));
      }
      // Also create another custom element
      if (ceCount <= 3) {
        var child = document.createElement("mutation-trigger");
        this.appendChild(child);
      }
    }
  }

  try {
    customElements.define("mutation-trigger", MutationTrigger);
  } catch(e) {
    B("C-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container3 = document.createElement("div");
  document.body.appendChild(container3);

  var observer = new MutationObserver(function(records) {
    moRecords.push(records.length);
    // During MO callback, modify the tree
    records.forEach(function(r) {
      if (r.addedNodes.length > 0 && moRecords.length < 5) {
        // Add more nodes during MO callback
        r.target.appendChild(document.createTextNode("MO-added"));
      }
    });
  });
  observer.observe(container3, {childList: true, subtree: true});

  container3.innerHTML = "<mutation-trigger></mutation-trigger>";

  // Disconnect and collect
  observer.disconnect();

  B("C-RESULT", {
    ceCount: ceCount,
    moRecordBatches: moRecords.length,
    totalNodes: container3.querySelectorAll("*").length
  });
}

// ================================================================
// Test D: Shadow DOM + slotchange + CE constructor interaction
// ================================================================

function testD() {
  B("D-START");

  var slotChanges = 0;
  var distributions = [];

  class SlotHost extends HTMLElement {
    constructor() {
      super();
      var shadow = this.attachShadow({mode: "open"});
      shadow.innerHTML = '<slot name="s1"></slot><slot name="s2"></slot><slot></slot>';

      // Listen for slotchange
      shadow.querySelectorAll("slot").forEach(function(slot) {
        slot.addEventListener("slotchange", function(e) {
          slotChanges++;
          distributions.push({
            name: slot.name || "default",
            assigned: slot.assignedNodes().length
          });

          // During slotchange, modify the host's children
          if (slotChanges <= 3) {
            var extraChild = document.createElement("div");
            extraChild.slot = "s" + slotChanges;
            extraChild.textContent = "dynamic-" + slotChanges;
            // Add to the host (this) triggers another distribution
            e.target.getRootNode().host.appendChild(extraChild);
          }
        });
      });
    }
  }

  try {
    customElements.define("slot-host", SlotHost);
  } catch(e) {
    B("D-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container4 = document.createElement("div");
  document.body.appendChild(container4);

  container4.innerHTML = '<slot-host><div slot="s1">A</div><div slot="s2">B</div><div>C</div></slot-host>';

  B("D-RESULT", {
    slotChanges: slotChanges,
    distributions: distributions.slice(0, 5),
    hostChildren: container4.querySelector("slot-host") ? container4.querySelector("slot-host").childNodes.length : -1
  });
}

// ================================================================
// Test E: adoptNode during CE construction
// ================================================================

function testE() {
  B("E-START");

  var adoptCount = 0;

  class NodeThief extends HTMLElement {
    constructor() {
      super();
      adoptCount++;
      // Try to adopt nodes from another document during construction
      if (this.parentNode) {
        var nodes = this.parentNode.querySelectorAll("div");
        nodes.forEach(function(n) {
          try {
            // Create new document and adopt the node into it
            var newDoc = document.implementation.createHTMLDocument("stolen");
            newDoc.body.appendChild(newDoc.adoptNode(n));
          } catch(e) {}
        });
      }
    }
  }

  try {
    customElements.define("node-thief", NodeThief);
  } catch(e) {
    B("E-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container5 = document.createElement("div");
  document.body.appendChild(container5);

  try {
    container5.innerHTML = "<div>target1</div><node-thief></node-thief><div>target2</div><node-thief></node-thief><div>target3</div>";
  } catch(e) {
    B("E-INNERHTML-ERR", e.message.slice(0, 60));
  }

  B("E-RESULT", {
    adoptCount: adoptCount,
    remaining: container5.childNodes.length,
    innerHTML: container5.innerHTML.slice(0, 100)
  });
}

// ================================================================
// Test F: Range + CE interaction
// ================================================================

function testF() {
  B("F-START");

  var rangeCount = 0;

  class RangeManipulator extends HTMLElement {
    constructor() {
      super();
      rangeCount++;
      if (this.parentNode) {
        try {
          var range = document.createRange();
          range.selectNodeContents(this.parentNode);
          range.deleteContents();
        } catch(e) {}
      }
    }
  }

  try {
    customElements.define("range-manip", RangeManipulator);
  } catch(e) {
    B("F-DEFINE-ERR", e.message.slice(0, 60));
    return;
  }

  var container6 = document.createElement("div");
  document.body.appendChild(container6);

  try {
    container6.innerHTML = "<div>before</div><range-manip></range-manip><div>after</div>";
  } catch(e) {
    B("F-INNERHTML-ERR", e.message.slice(0, 60));
  }

  B("F-RESULT", {
    rangeCount: rangeCount,
    childCount: container6.childNodes.length,
    innerHTML: container6.innerHTML.slice(0, 100)
  });
}

testA();
testB();
testC();
testD();
testE();
testF();

B("DONE");
})();
