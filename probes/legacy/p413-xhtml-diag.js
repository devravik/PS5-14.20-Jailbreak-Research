// p413 - XHTML delivery method diagnostic
//
// Tests every possible way to get XHTML+JS+CustomElements running on PS5:
//   T1: HTML baseline (should always work)
//   T2: XHTML Blob URL iframe with CDATA script
//   T3: XHTML Blob URL iframe with src= script
//   T4: Server-served XHTML iframe
//   T5: Server-served XHTML iframe with src= script
//   T6: Define CE from parent on Blob XHTML iframe, then inject
//   T7: HTML iframe innerHTML with registered CE (control test)
//
// Beacon prefix: V413-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V413-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');
  B('CE-' + (typeof customElements !== 'undefined' ? 'OK' : 'NO'));

  var idx = 0;
  var tests = [];

  function runNext() {
    if (idx < tests.length) {
      var t = tests[idx++];
      try { t(); }
      catch(e) { B('T' + idx + '-THROW-' + String(e).substring(0, 60)); setTimeout(runNext, 300); }
    } else {
      B('COMPLETE');
    }
  }

  // T1: HTML baseline
  tests.push(function() {
    B('T1-HTML-OK');
    setTimeout(runNext, 100);
  });

  // T2: XHTML Blob URL iframe with inline CDATA script
  tests.push(function() {
    B('T2-START');
    var xhtml = '<?xml version="1.0"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><title>T2</title></head>\n' +
      '<body>\n' +
      '<script><![CDATA[\n' +
      'window.t2ok = true;\n' +
      'try { new Image().src = "/beacon/V413-T2-INNER-OK?t=" + Date.now(); } catch(e) {}\n' +
      ']]></script>\n' +
      '<p id="t2p">test</p>\n' +
      '</body></html>';
    var blob = new Blob([xhtml], { type: 'application/xhtml+xml' });
    var url = URL.createObjectURL(blob);
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.onload = function() {
      URL.revokeObjectURL(url);
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T2-LOADED');
        B('T2-SCRIPT-' + (w && w.t2ok === true ? 'YES' : 'NO'));
        B('T2-DOM-' + (d && d.getElementById('t2p') ? 'YES' : 'NO'));
        // Check if contentDocument is accessible
        try {
          var t = d.title;
          B('T2-TITLE-' + (t || 'EMPTY'));
        } catch(e) {
          B('T2-CROSSORIGIN');
        }
      } catch(e) {
        B('T2-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    iframe.onerror = function() {
      URL.revokeObjectURL(url);
      B('T2-ONERROR');
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
    iframe.src = url;
  });

  // T3: XHTML Blob URL iframe with external script src
  tests.push(function() {
    B('T3-START');
    var xhtml = '<?xml version="1.0"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><title>T3</title></head>\n' +
      '<body>\n' +
      '<script src="/p413-inner.js"></script>\n' +
      '<p id="t3p">test</p>\n' +
      '</body></html>';
    var blob = new Blob([xhtml], { type: 'application/xhtml+xml' });
    var url = URL.createObjectURL(blob);
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.onload = function() {
      URL.revokeObjectURL(url);
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T3-LOADED');
        B('T3-SCRIPT-' + (w && w.t3ok === true ? 'YES' : 'NO'));
        B('T3-DOM-' + (d && d.getElementById('t3p') ? 'YES' : 'NO'));
      } catch(e) {
        B('T3-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    iframe.onerror = function() {
      URL.revokeObjectURL(url);
      B('T3-ONERROR');
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
    iframe.src = url;
  });

  // T4: Server-served XHTML iframe (real HTTP, proper Content-Type)
  tests.push(function() {
    B('T4-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.onload = function() {
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T4-LOADED');
        B('T4-SCRIPT-' + (w && w.t4ok === true ? 'YES' : 'NO'));
        B('T4-DOM-' + (d && d.getElementById('t4p') ? 'YES' : 'NO'));
        try {
          var t = d.title;
          B('T4-TITLE-' + (t || 'EMPTY'));
        } catch(e) {
          B('T4-CROSSORIGIN');
        }
      } catch(e) {
        B('T4-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    iframe.onerror = function() {
      B('T4-ONERROR');
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
    iframe.src = '/p413-t4.xhtml';
  });

  // T5: Server-served XHTML iframe with external script src
  tests.push(function() {
    B('T5-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.onload = function() {
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T5-LOADED');
        B('T5-SCRIPT-' + (w && w.t5ok === true ? 'YES' : 'NO'));
        B('T5-DOM-' + (d && d.getElementById('t5p') ? 'YES' : 'NO'));
      } catch(e) {
        B('T5-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    iframe.onerror = function() {
      B('T5-ONERROR');
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
    iframe.src = '/p413-t5.xhtml';
  });

  // T6: Define CE from parent on Blob XHTML iframe, then createContextualFragment
  tests.push(function() {
    B('T6-START');
    var xhtml = '<?xml version="1.0"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><title>T6</title></head>\n' +
      '<body><div id="host"></div></body></html>';
    var blob = new Blob([xhtml], { type: 'application/xhtml+xml' });
    var url = URL.createObjectURL(blob);
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.onload = function() {
      URL.revokeObjectURL(url);
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T6-LOADED');

        // Define CE from parent on iframe's window
        var ctorRan = false;
        try {
          var IframeHTMLElement = w.HTMLElement;
          w.customElements.define('t6-ce', class extends IframeHTMLElement {
            constructor() {
              super();
              ctorRan = true;
            }
          });
          B('T6-CE-DEFINED');
        } catch(e) {
          B('T6-CE-DEF-ERR-' + String(e).substring(0, 50));
          iframe.remove();
          setTimeout(runNext, 300);
          return;
        }

        // Try innerHTML on host element (HTML parser path)
        var host = d.getElementById('host');
        if (host) {
          try {
            host.innerHTML = '<t6-ce id="t6el"></t6-ce>';
            B('T6-INNERHTML-OK');
            B('T6-CTOR-' + (ctorRan ? 'YES' : 'NO'));
            var el = d.getElementById('t6el');
            B('T6-ELEM-' + (el ? el.tagName : 'NULL'));
          } catch(e) {
            B('T6-INNERHTML-ERR-' + String(e).substring(0, 50));
          }
        } else {
          B('T6-NO-HOST');
        }

        // Also try DOMParser in iframe context (XML parser path)
        ctorRan = false;
        try {
          var IframeDOMParser = w.DOMParser;
          var p = new IframeDOMParser();
          var xmlStr = '<?xml version="1.0"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml">' +
            '<body><t6-ce id="t6dp"></t6-ce></body></html>';
          var doc2 = p.parseFromString(xmlStr, 'application/xhtml+xml');
          B('T6-DOMPARSER-OK');
          B('T6-DP-CTOR-' + (ctorRan ? 'YES' : 'NO'));
        } catch(e) {
          B('T6-DP-ERR-' + String(e).substring(0, 50));
        }
      } catch(e) {
        B('T6-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
    iframe.src = url;
  });

  // T7: HTML iframe with CE defined from parent + innerHTML (control)
  tests.push(function() {
    B('T7-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    iframe.srcdoc = '<!doctype html><html><head><title>T7</title></head><body><div id="host"></div></body></html>';
    iframe.onload = function() {
      try {
        var w = iframe.contentWindow;
        var d = iframe.contentDocument;
        B('T7-LOADED');

        var ctorRan = false;
        var ctorSelf = null;
        try {
          w.customElements.define('t7-ce', class extends w.HTMLElement {
            constructor() {
              super();
              ctorRan = true;
              ctorSelf = this;
            }
          });
          B('T7-CE-DEFINED');
        } catch(e) {
          B('T7-CE-DEF-ERR-' + String(e).substring(0, 50));
          iframe.remove();
          setTimeout(runNext, 300);
          return;
        }

        var host = d.getElementById('host');
        if (host) {
          host.innerHTML = '<t7-ce id="t7el"></t7-ce>';
          B('T7-CTOR-' + (ctorRan ? 'YES' : 'NO'));
          var el = d.getElementById('t7el');
          B('T7-ELEM-' + (el ? el.tagName : 'NULL'));
          B('T7-SAME-' + (el === ctorSelf));
        }
      } catch(e) {
        B('T7-ERR-' + String(e).substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 300);
    };
    document.body.appendChild(iframe);
  });

  runNext();
})();
