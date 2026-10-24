/* v32-worker.js — worker de la batería de transferables.
 * Recibe {k:"xfer",ab,v}: beca lo que RECIBIÓ y devuelve longitudes.
 * Recibe {k:"ping"} → {k:"pong"}. */
self.onmessage = function (e) {
  try {
    var d = e.data || {};
    if (d.k === "ping") { self.postMessage({ k: "pong" }); return; }
    if (d.k === "xfer") {
      var abLen = -1, vLen = -1, b0 = "";
      try { abLen = d.ab.byteLength; } catch (er) { abLen = "E:" + String(er && er.message || er).slice(0, 20); }
      try { vLen = d.v.length; } catch (er) { vLen = "E:"; }
      try { b0 = Array.from(new Uint8Array(d.ab, 0, Math.min(4, d.ab.byteLength || 0))).join(","); } catch (er) {}
      try {
        fetch("/beacon/V32-WKR", {
          method: "POST", cache: "no-store", keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ r: "wkr" + Date.now().toString(36).slice(-8),
            b: "worker-recibió: abLen=" + abLen + ";vLen=" + vLen + ";b0=" + b0 })
        }).catch(function () {});
      } catch (er) {}
      self.postMessage({ k: "got", abLen: abLen, vLen: vLen });
    }
  } catch (ex) {
    try { self.postMessage({ k: "err", m: String(ex && ex.message || ex).slice(0, 50) }); } catch (e2) {}
  }
};
