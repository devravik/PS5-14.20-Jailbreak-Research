# WK1400 Abstract C++ Failure Audit (PS5 14.20 context)

Date: 2026-10-19
Tree audited: `/home/violence/Work/WebKit-1400/WebKit-1400/WebKit-1400/Source/` (newer upstream WebKit snapshot)
Device reference tree: `/home/violence/Work/ps5-lan-research/14.20-bid/wk1200-source/WebKit-1200/Source/` (PS5 14.20 / WK1200, LLInt-only, per AGENTS.md)

Rules followed: every claim traces to a file+line opened this session (or is explicitly marked device-cross-check-pending). Speculative findings are separated from source-verified ones.

Classification key:
- [S] — source-verified: code shape exists in WK1400; exploitability reasoned, not proven
- [D] — diff-verified against the WK1200 on-device tree

---

## Findings

### F1 — JSFinalizationRegistry: dead-bucket drain invariant lives only in debug-only asserts [S] [D]

Files:
- WK1400 `Source/JavaScriptCore/runtime/JSFinalizationRegistry.cpp:100-244` (read in full)
- WK1200 device tree: same region read in full at lines 155-215 — identical text, including the "please report a bug" message string.

Code shape:

```cpp
// finalizeUnconditionally (runs during the GC flip, per its own comment at line 60)
//   * moves entries out of live containers into:
//       i)  m_noUnregistrationDead                        (lines 110-118, 135)
//       ii) m_deadRegistrations[key] buckets              (line 127)
//   * schedules DeferredWorkTimer work                    (lines 153-162)

void JSFinalizationRegistry::runFinalizationCleanup(JSGlobalObject* globalObject)   // line 165
{
    while (JSValue value = takeDeadHoldingsValue()) {
        MarkedArgumentBuffer args;
        args.append(value);
        call(globalObject, callback(), args, "This should not be visible: please report a bug to bugs.webkit.org"_s);
        RETURN_IF_EXCEPTION(scope, void());
    }
}

JSValue JSFinalizationRegistry::takeDeadHoldingsValue()     // line 178
{
    Locker locker { cellLock() };
    JSValue result;
    if (m_noUnregistrationDead.size())
        result = m_noUnregistrationDead.takeLast().get();   // POPS, not peeks
    else {
        auto iter = m_deadRegistrations.begin();
        if (iter == m_deadRegistrations.end())
            return JSValue();
        ASSERT(iter->value.size());                          // line 188: debug-only
        result = iter->value.takeLast().get();
        if (!iter->value.size())
            m_deadRegistrations.remove(iter);
    }
#if ASSERT_ENABLED                                           // lines 194-197: invariant ONLY in debug builds
    for (const auto& iter : m_deadRegistrations)
        RELEASE_ASSERT(iter.value.size());
#endif
    return result;
}
```

Abstract failure class: #1 (destructor/cleanup reentrancy) + #10 (weak pointer state machine) + #2.

What breaks the C++ assumptions:
1. The "a dead bucket is never empty" invariant that `takeLast()` relies on is enforced ONLY inside `#if ASSERT_ENABLED`. In a release/LLInt-only device build, `takeLast()` on a wrongly-empty Vector is an underflow. The release-build trust path for the drain state machine is nothing.
2. The drain loop runs JS (`call(...)`) per entry with NO outer lock and NO outer protection of the containers it mutates. A JS cleanup callback that calls `register()`/`unregister()` re-enters this state machine while the drain loop is mid-flight. `unregister()` (line 218-226) removes arbitrary bucket keys (same maps the drain uses).
3. The popped JSValue is anchored only by a stack-resident MarkedArgumentBuffer. Whether that buffer is protected against a GC triggered inside the callback depends on conservative stack scanning behavior in the WK1200 build. Needs a device check. Inline-heap note (per WG tree): the p147/p150 work already showed GC behavior on-device respects heap marks; if the arg buffer isn't swept before `call`, the holding object can die mid-callback.

JS PoC sketch:

```js
const fr = new FinalizationRegistry(function (holding) {
    // Re-enter the same state machine from inside the cleanup callback:
    for (let i = 0; i < 5000; i++) {
        let t = {}, h = {a:i};
        fr.register(t, h, new Object());   // adds to m_liveRegistrations mid-drain
        fr.unregister(t);                  // hits m_liveRegistrations/m_deadRegistrations remove
    }
    gc(); gc();                            // force a second finalization pass
});
for (let i = 0; i < 1000; i++)
    fr.register(new Object(), {i:1}, new Object());   // seed many same-key buckets
```

Device verification plan (WK1200):
1. Probe `p160b-fr-dual.js` (probe-only, no deploy-touching work needed): seed one registry with tokens, force collection, in-loop call `register/unregister` repeatedly while the callback fires, then read back behavior through holdings visibility.
2. Instrument: does a second `gc()` during callback reentry produce a second drain of the SAME bucket? If yes, the drain loop is off-spec and we look for a manifest bug (this signal alone is not corruption).
3. Beacon-based: report bucket counts (`deadCount()` is internal — use observable register/unregister return values instead).

Exploitability estimate: crash-only unless conservative arg buffer scanning is proven; the concrete device test is cheap. TIER-2.

---

### F2 — SSV deserializer: resizable-buffer DataView accepts attacker-supplied byteOffset with only a developer comment as insurance [S]

Files:
- WK1400 `Source/WebCore/bindings/js/SerializedScriptValue.cpp:3259-3355`
- WK1400 `Source/JavaScriptCore/runtime/DataView.cpp:51-63`
- WK1400 `Source/JavaScriptCore/runtime/ArrayBufferView.cpp:34-55`

Code:

```cpp
bool readArrayBufferViewImpl(VM& vm, JSValue& arrayBufferView)   // 3278
{
    LengthType byteOffset;
    if (!read(byteOffset)) return false;                         // 3284-3286: ATTACKER-CONTROLLED, in-band
    LengthType byteLength;
    if (!read(byteLength)) return false;                         // 3287-3289: may be autoLengthMarker
    ...
    if (byteLength != autoLengthMarker) {                        // 3306
        LengthType computedLength = byteLength / elementSize;    // 3307 (strconv only)
        if (computedLength * elementSize != byteLength) return false;
        length = computedLength;                                 // no byteOffset check at all here either
    } else {
        if (!arrayBuffer->isResizableOrGrowableShared())         // 3312
            return false;
    }
    ...                                                          // NO byteOffset-to-buffer check on either branch
    case DataViewTag:
        arrayBufferView = toJS(m_lexicalGlobalObject, m_globalObject,
                                DataView::wrappedAs(arrayBuffer.releaseNonNull(), byteOffset, length).get());
```

```cpp
// JSC runtime/DataView.cpp:51
RefPtr<DataView> DataView::wrappedAs(Ref<ArrayBuffer>&& buffer, size_t byteOffset, std::optional<size_t> byteLength)
{
    // We do not check verifySubRangeLength for resizable buffer case since this function is only called from already created JS DataViews.
    // It is possible that verifySubRangeLength fails when underlying ArrayBuffer is resized, but it is OK since it will be just recognized as OOB DataView.
    if (!buffer->isResizableOrGrowableShared()) {
        if (!ArrayBufferView::verifySubRangeLength(buffer.get(), byteOffset, byteLength.value_or(0), 1))
            return nullptr;
    }
    return adoptRef(*new DataView(WTFMove(buffer), byteOffset, byteLength));
}
```

The claim in that comment ("only called from already created JS DataViews") is FALSE at this call site: `DataView::wrappedAs` is reached directly from `readArrayBufferViewImpl` with `byteOffset` straight out of the serialized byte stream, not from already-created JS DataViews. For a RESIZABLE buffer the deserializer will construct an arbitrary-byteOffset DataView with NO range verification and NO crash-trap determination. The "OOB DataView" object factory is 100% attacker-byte-stream-driven. `ArrayBufferView::ArrayBufferView` (WK1400 `ArrayBufferView.cpp:34-55`) confirms the design at the JSC level: for resizable (non-shared) buffers it EXPLICITLY allows `byteOffset + byteLength > buffer->byteLength()`, with the inline comment at line 44: "this is fine since it just becomes OOB array". Exploitation hinges 100% on every downstream consumer re-running the `isOutOfBounds()`-style check (`JSArrayBufferViewInlines.h:132-139`) at access time. The SSV WRITE path guard is `obj->isOutOfBounds()` at `SerializedScriptValue.cpp:1376-1379`; the READ path has no equivalent gate.

Reachability gate (must be closed before this is a live bug): this deserializer needs RAW serialized bytes in the read path. `structuredClone(o)` never lets you choose the bytes. Real raw-SSV entry points to check on PS5 14.20:
- WebView UI-process <-> permission-dialog state objects (not JS-reachable)
- `MessageChannel`/`Worker` (postMessage SSV -> IPC paths are power-safe but not byte-controllable)
- Anything in the Shell UI reading persisted sessionStorage-style blobs

JS PoC (once a raw-byte injector exists):
- tainted byte stream: `resizable=true, byteLength=0x100, maxByteLength=0x200` inside an SSV blob; embed `DataViewTag` with `byteOffset = 0xFFFFFFFF00000000` and `byteLength = autoLengthMarker`; then hand the deserialized object a crafted stub — instrument what `d.byteLength` prints and whether `d.getInt8(0)` throws RangeError (it should) vs. reads OOB memory (bug).

Device probe shape: p160a-family (`SubtleCrypto/TextDecoder stale read` family was DEAD per prior testing); this variant differs (raw-byte trust) but shares the same reachability prerequisite. TIER-3.

---

### F3 — cheap, renderer-local RAB shrink OOB-view existence check [S]

Same code (WK1400 `ArrayBufferView.cpp:43-49`) allows views on resizable buffers whose `byteOffset + byteLength > buffer->byteLength()`. The JSC public path is supposed to surface that as "OOB view" via the isOutOfBounds gate in `JSArrayBufferViewInlines.h:130-139`. The exact same design question that F2 hinges on, testable WITHOUT any SSV path.

Device probe sketch (~15 lines):

```js
const rab = new ArrayBuffer(0x1000, { maxByteLength: 0x10000 });
const dv  = new DataView(rab, 0x800);                  // valid auto-length view
rab.resize(0x400);                                     // byteOffset now exceeds live length
post("RAB-SHRUNK-0");
post("byteLength=" + dv.byteLength);                   // must be 0 per spec
post("try=" + (function(){ try { return dv.getInt8(0); } catch (e) { return "THREW:" + e.name; } })());  // must throw RangeError
```

If either of the two "must be" conditions fails on device, we have a renderer-local OOB DataPerspective path with NO SSV dependency — priority jump to TIER-1. TIER-3 to start (cheap).

---

### F4 — ArrayBufferView::setDetachable pin/unpin state machine on resizable buffers [S] — parked

WK1400 `ArrayBufferView.cpp:93-107`:

```cpp
void ArrayBufferView::setDetachable(bool flag)
{
    if (flag == m_isDetachable) return;
    m_isDetachable = flag;
    if (!m_buffer) return;
    if (flag) m_buffer->unpin();
    else      m_buffer->pin();
}
```

Pin count lives on `m_buffer` (ArrayBuffer). `setDetachable(true)` unpins; buffer can then be DETACHED. `setDetachable(false)` re-pins. Question: does RESIZE (which is legal on resizable buffers) honor pin state, and does a pinned-then-unpinned cycle leave the buffer in a state where a DETACH can be initiated by a JS-visible action between a view's pin window? Not verified this session. TIER-4 (recorded to avoid re-hunt).

---

### F5 — NOT bugs (verified clean in full this session; listed so the next researcher skips them) [S]

- `MessagePort::entanglePorts` [WK1400 `MessagePort.cpp:361-376`]: returns `Vector<RefPtr<MessagePort>>` built via `WTF::map`; no raw pointer capture; every transferable is a owning `Ref` holder. Clean.
- SSV BigInt read path [WK1400 `SerializedScriptValue.cpp:4266-4306`]: `checkedProduct` guards the 64-bit-digit length; `setDigit(index*2, ...)` / `setDigit(index*2+1, ...)` bounded by that product. Clean. (WK1200 same-shape crossing not diffed this session — flagged, not exploited.)
- SSV `if (static_cast<uint32_t>(m_end - m_ptr) < dataLength)` [WK1400 `SerializedScriptValue.cpp:3410`]: pointer-diff truncated to uint32 — theoretical false-positive only if buffer is > 4GB. Unreachable from JS-driven byte stream sizes. Parked.
- `ProxyObject::getHandlerTrap` offsets cache [WK1400 `ProxyObject.cpp:107-131`]: guarded by dual structure-ID validity re-check; dictionary transitions invalidate via new structure IDs. Clean.
- `ArrayPrototype` fastJoin length pre-check [WK1400 `ArrayPrototype.cpp:761-784`]: verifies `length > unsigned-max` BEFORE the `static_cast<unsigned>(length)`. Clean.
- `MutationObserver::notifyMutationObservers` [WK1400 `MutationObserver.cpp:227-267`]: `notifyList = copyToVector(...)` snapshot before JS runs; every entry holds a `Ref`; `signalSlotList` swap-then-iterate. Clean. (`enqueueSlotChangeEvent` at line 157-166 has an ASSERT-only `notFound` check before append; a duplicate-entry path would only double-dispatch slotchange, not corrupt memory. Recorded.)
- `CSSFontFace::setStatus` sync recursion [WK1400 `CSSFontFace.cpp:571-628`]: setLoading->TimedOut->Failure synchronous recursion loop; every client callback site goes through `iterateClients` which snapshot-copies to `Vector<Ref<Client>>` (lines 55-59). No iterator invalidation; client lifetime protected by Ref extraction from the WeakHashSet. Clean.
- `FontFace::adopt` delete+add client cycle [WK1400 `FontFace.cpp:324-330`]: old backing's removeClient happens BEFORE m_backing swap; no dangling client extraction window visible. Clean.
- `KeyframeEffect` null-renderer guard [WK1400 `KeyframeEffect.cpp:1127, 1449-1462`]: `if (!keyframeStyle) { ASSERT_NOT_REACHED(); continue; }` and `if (!renderer() || !animation()) return;` — null-checked. Clean.
- `AnimationEffect::getTimings`/`getBasicTiming` m_animation raw-pointer use [WK1400 `AnimationEffect.cpp:46-124`]: all uses wrapped by `animation()` accessor or immediate-pointer-with-presence-check. Clean.
- `JSWeakObjectRef` weak version coherence [WK1400 `JSWeakObjectRef.cpp:1-64`]: read in full; `m_lastAccessVersion` pattern is the standard weak-ref-coherence design; `finalizeUnconditionally` clears lazily. No bug found; data recorded for future work.
- `DeferredPromise` suspension requeue [WK1400 `JSDOMPromiseDeferred.cpp:55-120`, `.h:202-231`]: read in full. Deferred requeue path uses `Strong<Unknown, ShouldStrongDestructorGrabLock::Yes>` and captures `protectedThis`. No exploitable failure found in the paths read.

### F6 — streams C++ shell [S] — thin wrappers

Read in full: `ReadableStream.{h,cpp}`, `ReadableStreamSink.cpp`, `ReadableStreamSource.cpp`. All the pearls live in `ReadableStreamInternals.js` (not C++). One flagged item for a future pass: `ReadableStreamToSharedBufferSink::enqueue` (line 48-57) builds a `std::span` from `buffer->data()`/`byteLength()` and calls the (C++ out-arg) sink callback with it. If the sink consumers hold the span while JS re-enters, that's an exposed raw-view. No reentry path confirmed this session.

---

## Prioritization for PS5 device work

| # | Finding | Cheap first device test | Notes |
|---|---------|------------------------|-------|
| F1 | JSFinalizationRegistry finalize-drain trusts debug-only invariants + mid-drain JS reentrancy | ~40-line probe .js, probe-only (no deploy needed) | Code identical in WK1200 tree (read line-by-line) |
| F3 | RAB shrink OOB-view existence check | ~15-line probe | Renderer-local; no SSV dependency |
| F2 | SSV raw-byte view byteOffset unverified for resizable | None until raw-byte entry point confirmed | p160a-family; needs Shell/UI path research first |

## Source-reference table (files opened this session)

- WK1400 JSC/runtime/JSFinalizationRegistry.cpp — full read of lines 40-248.
- WK1200 (device) JSFinalizationRegistry.cpp — full read of lines 155-215; verbatim-identical in the F1 region.
- WK1400 WebCore/bindings/js/SerializedScriptValue.cpp — full read of 1330-1469 (dumpArrayBufferView writer), 3240-3359 (readArrayBuffer / readResizable / readArrayBufferViewImpl), 4240-4319 (BigInt read path).
- WK1400 JSC/runtime/ArrayBufferView.cpp — full read 1-109 (incl. the design-approved "OOB views allowed on resizable" at lines 43-49, comment at 44).
- WK1400 JSC/runtime/DataView.cpp — full read 1-73 (the false "only called from already created JS DataViews" comment at 55-56, shown FALSE by an actual SSV reader site).
- WK1400 JSC/runtime/JSDataView.cpp — grep + read: `create` path verifies (`verifySubRangeLength`, line 58); `wrappedAs` doesn't. The asymmetry is visible in-file.
- WK1400 JSC/runtime/JSArrayBufferViewInlines.h — grep read: isOutOfBounds-style access-time check present at lines 132-139.
- WK1400 JSC/runtime/CommonSlowPaths.cpp:1340 — grep hit only (`constructEmptyArray(static_cast<unsigned>(length))`); NOT verified in lines; same shape exists on WK1200.
- WK1400 JSC/runtime/ArrayPrototype.cpp — read 730-789 (fastJoin length check OK before cast).
- WK1400 JSC/runtime/StringPrototype.cpp:1433 — grep hit only; not verified in lines.
- WK1400 JSC/runtime/JSWeakObjectRef.cpp — full read 1-64. No bug; data recorded.
- WK1400 WebCore/animation/KeyframeEffect.cpp — full read 820-949, 1080-1170, 1440-1514.
- WK1400 WebCore/animation/AnimationEffect.cpp — full read 45-124.
- WK1400 WebCore/css/CSSFontFace.cpp — full read 1-802.
- WK1400 WebCore/css/FontFace.cpp — full read 180-386.
- WK1400 WebCore/dom/MutationObserver.cpp — full read 1-270.
- WK1400 WebCore/bindings/js/JSDOMPromiseDeferred.{h,cpp} — full read both.
- WK1400 WebCore/Modules/streams/ ReadableStream.{h,cpp}, ReadableStreamSink.cpp, ReadableStreamSource.cpp — full read; ReadableStreamInternals-level behavior is JS, not C++.
- WK1400 WebCore/llint/CommonSlowPaths* — grep'd only (NOT in the WK1200 on-device path — LLIntSlowPaths.cpp is the device-equivalent and I read only varargs-related areas of `WK1200/interpreter/Interpreter.cpp`).

## Session admit / not covered

- `CodeBlock.cpp`, `CanvasRenderingContext2DBase.cpp` meters: NOT opened line-by-line this session; scheduled as next-session targets. Any future pass over the task's list-of-10 angles should start there.
- The Interpreter.cpp varargs path (`WK1200`: `unsigned sizeOfVarargs(...)`/`sizeFrameForVarargs`/`loadVarargs`, lines 195-315) was READ IN FULL on-device; `loadVarargs` re-uses the already-subtracted `length` (no re-inflate after the subtract). The classical WebKit `sizeOfVarargs volatile TOCTOU` bug does NOT reproduce in this WK1200 snapshot. Closed.
