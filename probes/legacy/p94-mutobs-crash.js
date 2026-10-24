/* p94-mutobs — Isolate MutationObserver crash from p93 E3
 *
 * E3 killed the WebView. Isolate which component:
 * A. MutationObserver infinite mutation loop alone
 * B. Range manipulation alone
 * C. MutationObserver + Range (no SVG)
 * D. MutationObserver cascade with mutation limit
 * E. Range.surroundContents on MutationObserver-modified tree
 *
 * Key: MutObserver callback creates new mutations → infinite microtask loop
 * This starves macrotasks (heartbeats/setTimeout). Need to determine
 * if it's a hang (DoS) or crash (memory corruption).
 *
 * Beacon prefix: V94M-
 */
(function(){
"use strict";
var RUN_ID = "v94m" + Math.random().toString(36).slice(2,12);
var PREFIX = "V94M-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press94-mutobs-crash");

/* ====== A1: MutationObserver with BOUNDED cascade ====== */
function test_A1() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);

    var callbackCount = 0;
    var totalMutations = 0;
    var MAX_CALLBACKS = 50; // safety limit

    var observer = new MutationObserver(function(records) {
      callbackCount++;
      totalMutations += records.length;
      if (callbackCount >= MAX_CALLBACKS) return; // STOP cascading

      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length > 0) {
          for (var j = 0; j < records[i].addedNodes.length; j++) {
            var node = records[i].addedNodes[j];
            if (node.nodeType === 1 && !node.getAttribute('data-mut')) {
              node.setAttribute('data-mut', '1');
              var s = document.createElement('i');
              s.textContent = 'x';
              node.appendChild(s);
            }
          }
        }
      }
    });

    observer.observe(container, { childList: true, subtree: true, attributes: true });

    // Trigger mutations
    container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

    // Use setTimeout to check state after microtask cascade settles
    setTimeout(function() {
      observer.disconnect();
      r.callbackCount = callbackCount;
      r.totalMutations = totalMutations;
      r.children = container.children.length;
      r.innerHTML = container.innerHTML.slice(0, 200);
      r.CASCADE = callbackCount >= MAX_CALLBACKS;
      container.remove();
      B("A1-BOUNDED-CASCADE", r);
    }, 1000);

  } catch(e) { r.err = e.message.slice(0, 80); B("A1-BOUNDED-CASCADE", r); }
}

/* ====== A2: Range manipulation alone (no MutObserver) ====== */
function test_A2() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);
    container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

    // Extract and re-insert
    var range = document.createRange();
    range.selectNodeContents(container);
    var frag = range.extractContents();
    r.extractOK = true;
    r.fragChildren = frag.childNodes.length;
    container.appendChild(frag);
    r.reinsertOK = true;

    // surroundContents
    try {
      var range2 = document.createRange();
      if (container.firstChild && container.firstChild.firstChild) {
        range2.setStart(container.firstChild.firstChild, 0);
        if (container.firstChild.lastChild) {
          var endNode = container.firstChild.lastChild;
          var endOffset = endNode.textContent ? endNode.textContent.length : 0;
          range2.setEnd(endNode, endOffset);
        }
        var wrapper = document.createElement('mark');
        range2.surroundContents(wrapper);
        r.surroundOK = true;
      }
    } catch(e) {
      r.surroundErr = e.name + ":" + e.message.slice(0, 50);
    }

    r.SURVIVED = true;
    r.finalHTML = container.innerHTML.slice(0, 200);
    container.remove();

  } catch(e) { r.err = e.message.slice(0, 80); }
  B("A2-RANGE-ONLY", r);
}

/* ====== A3: MutObs bounded + Range (the crash combo, with safety limit) ====== */
function test_A3() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);
    container.innerHTML = '<p>initial <b>bold</b> text</p>';

    var callbackCount = 0;
    var MAX = 30;
    var observer = new MutationObserver(function(records) {
      callbackCount++;
      if (callbackCount >= MAX) return;
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length > 0) {
          for (var j = 0; j < records[i].addedNodes.length; j++) {
            var node = records[i].addedNodes[j];
            if (node.nodeType === 1 && !node.getAttribute('data-mut')) {
              node.setAttribute('data-mut', '1');
              node.appendChild(document.createElement('i'));
            }
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });

    container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

    // Range manipulation while MutObserver is active (but bounded)
    try {
      var range = document.createRange();
      range.selectNodeContents(container);
      var frag = range.extractContents();
      container.appendChild(frag);
      r.extractOK = true;
    } catch(e) {
      r.extractErr = e.message.slice(0, 50);
    }

    try {
      var range2 = document.createRange();
      if (container.firstChild && container.firstChild.firstChild) {
        range2.setStart(container.firstChild.firstChild, 0);
        if (container.firstChild.lastChild) {
          range2.setEnd(container.firstChild.lastChild,
            container.firstChild.lastChild.textContent ?
            container.firstChild.lastChild.textContent.length : 0);
        }
        var wrapper = document.createElement('mark');
        range2.surroundContents(wrapper);
        r.surroundOK = true;
      }
    } catch(e) {
      r.surroundErr = e.name + ":" + e.message.slice(0, 50);
    }

    setTimeout(function() {
      observer.disconnect();
      r.callbackCount = callbackCount;
      r.SURVIVED = true;
      r.children = container.children.length;
      container.remove();
      B("A3-MUTOBS-RANGE", r);
    }, 1000);

  } catch(e) { r.err = e.message.slice(0, 80); B("A3-MUTOBS-RANGE", r); }
}

/* ====== A4: MutObs UNBOUNDED + Range — the actual crash test ====== */
/* Runs LAST — this is what we believe crashes */
function test_A4() {
  B("A4-START", "begin-danger");
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);
    container.innerHTML = '<p>initial <b>bold</b> text</p>';

    var callbackCount = 0;
    // NO LIMIT — let it cascade
    var observer = new MutationObserver(function(records) {
      callbackCount++;
      // Only stop at 500 to prevent true infinite loop
      if (callbackCount > 500) {
        observer.disconnect();
        return;
      }
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length > 0) {
          for (var j = 0; j < records[i].addedNodes.length; j++) {
            var node = records[i].addedNodes[j];
            if (node.nodeType === 1 && !node.getAttribute('data-mut')) {
              node.setAttribute('data-mut', '1');
              var s = document.createElement('i');
              s.textContent = 'mut';
              node.appendChild(s);
            }
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });

    // Trigger the cascade
    container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

    // Range manipulation during cascade
    try {
      var range = document.createRange();
      range.selectNodeContents(container);
      var frag = range.extractContents();
      container.appendChild(frag);
    } catch(e) {
      r.extractErr = e.message.slice(0, 50);
    }

    try {
      if (container.firstChild && container.firstChild.firstChild) {
        var range2 = document.createRange();
        range2.setStart(container.firstChild.firstChild, 0);
        if (container.firstChild.lastChild) {
          range2.setEnd(container.firstChild.lastChild,
            container.firstChild.lastChild.textContent ?
            container.firstChild.lastChild.textContent.length : 0);
        }
        var wrapper = document.createElement('mark');
        range2.surroundContents(wrapper);
        r.surroundOK = true;
      }
    } catch(e) {
      r.surroundErr = e.message.slice(0, 50);
    }

    // If we survive the synchronous part, beacon immediately
    r.syncSurvived = true;
    r.callbackCountSync = callbackCount;
    B("A4-SYNC-OK", r);

    setTimeout(function() {
      observer.disconnect();
      r.callbackCount = callbackCount;
      r.SURVIVED = true;
      r.children = container.children.length;
      container.remove();
      B("A4-UNBOUNDED-RANGE", r);
    }, 3000);

  } catch(e) { r.err = e.message.slice(0, 80); B("A4-ERR", r); }
}

/* ====== A5: MutObs UNBOUNDED + innerHTML (NO Range) ====== */
function test_A5() {
  B("A5-START", "begin");
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);

    var callbackCount = 0;
    var observer = new MutationObserver(function(records) {
      callbackCount++;
      if (callbackCount > 500) { observer.disconnect(); return; }
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length > 0) {
          for (var j = 0; j < records[i].addedNodes.length; j++) {
            var node = records[i].addedNodes[j];
            if (node.nodeType === 1 && !node.getAttribute('data-mut')) {
              node.setAttribute('data-mut', '1');
              node.appendChild(document.createElement('i'));
            }
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });

    // Just innerHTML, NO Range manipulation
    container.innerHTML = '<div>a <span>b</span></div><div>c <span>d</span></div>';

    // Beacon SYNCHRONOUSLY to see if we survive innerHTML + cascade
    r.syncCallbacks = callbackCount;
    B("A5-SYNC", {callbacks: callbackCount});

    setTimeout(function() {
      observer.disconnect();
      r.callbackCount = callbackCount;
      r.SURVIVED = true;
      r.children = container.children.length;
      container.remove();
      B("A5-NORANGE", r);
    }, 3000);

  } catch(e) { r.err = e.message.slice(0, 80); B("A5-ERR", r); }
}

/* ====== Run — safe first, crash test LAST ====== */
try {
  test_A1(); // bounded cascade — safe
  test_A2(); // range only — safe
  setTimeout(test_A3, 3000);  // bounded mutobs + range — safe
  setTimeout(test_A5, 7000);  // unbounded mutobs, NO range
  setTimeout(test_A4, 14000); // DANGER: unbounded + range (crash test)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe94-done"); }, 30000);
})();
