// p200 — Lean test: does a(); already emit op_call_ignore_result?
//
// The void a(); blob was 345MB → probably OOM during construction.
// Key question: does bare a(); as ExpressionStatement already
// use op_call_ignore_result? JSC's bytecode generator checks if
// the expression result is consumed. Statement context = not consumed.
//
// Test sequence:
// A: 2M × a();  (should work, known from p198-C at 1M)
// B: 5M × a();  (between 1M works and 10M crashes)
// C: 3M × a();  (if 5M crashes, try 3M)
// D: 38M × a(); WITHOUT Blob, via incremental eval (different approach)
// E: SMALL void test: 1M × void a(); vs 1M × a(); — compare memory
//
// Beacon prefix: V200-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V200-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Test A: 2M calls
  function testA() {
    B('A-BUILD');
    var src = 'window.__a=function(a){' + 'a();'.repeat(2000000) + '};window.__aOk=1;';
    var blob = new Blob([src], {type:'application/javascript'});
    B('A-BLOB-' + Math.round(blob.size/1048576) + 'MB');
    src = null;
    var sc = document.createElement('script');
    sc.onload = function() {
      B('A-COMPILED');
      var c = 0;
      try {
        window.__a(function(){c++;if(c===1)B('A-CB-1');if(c>100)throw 'S';});
        B('A-RET-'+c);
      } catch(e) { B('A-THREW-'+c); }
      window.__a = null;
      setTimeout(testB, 300);
    };
    sc.onerror = function() { B('A-ERR'); setTimeout(testB, 300); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test B: 5M calls
  function testB() {
    B('B-BUILD');
    var chunk = 'a();'.repeat(1000000);
    var parts = ['window.__b=function(a){'];
    for(var i=0;i<5;i++) parts.push(chunk);
    parts.push('};window.__bOk=1;');
    chunk = null;
    var blob = new Blob(parts, {type:'application/javascript'});
    B('B-BLOB-' + Math.round(blob.size/1048576) + 'MB');
    parts = null;
    var sc = document.createElement('script');
    sc.onload = function() {
      B('B-COMPILED');
      var c = 0;
      try {
        window.__b(function(){c++;if(c===1)B('B-CB-1');if(c>100)throw 'S';});
        B('B-RET-'+c);
      } catch(e) { B('B-THREW-'+c); }
      window.__b = null;
      setTimeout(testC, 300);
    };
    sc.onerror = function() { B('B-ERR'); setTimeout(testC, 300); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test C: 3M calls (if 5M crashes)
  function testC() {
    B('C-BUILD');
    var chunk = 'a();'.repeat(1000000);
    var parts = ['window.__c=function(a){'];
    for(var i=0;i<3;i++) parts.push(chunk);
    parts.push('};window.__cOk=1;');
    chunk = null;
    var blob = new Blob(parts, {type:'application/javascript'});
    B('C-BLOB-' + Math.round(blob.size/1048576) + 'MB');
    parts = null;
    var sc = document.createElement('script');
    sc.onload = function() {
      B('C-COMPILED');
      var c = 0;
      try {
        window.__c(function(){c++;if(c===1)B('C-CB-1');if(c>100)throw 'S';});
        B('C-RET-'+c);
      } catch(e) { B('C-THREW-'+c); }
      window.__c = null;
      setTimeout(testE, 300);
    };
    sc.onerror = function() { B('C-ERR'); setTimeout(testE, 300); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test E: Compare void vs plain at 1M scale
  function testE() {
    B('E-BUILD-PLAIN');
    var srcP = 'window.__ep=function(a){' + 'a();'.repeat(1000000) + '};';
    eval(srcP); srcP = null;
    B('E-PLAIN-COMPILED');

    B('E-BUILD-VOID');
    var srcV = 'window.__ev=function(a){' + 'void a();'.repeat(1000000) + '};';
    eval(srcV); srcV = null;
    B('E-VOID-COMPILED');

    // Run plain
    var cp = 0;
    try {
      window.__ep(function(){cp++;if(cp>100)throw 'S';});
    } catch(e) {}
    B('E-PLAIN-' + cp);

    // Run void
    var cv = 0;
    try {
      window.__ev(function(){cv++;if(cv>100)throw 'S';});
    } catch(e) {}
    B('E-VOID-' + cv);
    B('ALL-DONE');
  }

  testA();
})();
