// p414 - HTML parser custom element constructor DOM corruption tests
//
// XHTML is dead on PS5 (V413 confirmed). Testing whether the HTML parser's
// custom element handling has similar post-constructor validation gaps.
//
// The XML parser bug (WK-1400 fix): parserAppendChild() after constructor
// runs without checking element.parentNode or m_currentNode validity.
// Does the HTML fragment parser (innerHTML) have the same issue?
//
// Beacon prefix: V414-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V414-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
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

  var idx = 0;
  var tests = [];

  function runNext() {
    if (idx < tests.length) {
      var t = tests[idx++];
      try { t(); }
      catch(e) { B('T' + idx + '-THROW-' + String(e).substring(0, 60)); setTimeout(runNext, 200); }
    } else {
      B('COMPLETE');
    }
  }

  // T1: Constructor appends self to alt parent during innerHTML
  // If HTML parser doesn't validate after constructor, element ends up in BOTH parents
  tests.push(function() {
    B('T1-START');

    var altDiv = document.createElement('div');
    altDiv.id = 'alt1';

    class SelfAppendEl extends HTMLElement {
      constructor() {
        super();
        try {
          altDiv.appendChild(this);
          B('T1-SELF-APPEND-OK');
        } catch(e) {
          B('T1-SELF-APPEND-ERR-' + e.name + '-' + e.message.substring(0, 40));
        }
      }
    }
    customElements.define('self-append-1', SelfAppendEl);

    var host = document.createElement('div');
    host.id = 'host1';
    document.body.appendChild(host);

    try {
      host.innerHTML = '<self-append-1 id="sa1">content</self-append-1>';
      B('T1-INNERHTML-OK');
    } catch(e) {
      B('T1-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    // Check where the element ended up
    var elem = document.getElementById('sa1');
    B('T1-ELEM-' + (elem ? 'FOUND' : 'GONE'));

    var inHost = false, inAlt = false;
    var c = host.firstChild;
    while (c) {
      if (c.id === 'sa1') inHost = true;
      c = c.nextSibling;
    }
    c = altDiv.firstChild;
    while (c) {
      if (c.id === 'sa1') inAlt = true;
      c = c.nextSibling;
    }

    B('T1-IN-HOST-' + inHost);
    B('T1-IN-ALT-' + inAlt);
    B('T1-HOST-CH-' + host.childNodes.length);
    B('T1-ALT-CH-' + altDiv.childNodes.length);

    if (elem) {
      B('T1-PARENT-' + (elem.parentNode ? (elem.parentNode.id || elem.parentNode.tagName) : 'NULL'));
    }

    if (inHost && inAlt) {
      B('T1-DOUBLE-PARENT');
    }

    host.remove();
    setTimeout(runNext, 200);
  });

  // T2: Constructor removes host (context node) from document
  tests.push(function() {
    B('T2-START');

    var host2 = document.createElement('div');
    host2.id = 'host2';
    document.body.appendChild(host2);

    class RemoveHostEl extends HTMLElement {
      constructor() {
        super();
        try {
          if (host2.parentNode) {
            host2.remove();
            B('T2-HOST-REMOVED');
          }
        } catch(e) {
          B('T2-REMOVE-ERR-' + e.message.substring(0, 40));
        }
      }
    }
    customElements.define('remove-host-1', RemoveHostEl);

    try {
      host2.innerHTML = '<remove-host-1 id="rh1"></remove-host-1><div id="after2">after</div>';
      B('T2-INNERHTML-OK');
    } catch(e) {
      B('T2-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    // Check state
    var rh = document.getElementById('rh1');
    var after = document.getElementById('after2');
    B('T2-HOST-CONNECTED-' + document.contains(host2));
    B('T2-HOST-CH-' + host2.childNodes.length);
    B('T2-RH-' + (rh ? 'FOUND-IN-DOC' : 'GONE'));
    B('T2-AFTER-' + (after ? 'FOUND-IN-DOC' : 'GONE'));

    // Check if elements are in the orphaned host
    var rhInHost = host2.querySelector('#rh1');
    var afterInHost = host2.querySelector('#after2');
    B('T2-RH-IN-HOST-' + (rhInHost ? 'Y' : 'N'));
    B('T2-AFTER-IN-HOST-' + (afterInHost ? 'Y' : 'N'));

    setTimeout(runNext, 200);
  });

  // T3: Constructor adopts self into different document
  tests.push(function() {
    B('T3-START');

    var doc2 = document.implementation.createHTMLDocument('victim');

    class AdoptSelfEl extends HTMLElement {
      constructor() {
        super();
        try {
          doc2.adoptNode(this);
          B('T3-ADOPT-OK');
        } catch(e) {
          B('T3-ADOPT-ERR-' + e.name + '-' + e.message.substring(0, 40));
        }
      }
    }
    customElements.define('adopt-self-1', AdoptSelfEl);

    var host3 = document.createElement('div');
    host3.id = 'host3';
    document.body.appendChild(host3);

    try {
      host3.innerHTML = '<adopt-self-1 id="as1"></adopt-self-1>';
      B('T3-INNERHTML-OK');
    } catch(e) {
      B('T3-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    var elem = document.getElementById('as1');
    var elem2 = doc2.getElementById('as1');
    B('T3-IN-ORIG-' + (elem ? 'Y' : 'N'));
    B('T3-IN-DOC2-' + (elem2 ? 'Y' : 'N'));

    if (elem) {
      B('T3-OWNER-' + (elem.ownerDocument === document ? 'MAIN' : 'DOC2'));
      B('T3-PARENT-' + (elem.parentNode ? (elem.parentNode.id || elem.parentNode.tagName) : 'NULL'));
    }

    // Cross-document confusion: element owned by doc2 but parented in main doc
    if (elem && elem.ownerDocument !== document && elem.parentNode) {
      B('T3-CROSS-DOC-CONFUSION');
    }

    host3.remove();
    setTimeout(runNext, 200);
  });

  // T4: Constructor replaces innerHTML of host (re-entrant parse)
  tests.push(function() {
    B('T4-START');

    var host4 = document.createElement('div');
    host4.id = 'host4';
    document.body.appendChild(host4);
    var reentryCount = 0;

    class ReentryEl extends HTMLElement {
      constructor() {
        super();
        reentryCount++;
        if (reentryCount === 1) {
          try {
            // This triggers ANOTHER parse inside the current parse
            host4.innerHTML = '<div id="reentry-child">replaced</div>';
            B('T4-REENTRY-OK');
          } catch(e) {
            B('T4-REENTRY-ERR-' + e.name + '-' + e.message.substring(0, 40));
          }
        }
      }
    }
    customElements.define('reentry-el-1', ReentryEl);

    try {
      host4.innerHTML = '<reentry-el-1 id="re1"></reentry-el-1><div id="post-re">post</div>';
      B('T4-INNERHTML-OK');
    } catch(e) {
      B('T4-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    B('T4-REENTRY-COUNT-' + reentryCount);
    B('T4-HOST-CH-' + host4.childNodes.length);

    var re = document.getElementById('re1');
    var postRe = document.getElementById('post-re');
    var reChild = document.getElementById('reentry-child');
    B('T4-RE1-' + (re ? 'FOUND' : 'GONE'));
    B('T4-POST-' + (postRe ? 'FOUND' : 'GONE'));
    B('T4-RECHILD-' + (reChild ? 'FOUND' : 'GONE'));

    host4.remove();
    setTimeout(runNext, 200);
  });

  // T5: Constructor adds MANY children to host to corrupt parser's child count
  tests.push(function() {
    B('T5-START');

    var host5 = document.createElement('div');
    host5.id = 'host5';
    document.body.appendChild(host5);

    class FloodEl extends HTMLElement {
      constructor() {
        super();
        try {
          // Add 100 children to the parse context during construction
          for (var i = 0; i < 100; i++) {
            var d = document.createElement('div');
            d.id = 'flood-' + i;
            host5.appendChild(d);
          }
          B('T5-FLOOD-OK');
        } catch(e) {
          B('T5-FLOOD-ERR-' + e.message.substring(0, 40));
        }
      }
    }
    customElements.define('flood-el-1', FloodEl);

    try {
      host5.innerHTML = '<flood-el-1 id="fl1"></flood-el-1><div id="post-flood">post</div>';
      B('T5-INNERHTML-OK');
    } catch(e) {
      B('T5-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    B('T5-HOST-CH-' + host5.childNodes.length);
    var fl = document.getElementById('fl1');
    var postFlood = document.getElementById('post-flood');
    B('T5-FL1-' + (fl ? 'FOUND' : 'GONE'));
    B('T5-POST-' + (postFlood ? 'FOUND' : 'GONE'));

    // Check for orphaned or misplaced children
    var flood0 = document.getElementById('flood-0');
    var flood99 = document.getElementById('flood-99');
    B('T5-FLOOD0-' + (flood0 ? (flood0.parentNode === host5 ? 'IN-HOST' : 'ELSEWHERE') : 'GONE'));
    B('T5-FLOOD99-' + (flood99 ? (flood99.parentNode === host5 ? 'IN-HOST' : 'ELSEWHERE') : 'GONE'));

    host5.remove();
    setTimeout(runNext, 200);
  });

  // T6: Two CEs in sequence, first one manipulates tree for second
  tests.push(function() {
    B('T6-START');

    var stealTarget = null;
    var altContainer = document.createElement('div');
    altContainer.id = 'alt6';

    class FirstEl extends HTMLElement {
      constructor() {
        super();
        B('T6-FIRST-CTOR');
      }
    }

    class StealEl extends HTMLElement {
      constructor() {
        super();
        B('T6-STEAL-CTOR');
        // Try to steal the previous sibling (FirstEl)
        var host6 = document.getElementById('host6');
        if (host6 && host6.firstChild) {
          try {
            stealTarget = host6.firstChild;
            altContainer.appendChild(stealTarget);
            B('T6-STOLE-SIBLING');
          } catch(e) {
            B('T6-STEAL-ERR-' + e.message.substring(0, 40));
          }
        }
      }
    }

    customElements.define('first-el-1', FirstEl);
    customElements.define('steal-el-1', StealEl);

    var host6 = document.createElement('div');
    host6.id = 'host6';
    document.body.appendChild(host6);

    try {
      host6.innerHTML = '<first-el-1 id="fe1"></first-el-1><steal-el-1 id="se1"></steal-el-1>';
      B('T6-INNERHTML-OK');
    } catch(e) {
      B('T6-INNERHTML-ERR-' + e.message.substring(0, 40));
    }

    B('T6-HOST-CH-' + host6.childNodes.length);
    B('T6-ALT-CH-' + altContainer.childNodes.length);

    var fe = document.getElementById('fe1');
    var se = document.getElementById('se1');
    B('T6-FE-' + (fe ? 'FOUND' : 'GONE'));
    B('T6-SE-' + (se ? 'FOUND' : 'GONE'));

    if (fe) {
      B('T6-FE-PARENT-' + (fe.parentNode ? (fe.parentNode.id || fe.parentNode.tagName) : 'NULL'));
    }

    host6.remove();
    setTimeout(runNext, 200);
  });

  runNext();
})();
