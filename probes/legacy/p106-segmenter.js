/* p106 — Intl.Segmenter edge cases + DFG-specific attack surfaces
 *
 * Intl.Segmenter is confirmed available on PS5 and used by Coruna.
 * Test iterator lifecycle, concurrent iteration, and edge cases
 * that could trigger corruption in JSC's Segmenter implementation.
 *
 * Also tests: RegExp JIT edge cases, JSON.parse deep nesting,
 * Proxy traps during JIT, generator/iterator corruption.
 *
 * Beacon prefix: V106J-
 */
(function(){
var RUN_ID = "v106j" + Math.random().toString(36).slice(2,12);
var PREFIX = "V106J-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press106-segmenter");

/* ====== J1: Segmenter basic + iterator lifecycle ====== */
function test_J1() {
  var r = {};
  try {
    // Verify Segmenter exists and works
    r.exists = typeof Intl.Segmenter !== 'undefined';
    if (!r.exists) { B("J1-SEG", r); return; }

    var seg = new Intl.Segmenter('en', {granularity: 'word'});
    r.segType = typeof seg;

    var str = "Hello world, this is a test string for segmentation.";
    var segments = seg.segment(str);
    r.segmentsType = typeof segments;

    // Iterate
    var items = [];
    for (var s of segments) {
      items.push(s.segment);
    }
    r.count = items.length;
    r.first = items[0];
    r.last = items[items.length - 1];

    // Test all granularities
    var granularities = ['grapheme', 'word', 'sentence'];
    var gcounts = {};
    for (var g of granularities) {
      var s2 = new Intl.Segmenter('en', {granularity: g});
      var count = 0;
      for (var seg2 of s2.segment(str)) count++;
      gcounts[g] = count;
    }
    r.granularities = gcounts;

    // containing() method
    var segs = seg.segment(str);
    try {
      var at5 = segs.containing(5);
      r.containing5 = at5 ? at5.segment : 'null';
      r.CONTAINING_WORKS = true;
    } catch(e) {
      r.containingErr = e.name;
    }

    r.SURVIVED = true;
    B("J1-SEG-BASIC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J1-ERR", r); }
}

/* ====== J2: Segmenter iterator reuse + concurrent iteration ====== */
function test_J2() {
  var r = {};
  try {
    var seg = new Intl.Segmenter('en', {granularity: 'grapheme'});
    var str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    var segments = seg.segment(str);

    // Get two iterators from same Segments object
    var iter1 = segments[Symbol.iterator]();
    var iter2 = segments[Symbol.iterator]();

    // Advance iter1 partially
    var v1 = [];
    for (var i = 0; i < 5; i++) {
      var next = iter1.next();
      if (!next.done) v1.push(next.value.segment);
    }
    r.iter1_first5 = v1.join('');

    // Now advance iter2 — should start from beginning
    var v2 = [];
    for (var i = 0; i < 5; i++) {
      var next = iter2.next();
      if (!next.done) v2.push(next.value.segment);
    }
    r.iter2_first5 = v2.join('');
    r.INDEPENDENT = (r.iter1_first5 === r.iter2_first5);

    // Continue iter1
    var v1rest = [];
    var next;
    while (!(next = iter1.next()).done) {
      v1rest.push(next.value.segment);
    }
    r.iter1_rest = v1rest.join('');

    // Reuse after exhaustion
    var v1reuse = iter1.next();
    r.exhausted = v1reuse.done;

    // Create iterator, modify underlying... (can we?)
    // Segments object is bound to a string (immutable), so no mutation
    // But what about the Segmenter itself?

    r.SURVIVED = true;
    B("J2-SEG-ITER", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J2-ERR", r); }
}

/* ====== J3: Segmenter with adversarial strings ====== */
function test_J3() {
  var r = {};
  try {
    var seg = new Intl.Segmenter('en', {granularity: 'grapheme'});

    // Empty string
    var count0 = 0;
    for (var s of seg.segment("")) count0++;
    r.empty = count0;

    // Very long string
    var longStr = "A".repeat(100000);
    var countLong = 0;
    for (var s of seg.segment(longStr)) countLong++;
    r.long100k = countLong;

    // Unicode edge cases
    var emoji = "😀😁😂"; // 3 emoji
    var countEmoji = 0;
    for (var s of seg.segment(emoji)) countEmoji++;
    r.emoji = countEmoji;

    // Surrogate pairs
    var surrogates = "𐀀𐀁𐀂";
    var countSurr = 0;
    for (var s of seg.segment(surrogates)) countSurr++;
    r.surrogates = countSurr;

    // Lone surrogates (invalid UTF-16)
    var loneSurr = "\uD800X\uDC00Y";
    var countLone = 0;
    var loneSegments = [];
    for (var s of seg.segment(loneSurr)) {
      countLone++;
      loneSegments.push(s.segment.length + ':' + s.index);
    }
    r.loneSurrogates = countLone;
    r.loneDetail = loneSegments.join('|');

    // Null characters
    var nullStr = "A\0B\0C";
    var countNull = 0;
    for (var s of seg.segment(nullStr)) countNull++;
    r.nullChars = countNull;

    // ZWJ sequences (family emoji)
    var zwj = "👨‍👩‍👧‍👦";
    var countZwj = 0;
    for (var s of seg.segment(zwj)) countZwj++;
    r.zwj = countZwj;

    r.SURVIVED = true;
    B("J3-SEG-ADVERSARIAL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J3-ERR", r); }
}

/* ====== J4: Segmenter with Symbol.iterator override ====== */
function test_J4() {
  var r = {};
  try {
    var seg = new Intl.Segmenter('en', {granularity: 'word'});
    var segments = seg.segment("Hello world test");

    // Try to override the iterator
    var origIter = segments[Symbol.iterator];
    r.hasIterator = typeof origIter === 'function';

    // Prototype pollution on Segments
    var proto = Object.getPrototypeOf(segments);
    r.protoName = proto.constructor ? proto.constructor.name : 'unknown';

    // Get segment data for containing at boundary
    try {
      var boundary = segments.containing(0);
      r.boundary0 = boundary ? boundary.segment : 'null';
      var boundary5 = segments.containing(5);
      r.boundary5 = boundary5 ? boundary5.segment : 'null';

      // containing() at invalid indices
      var boundaryNeg = segments.containing(-1);
      r.boundaryNeg = boundaryNeg === undefined ? 'undef' : 'exists';

      var boundaryBig = segments.containing(99999);
      r.boundaryBig = boundaryBig === undefined ? 'undef' : 'exists';
    } catch(e) {
      r.boundaryErr = e.name + ':' + e.message.slice(0,30);
    }

    // Try to access internal slots
    r.segKeys = Object.getOwnPropertyNames(proto).join(',');

    r.SURVIVED = true;
    B("J4-SEG-OVERRIDE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J4-ERR", r); }
}

/* ====== J5: Segmenter + DFG interaction ====== */
function test_J5() {
  var r = {};
  try {
    // JIT-compile a function that uses Segmenter
    var seg = new Intl.Segmenter('en', {granularity: 'grapheme'});

    function hotSeg(str) {
      var segments = seg.segment(str);
      var count = 0;
      for (var s of segments) count++;
      return count;
    }

    // Warmup with consistent string
    for (var i = 0; i < 10000; i++) {
      hotSeg("test" + (i & 7));
    }
    r.warmupDone = true;

    // Now call with adversarial input
    var result1 = hotSeg("\uD800"); // lone surrogate
    r.loneSurr = result1;

    var result2 = hotSeg(""); // empty
    r.empty = result2;

    var result3 = hotSeg("\0\0\0"); // null bytes
    r.nullBytes = result3;

    // Very different length
    var result4 = hotSeg("A".repeat(10000));
    r.long10k = result4;

    r.SURVIVED = true;
    B("J5-SEG-DFG", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J5-ERR", r); }
}

/* ====== J6: RegExp JIT edge cases ====== */
function test_J6() {
  var r = {};
  try {
    // Large quantifiers
    try {
      var re1 = new RegExp("a{0,99999}");
      r.largeQuant = re1.test("a".repeat(1000));
    } catch(e) { r.largeQuantErr = e.name; }

    // Deeply nested groups
    try {
      var pattern = "";
      for (var i = 0; i < 100; i++) pattern += "(";
      pattern += "a";
      for (var i = 0; i < 100; i++) pattern += ")";
      var re2 = new RegExp(pattern);
      var match = re2.exec("a");
      r.deepGroups = match ? match.length : 'no match';
    } catch(e) { r.deepGroupsErr = e.name; }

    // Catastrophic backtracking (limited)
    try {
      var re3 = /^(a+)+$/;
      var t0 = Date.now();
      re3.test("a".repeat(20) + "b");
      r.backtrackMs = Date.now() - t0;
    } catch(e) { r.backtrackErr = e.name; }

    // Unicode regex
    try {
      var re4 = /\p{Emoji}/u;
      r.unicodeProp = re4.test("😀");
      r.UNICODE_REGEX = true;
    } catch(e) { r.unicodeErr = e.name; }

    // Named capture groups
    try {
      var re5 = /(?<year>\d{4})-(?<month>\d{2})/;
      var m = re5.exec("2024-01");
      r.namedCapture = m ? m.groups.year : 'no match';
    } catch(e) { r.namedErr = e.name; }

    // Lookbehind
    try {
      var re6 = /(?<=@)\w+/;
      r.lookbehind = re6.exec("user@test") ? re6.exec("user@test")[0] : 'no';
      r.LOOKBEHIND = true;
    } catch(e) { r.lookbehindErr = e.name; }

    // DFG-compiled regex
    function hotRegex(str) {
      return /^[a-z]+\d+$/.test(str);
    }
    for (var i = 0; i < 100000; i++) hotRegex("abc" + i);
    r.hotRegexDone = true;

    // Feed adversarial input to hot regex
    r.nullInRegex = hotRegex("abc\0123");
    r.longRegex = hotRegex("a".repeat(10000) + "1");
    r.emojiRegex = hotRegex("😀");

    r.SURVIVED = true;
    B("J6-REGEXP", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J6-ERR", r); }
}

/* ====== J7: Proxy + DFG interaction ====== */
function test_J7() {
  var r = {};
  try {
    // Proxy traps during DFG-compiled property access
    var trapCount = 0;
    var handler = {
      get: function(target, prop) {
        trapCount++;
        return target[prop];
      }
    };

    var target = {x: 1.1, y: 2.2, arr: [1.1, 2.2, 3.3]};
    var proxy = new Proxy(target, handler);

    function hotProxy(obj) {
      return obj.x + obj.y;
    }

    // Warmup with plain object
    for (var i = 0; i < 100000; i++) {
      hotProxy({x: i + 0.1, y: i + 0.2});
    }
    r.warmupDone = true;

    // Now call with Proxy
    trapCount = 0;
    var result = hotProxy(proxy);
    r.proxyResult = result;
    r.trapCount = trapCount;
    r.PROXY_WORKS = (result === 3.3 && trapCount === 2);

    // Mutating proxy — changes type during access
    var mutateCount = 0;
    var mutHandler = {
      get: function(target, prop) {
        mutateCount++;
        if (prop === 'y' && mutateCount > 2) {
          target.x = {};  // mutate during access
        }
        return target[prop];
      }
    };
    var mutTarget = {x: 1.1, y: 2.2};
    var mutProxy = new Proxy(mutTarget, mutHandler);

    mutateCount = 0;
    var mutResult = hotProxy(mutProxy);
    r.mutResult = typeof mutResult === 'number' ? mutResult : typeof mutResult;
    r.mutCount = mutateCount;

    r.SURVIVED = true;
    B("J7-PROXY-DFG", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J7-ERR", r); }
}

/* ====== J8: Generator/Iterator protocol corruption ====== */
function test_J8() {
  var r = {};
  try {
    // Custom iterator with mutable state
    function makeIter(arr) {
      var idx = 0;
      return {
        [Symbol.iterator]: function() { return this; },
        next: function() {
          if (idx >= arr.length) return {done: true};
          return {done: false, value: arr[idx++]};
        }
      };
    }

    // DFG-compile for-of with custom iterator
    function sumIter(iter) {
      var s = 0;
      for (var v of iter) s += v;
      return s;
    }

    for (var i = 0; i < 50000; i++) {
      sumIter(makeIter([1, 2, 3]));
    }
    r.warmupDone = true;

    // Adversarial iterator — changes behavior mid-iteration
    var callCount = 0;
    var evilIter = {
      [Symbol.iterator]: function() { return this; },
      next: function() {
        callCount++;
        if (callCount > 100) return {done: true};
        if (callCount === 50) return {done: false, value: {}}; // type change!
        return {done: false, value: callCount};
      }
    };

    callCount = 0;
    var evilResult = sumIter(evilIter);
    r.evilResult = typeof evilResult;
    r.evilStr = String(evilResult).slice(0, 50);
    r.callCount = callCount;

    // Iterator that throws mid-iteration
    var throwIter = {
      [Symbol.iterator]: function() { return this; },
      next: function() {
        callCount++;
        if (callCount > 5) throw new Error("boom");
        return {done: false, value: callCount};
      }
    };

    callCount = 0;
    try {
      sumIter(throwIter);
      r.throwCaught = false;
    } catch(e) {
      r.throwCaught = true;
    }

    r.SURVIVED = true;
    B("J8-ITERATOR", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_J1();                     // Segmenter basic (0ms)
  setTimeout(test_J2, 2000);     // Segmenter iterator reuse (2s)
  setTimeout(test_J3, 4000);     // Segmenter adversarial strings (4s)
  setTimeout(test_J4, 7000);     // Segmenter override (7s)
  setTimeout(test_J5, 10000);    // Segmenter + DFG (10s)
  setTimeout(test_J6, 15000);    // RegExp JIT (15s)
  setTimeout(test_J7, 20000);    // Proxy + DFG (20s)
  setTimeout(test_J8, 25000);    // Iterator protocol (25s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe106-done"); }, 45000);
})();
