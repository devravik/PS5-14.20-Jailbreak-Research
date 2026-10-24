// p187 — Hidden/Alternative API probe for PS5 14.20
// Tests whether "unavailable" APIs exist under different names,
// vendor prefixes, or alternative access paths.
// Beacon prefix: V187-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V187-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  function test(name, fn) {
    var result;
    try {
      result = fn();
      if (result === true) result = 'Y';
      else if (result === false) result = 'N';
      else if (result === null || result === undefined) result = 'N';
      else result = String(result).substring(0, 40);
    } catch(e) {
      result = 'E-' + (e.message || '').substring(0, 25);
    }
    syncB(name + '-' + result);
  }

  syncB('BOOT');

  // ================================================================
  // 1. NAVIGATOR PROPERTY DUMP — find Sony-specific extensions
  // ================================================================
  syncB('NAV-DUMP-START');
  try {
    var navProps = [];
    for (var key in navigator) {
      navProps.push(key);
    }
    // Also get non-enumerable own properties
    var ownProps = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator));
    for (var i = 0; i < ownProps.length; i++) {
      if (navProps.indexOf(ownProps[i]) === -1) navProps.push(ownProps[i]);
    }
    navProps.sort();

    // Beacon in chunks of ~10 props
    var chunk = [];
    for (var i = 0; i < navProps.length; i++) {
      chunk.push(navProps[i]);
      if (chunk.length >= 8 || i === navProps.length - 1) {
        syncB('NAV-' + Math.floor(i / 8) + '-' + chunk.join(','));
        chunk = [];
      }
    }
    syncB('NAV-TOTAL-' + navProps.length);

    // Check specific Sony/PlayStation extensions
    test('nav-playstation', function() { return typeof navigator.playstation !== 'undefined'; });
    test('nav-sce', function() { return typeof navigator.sce !== 'undefined'; });
    test('nav-ps5', function() { return typeof navigator.ps5 !== 'undefined'; });
    test('nav-orbis', function() { return typeof navigator.orbis !== 'undefined'; });
    test('nav-prospero', function() { return typeof navigator.prospero !== 'undefined'; });
    test('nav-sony', function() { return typeof navigator.sony !== 'undefined'; });
    test('nav-sie', function() { return typeof navigator.sie !== 'undefined'; });
    test('nav-nativeapp', function() { return typeof navigator.nativeApp !== 'undefined'; });
    test('nav-standalone', function() { return typeof navigator.standalone !== 'undefined'; });
  } catch(e) {
    syncB('NAV-DUMP-ERR');
  }

  // ================================================================
  // 2. WINDOW PROPERTY SCAN — non-standard globals
  // ================================================================
  syncB('WIN-SCAN-START');
  try {
    // Check for Sony-specific globals
    test('win-sce', function() { return typeof window.sce !== 'undefined'; });
    test('win-SCE', function() { return typeof window.SCE !== 'undefined'; });
    test('win-PlayStation', function() { return typeof window.PlayStation !== 'undefined'; });
    test('win-ps5', function() { return typeof window.ps5 !== 'undefined'; });
    test('win-orbis', function() { return typeof window.orbis !== 'undefined'; });
    test('win-prospero', function() { return typeof window.prospero !== 'undefined'; });
    test('win-NativeShell', function() { return typeof window.NativeShell !== 'undefined'; });
    test('win-webkit', function() { return typeof window.webkit !== 'undefined'; });
    test('win-webkitMsg', function() { return typeof window.webkit !== 'undefined' && typeof window.webkit.messageHandlers !== 'undefined'; });
    test('win-external', function() { return typeof window.external !== 'undefined'; });

    // Check for undocumented constructors
    test('win-WebKitMediaKeys', function() { return typeof window.WebKitMediaKeys !== 'undefined'; });
    test('win-MSMediaKeys', function() { return typeof window.MSMediaKeys !== 'undefined'; });
    test('win-MediaKeys', function() { return typeof window.MediaKeys !== 'undefined'; });
  } catch(e) {
    syncB('WIN-SCAN-ERR');
  }

  // ================================================================
  // 3. SharedArrayBuffer ALTERNATIVES
  // Atomics=YES but SharedArrayBuffer=NO is very unusual
  // ================================================================
  syncB('SAB-ALT-START');

  // Check if SAB exists under webkit prefix
  test('sab-webkit', function() { return typeof window.webkitSharedArrayBuffer !== 'undefined'; });

  // Check ArrayBuffer.prototype for sharing/transfer methods
  test('ab-transfer', function() { return typeof ArrayBuffer.prototype.transfer === 'function'; });
  test('ab-transferToFixed', function() { return typeof ArrayBuffer.prototype.transferToFixedLength === 'function'; });
  test('ab-resize', function() { return typeof ArrayBuffer.prototype.resize === 'function'; });
  test('ab-resizable', function() { var ab = new ArrayBuffer(8, {maxByteLength: 16}); return ab.resizable; });
  test('ab-detached', function() { var ab = new ArrayBuffer(8); return typeof ab.detached !== 'undefined'; });
  test('ab-maxByteLen', function() { var ab = new ArrayBuffer(8, {maxByteLength: 16}); return ab.maxByteLength; });

  // Check if Atomics methods work on regular typed arrays
  test('atomics-regular-ab', function() {
    var ab = new ArrayBuffer(4);
    var view = new Int32Array(ab);
    view[0] = 42;
    var old = Atomics.compareExchange(view, 0, 42, 99);
    return 'old=' + old + ',new=' + view[0];
  });

  // Check if Worker postMessage with transfer actually shares
  test('atomics-wait', function() { return typeof Atomics.wait === 'function'; });
  test('atomics-notify', function() { return typeof Atomics.notify === 'function'; });
  test('atomics-waitAsync', function() { return typeof Atomics.waitAsync === 'function'; });

  // Check if crossOriginIsolated (needed for SAB in browsers)
  test('crossOriginIsolated', function() { return window.crossOriginIsolated; });

  // Try constructing SAB-like from ArrayBuffer
  test('ab-slice-share', function() {
    var ab = new ArrayBuffer(16);
    var v1 = new Int32Array(ab);
    v1[0] = 123;
    var v2 = new Int32Array(ab);
    return v2[0] === 123; // true = same backing store (expected)
  });

  // ================================================================
  // 4. WebGL / GPU ALTERNATIVES
  // ================================================================
  syncB('GPU-ALT-START');
  var c = document.createElement('canvas');
  c.width = 1; c.height = 1;

  test('ctx-webgl', function() { return !!c.getContext('webgl'); });
  test('ctx-webgl2', function() { return !!c.getContext('webgl2'); });
  test('ctx-experimental-webgl', function() { return !!c.getContext('experimental-webgl'); });
  test('ctx-webkit-3d', function() { return !!c.getContext('webkit-3d'); });
  test('ctx-moz-webgl', function() { return !!c.getContext('moz-webgl'); });
  test('ctx-webgpu', function() { return !!c.getContext('webgpu'); });
  test('ctx-bitmaprenderer', function() { return !!c.getContext('bitmaprenderer'); });

  // WebGPU
  test('gpu-navigator', function() { return typeof navigator.gpu !== 'undefined'; });
  test('gpu-GPUDevice', function() { return typeof GPUDevice !== 'undefined'; });

  // Canvas methods
  test('canvas-transferCtrl', function() { return typeof c.transferControlToOffscreen === 'function'; });
  test('canvas-captureStream', function() { return typeof c.captureStream === 'function'; });
  test('canvas-mozCaptureStream', function() { return typeof c.mozCaptureStream === 'function'; });

  // HTMLCanvasElement prototype extras
  try {
    var canvasProto = Object.getOwnPropertyNames(HTMLCanvasElement.prototype);
    var nonStd = canvasProto.filter(function(p) {
      return ['getContext','toDataURL','toBlob','width','height','constructor'].indexOf(p) === -1;
    });
    if (nonStd.length > 0) {
      syncB('CANVAS-EXTRA-' + nonStd.join(',').substring(0, 60));
    } else {
      syncB('CANVAS-EXTRA-NONE');
    }
  } catch(e) {
    syncB('CANVAS-EXTRA-ERR');
  }

  // ================================================================
  // 5. WASM ALTERNATIVES
  // ================================================================
  syncB('WASM-ALT-START');
  test('wasm-WebAssembly', function() { return typeof WebAssembly !== 'undefined'; });
  test('wasm-webkitWasm', function() { return typeof window.webkitWebAssembly !== 'undefined'; });
  test('wasm-asmjs', function() {
    // Check if asm.js works (may be optimized even without full WASM)
    var fn = new Function('"use asm"; function f(x) { x = x|0; return (x + 1)|0; } return f;');
    var f = fn();
    return f(41) === 42;
  });

  // ================================================================
  // 6. IndexedDB ALTERNATIVES
  // ================================================================
  syncB('IDB-ALT-START');
  test('idb-webkit', function() { return typeof window.webkitIndexedDB !== 'undefined'; });
  test('idb-moz', function() { return typeof window.mozIndexedDB !== 'undefined'; });
  test('idb-ms', function() { return typeof window.msIndexedDB !== 'undefined'; });
  test('idb-openDatabase', function() { return typeof window.openDatabase === 'function'; }); // Web SQL
  test('idb-webSQL', function() {
    try {
      var db = openDatabase('test', '1.0', 'Test', 1024);
      return !!db;
    } catch(e) { return false; }
  });

  // ================================================================
  // 7. AUDIO ALTERNATIVES
  // ================================================================
  syncB('AUDIO-ALT-START');
  test('audio-AudioCtx', function() { return typeof AudioContext !== 'undefined'; });
  test('audio-wkAudioCtx', function() { return typeof webkitAudioContext !== 'undefined'; });
  test('audio-AudioEl', function() { return typeof HTMLAudioElement !== 'undefined'; });
  test('audio-AudioCtor', function() { return typeof Audio !== 'undefined'; });
  test('audio-new-Audio', function() {
    var a = new Audio();
    return typeof a.play === 'function';
  });
  test('audio-canPlayType', function() {
    var a = document.createElement('audio');
    return a.canPlayType('audio/mp4') || a.canPlayType('audio/mpeg') || 'none';
  });
  test('audio-mediaDevices', function() { return typeof navigator.mediaDevices !== 'undefined'; });
  test('audio-getUserMedia', function() { return typeof navigator.mediaDevices !== 'undefined' && typeof navigator.mediaDevices.getUserMedia === 'function'; });
  test('audio-wkGetUserMedia', function() { return typeof navigator.webkitGetUserMedia === 'function'; });

  // ================================================================
  // 8. GAMEPAD ALTERNATIVES
  // ================================================================
  syncB('GAMEPAD-ALT-START');
  test('gp-getGamepads', function() { return typeof navigator.getGamepads === 'function'; });
  test('gp-wkGetGamepads', function() { return typeof navigator.webkitGetGamepads === 'function'; });
  test('gp-GamepadEvent', function() { return typeof GamepadEvent !== 'undefined'; });
  test('gp-gamepadconnected', function() {
    // Check if gamepadconnected event type exists
    var evt = new Event('gamepadconnected');
    return evt.type === 'gamepadconnected';
  });
  test('gp-hid', function() { return typeof navigator.hid !== 'undefined'; });
  test('gp-serial', function() { return typeof navigator.serial !== 'undefined'; });
  test('gp-usb', function() { return typeof navigator.usb !== 'undefined'; });
  test('gp-bluetooth', function() { return typeof navigator.bluetooth !== 'undefined'; });
  test('gp-vibrate', function() { return typeof navigator.vibrate === 'function'; });

  // ================================================================
  // 9. CLIPBOARD ALTERNATIVES
  // ================================================================
  syncB('CLIP-ALT-START');
  test('clip-api', function() { return typeof navigator.clipboard !== 'undefined'; });
  test('clip-execCopy', function() { return document.queryCommandSupported('copy'); });
  test('clip-execPaste', function() { return document.queryCommandSupported('paste'); });
  test('clip-execCut', function() { return document.queryCommandSupported('cut'); });
  test('clip-queryEnabled', function() { return document.queryCommandEnabled('copy'); });

  // ================================================================
  // 10. MEDIA EXTENSIONS / DRM ALTERNATIVES
  // ================================================================
  syncB('MEDIA-ALT-START');
  test('media-WebKitMediaKeys', function() { return typeof WebKitMediaKeys !== 'undefined'; });
  test('media-MSMediaKeys', function() { return typeof MSMediaKeys !== 'undefined'; });
  test('media-MediaKeys', function() { return typeof MediaKeys !== 'undefined'; });
  test('media-MediaKeySession', function() { return typeof MediaKeySession !== 'undefined'; });
  test('media-HTMLMediaEl', function() { return typeof HTMLMediaElement !== 'undefined'; });
  test('media-HTMLVideoEl', function() { return typeof HTMLVideoElement !== 'undefined'; });
  test('media-video-canPlay', function() {
    var v = document.createElement('video');
    return v.canPlayType('video/mp4; codecs="avc1.42E01E"') || 'none';
  });
  test('media-video-wkKeys', function() {
    var v = document.createElement('video');
    return typeof v.webkitKeys !== 'undefined';
  });
  test('media-video-setMediaKeys', function() {
    var v = document.createElement('video');
    return typeof v.setMediaKeys === 'function';
  });
  test('media-video-wkSetMediaKeys', function() {
    var v = document.createElement('video');
    return typeof v.webkitSetMediaKeys === 'function';
  });
  test('media-video-msSetMediaKeys', function() {
    var v = document.createElement('video');
    return typeof v.msSetMediaKeys === 'function';
  });
  test('media-SourceBuffer', function() { return typeof SourceBuffer !== 'undefined'; });
  test('media-MediaSource-isType', function() {
    return MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
  });

  // ================================================================
  // 11. IMAGE FORMAT PROBING
  // ================================================================
  syncB('IMG-ALT-START');
  test('img-createImageBitmap', function() { return typeof createImageBitmap === 'function'; });
  test('img-ImageData', function() { return typeof ImageData !== 'undefined'; });

  // Check what image formats canvas can produce
  test('img-png', function() {
    var c2 = document.createElement('canvas'); c2.width=1; c2.height=1;
    return c2.toDataURL('image/png').indexOf('data:image/png') === 0;
  });
  test('img-jpeg', function() {
    var c2 = document.createElement('canvas'); c2.width=1; c2.height=1;
    return c2.toDataURL('image/jpeg').indexOf('data:image/jpeg') === 0;
  });
  test('img-bmp', function() {
    var c2 = document.createElement('canvas'); c2.width=1; c2.height=1;
    return c2.toDataURL('image/bmp').indexOf('data:image/bmp') === 0;
  });
  test('img-gif', function() {
    var c2 = document.createElement('canvas'); c2.width=1; c2.height=1;
    return c2.toDataURL('image/gif').indexOf('data:image/gif') === 0;
  });

  // ================================================================
  // 12. DOCUMENT / MISC APIS
  // ================================================================
  syncB('MISC-START');
  test('doc-designMode', function() { return typeof document.designMode !== 'undefined'; });
  test('doc-contentEditable', function() { return typeof document.body.contentEditable !== 'undefined'; });
  test('doc-execCommand', function() { return typeof document.execCommand === 'function'; });
  test('doc-queryCommand', function() { return typeof document.queryCommandSupported === 'function'; });
  test('win-requestIdleCallback', function() { return typeof requestIdleCallback === 'function'; });
  test('win-queueMicrotask', function() { return typeof queueMicrotask === 'function'; });
  test('win-reportError', function() { return typeof reportError === 'function'; });
  test('win-structuredClone', function() { return typeof structuredClone === 'function'; });
  test('win-CompressionStream', function() { return typeof CompressionStream !== 'undefined'; });
  test('win-DecompressionStream', function() { return typeof DecompressionStream !== 'undefined'; });
  test('win-TextEncoder', function() { return typeof TextEncoder !== 'undefined'; });
  test('win-TextDecoder', function() { return typeof TextDecoder !== 'undefined'; });
  test('win-TextEncoderStream', function() { return typeof TextEncoderStream !== 'undefined'; });

  // Check for reporting/telemetry APIs
  test('nav-sendBeacon', function() { return typeof navigator.sendBeacon === 'function'; });
  test('nav-connection', function() { return typeof navigator.connection !== 'undefined'; });
  test('nav-deviceMemory', function() { return navigator.deviceMemory; });
  test('nav-hardwareConcurrency', function() { return navigator.hardwareConcurrency; });
  test('nav-maxTouchPoints', function() { return navigator.maxTouchPoints; });
  test('nav-language', function() { return navigator.language; });
  test('nav-languages', function() { return (navigator.languages || []).join(','); });

  // ================================================================
  // 13. NOTIFICATION / PUSH ALTERNATIVES
  // ================================================================
  syncB('NOTIF-ALT-START');
  test('notif-Notification', function() { return typeof Notification !== 'undefined'; });
  test('notif-PushManager', function() { return typeof PushManager !== 'undefined'; });
  test('notif-wkNotif', function() { return typeof window.webkitNotifications !== 'undefined'; });

  // ================================================================
  // 14. STORAGE API DEEP CHECK
  // ================================================================
  syncB('STORE-START');
  test('store-caches', function() { return typeof caches !== 'undefined'; });
  test('store-StorageManager', function() { return typeof navigator.storage !== 'undefined'; });
  test('store-estimate', function() { return typeof navigator.storage !== 'undefined' && typeof navigator.storage.estimate === 'function'; });
  test('store-persist', function() { return typeof navigator.storage !== 'undefined' && typeof navigator.storage.persist === 'function'; });
  test('store-sessionStorage', function() { return typeof sessionStorage !== 'undefined'; });

  // ================================================================
  // 15. CSS / RENDERING EXTENSIONS
  // ================================================================
  syncB('CSS-EXT-START');
  test('css-Highlights', function() { return typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined'; });
  test('css-registerProp', function() { return typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function'; });
  test('css-paintWl', function() { return typeof CSS !== 'undefined' && typeof CSS.paintWorklet !== 'undefined'; });
  test('css-animWl', function() { return typeof CSS !== 'undefined' && typeof CSS.animationWorklet !== 'undefined'; });
  test('css-layoutWl', function() { return typeof CSS !== 'undefined' && typeof CSS.layoutWorklet !== 'undefined'; });
  test('css-escape', function() { return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'; });
  test('css-supports', function() { return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'; });

  // ================================================================
  // 16. SECURITY / PERMISSIONS
  // ================================================================
  syncB('SEC-START');
  test('sec-permissions', function() { return typeof navigator.permissions !== 'undefined'; });
  test('sec-credentials', function() { return typeof navigator.credentials !== 'undefined'; });
  test('sec-webauthn', function() { return typeof PublicKeyCredential !== 'undefined'; });

  syncB('COMPLETE');
})();
