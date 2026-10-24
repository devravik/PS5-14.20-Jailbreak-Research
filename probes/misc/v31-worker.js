/* v31-worker.js — worker via REAL same-origin URL (los blob nunca corrieron).
 * Si este archivo EJECUTA y beca: los workers existen → superficie de
 * threads/transferables/desync se abre. Testigo en el wire (GET + beacon). */
try {
  fetch("/beacon/V31-WK", {
    method: "POST", cache: "no-store", keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ r: "wk" + Date.now().toString(36).slice(-8),
      b: "REAL-URL-WORKER EJECUTA; idc=" + (typeof Worker) +
         "; sab=" + (typeof SharedArrayBuffer) +
         "; atomics=" + (typeof Atomics) })
  }).catch(function () {});
  /* autotest interno: transfer de un ArrayBuffer al padre (si el padre lo pide) */
  self.onmessage = function (e) {
    try {
      if (e.data === "xfer") {
        var ab = new ArrayBuffer(8);
        self.postMessage({ t: "xfer-ok", len: ab.byteLength }, [ab]);
      } else {
        self.postMessage({ t: "echo", got: String(e.data).slice(0, 30) });
      }
    } catch (er) {
      try { self.postMessage({ t: "err", m: String(er && er.message || er).slice(0, 60) }); } catch (e2) {}
    }
  };
} catch (ex) { /* silencio: el wire dirá */ }
