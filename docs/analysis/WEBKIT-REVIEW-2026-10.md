# WebKit 605.1.15 (Dec-2023 fork) — review of probes p111–p119 and next vectors

Target: AppleWebKit/605.1.15 on PS5 FW 14.20, LLInt-only, x86-64 (Zen 2),
16 KB pages, MXCSR DAZ+FTZ, FreeBSD r230171.
Scope: memory corruption reachable from web content. Logic bugs, infoleaks and
DoS are noted only where they are a stepping stone.

---

## 0. The two framing corrections

### 0.1 Your RAB/structuredClone TOCTOU does not exist

`p118-rab-uaf` concludes that `structuredClone` "snapshots RAB byteLength at
property-read time but copies data later". Your own beacons falsify this:

| test | getter position | clone len | clone contents | meaning |
|---|---|---|---|---|
| T1 | after `buf` (`zzz_`) | 4096 | all 0xDD past 64 | buffer serialized before getter |
| T2 | after `buf`, **detach** + 500×4 KB spray | 4096 | all 0xAA, `markerWords:0` | backing store not freed under the copy |
| T5 | before `buf` (`aaa_`) | 65536 | 0xFF×64 then zeros | buffer serialized after getter, at grown size |
| T7 | after `buf` (history) | 4096 | 0xEE past 64 | same as T1 |

T1 is not dispositive on its own: `rab.resize(64)` is an **in-place** length
change. WebKit keeps the base pointer and does not free or zero the tail, so
"old bytes still readable" proves nothing. T2 is the dispositive experiment,
because `structuredClone(ab,{transfer:[ab]})` really detaches and frees the
`ArrayBufferContents`—and the clone still contains the original bytes.

The correct model is per-property, fully materialised at the point the
serializer reaches the value:

```
for each own key k in [[OwnPropertyKeys]] order:
    v = Get(obj, k)                 <-- getters can run here
    serialize(v)                    <-- tag + length + memcpy, atomically w.r.t. JS
```

There is no call-out inside `CloneSerializer::write(ArrayBuffer&)`, so JS
cannot run between the length read and the `memcpy` **for that buffer**. The
"size mismatch" you observed is simply "clone taken at T, source mutated at
T+1"—not a snapshot/copy gap. T5 confirms the length is read at the buffer's
own serialization point, not at object-walk start.

Even if WebKit deferred the copy, a correct serializer must hold the
`ArrayBufferContents` (entrain it) for exactly this reason, and WebKit does
that for transferables. A detach cannot free memory the serializer still owns.

**Drop this lead.** It has consumed p118 and part of p85. What is left of the
"TOCTOU" idea is a different bug class, below.

### 0.2 You are testing 2022–2023 bugs against a Dec-2023 fork

Everything in your "patched/safe" list is a bug that was already fixed when
your build was cut: Relapse (2022), PSFree/CVE-2022-22620, CSSFontFace
(~13.40), CVE-2023-37450, JSScope variants. Re-confirming them is not
productive.

The build is from Dec 2023. Every WebKit-proper security fix **after** that
date is, by default, absent until you prove a backport. Sony does backport
selected in-the-wild bugs (your data shows Relapse patched by 14.00), but the
long tail of 2024–2026 fixes is almost certainly missing. Those fixes come
with public commit messages that describe the broken invariant. That is a far
better bug supply than re-deriving conformance gaps.

`tools/cve-commit-map.py` turns an advisory into fix commits (see §5).

---

## 1. ResizableArrayBuffer: where the TOCTOU actually lives

The pattern you were looking for requires a call-out **between** "observe the
buffer" and "use the buffer". `structuredClone` has none. These do:

### 1.1 Cross-task / cross-thread handoff

The C++ side receives a `BufferSource`, converts it, and the *work* happens
later on a queue or a worker thread. If any layer keeps `ArrayBuffer*` /
`ArrayBufferView*` instead of copying `Vector<uint8_t>`, a detach between
handoff and use is a UAF.

Candidates, in order of value:

1. **`crypto.subtle.*`** — `digest`, `encrypt`, `decrypt`, `sign`, `verify`,
   `deriveBits`, `importKey("raw")`, `wrapKey`. All run on WebKit's
   `CryptoQueue` thread. Also note the coercion order: the `algorithm`
   dictionary is converted before `data`, so an `iv`/`name` getter can detach
   `data` before `data` is converted.
2. **`FontFace(family, bufferSource)`** — font parsing is asynchronous and a
   font binary is a much richer parser than a hash function. You already have
   a TTF/WOFF corpus (`f00.ttf`…`f99.ttf`, `evil-woff2-*`). The question is
   whether `FontFace` copies into a `SharedBuffer` or adopts the JS buffer.
3. **`CompressionStream`/`DecompressionStream` write queue** — a chunk can sit
   in the writable queue behind backpressure; the conversion to bytes happens
   at write time, not enqueue time.
4. **`Response`/`Request`/`Blob`** — these look like they copy at construction
   (p121 C1–C3 confirm on V8; verify on JSC).
5. **`WebSocket.send(view)`** — copies into a `Vector` before queueing in
   WebKit, but worth a check with a large view and an immediate detach.
6. **`ImageBitmap` transfer** — a resource, not a byte buffer. Transferring it
   and then drawing must throw `InvalidStateError`; if the image backing is
   freed while a `drawImage` is in flight, that is a UAF in the image decoder.

### 1.2 Duplicate transferables

Not in your report. This is the canonical double-free shape:

```js
structuredClone({ab}, {transfer: [ab, ab]})
structuredClone({ab}, {transfer: [ab, new Uint8Array(ab).buffer]})
port.postMessage({p: port2}, [port2, port2])
port.postMessage({a: ab, b: ab}, [ab])
// and the interesting one: transfer inside a getter, then transfer again
port.postMessage({get x(){ port.postMessage(null,[ab]); return 1; }, ab}, [ab])
```

Spec says `DataCloneError`. A missing dedupe is a double `ArrayBufferContents`
release or a double `MessagePort` entangle. Both are directly exploitable.
On V8 the first four throw and the getter variant is silently accepted —
compare on JSC.

### 1.3 Dictionary/sequence conversion order

WebIDL converts dictionary members in **lexicographic order**. So for
`RequestInit`: `body`, `duplex`, `headers`, `integrity`, `keepalive`,
`method`, `mode`, `priority`, `redirect`, `referrer`, … `signal`, `window`.
`body` is converted before `headers`/`signal`. If `FetchBody` retains the
`ArrayBufferView` rather than copying, then:

```js
let rab = new ArrayBuffer(1<<16);
let u8 = new Uint8Array(rab);
new Request("https://x.invalid/", {
  body: u8,
  get headers() { detach(rab); return {}; }   // runs AFTER body conversion
});
```

is a delayed-use bug. Same shape for `fetch(url, {...})`, `Element.animate`,
`new Worker(url, opts)`, `ReadableStream(source, strategy)`.

Validating `p121` C4 on V8 already shows the divergence: the body came back as
**0 bytes** rather than 65536 or a throw, i.e. the body was materialised *after*
the `headers` getter ran and after the buffer was detached. That is the benign
version (a detached view has `byteLength` 0). The dangerous version is a
consumer that caches the length before the getter and the data pointer after —
which is exactly what a JSC `FetchBody` holding an `ArrayBufferView` would do.
The probe distinguishes all three outcomes: 65536 = copied at entry, 0/throw =
re-converted late, crash = dangling pointer.

Probes: `probes/p121-rab-handoff.js`.

---

## 2. Streams: ranked state transitions

WebKit's streams are `RefCounted` C++ state machines wrapped by JS objects, and
the native-source paths (`FetchResponseSource`, `BlobStreamSource`,
`ZlibCompressionStream`, `ReadableStreamSource`) hold pointers across task
boundaries. Ranked by expected yield:

### 2.1 Reader GC'd with a pending read on a native source — highest confidence

[WebKit bug 303460](https://bugs.webkit.org/show_bug.cgi?id=303460),
"ReadableStream readers should not be GCed if having pending read requests for
native sources", fixed 2025-12 (commit `303833@main`). The test that motivated
it is `streams/blob-and-tee.html`. This is exactly your class: the reader
wrapper is collected while C++ still holds a pointer to it; the native source
completes and calls back into freed memory. It post-dates your build.

Deterministic trigger (no luck required):

```js
const cs = new CompressionStream("deflate");
const w  = cs.writable.getWriter();      // keep the writable side
let r    = cs.readable.getReader();
const p  = r.read();                     // pending, no data yet
r = null;                                // drop the reader wrapper
await forceGC();                         // collect BEFORE data exists
w.write(new Uint8Array(4096));           // now the source produces
await p;                                 // completion -> callback into reader
```

Same with `Blob.stream()` (the original repro), `Response.body`,
`TransformStream.readable`, `TextDecoderStream.readable`.

### 2.2 Re-entrancy while the controller is mid-mutation

The `size`/`pull`/`transform`/`write` callbacks are user JS invoked from inside
a controller algorithm. Nested controller calls mutate the same queue/deque
that the outer call is operating on.

- `size()` calls `controller.enqueue()` → nested push, then outer push.
- `size()` calls `controller.error()`/`close()` → outer enqueue writes into an
  errored controller.
- `pull()` calls `controller.close()` then `controller.enqueue()`.
- `transform()` calls `controller.terminate()`/`error()` then `enqueue()`.
- `transform()` calls `writer.abort()` on its **own** writable side, i.e.
  re-entrant shutdown while the transform algorithm is on the stack.
- `flush()` calls `controller.error()`.

`p122` R1–R4, T1, T3, T4. Note that on V8, `terminate()`-then-`write()` and
`error()`-in-`flush` leave the write promise pending forever; the corresponding
JSC behaviour is worth measuring because WebKit's `TransformStream` backpressure
promise is resolved from `transformStreamDefaultSourcePullAlgorithm`, which
`terminate()` may never reach.

### 2.3 Abort vs. in-flight write on a native sink

`WritableStreamAbort` sets the stream to *erroring* and calls `sink.abort()`.
For `CompressionStream` the sink is `ZlibCompressionStream`; `abort()` tears
down the zlib stream while a write's completion handler is still queued. If
the completion later calls `write()` on the torn-down sink, that is a UAF of
the zlib state, not of a JS object.

```js
const w = new CompressionStream("deflate").writable.getWriter();
const pw = w.write(bigChunk);   // in flight
const pa = w.abort("x");        // frees zlib state
// then let pw settle
```

`p122` W1, `p123` F1/F2.

### 2.4 Lock/queue edge cases (lower yield, cheap to run)

- `releaseLock()` with a pending read (must reject the read, not drop it).
- `cancel()` during a pending read (must resolve `{done:true}`).
- `tee()`: cancel both branches while `pull` is on the stack; the shared
  `TeeState` is refcounted by both controllers.
- `pipeTo` where the destination `write` returns a thenable that errors the
  source; shutdown ordering (`shutdown with an action`).
- `highWaterMark: NaN/±Infinity/1e308`, `size` returning `-Infinity` — DoS
  only, but `-Infinity` makes `desiredSize` unbounded and the queue grows
  without limit; useful as a heap-shaping tool.

Probes: `probes/p122-streams-state.js`.

---

## 3. CompressionStream / DecompressionStream

zlib's `inflate` is one of the most fuzzed pieces of C on earth. The wrapper is
the soft target. Public WebKit fixes in this file:

- [`ZStream::~ZStream()` should call `inflateEnd()` for decompression mode](https://github.com/WebKit/WebKit/pull/60621)
- [bug 307952 — `DecompressionStream` should output valid data before throwing for extra trailing bytes](https://bugs.webkit.org/show_bug.cgi?id=307952)

Both are recent enough to be absent. Concrete inputs worth feeding, in one
byte at a time and in one chunk:

| input | why |
|---|---|
| `78 20 00 00 00 00` | zlib header with FDICT=1 → `Z_NEED_DICT`. Does the wrapper loop, error, or call `inflate` again on a stream it already ended? |
| `78 9c 07` | BFINAL=1, BTYPE=3 (reserved). Plain `Z_DATA_ERROR`. |
| `78 9c 01 05 00 00 00` | stored block with LEN=5, NLEN=0. |
| `78 9c 05 fe ff ff 0f 00…` | dynamic Huffman with an incomplete tree. |
| gzip `1f 8b 08 04 … 01 00` | FEXTRA with XLEN=1 and no payload. |
| gzip `1f 8b 08 08 …` + `ABC` | FNAME with no NUL. |
| gzip `1f 8b 08 02 …` | FHCRC with no header CRC. |
| valid gzip ++ garbage | trailing-bytes path from bug 307952. |
| 16 MB of zeros compressed | output-growth / queue-pressure path. |

Also: `write()` after the stream has errored, `close()` then `write()`,
`abort()` mid-stream, and `write()` with a chunk that decompresses to more than
the readable high-water mark.

One more surface you may not have considered: **`Content-Encoding` handling in
the network stack** is a separate decompressor from the Streams API. Your
`host.py` can serve `Content-Encoding: gzip` with truncated/corrupt bodies;
that path is reachable without any JS API.

Probes: `probes/p123-deflate-malformed.js`.

---

## 4. What `jsDynamicCast` does not protect

`jsDynamicCast` validates **argument type identity at the binding boundary,
once, at entry**. It cannot protect invariants that JS invalidates during the
call. The unprotected classes:

### (a) Re-entrancy — C++ caches, then calls JS, then uses the cache

Every callback is a chance to invalidate a pointer, length, index or iterator:

| sink | invariant that can break |
|---|---|
| `TypedArray.prototype.sort(cmp)` | C++ sorts in place over the backing store and calls `cmp` in a loop. `cmp` detaches/resizes the buffer → writes through a dangling pointer. **No JIT needed.** |
| `Array.prototype.sort(cmp)` | `cmp` sets `length`, pushes, or proxies writes back |
| `Array.prototype.concat` | `Symbol.isConcatSpreadable` getter changes `length` mid-copy |
| `Array.prototype.join` | element `toString` mutates the array |
| `JSON.stringify` | `toJSON` mutates the object being walked |
| `RegExp.prototype[Symbol.replace/split/matchAll]` | overridden `exec` mutates `lastIndex`/`source` |
| `Node.innerHTML` / parser | `connectedCallback` removes nodes, re-parents, or `document.write`s while the tree builder's stack is live |
| `setAttribute` | `attributeChangedCallback` re-enters `setAttribute` |
| `Element.animate` | keyframe/dictionary getters remove the element mid-conversion |
| `Range.surroundContents` | custom-element reactions move the boundary nodes |
| `adoptNode` | `adoptedCallback` mutates the tree |
| `DOMTokenList.add` | `toString` on the token mutates `class` |
| `Element.attachShadow` / slot assignment | `slotchange` reassigns slots |

`p124` A1–A5 is the one I would run first: `ta.sort()` with a comparator that
calls `ab.transfer()`. On V8 the spec-mandated copy makes it safe (53 248
comparator calls after detach, no corruption); WebKit's `typedArraySort` has
historically operated on the raw `m_vector`, so a JSC-specific crash here is
plausible.

### (b) GC liveness — C++ holds a raw pointer to something JS can drop

The binding layer has no opinion about lifetime. Any `RefCounted` native object
reachable only from C++ (a reader, a source, a sink, a pending promise's
reaction) can be collected if the last JS wrapper dies. Bug 303460 is the
streams instance; the same shape exists for `MessagePort` entanglements,
`FontFace` loads, `WebSocket` sends and pending `ResizeObserver` callbacks.

This is why `WeakRef`/`FinalizationRegistry` availability matters: they turn
"maybe GC happened" into a deterministic trigger (see §6).

### (c) Internal builtins that use public, patchable prototypes

This one is visible in your own data. `p120` replaced
`Array.prototype[Symbol.iterator]` and `TransformStream` construction changed
behaviour, returning:

```
TypeError: Internal TransformStream creation returned an unexpected number of values
TypeError: Internal TransformStream creation returned values of unexpected types
```

That message proves WebKit's internal "create transform stream" algorithm
builds a plain `Array`, iterates it through **`%Array.prototype%[Symbol.iterator]`**
(user-patchable), and validates the count and types afterwards. The validation
is the fix for CVE-2026-43705. The *pattern* — spec-internal operation leaking
onto a user-replaceable prototype — is a general bug class, and a validation
added after the fact is often incomplete (count checked, type not; type
checked, order not).

You can map this systematically. Install counting wrappers on the prototypes
that internal algorithms are most likely to touch, run a corpus, and log which
internal operations observed the patched function:

```js
const taps = new Map();
let armed = false;
function tap(proto, key, label) {
  const orig = proto[key];
  proto[key] = function () {
    if (armed) taps.set(label, (taps.get(label) || 0) + 1);
    return orig.apply(this, arguments);
  };
}
tap(Array.prototype, Symbol.iterator, "Array@@iterator");
tap(Array.prototype, "push", "Array.push");
tap(Array.prototype, "slice", "Array.slice");
tap(Object.prototype, "toString", "Object.toString");
tap(Function.prototype, "apply", "Function.apply");
tap(String.prototype, "slice", "String.slice");
tap(RegExp.prototype, "exec", "RegExp.exec");
// ...then:
armed = true;
for (const op of corpus) { try { op(); } catch (e) {} }
armed = false;
```

Anything that shows up is an internal algorithm calling user code — i.e. a
potential re-entrancy point that `jsDynamicCast` never sees. `TransformStream`
already scores; the interesting question is what else does.

### (d) Deserialisation

The `SerializedScriptValue` reader trusts its tag stream. Same-origin JS cannot
forge tags, so this is only reachable if a producer can be made inconsistent
(`history.state` across navigations, a `postMessage` from a compromised
sibling frame). Low priority unless you already have a sibling-frame primitive.

### (e) Cross-thread objects

WebCrypto, workers, network decompression. Covered in §1.1 and §3.

### (f) Dictionary/sequence conversion order

Covered in §1.3. The general rule: any IDL argument list or dictionary is a
sequence of getters separated by C++ state, and the C++ state is not
re-validated between them.

---

## 5. The 2024–2026 fix stream, and what to port

Your build predates all of these. Filter: no JIT, no WebGL/ANGLE, no Web Audio,
no WASM.

### 5.1 Shortlist (WebKit-proper, memory-safety)

From [WSA-2024-0008](https://www.webkitgtk.org/security/WSA-2024-0008.html),
[WSA-2025-0003](https://webkitgtk.org/security/WSA-2025-0003.html),
[WSA-2026-0005](https://webkitgtk.org/security/WSA-2026-0005.html),
[WSA-2026-0006](https://webkitgtk.org/security/WSA-2026-0006.html):

| Bugzilla | CVE | Class |
|---|---|---|
| 282661 | CVE-2024-54505 | type confusion → memory corruption |
| 277967 | CVE-2024-54534 | memory corruption |
| 281912 | CVE-2024-54502 | crash, "improved checks" (Project Zero) |
| 278497 | CVE-2024-54479 | crash, "improved checks" |
| 282180 | CVE-2024-54508 | crash, memory handling |
| 286462 | CVE-2025-24209 | **buffer overflow** |
| 285643 | CVE-2025-30427 | **use-after-free** |
| 284055 | CVE-2025-24216 | crash, memory handling |
| 285892 | CVE-2025-24264 | crash, memory handling |
| 311883 | CVE-2026-28984 | crash, memory handling |
| 313521 | CVE-2026-64783 | **use-after-free** |
| 313703 | CVE-2026-64787 | **use-after-free** |
| 319404 | CVE-2026-64719 | **out-of-bounds access** |
| 316347 | CVE-2026-64715 | **use-after-free** |
| 321485 | CVE-2026-64779 | memory corruption, "improved locking" |
| 321480 | CVE-2026-64782 | memory corruption, "improved locking" |
| 317632 | CVE-2026-64784 | out-of-bounds access |
| 316791 | CVE-2026-65334 | memory corruption, state management |
| 318405 | CVE-2026-65341 | memory corruption |
| 315082 | CVE-2026-64757 | JSC `ScopedArgumentsTable` (see §5.2) |

"Improved locking" on 321480/321485 is worth noting: those are likely
thread-safety races, which in WebKit usually means media/GPU/network threads —
often not reachable from the JS API you have. Verify before investing.

### 5.2 `ScopedArgumentsTable` — the one that matches your build

[Commit `72272dcc4feb`](https://github.com/WebKit/WebKit/commit/72272dcc4feb84122a18d38b2ef1af99c0bf01d1)
(fixes 315082 / CVE-2026-64757) says, in the author's own words:

> `ScopedArgumentsTable::m_arguments` is engine metadata, not user payload, but
> it was allocated from `Gigacage::Primitive` — making its `ScopeOffset`s
> reachable through any Primitive-cage write primitive and **usable as an
> unchecked index into `JSLexicalEnvironment::variables()`**.

> Also, drop a stale `m_watchpointSets.resize(newLength)` from the `m_locked`
> branch of `trySetLength`: it mutated the supposedly-locked instance.

Two things follow. First, this fix is *hardening* (move the buffer out of the
cage), not a standalone 0-day — it does not hand you a primitive. Second, and
more useful: it confirms that a `ScopeOffset` is an unchecked index into the
lexical environment. Anything that makes WebKit *compute* a bad `ScopeOffset`,
or that leaves a stale `m_length` next to a shorter buffer, is a type confusion
by construction. The reachable mutation is
`SymbolTable::trySetArgumentsLength()`, triggered by calling one function with
different argument counts. That is `probes/p125-scoped-arguments.js`:

```js
class D extends Base {
  make() { super.m(); aRef = arguments; return arguments.length; }
}
x.make.apply(x, bigArray);   // table length 40 000
x.make(1);                   // table shrinks to 1, old buffer freed
aRef[39999] = 0x41414141;     // stale length? OOB ScopeOffset?
```

This is LLInt-only, sits in the same `super` + scope machinery as Relapse, and
is the closest thing you have to a targeted lead rather than a fishing trip.

### 5.3 Hardware-specific angles

**16 KB pages.** JSC's `MarkedBlock`/`PageBlock`/`Gigacage` and
`OSAllocator::reserveUncommitted/commit` are written around `pageSize()`. If
any layer of this port still assumes 4 KB, guard pages are not where the code
thinks they are and `madvise(MADV_DONTNEED)` can decommit memory that is still
logically live. Probe at page boundaries: `ArrayBuffer` of 4096/8192/16384/
32768 bytes, `resize()` to and across a page boundary, detach, spray the same
size, then read. Your T8 used 16 KB but only checked clone contents, not
whether the freed page was returned to the OS.

**DAZ/FTZ.** Denormals become zero. This is not corruption by itself, but any
C++ path that computes an element count, stride or allocation size from a
`double` can turn "tiny positive" into 0 and then divide. Probe:

```js
const d = new Float64Array(1);
new DataView(d.buffer).setFloat64(0, Number.MIN_VALUE, true);  // denormal
// round-trip through Float32Array, Math.fround, arithmetic, then feed into:
new Uint8Array(n); new Array(n); "x".repeat(n);
ctx.createImageData(w, h); canvas.width = n; el.style.width = n + "px";
```

**Canvas dimension arithmetic.** Related and historically productive:
`createImageData(w, h)` and `putImageData(img, dx, dy, dirtyX, dirtyY,
dirtyWidth, dirtyHeight)` with negative dirty origin and oversized dirty
rectangle. The dirty-rect clamp has been wrong more than once, and it is a
direct OOB read/write into the canvas backing store. Cheap to test:

```js
const c = document.createElement("canvas"); c.width = c.height = 64;
const ctx = c.getContext("2d");
const img = ctx.createImageData(64, 64);
ctx.putImageData(img, 0, 0, -1, -1, 1e9, 1e9);
ctx.putImageData(img, 0x7fffffff, 0x7fffffff, 0, 0, 1, 1);
```

---

## 6. How to tell "safe" from "silently corrupted"

A non-crashing UAF read is indistinguishable from a pass in your current
harness. Three cheap upgrades:

1. **Canaries.** Keep N `Uint32Array(2048)` filled with a known pattern and
   verify after every probe (`canaryOK()` in the supplied probes). A silent OOB
   write usually lands in one of them.
2. **Deterministic GC.** `WeakRef` cannot be cleared in the job that created
   it, so a synchronous churn loop does nothing. `forceGC()` in `p122` awaits a
   macrotask between rounds and verifies collection via `WeakRef.deref()`. If
   `WeakRef` is absent on this build, fall back to `FinalizationRegistry`, and
   if that is absent too, treat GC-dependent probes as inconclusive.
3. **Crash attribution.** Beacon a `mark(name)` *before* each test. You already
   do this ("HB-marker: pre-crash"); keep it, and run each batch in a fresh
   page so one crash does not poison the next probe's heap.

Run every memory probe at least 8 times with different heap layouts (spray
before vs. after, with and without GC). A UAF that needs the freed slot to be
reused will not reproduce deterministically.

---

## 7. What I would stop doing

- Re-testing Relapse / PSFree / CSSFontFace / CVE-2023-37450 variants.
- `structuredClone` + RAB size-mismatch permutations.
- JIT-detection probes (`p99`, `p104`, `p105`, `p109`): the engine is LLInt by
  configuration; the probes cannot change that, and they consume time.
- Generic parser nesting-limit fuzzing (CSS calc, JS parens, SVG groups): you
  already established the limits and the guards work.
- Cross-prototype `jsDynamicCast` fuzzing: 40/40 TypeError is a conclusive
  result for that specific boundary.

## 8. Priority order

1. `p125` — ScopedArgumentsTable (targeted, LLInt-only, real 2026 fix).
2. `p122` G1–G4 — reader/writer GC liveness (real 2025 fix, native sources).
3. `p124` A1–A5 — typed-array sort with detaching comparator.
4. `p121` — async BufferSource handoff, `FontFace` in particular; duplicate
   transferables.
5. `p122` T1–T4 / `p123` F1–F4 — TransformStream and zlib wrapper
   abort/terminate/error races.
6. Canvas dirty-rect and 16 KB page-boundary probes (§5.3).
7. Port the rest of the §5.1 table with `cve-commit-map.py`.
