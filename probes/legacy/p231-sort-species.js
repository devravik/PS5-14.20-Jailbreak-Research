(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V231-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  // TEST A: TypedArray.sort comparator detaches underlying buffer
  // The merge sort in JSC's typedArrayMergeSort creates src = array (raw buffer).
  // If comparator detaches via structuredClone, subsequent src[i]/dst[i] accesses
  // should be caught by LLInt detachment checks. We verify.
  try {
    BS('A-START');
    var ab = new ArrayBuffer(4096);
    var ta = new Int32Array(ab);
    for (var i = 0; i < ta.length; i++) ta[i] = ta.length - i;

    var detached = false;
    var callCount = 0;
    var preDetachLen = ta.length;
    var postDetachRead = 'none';

    ta.sort(function(a, b) {
      callCount++;
      if (!detached && callCount === 20) {
        try {
          structuredClone(ab, { transfer: [ab] });
          detached = true;
          BS('A-DETACHED-AT-' + callCount);
        } catch (e) {
          BS('A-DETACH-FAIL-' + e.message.slice(0, 40));
        }
      }
      if (detached && postDetachRead === 'none') {
        try {
          var v = ta[0];
          postDetachRead = (v === undefined) ? 'undef' : hex(v);
        } catch (e) {
          postDetachRead = 'err-' + e.message.slice(0, 20);
        }
      }
      return a - b;
    });

    BS('A-DONE-calls=' + callCount + '-det=' + detached + '-read=' + postDetachRead + '-len=' + ta.length);
    if (detached) {
      try {
        ta[0] = 0x41414141;
        BS('A-POST-WRITE-OK');
      } catch (e) {
        BS('A-POST-WRITE-ERR');
      }
      try {
        var readBack = ta[0];
        BS('A-READBACK=' + (readBack === undefined ? 'undef' : hex(readBack)));
      } catch (e) {
        BS('A-READBACK-ERR');
      }
    }
  } catch (e) {
    BS('A-CRASH-' + e.message.slice(0, 50));
  }

  // TEST B: TypedArray.filter with @@species returning wrong type
  // If @@species returns Uint8Array when source is Float64Array,
  // the copy might write 8-byte floats into 1-byte slots.
  try {
    BS('B-START');
    var src = new Float64Array(32);
    for (var i = 0; i < src.length; i++) src[i] = 1.1 + i;

    src.constructor = { [Symbol.species]: Uint8Array };

    var result;
    try {
      result = src.filter(function(x) { return true; });
      BS('B-RESULT-type=' + result.constructor.name +
         '-len=' + result.length +
         '-bytes=' + result.byteLength +
         '-v0=' + result[0] +
         '-v1=' + result[1]);

      if (result instanceof Uint8Array && result.length === 32) {
        var raw = new DataView(result.buffer);
        var vals = [];
        for (var j = 0; j < Math.min(8, result.buffer.byteLength); j++) {
          vals.push(hex(raw.getUint8(j)));
        }
        BS('B-RAW=' + vals.join(','));
      }
    } catch (e) {
      BS('B-FILTER-ERR-' + e.name + '-' + e.message.slice(0, 40));
    }
  } catch (e) {
    BS('B-CRASH-' + e.message.slice(0, 50));
  }

  // TEST C: TypedArray.map with @@species returning larger type
  // If source is Uint8Array(256) and @@species returns Float64Array,
  // the result gets 256 Float64 elements = 2048 bytes,
  // but the copy loop writes src values as Float64. Safe if types match.
  try {
    BS('C-START');
    var srcC = new Uint8Array(64);
    for (var i = 0; i < srcC.length; i++) srcC[i] = i;

    srcC.constructor = { [Symbol.species]: Float64Array };
    var resultC;
    try {
      resultC = srcC.map(function(x) { return x; });
      BS('C-RESULT-type=' + resultC.constructor.name +
         '-len=' + resultC.length +
         '-bytes=' + resultC.byteLength +
         '-v0=' + resultC[0] + '-v63=' + resultC[63]);
    } catch (e) {
      BS('C-MAP-ERR-' + e.name + '-' + e.message.slice(0, 40));
    }
  } catch (e) {
    BS('C-CRASH-' + e.message.slice(0, 50));
  }

  // TEST D: Array.from with Proxy that changes length mid-iteration
  // Array.from captures length once, then iterates. A Proxy that reports
  // decreasing length during iteration could cause undershoot.
  try {
    BS('D-START');
    var realLen = 100;
    var iterCount = 0;
    var proxyTarget = [];
    for (var i = 0; i < realLen; i++) proxyTarget[i] = i;

    var handler = {
      get: function(target, prop) {
        if (prop === 'length') {
          iterCount++;
          if (iterCount > 5) return 200;
          return realLen;
        }
        if (prop === Symbol.iterator) return undefined;
        var idx = parseInt(prop);
        if (!isNaN(idx)) {
          if (idx >= realLen) return 0xBEEF0000 + idx;
          return target[idx];
        }
        return target[prop];
      }
    };

    var p = new Proxy(proxyTarget, handler);
    var resultD;
    try {
      resultD = Array.from(p);
      BS('D-RESULT-len=' + resultD.length +
         '-v0=' + resultD[0] +
         '-v99=' + resultD[99] +
         '-v100=' + (resultD[100] !== undefined ? hex(resultD[100]) : 'undef') +
         '-v199=' + (resultD[199] !== undefined ? hex(resultD[199]) : 'undef'));
    } catch (e) {
      BS('D-FROM-ERR-' + e.name + '-' + e.message.slice(0, 40));
    }
  } catch (e) {
    BS('D-CRASH-' + e.message.slice(0, 50));
  }

  // TEST E: Array.splice with species constructor that modifies original
  try {
    BS('E-START');
    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    var speciesCalled = false;

    arr.constructor = {
      [Symbol.species]: function(len) {
        speciesCalled = true;
        arr.length = 2;
        arr[0] = 0xDEAD;
        return new Array(len);
      }
    };

    var spliced;
    try {
      spliced = arr.splice(2, 3);
      BS('E-RESULT-spliced=' + spliced.join(',') +
         '-arr=' + arr.join(',') +
         '-species=' + speciesCalled +
         '-arrLen=' + arr.length);
    } catch (e) {
      BS('E-SPLICE-ERR-' + e.name + '-' + e.message.slice(0, 40));
    }
  } catch (e) {
    BS('E-CRASH-' + e.message.slice(0, 50));
  }

  BS('ALL-DONE');
})();
