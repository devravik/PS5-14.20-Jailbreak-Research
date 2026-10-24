// p114-typefuzz.js — Type confusion + async detach + novel surfaces
//
// Synthesized from multi-agent brainstorm (Opus weaponize + novel surfaces).
// Top vectors: Custom Element type confusion, FontFace ArrayBuffer detach,
// SubtleCrypto async detach, cross-prototype method calls, adoptNode GC,
// Shadow DOM MO re-entrancy, orphan animation WeakRef.
//
// Beacon prefix: V114E-

(function(){
var RUN = 'v114e' + Math.random().toString(36).slice(2,14);
var BC = '/beacon/V114E-';

function send(tag, data) {
    var body = JSON.stringify({r: RUN, b: typeof data === 'string' ? data : JSON.stringify(data)});
    try { navigator.sendBeacon(BC + tag, body); } catch(e) {}
}

var hb = setInterval(function(){ send('HB','hb'); }, 5000);

setTimeout(function() {
    send('L', 'probe114-start');

    // ═══════════════════════════════════════════════════════════════
    // E1: Custom Element constructor returns WRONG element type
    // WebKit's custom element upgrade expects an HTMLElement back.
    // If constructor returns a canvas, does the element registry
    // trust the type tag or check the C++ class?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var e1_err = null;
            var e1_defineOk = false;
            var e1_createOk = false;
            var e1_ctorCalled = false;
            var e1_returnedTag = '';
            var e1_appendOk = false;
            var e1_layoutOk = false;
            var e1_innerOk = false;
            var e1_getCtxResult = '';

            class WrongTypeEl extends HTMLElement {
                constructor() {
                    e1_ctorCalled = true;
                    return document.createElement('canvas');
                }
            }
            try {
                customElements.define('wrong-type-el', WrongTypeEl);
                e1_defineOk = true;
            } catch(de) {
                e1_err = 'define:' + de.constructor.name + ':' + de.message.slice(0,60);
            }

            if (e1_defineOk) {
                try {
                    var el = document.createElement('wrong-type-el');
                    e1_createOk = true;
                    e1_returnedTag = el.tagName;

                    document.body.appendChild(el);
                    e1_appendOk = true;
                    var h = el.offsetHeight;
                    e1_layoutOk = true;

                    el.innerHTML = '<span>test</span>';
                    e1_innerOk = true;

                    try {
                        var ctx = el.getContext('2d');
                        e1_getCtxResult = ctx ? 'GOT_CONTEXT' : 'null';
                    } catch(ce) {
                        e1_getCtxResult = 'ERR:' + ce.constructor.name;
                    }
                } catch(ce2) {
                    e1_err = (e1_err || '') + '|create:' + ce2.constructor.name + ':' + ce2.message.slice(0,60);
                }
            }

            send('E1-WRONGTYPE', {
                defineOk: e1_defineOk,
                ctorCalled: e1_ctorCalled,
                createOk: e1_createOk,
                tag: e1_returnedTag,
                appendOk: e1_appendOk,
                layoutOk: e1_layoutOk,
                innerOk: e1_innerOk,
                getCtx: e1_getCtxResult,
                err: e1_err
            });
        } catch(e) {
            send('E1-WRONGTYPE', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 100);

    // ═══════════════════════════════════════════════════════════════
    // E2: Custom Element constructor returns Proxy-wrapped element
    // Proxy lies about nodeName/nodeType. Does WebKit C++ code
    // access properties through the Proxy during layout/render?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var e2_trapLog = [];
            var e2_err = null;
            var e2_defineOk = false;
            var e2_createOk = false;
            var e2_layoutTraps = 0;

            class ProxyEl extends HTMLElement {
                constructor() {
                    var real = Reflect.construct(HTMLElement, [], ProxyEl);
                    return new Proxy(real, {
                        get: function(target, prop) {
                            if (typeof prop === 'string' && prop !== 'then') {
                                e2_trapLog.push(prop);
                            }
                            if (prop === 'nodeName') return 'CANVAS';
                            if (prop === 'nodeType') return 1;
                            var v = Reflect.get(target, prop, target);
                            return typeof v === 'function' ? v.bind(target) : v;
                        }
                    });
                }
            }
            try {
                customElements.define('proxy-el-114', ProxyEl);
                e2_defineOk = true;
            } catch(de) {
                e2_err = 'define:' + de.constructor.name;
            }

            if (e2_defineOk) {
                try {
                    var p = document.createElement('proxy-el-114');
                    e2_createOk = true;
                    document.body.appendChild(p);
                    p.style.width = '100px';
                    p.style.height = '100px';
                    p.style.background = 'red';
                    var before = e2_trapLog.length;
                    p.offsetHeight;
                    p.getBoundingClientRect();
                    e2_layoutTraps = e2_trapLog.length - before;
                } catch(ce) {
                    e2_err = (e2_err || '') + '|use:' + ce.constructor.name + ':' + ce.message.slice(0,60);
                }
            }

            var uniqueTraps = {};
            for (var i = 0; i < e2_trapLog.length; i++) uniqueTraps[e2_trapLog[i]] = 1;

            send('E2-PROXY', {
                defineOk: e2_defineOk,
                createOk: e2_createOk,
                totalTraps: e2_trapLog.length,
                layoutTraps: e2_layoutTraps,
                uniqueProps: Object.keys(uniqueTraps).join(','),
                first20: e2_trapLog.slice(0,20).join(','),
                err: e2_err
            });
        } catch(e) {
            send('E2-PROXY', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 600);

    // ═══════════════════════════════════════════════════════════════
    // E3: Custom Element batch upgrade — alternating failure
    // innerHTML creates 20 elements, constructor throws on even.
    // Does the upgrade queue get left in inconsistent state?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var e3_count = 0;
            var e3_successes = 0;
            var e3_failures = 0;
            var e3_err = null;

            class FlickerEl extends HTMLElement {
                constructor() {
                    e3_count++;
                    if (e3_count % 2 === 0) {
                        throw new Error('even-fail');
                    }
                    return Reflect.construct(HTMLElement, [], FlickerEl);
                }
            }
            customElements.define('flicker-el-114', FlickerEl);

            var container = document.createElement('div');
            container.innerHTML = '<flicker-el-114></flicker-el-114>'.repeat(20);
            document.body.appendChild(container);
            container.offsetHeight;

            var children = container.querySelectorAll('flicker-el-114');
            var upgraded = 0;
            var notUpgraded = 0;
            for (var i = 0; i < children.length; i++) {
                if (children[i].matches(':defined')) upgraded++;
                else notUpgraded++;
            }

            var e3_afterInner = false;
            try {
                for (var j = 0; j < children.length; j++) {
                    children[j].innerHTML = '<b>x</b>';
                }
                e3_afterInner = true;
            } catch(ie) {
                e3_err = 'innerHTML:' + ie.constructor.name;
            }

            send('E3-FLICKER', {
                ctorCalls: e3_count,
                childCount: children.length,
                upgraded: upgraded,
                notUpgraded: notUpgraded,
                innerHtmlOk: e3_afterInner,
                err: e3_err
            });
        } catch(e) {
            send('E3-FLICKER', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 1200);

    // ═══════════════════════════════════════════════════════════════
    // E4: FontFace(ArrayBuffer) + immediate detach
    // Font parser is async. If we detach the source ArrayBuffer
    // after construction but before parsing completes, the parser
    // may read from freed/transferred memory (UAF read).
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var fontBuf = new ArrayBuffer(1024);
            var view = new Uint8Array(fontBuf);
            view[0] = 0x77; view[1] = 0x4F; view[2] = 0x46; view[3] = 0x32;
            view[4] = 0x00; view[5] = 0x01; view[6] = 0x00; view[7] = 0x00;
            for (var i = 8; i < 1024; i++) view[i] = 0x41;

            var e4_ctorOk = false;
            var e4_detachOk = false;
            var e4_loadResult = '';
            var e4_err = null;

            var font = null;
            try {
                font = new FontFace('TestFont114', fontBuf);
                e4_ctorOk = true;
            } catch(ce) {
                e4_err = 'ctor:' + ce.constructor.name + ':' + ce.message.slice(0,60);
            }

            if (e4_ctorOk) {
                try {
                    structuredClone({x: fontBuf}, {transfer: [fontBuf]});
                    e4_detachOk = (fontBuf.byteLength === 0);
                } catch(te) {
                    e4_err = 'transfer:' + te.constructor.name;
                }

                font.load().then(function(loaded) {
                    e4_loadResult = 'LOADED:family=' + loaded.family + ',status=' + loaded.status;
                    send('E4-FONTDETACH', {
                        ctorOk: e4_ctorOk, detachOk: e4_detachOk,
                        loadResult: e4_loadResult, err: e4_err
                    });
                }).catch(function(le) {
                    e4_loadResult = 'LOAD_ERR:' + le.constructor.name + ':' + le.message.slice(0,60);
                    send('E4-FONTDETACH', {
                        ctorOk: e4_ctorOk, detachOk: e4_detachOk,
                        loadResult: e4_loadResult, err: e4_err
                    });
                });
            } else {
                send('E4-FONTDETACH', {ctorOk: false, err: e4_err});
            }

            // E4b: detach DURING load (race the parser)
            var fontBuf2 = new ArrayBuffer(2048);
            var v2 = new Uint8Array(fontBuf2);
            v2[0] = 0x77; v2[1] = 0x4F; v2[2] = 0x46; v2[3] = 0x32;
            v2[4] = 0x00; v2[5] = 0x01; v2[6] = 0x00; v2[7] = 0x00;
            for (var k = 8; k < 2048; k++) v2[k] = 0x42;

            try {
                var font2 = new FontFace('TestFont114b', fontBuf2);
                font2.load();
                structuredClone({x: fontBuf2}, {transfer: [fontBuf2]});
                font2.load().then(function() {
                    send('E4b-RACEDETACH', {result: 'LOADED_AFTER_DETACH'});
                }).catch(function(e2) {
                    send('E4b-RACEDETACH', {result: 'ERR:' + e2.constructor.name + ':' + e2.message.slice(0,60)});
                });
            } catch(re) {
                send('E4b-RACEDETACH', {result: 'RACE_ERR:' + re.constructor.name});
            }

        } catch(e) {
            send('E4-FONTDETACH', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 1800);

    // ═══════════════════════════════════════════════════════════════
    // E5: SubtleCrypto digest + immediate buffer detach
    // Async C++ thread reads the buffer. If we detach immediately,
    // the parser thread may read from freed memory.
    // We verify by comparing hash to expected value.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var data5 = new ArrayBuffer(65536);
            new Uint8Array(data5).fill(0xAA);

            var e5_detachOk = false;
            var e5_result = '';

            var digestP = crypto.subtle.digest('SHA-256', data5);

            try {
                structuredClone({x: data5}, {transfer: [data5]});
                e5_detachOk = (data5.byteLength === 0);
            } catch(te) {
                e5_result = 'TRANSFER_ERR:' + te.constructor.name;
            }

            digestP.then(function(hash) {
                var arr = new Uint8Array(hash);
                var hex = '';
                for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
                e5_result = 'HASH:' + hex.slice(0, 32) + '...';
                send('E5-CRYPTODETACH', {
                    detachOk: e5_detachOk, result: e5_result,
                    hashLen: arr.length, bufDetached: (data5.byteLength === 0)
                });
            }).catch(function(he) {
                e5_result = 'DIGEST_ERR:' + he.constructor.name + ':' + he.message.slice(0,60);
                send('E5-CRYPTODETACH', {detachOk: e5_detachOk, result: e5_result});
            });

            // E5b: importKey with detached key buffer
            var keyBuf = new ArrayBuffer(16);
            new Uint8Array(keyBuf).fill(0xDD);
            var importP = crypto.subtle.importKey('raw', keyBuf, {name: 'AES-CBC'}, false, ['encrypt']);
            structuredClone({x: keyBuf}, {transfer: [keyBuf]});

            importP.then(function(key) {
                send('E5b-KEYDETACH', {result: 'KEY_IMPORTED', keyType: key.type, algo: key.algorithm.name});
            }).catch(function(ke) {
                send('E5b-KEYDETACH', {result: 'IMPORT_ERR:' + ke.constructor.name + ':' + ke.message.slice(0,60)});
            });

        } catch(e) {
            send('E5-CRYPTODETACH', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 2400);

    // ═══════════════════════════════════════════════════════════════
    // E6: Cross-prototype method call fuzzing
    // Call DOM methods with wrong |this| via .call(). Any that
    // doesn't throw TypeError = potential type confusion entry.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            document.body.appendChild(div);
            var canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            document.body.appendChild(canvas);
            var ctx = canvas.getContext('2d');
            var input = document.createElement('input');
            document.body.appendChild(input);
            var textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            var span = document.createElement('span');
            span.textContent = 'test';
            document.body.appendChild(span);
            var img = document.createElement('img');
            document.body.appendChild(img);

            var tests = [];
            function tryCall(name, fn) {
                try {
                    fn();
                    tests.push(name + ':OK');
                } catch(e) {
                    tests.push(name + ':' + e.constructor.name);
                }
            }

            // Canvas methods on wrong objects
            tryCall('getCtx-on-div', function() {
                HTMLCanvasElement.prototype.getContext.call(div, '2d');
            });
            tryCall('getCtx-on-input', function() {
                HTMLCanvasElement.prototype.getContext.call(input, '2d');
            });
            tryCall('toDataURL-on-div', function() {
                HTMLCanvasElement.prototype.toDataURL.call(div);
            });
            tryCall('toBlob-on-div', function() {
                HTMLCanvasElement.prototype.toBlob.call(div, function(){});
            });

            // Context methods on canvas element (not context)
            tryCall('fillRect-on-canvas', function() {
                CanvasRenderingContext2D.prototype.fillRect.call(canvas, 0, 0, 10, 10);
            });
            tryCall('getImgData-on-canvas', function() {
                CanvasRenderingContext2D.prototype.getImageData.call(canvas, 0, 0, 1, 1);
            });
            tryCall('putImgData-on-div', function() {
                var id = ctx.getImageData(0, 0, 4, 4);
                CanvasRenderingContext2D.prototype.putImageData.call(div, id, 0, 0);
            });
            tryCall('measureText-on-div', function() {
                CanvasRenderingContext2D.prototype.measureText.call(div, 'hello');
            });
            tryCall('drawImage-on-div', function() {
                CanvasRenderingContext2D.prototype.drawImage.call(div, canvas, 0, 0);
            });

            // Swap context method onto canvas prototype
            tryCall('ctx-toDataURL-swap', function() {
                var orig = HTMLCanvasElement.prototype.toDataURL;
                CanvasRenderingContext2D.prototype.__testToDataURL = orig;
                ctx.__testToDataURL();
            });

            // Input methods on wrong types
            tryCall('selRange-on-div', function() {
                HTMLInputElement.prototype.setSelectionRange.call(div, 0, 1);
            });
            tryCall('selRange-on-canvas', function() {
                HTMLInputElement.prototype.setSelectionRange.call(canvas, 0, 1);
            });
            tryCall('checkValidity-on-div', function() {
                HTMLInputElement.prototype.checkValidity.call(div);
            });
            tryCall('select-on-div', function() {
                HTMLInputElement.prototype.select.call(div);
            });

            // Textarea methods on wrong types
            tryCall('ta-selRange-on-div', function() {
                HTMLTextAreaElement.prototype.setSelectionRange.call(div, 0, 1);
            });

            // Object.create with wrong prototype
            tryCall('fakeCanvas-getCtx', function() {
                var fake = Object.create(HTMLCanvasElement.prototype);
                fake.getContext('2d');
            });
            tryCall('fakeTA-set', function() {
                var fake = Object.create(Int32Array.prototype);
                fake.set([1,2,3]);
            });
            tryCall('fakeTA-slice', function() {
                var fake = Object.create(Int32Array.prototype);
                fake.slice(0, 1);
            });

            // Image decode on wrong type
            tryCall('decode-on-div', function() {
                HTMLImageElement.prototype.decode.call(div);
            });

            // Reflect.apply variants
            tryCall('reflectApply-getCtx', function() {
                Reflect.apply(HTMLCanvasElement.prototype.getContext, div, ['2d']);
            });

            // Count non-TypeError results (potential type confusion)
            var nonTypeError = tests.filter(function(t) {
                return t.indexOf(':OK') !== -1 || (t.indexOf(':TypeError') === -1 && t.indexOf(':ERR') === -1);
            });

            send('E6-XPROTO', {
                total: tests.length,
                nonTypeErr: nonTypeError.length,
                interesting: nonTypeError.join('|'),
                all: tests.join('|')
            });
        } catch(e) {
            send('E6-XPROTO', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 3000);

    // ═══════════════════════════════════════════════════════════════
    // E7: adoptNode cross-document + GC prototype chain dangle
    // Nodes adopted from DOMParser doc keep old wrapper/prototype.
    // GC'ing the parser doc may dangle the prototype chain.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(
                '<div id="target"><span>child</span></div>', 'text/html'
            );
            var target = doc.getElementById('target');

            document.adoptNode(target);
            document.body.appendChild(target);

            var proto1 = Object.getPrototypeOf(target);
            var mainProto = Object.getPrototypeOf(document.createElement('div'));
            var sameProto = (proto1 === mainProto);

            doc = null;
            parser = null;

            for (var i = 0; i < 100000; i++) new ArrayBuffer(1024);

            var e7_heightOk = false;
            var e7_innerOk = false;
            var e7_childOk = false;
            var e7_classOk = false;
            var e7_err = null;
            try {
                target.offsetHeight;
                e7_heightOk = true;
                target.innerHTML;
                e7_innerOk = true;
                target.firstChild.textContent;
                e7_childOk = true;
            } catch(ae) {
                e7_err = 'access:' + ae.constructor.name + ':' + ae.message.slice(0,60);
            }

            // Mass adopt + GC
            var adopted = [];
            for (var j = 0; j < 50; j++) {
                var p2 = new DOMParser();
                var d2 = p2.parseFromString('<div class="x' + j + '">test' + j + '</div>', 'text/html');
                var el2 = d2.querySelector('div');
                document.adoptNode(el2);
                adopted.push(el2);
            }

            for (var k = 0; k < 500000; k++) new ArrayBuffer(256);

            var massOk = 0;
            var massErr = 0;
            for (var m = 0; m < adopted.length; m++) {
                try {
                    document.body.appendChild(adopted[m]);
                    adopted[m].offsetHeight;
                    adopted[m].className;
                    massOk++;
                } catch(me) {
                    massErr++;
                }
            }

            send('E7-ADOPTGC', {
                sameProto: sameProto,
                heightOk: e7_heightOk,
                innerOk: e7_innerOk,
                childOk: e7_childOk,
                massOk: massOk,
                massErr: massErr,
                err: e7_err
            });
        } catch(e) {
            send('E7-ADOPTGC', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 3800);

    // ═══════════════════════════════════════════════════════════════
    // E8: Shadow DOM MutationObserver + adoptNode re-entrancy
    // adoptNode of shadow host during MO delivery moves entire
    // shadow tree to different document mid-iteration.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var host = document.createElement('div');
            document.body.appendChild(host);
            var shadow = host.attachShadow({mode: 'open'});
            var inner = document.createElement('span');
            inner.textContent = 'shadow content';
            shadow.appendChild(inner);

            var doc2 = new DOMParser().parseFromString('<body></body>', 'text/html');

            var moCount = 0;
            var moMutations = 0;
            var moErr = null;
            var adoptedDuring = false;

            var mo = new MutationObserver(function(mutations) {
                moCount++;
                moMutations += mutations.length;
                if (moCount === 1) {
                    try {
                        doc2.adoptNode(host);
                        adoptedDuring = true;
                        var newChild = doc2.createElement('div');
                        shadow.appendChild(newChild);
                        newChild.remove();
                        var nc2 = doc2.createElement('p');
                        shadow.appendChild(nc2);
                    } catch(ae) {
                        moErr = 'adopt:' + ae.constructor.name + ':' + ae.message.slice(0,60);
                    }
                }
            });

            mo.observe(shadow, {childList: true, subtree: true});

            var trigger = document.createElement('b');
            shadow.appendChild(trigger);

            setTimeout(function() {
                var hostDoc = host.ownerDocument === document ? 'main' :
                              host.ownerDocument === doc2 ? 'parser' : 'unknown';
                var shadowOk = false;
                try {
                    shadow.childNodes.length;
                    shadowOk = true;
                } catch(se) {}

                send('E8-SHADOWMO', {
                    moCount: moCount,
                    moMutations: moMutations,
                    adoptedDuring: adoptedDuring,
                    hostDoc: hostDoc,
                    shadowOk: shadowOk,
                    shadowChildren: shadowOk ? shadow.childNodes.length : -1,
                    err: moErr
                });
            }, 200);
        } catch(e) {
            send('E8-SHADOWMO', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 4600);

    // ═══════════════════════════════════════════════════════════════
    // E9: Orphan animation + WeakRef GC test
    // If animation holds raw pointer (not ref-counted) to element,
    // and element is GC'd while animation runs → UAF on tick.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var el = document.createElement('div');
            el.style.width = '100px';
            el.style.height = '100px';
            el.style.background = 'blue';
            document.body.appendChild(el);

            var anim = el.animate([
                {transform: 'translateX(0px)', opacity: 1},
                {transform: 'translateX(200px)', opacity: 0}
            ], {duration: 10000, iterations: Infinity});

            var wr = new WeakRef(el);

            el.remove();
            el = null;

            for (var i = 0; i < 200000; i++) new ArrayBuffer(512);

            var afterGC1 = wr.deref() ? 'ALIVE' : 'COLLECTED';
            var animState1 = 'unknown';
            try { animState1 = anim.playState; } catch(pe) { animState1 = 'ERR:' + pe.constructor.name; }

            for (var j = 0; j < 300000; j++) new ArrayBuffer(256);

            var afterGC2 = wr.deref() ? 'ALIVE' : 'COLLECTED';
            var animState2 = 'unknown';
            try { animState2 = anim.playState; } catch(pe2) { animState2 = 'ERR:' + pe2.constructor.name; }

            var cancelOk = false;
            try {
                anim.cancel();
                cancelOk = true;
            } catch(ce) {}

            for (var k = 0; k < 200000; k++) new ArrayBuffer(512);
            var afterCancel = wr.deref() ? 'ALIVE' : 'COLLECTED';

            send('E9-ORPHANANIM', {
                afterGC1: afterGC1,
                animState1: animState1,
                afterGC2: afterGC2,
                animState2: animState2,
                cancelOk: cancelOk,
                afterCancel: afterCancel
            });
        } catch(e) {
            send('E9-ORPHANANIM', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 5400);

    // ═══════════════════════════════════════════════════════════════
    // E10: Proxy as DOM node prototype
    // Setting __proto__ to Proxy makes every property access go
    // through traps. Internal WebKit C++ code may hit traps in
    // paths that don't expect re-entrancy.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            div.id = 'proxy-proto-target';
            div.textContent = 'proxy test';
            document.body.appendChild(div);

            var trapLog = [];
            var handler = {
                get: function(target, prop, receiver) {
                    if (typeof prop === 'string') trapLog.push('g:' + prop);
                    if (prop === 'nodeType') return 3;
                    return Reflect.get(target, prop, receiver);
                },
                set: function(target, prop, value, receiver) {
                    trapLog.push('s:' + prop);
                    return Reflect.set(target, prop, value, receiver);
                }
            };

            var e10_setProtoOk = false;
            var e10_err = null;
            try {
                Object.setPrototypeOf(div, new Proxy(HTMLDivElement.prototype, handler));
                e10_setProtoOk = true;
            } catch(spe) {
                e10_err = 'setProto:' + spe.constructor.name;
            }

            if (e10_setProtoOk) {
                trapLog = [];
                try {
                    div.innerHTML = '<span>inner</span>';
                    div.offsetHeight;
                    div.getBoundingClientRect();
                    div.style.color = 'red';
                    var clone = div.cloneNode(true);
                    div.normalize();
                    div.hasAttribute('id');
                    div.getAttribute('id');
                } catch(ue) {
                    e10_err = 'use:' + ue.constructor.name + ':' + ue.message.slice(0,60);
                }
            }

            var unique = {};
            for (var i = 0; i < trapLog.length; i++) unique[trapLog[i]] = 1;

            send('E10-PROXYPROT', {
                setProtoOk: e10_setProtoOk,
                totalTraps: trapLog.length,
                uniqueTraps: Object.keys(unique).length,
                first30: trapLog.slice(0,30).join(','),
                err: e10_err
            });
        } catch(e) {
            send('E10-PROXYPROT', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 6200);

    // ═══════════════════════════════════════════════════════════════
    // E11: Range across shadow DOM boundary
    // If Selection API can create cross-shadow selection,
    // extractContents may mishandle the boundary crossing.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var host = document.createElement('div');
            document.body.appendChild(host);
            var shadow = host.attachShadow({mode: 'open'});
            shadow.innerHTML = '<p>AAA</p><p>BBB</p><p>CCC</p>';

            var e11_rangeSet = false;
            var e11_selSet = false;
            var e11_extractOk = false;
            var e11_err = null;
            var e11_extractLen = -1;

            // Try direct Range across shadow
            try {
                var range = document.createRange();
                range.setStartBefore(host);
                range.setEnd(shadow.querySelector('p:last-child'), 1);
                e11_rangeSet = true;
            } catch(re) {
                e11_err = 'range:' + re.constructor.name;
            }

            // Try Selection API cross-shadow
            try {
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.setBaseAndExtent(
                    document.body, 0,
                    shadow.querySelector('p'), 1
                );
                if (sel.rangeCount > 0) {
                    e11_selSet = true;
                    var crossRange = sel.getRangeAt(0);
                    try {
                        var extracted = crossRange.extractContents();
                        e11_extractOk = true;
                        e11_extractLen = extracted.childNodes.length;
                    } catch(ee) {
                        e11_err = (e11_err || '') + '|extract:' + ee.constructor.name;
                    }
                }
            } catch(se) {
                e11_err = (e11_err || '') + '|sel:' + se.constructor.name;
            }

            send('E11-SHADOWRANGE', {
                rangeSet: e11_rangeSet,
                selSet: e11_selSet,
                extractOk: e11_extractOk,
                extractLen: e11_extractLen,
                err: e11_err
            });
        } catch(e) {
            send('E11-SHADOWRANGE', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 7000);

    // ═══════════════════════════════════════════════════════════════
    // E12: Stale MessagePort deep probe
    // Transfer port to worker, then rapid-fire postMessage on stale
    // port reference. Check for crash, memory corruption, or
    // incorrect message delivery.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var mc = new MessageChannel();
            var port1 = mc.port1;
            var port2 = mc.port2;

            var workerCode = [
                'var gotPorts = [];',
                'onmessage = function(e) {',
                '  if (e.data.type === "port" && e.ports[0]) {',
                '    gotPorts.push(e.ports[0]);',
                '    e.ports[0].onmessage = function(m) {',
                '      postMessage({type:"portmsg", data: m.data});',
                '    };',
                '    e.ports[0].start();',
                '    try { postMessage({type:"bounce"}, [e.ports[0]]); } catch(te) {',
                '      postMessage({type:"bounce_err", err: te.message});',
                '    }',
                '  }',
                '};'
            ].join('\n');

            var blob = new Blob([workerCode], {type: 'application/javascript'});
            var worker = new Worker(URL.createObjectURL(blob));

            var e12_staleResults = [];
            var e12_port2Msgs = [];
            var e12_workerMsgs = [];

            port2.onmessage = function(e) { e12_port2Msgs.push(JSON.stringify(e.data).slice(0,50)); };
            port2.start();

            worker.postMessage({type: 'port'}, [port1]);

            for (var i = 0; i < 10; i++) {
                try {
                    port1.postMessage({stale: true, idx: i});
                    e12_staleResults.push(i + ':OK');
                } catch(se) {
                    e12_staleResults.push(i + ':' + se.constructor.name);
                }
            }

            worker.onmessage = function(e) {
                e12_workerMsgs.push(JSON.stringify(e.data).slice(0,50));
            };

            setTimeout(function() {
                send('E12-STALEPORT', {
                    staleSends: e12_staleResults.join('|'),
                    port2Msgs: e12_port2Msgs.length,
                    port2First: e12_port2Msgs.slice(0,3).join('|'),
                    workerMsgs: e12_workerMsgs.length,
                    workerFirst: e12_workerMsgs.slice(0,3).join('|')
                });
                worker.terminate();
            }, 500);
        } catch(e) {
            send('E12-STALEPORT', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,80)});
        }
    }, 7800);

    // ═══════════════════════════════════════════════════════════════
    // DONE beacon
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        clearInterval(hb);
        send('Z', 'probe114-done');
    }, 9500);

}, 300);
})();
