// p424: Proxy for-in duplicate keys + structure transition probe
// JSC accepts duplicate keys from ownKeys trap (V8/SM throw)
// If for-in processes two entries for same key and getter modifies
// structure between iterations, stale property slot possible
(function() {
    var R = '';
    function log(s) { R += s + '\n'; }
    function send(tag, data) {
        var x = new XMLHttpRequest();
        x.open('GET', '/beacon?tag=' + tag + '&data=' + encodeURIComponent(data), false);
        x.send();
    }

    try {
        log('=== V424: Proxy for-in Duplicate Keys ===');

        // Test A: Basic duplicate key acceptance
        log('\n--- Test A: Duplicate key basic ---');
        var target = {a: 1, b: 2, c: 3};
        var dupeCount = 0;
        try {
            var p = new Proxy(target, {
                ownKeys: function() {
                    return ['a', 'b', 'a', 'c', 'b', 'a'];
                },
                getOwnPropertyDescriptor: function(t, k) {
                    return {value: t[k], writable: true, enumerable: true, configurable: true};
                }
            });
            var keys = [];
            for (var k in p) {
                keys.push(k);
                dupeCount++;
            }
            log('A: keys=[' + keys.join(',') + '] count=' + dupeCount);
            log('A: JSC accepts duplicates=' + (dupeCount > 3));
        } catch(e) {
            log('A: threw=' + e.message + ' (like V8/SM, no duplicates)');
        }

        // Test B: Structure transition during duplicate key access
        log('\n--- Test B: Structure transition during for-in ---');
        var victim = {x: 1, y: 2, z: 3};
        var callNum = 0;
        var getLog = [];
        try {
            var p2 = new Proxy(victim, {
                ownKeys: function() {
                    return ['x', 'y', 'x', 'z'];
                },
                getOwnPropertyDescriptor: function(t, k) {
                    return {value: t[k], writable: true, enumerable: true, configurable: true};
                },
                get: function(t, k) {
                    callNum++;
                    getLog.push(k + ':' + callNum);
                    // On second access of 'x', add many properties to force structure transition
                    if (k === 'x' && callNum > 1) {
                        for (var i = 0; i < 64; i++) {
                            t['prop' + i] = i;
                        }
                        log('B: added 64 props to target on 2nd x access');
                    }
                    return t[k];
                }
            });
            var values = [];
            for (var k in p2) {
                values.push(k + '=' + p2[k]);
            }
            log('B: values=[' + values.join(', ') + ']');
            log('B: getLog=[' + getLog.join(', ') + ']');
        } catch(e) {
            log('B: threw=' + e.message);
        }

        // Test C: Inline cache confusion via Proxy ownKeys
        log('\n--- Test C: IC confusion with Proxy ---');
        function readProp(obj) {
            return obj.x;
        }
        var normalObj = {x: 42, y: 99};
        // Warm up IC
        for (var i = 0; i < 100; i++) readProp(normalObj);
        log('C: warmup done, readProp(normal)=' + readProp(normalObj));

        // Now create object with different structure but Proxy-swapped properties
        var trickObj = {};
        Object.defineProperty(trickObj, 'x', {
            get: function() {
                // Modify our own structure
                if (!this._tripped) {
                    this._tripped = true;
                    delete this.y;
                    this.a = 1;
                    this.b = 2;
                    this.c = 3;
                    this.x2 = 0xDEADBEEF;
                }
                return 42;
            },
            configurable: true,
            enumerable: true
        });
        trickObj.y = 100;
        log('C: readProp(trick)=' + readProp(trickObj));
        log('C: trickObj.x2=' + trickObj.x2);

        // Test D: for-in with defineProperty during iteration
        log('\n--- Test D: defineProperty during for-in ---');
        var obj4 = {a: 1, b: 2, c: 3, d: 4};
        var iterKeys = [];
        var iterVals = [];
        for (var k in obj4) {
            iterKeys.push(k);
            iterVals.push(obj4[k]);
            if (k === 'b') {
                // Convert c from data to accessor
                Object.defineProperty(obj4, 'c', {
                    get: function() { return 0xBEEF; },
                    configurable: true,
                    enumerable: true
                });
                // Add more properties
                obj4.e = 5;
                obj4.f = 6;
            }
        }
        log('D: keys=[' + iterKeys.join(',') + ']');
        log('D: vals=[' + iterVals.map(function(v){return '0x'+v.toString(16)}).join(',') + ']');

        // Test E: Proxy with getPrototypeOf trap
        log('\n--- Test E: Prototype chain manipulation ---');
        var base = {inherited: 'base'};
        var child = Object.create(base);
        child.own = 'child';
        var trapCount = 0;
        var protoProxy = new Proxy(child, {
            getPrototypeOf: function(t) {
                trapCount++;
                if (trapCount > 1) {
                    // Return a different prototype on subsequent calls
                    return {sneaky: 'injected', inherited: 'fake'};
                }
                return Object.getPrototypeOf(t);
            }
        });
        var protoKeys = [];
        for (var k in protoProxy) {
            protoKeys.push(k + '=' + protoProxy[k]);
        }
        log('E: keys=[' + protoKeys.join(', ') + '] trapCount=' + trapCount);

        // Test F: Object.keys with structure transition in toString
        log('\n--- Test F: Structure transition in toString ---');
        var obj6 = {};
        obj6[{toString: function() {
            // Add properties during key creation
            obj6.sneaky1 = 0xAAAA;
            obj6.sneaky2 = 0xBBBB;
            return 'key1';
        }}] = 'val1';
        log('F: obj6 keys=' + Object.keys(obj6).join(','));
        log('F: obj6.sneaky1=' + obj6.sneaky1 + ' sneaky2=' + obj6.sneaky2);

        send('V424', R);
        log('\nSent.');
    } catch(e) {
        log('FATAL: ' + e.message);
        send('V424-ERR', R + '\nFATAL: ' + e.message);
    }
})();
