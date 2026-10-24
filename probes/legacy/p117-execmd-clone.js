// p117-execmd-clone.js — execCommand UAF + structuredClone edge cases
//
// WebKit's editing code (execCommand, contenteditable) has produced
// dozens of CVEs. Also: structuredClone with complex object graphs,
// and Selection/Range re-entrancy during editing operations.
//
// Beacon prefix: V117X-

(function(){
var RUN = 'v117x' + Math.random().toString(36).slice(2,14);
var BC = '/beacon/V117X-';

function send(tag, data) {
    var body = JSON.stringify({r: RUN, b: typeof data === 'string' ? data : JSON.stringify(data)});
    try { navigator.sendBeacon(BC + tag, body); } catch(e) {}
}

var hb = setInterval(function(){ send('HB','hb'); }, 5000);

setTimeout(function() {
    send('L', 'probe117-start');

    // ═══════════════════════════════════════════════════════════════
    // X1: execCommand('insertHTML') with complex nested HTML
    // during MutationObserver callback that mutates the document.
    // Classic WebKit editing UAF pattern.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p>line1</p><p>line2</p><p>line3</p>';
            document.body.appendChild(editable);
            editable.focus();

            var moCount = 0;
            var moErr = null;
            var mo = new MutationObserver(function(records) {
                moCount++;
                if (moCount === 1) {
                    try {
                        // Re-enter editing during MO callback
                        document.execCommand('insertText', false, 'INJECTED');
                    } catch(e) {
                        moErr = e.constructor.name + ':' + e.message.slice(0,40);
                    }
                }
                if (moCount === 2) {
                    try {
                        // Remove the editable element during editing
                        editable.remove();
                        // Then try to continue editing
                        document.execCommand('insertHTML', false, '<b>after-remove</b>');
                    } catch(e) {
                        moErr = (moErr || '') + '|' + e.constructor.name;
                    }
                }
            });
            mo.observe(editable, {childList: true, subtree: true, characterData: true});

            // Select all and insert complex HTML
            var sel = window.getSelection();
            var range = document.createRange();
            range.selectNodeContents(editable);
            sel.removeAllRanges();
            sel.addRange(range);

            var x1_err = null;
            try {
                document.execCommand('insertHTML', false,
                    '<table><tr><td><div contenteditable="true"><p>nested</p></div></td></tr></table>' +
                    '<ul><li>item1</li><li>item2</li></ul>' +
                    '<blockquote><pre>code</pre></blockquote>'
                );
            } catch(e) {
                x1_err = e.constructor.name + ':' + e.message.slice(0,60);
            }

            setTimeout(function() {
                mo.disconnect();
                send('X1-INSERTHTML', {
                    moCount: moCount,
                    moErr: moErr,
                    execErr: x1_err,
                    survived: true
                });
            }, 500);
        } catch(e) {
            send('X1-INSERTHTML', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,60)});
        }
    }, 100);

    // ═══════════════════════════════════════════════════════════════
    // X2: execCommand('delete') with MO that re-adds deleted content
    // Delete fires MO → MO re-inserts → delete continues on stale
    // node list → potential UAF.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p id="x2a">AAA</p><p id="x2b">BBB</p><p id="x2c">CCC</p><p id="x2d">DDD</p>';
            document.body.appendChild(editable);
            editable.focus();

            var x2_moCount = 0;
            var x2_reinserted = 0;
            var mo = new MutationObserver(function(records) {
                x2_moCount++;
                for (var i = 0; i < records.length; i++) {
                    for (var j = 0; j < records[i].removedNodes.length; j++) {
                        var removed = records[i].removedNodes[j];
                        if (x2_reinserted < 5) {
                            try {
                                // Re-add the removed node
                                editable.appendChild(removed.cloneNode(true));
                                x2_reinserted++;
                            } catch(e) {}
                        }
                    }
                }
            });
            mo.observe(editable, {childList: true, subtree: true});

            // Select all
            var sel = window.getSelection();
            var range = document.createRange();
            range.selectNodeContents(editable);
            sel.removeAllRanges();
            sel.addRange(range);

            // Delete selected content — MO will re-add nodes
            var x2_err = null;
            try {
                document.execCommand('delete', false, null);
            } catch(e) {
                x2_err = e.constructor.name + ':' + e.message.slice(0,60);
            }

            setTimeout(function() {
                mo.disconnect();
                send('X2-DELETEREADD', {
                    moCount: x2_moCount,
                    reinserted: x2_reinserted,
                    childCount: editable.childNodes.length,
                    execErr: x2_err,
                    survived: true
                });
                editable.remove();
            }, 500);
        } catch(e) {
            send('X2-DELETEREADD', {err: 'OUTER:' + e.constructor.name});
        }
    }, 900);

    // ═══════════════════════════════════════════════════════════════
    // X3: execCommand('undo') / 'redo' with DOM mutation between
    // Undo stack may hold stale references to removed nodes.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p>original</p>';
            document.body.appendChild(editable);
            editable.focus();

            // Make some edits to build undo stack
            var sel = window.getSelection();

            // Edit 1: insert text
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, 'replaced');

            // Edit 2: insert HTML
            document.execCommand('selectAll', false, null);
            document.execCommand('insertHTML', false, '<div><span id="x3inner">complex</span></div>');

            // Now manually destroy the DOM structure
            var inner = document.getElementById('x3inner');
            if (inner) inner.remove();
            editable.innerHTML = '<p>completely different</p>';

            // Now undo — should try to restore removed nodes
            var x3_undoResults = [];
            for (var i = 0; i < 5; i++) {
                try {
                    document.execCommand('undo', false, null);
                    x3_undoResults.push('undo' + i + ':OK:' + editable.innerHTML.slice(0,30));
                } catch(e) {
                    x3_undoResults.push('undo' + i + ':' + e.constructor.name);
                }
            }

            // Then redo
            var x3_redoResults = [];
            for (var j = 0; j < 5; j++) {
                try {
                    document.execCommand('redo', false, null);
                    x3_redoResults.push('redo' + j + ':OK:' + editable.innerHTML.slice(0,30));
                } catch(e) {
                    x3_redoResults.push('redo' + j + ':' + e.constructor.name);
                }
            }

            send('X3-UNDOREDO', {
                undos: x3_undoResults.join('|'),
                redos: x3_redoResults.join('|'),
                survived: true
            });
            editable.remove();
        } catch(e) {
            send('X3-UNDOREDO', {err: 'OUTER:' + e.constructor.name + ':' + e.message.slice(0,60)});
        }
    }, 1700);

    // ═══════════════════════════════════════════════════════════════
    // X4: Selection manipulation during execCommand
    // Change selection in a beforeinput event handler, then let
    // the command proceed with stale selection state.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p id="x4a">AAAA</p><p id="x4b">BBBB</p><p id="x4c">CCCC</p>';
            document.body.appendChild(editable);
            editable.focus();

            var x4_beforeCount = 0;
            var x4_inputCount = 0;
            var x4_err = null;

            editable.addEventListener('beforeinput', function(e) {
                x4_beforeCount++;
                if (x4_beforeCount === 1) {
                    // Mutate selection during beforeinput
                    try {
                        var sel = window.getSelection();
                        sel.removeAllRanges();
                        var newRange = document.createRange();
                        var x4c = document.getElementById('x4c');
                        if (x4c && x4c.firstChild) {
                            newRange.setStart(x4c.firstChild, 0);
                            newRange.setEnd(x4c.firstChild, 2);
                            sel.addRange(newRange);
                        }
                    } catch(se) {
                        x4_err = 'selChange:' + se.constructor.name;
                    }
                }
            });

            editable.addEventListener('input', function(e) {
                x4_inputCount++;
            });

            // Select paragraph A
            var sel = window.getSelection();
            var range = document.createRange();
            var x4a = document.getElementById('x4a');
            if (x4a) {
                range.selectNodeContents(x4a);
                sel.removeAllRanges();
                sel.addRange(range);
            }

            // Execute delete — beforeinput will change selection mid-operation
            try {
                document.execCommand('delete', false, null);
            } catch(de) {
                x4_err = (x4_err || '') + '|delete:' + de.constructor.name;
            }

            send('X4-SELINPUT', {
                beforeCount: x4_beforeCount,
                inputCount: x4_inputCount,
                html: editable.innerHTML.slice(0,80),
                err: x4_err,
                survived: true
            });
            editable.remove();
        } catch(e) {
            send('X4-SELINPUT', {err: 'OUTER:' + e.constructor.name});
        }
    }, 2500);

    // ═══════════════════════════════════════════════════════════════
    // X5: structuredClone with very deep object nesting
    // structuredClone uses recursive serialization. Deep nesting
    // may overflow C++ stack.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = {};

            // Deep object nesting
            var depths = [100, 500, 1000, 5000, 10000];
            for (var d = 0; d < depths.length; d++) {
                var depth = depths[d];
                var obj = {leaf: true};
                for (var i = 0; i < depth; i++) obj = {child: obj};
                try {
                    var clone = structuredClone(obj);
                    // Verify depth
                    var c = clone;
                    var counted = 0;
                    while (c && c.child) { c = c.child; counted++; }
                    results['obj_' + depth] = 'OK:depth=' + counted;
                } catch(e) {
                    results['obj_' + depth] = e.constructor.name + ':' + e.message.slice(0,40);
                }
            }

            // Deep array nesting
            var arrDepths = [100, 500, 1000, 5000];
            for (var a = 0; a < arrDepths.length; a++) {
                var ad = arrDepths[a];
                var arr = [1];
                for (var j = 0; j < ad; j++) arr = [arr];
                try {
                    var clone2 = structuredClone(arr);
                    results['arr_' + ad] = 'OK';
                } catch(e) {
                    results['arr_' + ad] = e.constructor.name + ':' + e.message.slice(0,40);
                }
            }

            // Circular reference
            try {
                var circ = {a: 1};
                circ.self = circ;
                circ.arr = [circ, circ, circ];
                var clone3 = structuredClone(circ);
                results.circular = 'OK:selfRef=' + (clone3.self === clone3);
            } catch(e) {
                results.circular = e.constructor.name + ':' + e.message.slice(0,40);
            }

            send('X5-DEEPCLONE', results);
        } catch(e) {
            send('X5-DEEPCLONE', {err: 'OUTER:' + e.constructor.name});
        }
    }, 3300);

    // ═══════════════════════════════════════════════════════════════
    // X6: structuredClone with getter callbacks during serialization
    // Proxy/getter on source object — does clone fire getters?
    // If so, getters can mutate state during serialization.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = {};
            var getterLog = [];

            // Object with getter that mutates during clone
            var poison = {};
            var bufToDetach = new ArrayBuffer(256);
            new Uint8Array(bufToDetach).fill(0xEE);

            Object.defineProperty(poison, 'a', {
                get: function() { getterLog.push('a'); return 1; },
                enumerable: true
            });
            Object.defineProperty(poison, 'b', {
                get: function() {
                    getterLog.push('b');
                    // Detach the buffer during serialization
                    if (bufToDetach.byteLength > 0) {
                        try {
                            structuredClone({x: bufToDetach}, {transfer: [bufToDetach]});
                        } catch(e) {}
                    }
                    return 2;
                },
                enumerable: true
            });
            Object.defineProperty(poison, 'c', {
                get: function() {
                    getterLog.push('c');
                    return new Uint8Array(bufToDetach); // Detached view
                },
                enumerable: true
            });

            try {
                var clone = structuredClone(poison);
                results.cloneOk = true;
                results.cloneKeys = Object.keys(clone).join(',');
                results.cloneA = clone.a;
                results.cloneB = clone.b;
                results.cloneC = clone.c ? 'len=' + clone.c.length : 'null';
            } catch(e) {
                results.cloneErr = e.constructor.name + ':' + e.message.slice(0,60);
            }
            results.getterOrder = getterLog.join(',');
            results.bufDetached = (bufToDetach.byteLength === 0);

            // Proxy as structuredClone source
            var proxyLog = [];
            var proxyObj = new Proxy({x: 1, y: 2, z: 3}, {
                get: function(target, prop) {
                    proxyLog.push(prop);
                    return target[prop];
                },
                ownKeys: function(target) {
                    proxyLog.push('ownKeys');
                    return ['x', 'y', 'z'];
                },
                getOwnPropertyDescriptor: function(target, prop) {
                    proxyLog.push('desc:' + prop);
                    return {value: target[prop], writable: true, enumerable: true, configurable: true};
                }
            });

            try {
                var clone2 = structuredClone(proxyObj);
                results.proxyCloneOk = true;
                results.proxyCloneKeys = Object.keys(clone2).join(',');
            } catch(e) {
                results.proxyCloneErr = e.constructor.name + ':' + e.message.slice(0,60);
            }
            results.proxyTraps = proxyLog.length;
            results.proxyFirst10 = proxyLog.slice(0,10).join(',');

            send('X6-CLONEGETTERS', results);
        } catch(e) {
            send('X6-CLONEGETTERS', {err: 'OUTER:' + e.constructor.name});
        }
    }, 4100);

    // ═══════════════════════════════════════════════════════════════
    // X7: execCommand('insertHTML') with SVG + foreignObject
    // insertHTML with SVG containing foreignObject creates a
    // cross-namespace situation in the editing code.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p>before</p>';
            document.body.appendChild(editable);
            editable.focus();

            document.execCommand('selectAll', false, null);

            var svgHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
                '<foreignObject width="200" height="200">' +
                '<div xmlns="http://www.w3.org/1999/xhtml" contenteditable="true">' +
                '<p>inside foreignObject</p>' +
                '</div></foreignObject>' +
                '<text x="10" y="20">SVG text</text>' +
                '</svg>';

            var x7_err = null;
            try {
                document.execCommand('insertHTML', false, svgHtml);
            } catch(e) {
                x7_err = e.constructor.name + ':' + e.message.slice(0,60);
            }

            // Now try to edit inside the foreignObject
            var foreign = editable.querySelector('foreignObject div');
            var x7_foreignFound = !!foreign;
            var x7_editResult = '';
            if (foreign) {
                try {
                    foreign.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, 'edited');
                    x7_editResult = 'OK:' + foreign.textContent.slice(0,30);
                } catch(fe) {
                    x7_editResult = fe.constructor.name;
                }
            }

            // Delete the SVG — editing code must handle cross-namespace removal
            editable.focus();
            document.execCommand('selectAll', false, null);
            var x7_deleteErr = null;
            try {
                document.execCommand('delete', false, null);
            } catch(de) {
                x7_deleteErr = de.constructor.name;
            }

            send('X7-SVGFOREIGN', {
                insertErr: x7_err,
                foreignFound: x7_foreignFound,
                editResult: x7_editResult,
                deleteErr: x7_deleteErr,
                finalHtml: editable.innerHTML.slice(0,80),
                survived: true
            });
            editable.remove();
        } catch(e) {
            send('X7-SVGFOREIGN', {err: 'OUTER:' + e.constructor.name});
        }
    }, 4900);

    // ═══════════════════════════════════════════════════════════════
    // X8: contenteditable with adoptNode during input event
    // Move the editable element to a different document during
    // an editing operation.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<p>adopt test</p>';
            document.body.appendChild(editable);
            editable.focus();

            var doc2 = new DOMParser().parseFromString('<body></body>', 'text/html');

            var x8_adopted = false;
            var x8_err = null;

            editable.addEventListener('input', function() {
                if (!x8_adopted) {
                    try {
                        doc2.adoptNode(editable);
                        x8_adopted = true;
                        // Try more editing after adoption
                        document.execCommand('insertText', false, 'after-adopt');
                    } catch(ae) {
                        x8_err = 'adopt:' + ae.constructor.name + ':' + ae.message.slice(0,40);
                    }
                }
            });

            // Trigger an edit
            document.execCommand('selectAll', false, null);
            try {
                document.execCommand('insertText', false, 'trigger');
            } catch(te) {
                x8_err = (x8_err || '') + '|trigger:' + te.constructor.name;
            }

            setTimeout(function() {
                send('X8-ADOPTINPUT', {
                    adopted: x8_adopted,
                    editableDoc: editable.ownerDocument === document ? 'main' :
                                 editable.ownerDocument === doc2 ? 'parser' : 'unknown',
                    html: editable.innerHTML.slice(0,60),
                    err: x8_err,
                    survived: true
                });
            }, 300);
        } catch(e) {
            send('X8-ADOPTINPUT', {err: 'OUTER:' + e.constructor.name});
        }
    }, 5700);

    // ═══════════════════════════════════════════════════════════════
    // X9: execCommand with table editing operations
    // Table editing (insertRow, deleteRow) through execCommand
    // has historically produced UAFs in WebKit's editing code.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var editable = document.createElement('div');
            editable.contentEditable = 'true';
            editable.innerHTML = '<table><tbody>' +
                '<tr><td>A1</td><td>A2</td><td>A3</td></tr>' +
                '<tr><td>B1</td><td>B2</td><td>B3</td></tr>' +
                '<tr><td>C1</td><td>C2</td><td>C3</td></tr>' +
                '</tbody></table>';
            document.body.appendChild(editable);
            editable.focus();

            var results = {};

            // Select a cell and try various operations
            var td = editable.querySelector('td');
            if (td) {
                var range = document.createRange();
                range.selectNodeContents(td);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
            }

            var cmds = ['insertOrderedList', 'insertUnorderedList', 'indent', 'outdent',
                       'formatBlock', 'removeFormat', 'insertParagraph',
                       'insertHorizontalRule', 'insertHTML'];
            var cmdArgs = [null, null, null, null, '<h1>', null, null, null, '<table><tr><td>nested</td></tr></table>'];

            for (var i = 0; i < cmds.length; i++) {
                try {
                    var supported = document.queryCommandSupported(cmds[i]);
                    if (supported) {
                        document.execCommand(cmds[i], false, cmdArgs[i]);
                        results[cmds[i]] = 'OK';
                    } else {
                        results[cmds[i]] = 'UNSUPPORTED';
                    }
                } catch(e) {
                    results[cmds[i]] = e.constructor.name;
                }
            }

            // Rapid undo/redo cycle
            var undoErr = null;
            try {
                for (var j = 0; j < 20; j++) {
                    document.execCommand('undo', false, null);
                }
                for (var k = 0; k < 20; k++) {
                    document.execCommand('redo', false, null);
                }
            } catch(ue) {
                undoErr = ue.constructor.name;
            }

            results.undoRedoCycle = undoErr || 'OK';
            results.survived = true;

            send('X9-TABLEEDIT', results);
            editable.remove();
        } catch(e) {
            send('X9-TABLEEDIT', {err: 'OUTER:' + e.constructor.name});
        }
    }, 6500);

    // ═══════════════════════════════════════════════════════════════
    // X10: Multiple structuredClone transfers in rapid succession
    // with GC pressure between each transfer. Test if the
    // transfer bookkeeping can be confused.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var results = {};
            var errors = [];

            // Rapid transfer chain
            var buf = new ArrayBuffer(1024);
            new Uint8Array(buf).fill(0xAA);

            for (var i = 0; i < 50; i++) {
                try {
                    var clone = structuredClone({data: buf}, {transfer: [buf]});
                    buf = clone.data; // Get the transferred buffer back
                    // GC pressure
                    if (i % 10 === 0) {
                        for (var j = 0; j < 10000; j++) new ArrayBuffer(64);
                    }
                } catch(e) {
                    errors.push(i + ':' + e.constructor.name);
                    break;
                }
            }
            results.chainLen = 50;
            results.errors = errors.join('|') || 'none';
            results.finalBufSize = buf ? buf.byteLength : -1;

            // Verify final buffer contents
            if (buf && buf.byteLength > 0) {
                var view = new Uint8Array(buf);
                var intact = true;
                for (var k = 0; k < view.length; k++) {
                    if (view[k] !== 0xAA) { intact = false; break; }
                }
                results.dataIntact = intact;
            }

            // Multiple buffers transferred simultaneously
            var bufs = [];
            for (var m = 0; m < 20; m++) {
                var b = new ArrayBuffer(512);
                new Uint8Array(b).fill(m & 0xFF);
                bufs.push(b);
            }

            try {
                var obj = {};
                var transfers = [];
                for (var n = 0; n < bufs.length; n++) {
                    obj['buf' + n] = bufs[n];
                    transfers.push(bufs[n]);
                }
                var multiClone = structuredClone(obj, {transfer: transfers});
                var allDetached = bufs.every(function(b) { return b.byteLength === 0; });
                results.multiTransfer = 'OK:allDetached=' + allDetached;

                // Verify each buffer
                var corrupted = 0;
                for (var p = 0; p < 20; p++) {
                    var v = new Uint8Array(multiClone['buf' + p]);
                    for (var q = 0; q < v.length; q++) {
                        if (v[q] !== (p & 0xFF)) { corrupted++; break; }
                    }
                }
                results.multiCorrupted = corrupted;
            } catch(e) {
                results.multiTransfer = e.constructor.name + ':' + e.message.slice(0,40);
            }

            send('X10-TRANSFERCHAIN', results);
        } catch(e) {
            send('X10-TRANSFERCHAIN', {err: 'OUTER:' + e.constructor.name});
        }
    }, 7300);

    // ═══════════════════════════════════════════════════════════════
    // DONE beacon
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        clearInterval(hb);
        send('Z', 'probe117-done');
    }, 9500);

}, 300);
})();
