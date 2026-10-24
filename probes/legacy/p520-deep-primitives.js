// p520 — Deep primitive hunting across multiple subsystems
//
// Tests uncommon interactions that could yield memory corruption:
// T1: commitStyles() on animation after element adopted to different document
// T2: CSSStyleSheet.replaceSync() during style resolution callback
// T3: crypto.subtle with malformed key data (JWK integer overflow)
// T4: structuredClone of object with getters that detach AB during clone
// T5: Intl.Segmenter/Collator with extreme locale + long string
// T6: Response.clone() body consumption race via tee()
// T7: AbortSignal.any() with circular abort chains
// T8: URLSearchParams iterator with toString modification during iteration
//
// Beacon prefix: V520-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V520-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: commitStyles() after element adopted to different document
  try {
    B('T1-START', 'commitStyles after adopt');
    var iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    var el = document.createElement('div');
    el.style.cssText = 'width:100px;height:100px;background:red';
    document.body.appendChild(el);

    var anim = el.animate([
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.5)' }
    ], { duration: 50, fill: 'forwards' });

    anim.onfinish = function() {
      try {
        // Adopt the element to a different document while animation is filled
        iframe.contentDocument.adoptNode(el);
        // Now try commitStyles — element is in iframe doc but animation's
        // timeline is in parent doc. The renderer is gone.
        try {
          anim.commitStyles();
          B('T1-COMMIT-OK', 'commitStyles succeeded after adopt');
        } catch(e) {
          B('T1-COMMIT-ERR', e.name + ': ' + e.message);
        }
        // Re-attach to iframe doc and try again
        iframe.contentDocument.body.appendChild(el);
        el.offsetHeight; // force layout
        try {
          anim.commitStyles();
          B('T1-COMMIT2-OK', 'second commitStyles after reattach');
        } catch(e) {
          B('T1-COMMIT2-ERR', e.name + ': ' + e.message);
        }
      } catch(e) {
        B('T1-ERR', e.name + ': ' + e.message);
      }
    };

    setTimeout(function() {
      B('T1-DONE', 'finished');
      iframe.remove();
    }, 500);
  } catch(e) {
    B('T1-ERR', '' + e);
  }

  // T2: CSSStyleSheet replaceSync during requestAnimationFrame
  setTimeout(function() {
    try {
      B('T2-START', 'adoptedStyleSheets replaceSync');
      if (typeof CSSStyleSheet !== 'function' || !('replaceSync' in CSSStyleSheet.prototype)) {
        B('T2-DEAD', 'Constructable stylesheets not available');
        return;
      }
      var sheet = new CSSStyleSheet();
      sheet.replaceSync('.test { color: red; }');
      document.adoptedStyleSheets = [sheet];

      var el2 = document.createElement('div');
      el2.className = 'test';
      el2.textContent = 'test';
      document.body.appendChild(el2);

      var rafCount = 0;
      function rafLoop() {
        rafCount++;
        // Replace stylesheet content every frame — tests invalidation during resolution
        sheet.replaceSync('.test { color: ' + (rafCount % 2 === 0 ? 'blue' : 'green') + '; width: ' + (rafCount * 10) + 'px; }');

        if (rafCount === 50) {
          var cs = getComputedStyle(el2);
          B('T2-DONE', 'color=' + cs.color + ' width=' + cs.width + ' frames=' + rafCount);
          el2.remove();
          document.adoptedStyleSheets = [];
          return;
        }
        requestAnimationFrame(rafLoop);
      }
      requestAnimationFrame(rafLoop);
    } catch(e) {
      B('T2-ERR', '' + e);
    }
  }, 700);

  // T3: crypto.subtle with edge-case key data
  setTimeout(function() {
    try {
      B('T3-START', 'crypto.subtle edge cases');
      if (!crypto || !crypto.subtle) {
        B('T3-DEAD', 'no crypto.subtle');
        return;
      }

      var tests = [];

      // T3a: Import a JWK with extremely large 'n' value
      var bigN = '';
      for (var i = 0; i < 16384; i++) bigN += 'A';
      tests.push(
        crypto.subtle.importKey('jwk', {
          kty: 'RSA',
          n: bigN,
          e: 'AQAB',
          alg: 'RS256',
          ext: true
        }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify'])
        .then(function(k) { return 'big-n:OK:' + k.algorithm.modulusLength; })
        .catch(function(e) { return 'big-n:ERR:' + e.name; })
      );

      // T3b: ECDH with wrong curve point
      tests.push(
        crypto.subtle.importKey('jwk', {
          kty: 'EC',
          crv: 'P-256',
          x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          ext: true
        }, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
        .then(function(k) { return 'bad-point:OK'; })
        .catch(function(e) { return 'bad-point:ERR:' + e.name; })
      );

      // T3c: AES key with wrong length
      tests.push(
        crypto.subtle.importKey('raw',
          new Uint8Array(7).buffer,
          { name: 'AES-GCM' }, true, ['encrypt'])
        .then(function() { return 'bad-aes-len:OK'; })
        .catch(function(e) { return 'bad-aes-len:ERR:' + e.name; })
      );

      Promise.all(tests).then(function(r) {
        B('T3-DONE', JSON.stringify(r));
      });
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 1500);

  // T4: structuredClone with AB detach during clone via getter
  setTimeout(function() {
    try {
      B('T4-START', 'structuredClone getter detach');

      var ab = new ArrayBuffer(1024);
      var view = new Uint8Array(ab);
      for (var i = 0; i < 1024; i++) view[i] = i & 0xFF;

      var mc = new MessageChannel();
      var accessCount = 0;

      var obj = {
        get a() {
          accessCount++;
          if (accessCount === 1) {
            // First property access: detach the AB
            try {
              mc.port1.postMessage('x', [ab]);
              return 'detached:' + (ab.byteLength === 0);
            } catch(e) {
              return 'detach-err:' + e.message.slice(0, 40);
            }
          }
          return 'normal';
        },
        b: ab, // This references the now-detached AB
        c: 'end'
      };

      try {
        var clone = structuredClone(obj);
        B('T4-CLONE-OK', 'clone succeeded, keys=' + Object.keys(clone));
      } catch(e) {
        B('T4-CLONE-ERR', e.name + ': ' + e.message.slice(0, 60));
      }
      B('T4-DONE', 'accesses=' + accessCount + ' ab.byteLength=' + ab.byteLength);
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 2500);

  // T5: Intl edge cases
  setTimeout(function() {
    try {
      B('T5-START', 'Intl edge cases');
      var results = [];

      // T5a: Segmenter (if available)
      if (typeof Intl.Segmenter === 'function') {
        try {
          var seg = new Intl.Segmenter('ja', { granularity: 'word' });
          var longStr = '';
          for (var i = 0; i < 100000; i++) longStr += String.fromCharCode(0x4E00 + (i % 0x9FFF));
          var segments = seg.segment(longStr);
          var count = 0;
          for (var s of segments) { count++; if (count > 10) break; }
          results.push('segmenter:OK:' + count);
        } catch(e) {
          results.push('segmenter:ERR:' + e.name);
        }
      } else {
        results.push('segmenter:MISSING');
      }

      // T5b: NumberFormat with extreme values
      try {
        var nf = new Intl.NumberFormat('ar-SA', {
          style: 'currency',
          currency: 'SAR',
          notation: 'compact',
          maximumFractionDigits: 20
        });
        var r = nf.format(Number.MAX_SAFE_INTEGER);
        results.push('numfmt:OK:' + r.length);
      } catch(e) {
        results.push('numfmt:ERR:' + e.name);
      }

      // T5c: Collator compare with very long strings
      try {
        var col = new Intl.Collator('de', { sensitivity: 'variant', numeric: true });
        var s1 = '', s2 = '';
        for (var i = 0; i < 50000; i++) {
          s1 += String.fromCharCode(65 + (i % 26));
          s2 += String.fromCharCode(65 + ((i + 1) % 26));
        }
        var cmp = col.compare(s1, s2);
        results.push('collator:OK:' + cmp);
      } catch(e) {
        results.push('collator:ERR:' + e.name);
      }

      B('T5-DONE', JSON.stringify(results));
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 3500);

  // T6: Response.clone() body consumption race
  setTimeout(function() {
    try {
      B('T6-START', 'Response.clone body race');
      if (typeof Response === 'undefined') {
        B('T6-DEAD', 'no Response');
        return;
      }

      // Create a Response with a body, clone it, consume both simultaneously
      var bigBody = new ArrayBuffer(1024 * 1024);
      new Uint8Array(bigBody).fill(0x42);
      var resp = new Response(bigBody);
      var clone = resp.clone();

      // Race: consume both clones at the same time
      Promise.all([
        resp.arrayBuffer().then(function(ab1) { return 'orig:' + ab1.byteLength; }),
        clone.arrayBuffer().then(function(ab2) { return 'clone:' + ab2.byteLength; })
      ]).then(function(r) {
        B('T6-DONE', JSON.stringify(r));
      }).catch(function(e) {
        B('T6-ERR', e.name + ': ' + e.message);
      });
    } catch(e) {
      B('T6-ERR', '' + e);
    }
  }, 4500);

  // T7: AbortSignal.any() with circular chains
  setTimeout(function() {
    try {
      B('T7-START', 'AbortSignal chains');
      if (typeof AbortSignal.any !== 'function') {
        B('T7-DEAD', 'no AbortSignal.any');
        return;
      }

      var controllers = [];
      for (var i = 0; i < 100; i++) {
        controllers.push(new AbortController());
      }

      // Create deep chain of AbortSignal.any()
      var signals = controllers.map(function(c) { return c.signal; });
      var combined = AbortSignal.any(signals);

      // Now abort one in the middle — does it propagate correctly?
      combined.addEventListener('abort', function() {
        B('T7-ABORT', 'combined signal aborted');
      });

      controllers[50].abort('test-reason');

      setTimeout(function() {
        B('T7-DONE', 'aborted=' + combined.aborted + ' reason=' + combined.reason);
      }, 100);
    } catch(e) {
      B('T7-ERR', '' + e);
    }
  }, 5500);

  // T8: URLSearchParams iterator modification during iteration
  setTimeout(function() {
    try {
      B('T8-START', 'URLSearchParams mutation during iteration');
      var params = new URLSearchParams('a=1&b=2&c=3&d=4&e=5');

      var results = [];
      var iterCount = 0;
      for (var pair of params) {
        iterCount++;
        results.push(pair[0] + '=' + pair[1]);
        if (iterCount === 2) {
          // Modify params during iteration
          params.delete('d');
          params.append('f', '6');
          params.set('a', 'modified');
        }
      }

      B('T8-DONE', 'iters=' + iterCount + ' result=' + results.join(','));
    } catch(e) {
      B('T8-ERR', '' + e);
    }
  }, 6500);

  // Final summary
  setTimeout(function() {
    B('COMPLETE', 'all tests done');
  }, 8000);

})();
