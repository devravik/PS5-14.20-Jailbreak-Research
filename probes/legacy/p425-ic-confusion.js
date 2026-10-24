// p425: LLInt Inline Cache / StructureID confusion probe
// On PS5 no-JIT, LLInt caches StructureID + offset for get_by_id/put_by_id
// StructureID decode has NO validation in release mode
// Goal: force IC to use stale offset after structure transition
(function() {
    var R = '';
    function log(s) { R += s + '\n'; }
    function send(tag, data) {
        var x = new XMLHttpRequest();
        x.open('GET', '/beacon?tag=' + tag + '&data=' + encodeURIComponent(data), false);
        x.send();
    }

    try {
        log('=== V425: LLInt IC / StructureID Confusion ===');

        // Test A: Megamorphic IC thrashing
        // Create many objects with different structures, access same property
        log('\n--- Test A: Megamorphic IC thrash ---');
        function getX(obj) { return obj.x; }

        var shapes = [];
        for (var i = 0; i < 64; i++) {
            var o = {};
            // Add properties in different orders to create different structures
            for (var j = 0; j < i; j++) {
                o['pad' + j] = j;
            }
            o.x = 0xAAAA0000 + i;
            shapes.push(o);
        }

        // Access with many different structures
        var lastVal = 0;
        for (var rep = 0; rep < 10; rep++) {
            for (var i = 0; i < shapes.length; i++) {
                lastVal = getX(shapes[i]);
            }
        }
        log('A: lastVal=0x' + lastVal.toString(16) + ' (expect 0xaaaa003f)');

        // Now create an object where x is at a DIFFERENT offset
        var tricky = {a:1, b:2, c:3, d:4, e:5, f:6, g:7, h:8, x: 0xBBBB};
        var trickyVal = getX(tricky);
        log('A: trickyVal=0x' + trickyVal.toString(16) + ' (expect 0xbbbb)');

        // Test B: delete+re-add property to change slot
        log('\n--- Test B: Property slot migration ---');
        function readY(obj) { return obj.y; }

        var obj1 = {y: 0x1111, z: 0x2222};
        // Warm IC
        for (var i = 0; i < 200; i++) readY(obj1);
        log('B: initial readY=0x' + readY(obj1).toString(16));

        // Delete y and re-add it -- this changes the structure
        delete obj1.y;
        obj1.y = 0x3333;
        log('B: after delete+readd, readY=0x' + readY(obj1).toString(16) + ' (expect 0x3333)');

        // Now make another object with y at a different butterfly offset
        var obj2 = {a:1, b:2, c:3, d:4, e:5, y: 0x4444};
        log('B: obj2 readY=0x' + readY(obj2).toString(16) + ' (expect 0x4444)');

        // Test C: Prototype chain IC confusion
        log('\n--- Test C: Prototype chain IC ---');
        function readP(obj) { return obj.prop; }

        var proto1 = {prop: 0x5555};
        var child1 = Object.create(proto1);
        // Warm IC with proto lookup
        for (var i = 0; i < 200; i++) readP(child1);
        log('C: child1.prop=0x' + readP(child1).toString(16));

        // Change prototype
        child1.__proto__ = {prop: 0x6666, extra: 'added'};
        log('C: after proto change, readP=0x' + readP(child1).toString(16) + ' (expect 0x6666)');

        // Add own property to shadow proto
        child1.prop = 0x7777;
        log('C: after own add, readP=0x' + readP(child1).toString(16) + ' (expect 0x7777)');

        // Test D: TypedArray vs Object confusion via IC
        log('\n--- Test D: TypedArray/Object IC ---');
        function readLen(obj) { return obj.length; }

        var arr = new Uint32Array(16);
        for (var i = 0; i < 200; i++) readLen(arr);
        log('D: arr.length=' + readLen(arr));

        var fakeArr = {length: 0xDEAD, buffer: null};
        log('D: fakeArr.length=0x' + readLen(fakeArr).toString(16));

        // Test E: Structure transition during property access via getter
        log('\n--- Test E: Getter-triggered transition ---');
        var transitObj = {};
        var getterHits = 0;
        Object.defineProperty(transitObj, 'trigger', {
            get: function() {
                getterHits++;
                if (getterHits === 1) {
                    // First access: add many properties to force structure chain
                    for (var i = 0; i < 100; i++) {
                        this['expand' + i] = i;
                    }
                }
                return 42;
            },
            configurable: true,
            enumerable: true
        });
        transitObj.target = 0x9999;

        function readTarget(obj) {
            var t = obj.trigger; // may modify structure
            return obj.target;  // stale IC?
        }

        // Warm IC
        var plainObj = {trigger: 1, target: 0xAAAA};
        for (var i = 0; i < 200; i++) readTarget(plainObj);

        // Now use the getter object
        var result = readTarget(transitObj);
        log('E: result=0x' + result.toString(16) + ' getterHits=' + getterHits);
        log('E: transitObj.expand50=' + transitObj.expand50);

        // Test F: StructureID reuse via GC
        log('\n--- Test F: StructureID reuse via GC ---');
        function readVal(obj) { return obj.val; }

        // Create and discard many objects to cycle StructureIDs
        var keeper = null;
        for (var round = 0; round < 3; round++) {
            var tempObjects = [];
            for (var i = 0; i < 1000; i++) {
                var o = {};
                for (var j = 0; j < (i % 10); j++) {
                    o['p' + j] = j;
                }
                o.val = 0xF000 + round * 1000 + i;
                tempObjects.push(o);
            }
            // Access them to fill IC
            for (var i = 0; i < tempObjects.length; i++) {
                readVal(tempObjects[i]);
            }
            if (round === 1) keeper = tempObjects[500];
            tempObjects = null;
        }

        // Force GC
        for (var i = 0; i < 50; i++) {
            var waste = new ArrayBuffer(1024 * 1024);
        }

        if (keeper) {
            var keptVal = readVal(keeper);
            log('F: keeper.val=0x' + keptVal.toString(16) + ' (expect 0xf1f4)');
        }

        // Create new objects that might reuse freed StructureIDs
        var newObj = {};
        for (var j = 0; j < 5; j++) newObj['q' + j] = j;
        newObj.val = 0xCAFE;
        log('F: newObj.val=0x' + readVal(newObj).toString(16) + ' (expect 0xcafe)');

        send('V425', R);
        log('\nSent.');
    } catch(e) {
        log('FATAL: ' + e.message);
        send('V425-ERR', R + '\nFATAL: ' + e.message);
    }
})();
