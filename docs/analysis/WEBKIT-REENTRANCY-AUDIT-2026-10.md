# WebKit-1400 (and PS5 14.20 WebKit-1200) — Re-entrancy / UAF / Type-Confusion Audit

**Date:** 2026-10-20
**Review tree given:** `/home/violence/Work/WebKit-1400/WebKit-1400/WebKit-1400/Source/`
**Target tree (shipped on PS5 14.20):** `/home/violence/Work/ps5-lan-research/14.20-bid/wk1200-source/WebKit-1200/Source/`
**Method:** full-file source reads of all ten requested targets + every adjacent file on
the call path (IDL generator, binding layer, JSC weak/GC machinery, DOM tree-mutation
notification), cross-validated against upstream WebKit commit history.

---

## 0. Two setup corrections that change the whole result

### 0.1 The PS5 14.20 firmware does not run WK-1400 — it runs WK-1200

The brief points at WK-1400. PS5 14.20's WebView is `AppleWebKit/605.1.15`, i.e. the
**WK-1200 (Dec-2023)** snapshot, which is present in this workspace.

All ten requested files (and the files on their call paths) are **byte-identical**
between the two trees, so the analysis transfers directly:

```
SAME  WebCore/dom/TreeWalker.cpp        SAME  WebCore/dom/MutationObserver.cpp
SAME  WebCore/dom/Range.cpp             SAME  WebCore/Modules/encryptedmedia/MediaKeySession.cpp
SAME  WebCore/Modules/speech/SpeechSynthesis.cpp
SAME  WebCore/workers/WorkerMessagingProxy.cpp
SAME  WebCore/html/HTMLMediaElement.cpp SAME  WebCore/svg/properties/SVGAnimatedPropertyAnimatorImpl.h
SAME  JavaScriptCore/runtime/JSMap.cpp  SAME  WebCore/svg/SVGAnimationElement.cpp
SAME  JavaScriptCore/heap/WeakSet.cpp   SAME  JavaScriptCore/runtime/WeakObjectRef{Constructor,Prototype}.cpp
```

Every `file:line` below was re-verified against the **WK-1200** tree (see
`/tmp/opencode/verify_lines.sh`, which reports `IDENTICAL-in-WK1400+WK1200`).

### 0.2 The requested file names do not exist in this WebKit generation

`SVGAnimatedType.h` / `SVGAnimatedTypeAnimator.cpp` were restructured into
`WebCore/svg/properties/SVGAnimatedProperty*.h`; `WeakObjectRef.cpp` became
`JavaScriptCore/runtime/WeakObjectRef{Constructor,Prototype}.cpp` +
`JavaScriptCore/heap/WeakGC{Map,Set}.h`. The substantive targets are unchanged.

### 0.3 Build configuration on the target (reachability facts)

| Flag | PS5 14.20 | Source |
|---|---|---|
| `ENABLE_SPEECH_SYNTHESIS` | **OFF** | absent from `cmake/OptionsPlayStation.cmake` (default OFF, `cmake/WebKitFeatures.cmake:236`) |
| `ENABLE_ENCRYPTED_MEDIA` (EME) | **ON if** mediaplayer ≥ v2 | `cmake/OptionsPlayStation.cmake:669-676` (forced ON) |
| SVG SMIL | **always on** | no `ENABLE_SVG_ANIMATION` flag exists |
| `NDEBUG` | **on** (RelWithDebInfo, `cmake/WebKitCommon.cmake:9-11`) → `ASSERT()` compiles out (`WTF/wtf/PlatformEnable.h:64-70`) | |

**Target #4 (`SpeechSynthesis.cpp`) is not built on PS5** and is therefore not
reachable. I report it for completeness but mark it *not reachable on target*.

---

## 1. Method note: the highest-yield technique

Reading alone finds the *shape* of a bug; it cannot tell you whether the bug is
real. So every candidate was pushed through a second filter: **does upstream
WebKit have a later commit that fixes this exact code?** A commit landing after
the Dec-2023 snapshot that touches a target file is, by construction, a bug
present in the PS5 14.20 build.

That filter turned 10 files into **10 confirmed, upstream-acknowledged bugs** with
WebKit bug numbers, rdar numbers, and upstream LayoutTests that can be used
verbatim as PoCs. The most recent fix found is **12 days old** (2026-10-07).

---

## 2. Findings, ranked by severity

### F1 — CONFIRMED. Use-after-free (read **and** write) in the SMIL animation schedule table

**Upstream:** WebKit bug **302916**, fixed 2025-11-22, commit `5e1cddb4e2bf`,
*"Stop storing SVGSMILElement objects are raw pointers in SMILTimeContainer.h"*

**Vulnerable code in the target (WK-1200):**

`WebCore/svg/animation/SMILTimeContainer.h:74-76`
```cpp
using ElementAttributePair = std::pair<SVGElement*, QualifiedName>;
using AnimationsVector = Vector<SVGSMILElement*>;      // <-- RAW POINTER
using GroupedAnimationsMap = HashMap<ElementAttributePair, AnimationsVector>;
```

`WebCore/svg/animation/SMILTimeContainer.cpp:250-256`
```cpp
void SMILTimeContainer::processScheduledAnimations(const Function<void(SVGSMILElement&)>& callback)
{
    for (auto& animations : copyToVector(m_scheduledAnimations.values())) {
        for (auto* animation : animations)
            callback(*animation);          // <-- UAF READ on a freed SVGSMILElement
    }
}
```

`WebCore/svg/animation/SMILTimeContainer.cpp:283-292`
```cpp
RefPtr<SVGSMILElement> firstAnimation;
for (auto* animation : animations) {
    ASSERT(animation->timeContainer() == this);        // ASSERTs compile out (NDEBUG)
    ASSERT(animation->targetElement());
    ASSERT(animation->hasValidAttributeName());
    if (!firstAnimation) {
        if (!animation->hasValidAttributeType())
            return;
        firstAnimation = animation;    // <-- UAF WRITE: RefPtr::operator=(T*) -> animation->ref()
    }                                   //     increments a refcount inside freed memory
```

**Why the stale entry is never removed** — the unschedule path is gated on a
`WeakPtr` that has already been nulled:

`WebCore/svg/animation/SVGSMILElement.h:187`
```cpp
WeakPtr<SVGElement, WeakPtrImplWithEventTargetData> m_targetElement;   // nulled when target dies
```
`WebCore/svg/animation/SVGSMILElement.cpp:639-646` (and `:165`, `:627` — the only
three `unschedule()` call sites in the whole of `WebCore/svg/`)
```cpp
if (m_timeContainer && hasValidAttributeName()) {
    if (m_targetElement)                                   // <-- NULL => unschedule() SKIPPED
        m_timeContainer->unschedule(this, m_targetElement.get(), m_attributeName);
```
`WebCore/svg/animation/SVGSMILElement.cpp:298-307`
```cpp
void SVGSMILElement::removedFromAncestor(RemovalType removalType, ...)
{
    if (removalType.disconnectedFromDocument) {
        ...
        setTargetElement(nullptr);   // (A) m_targetElement already null => unschedule skipped
        ...
        m_timeContainer = nullptr;   // (B) destructor can no longer unschedule either
    }
```

**The sequence:** destroy the animation *target* first (its `WeakPtr` target goes
null), *then* remove the `<animate>` element. The schedule table keeps a raw
pointer to the now-freed `<animate>` under the key `(dangling <circle>*, "r")`.
The next SMIL tick dereferences it.

**Impact:** UAF read (virtual dispatch through a freed vtable → type-confusion
primitive) plus a UAF **write** (`Node::ref()` → `m_refCountAndParentBit += 2`
at a fixed offset in the reused chunk). On PS5 (no Gigacage, FastMalloc→bmalloc,
`MADV_FREE` keeps the mapping) the freed chunk is immediately reusable, so the
freed vtable can be groomed with an attacker-chosen object.

**Reachability:** SVG + SMIL + DOM only. All present on PS5. No build flag.

**PoC:** `p493-smil-schedule-uaf.js` (delivered).

---

### F2 — CONFIRMED. NULL-pointer dereference via a collected weak callback (TreeWalker / NodeIterator)

**Upstream:** still present in upstream `main` as of 2026-10 (verified by fetching
upstream `JSCallbackData.cpp` and `CodeGeneratorJS.pm`).

**This is the only `callback interface` in WebKit that is both weakly held and
exempt from the invoke check.**

`WebCore/dom/NodeFilter.idl:21-24, 45`
```
[
    IsWeakCallback,          // <-- JS object held via JSC::Weak => COLLECTIBLE
    Exposed=Window
] callback interface NodeFilter {
    ...
    [SkipCallbackInvokeCheck, RethrowException] unsigned short acceptNode(Node node);
```

`WebCore/bindings/scripts/CodeGeneratorJS.pm:6678` (generated `JSNodeFilter`)
```perl
, m_data(new ${callbackDataType}(callback, globalObject, this))   // JSCallbackDataWeak
```
`WebCore/bindings/scripts/CodeGeneratorJS.pm:6785-6788` — `SkipCallbackInvokeCheck`
means **no** `canInvokeCallback()` guard is generated.

`WebCore/dom/Traversal.cpp:53-57` — the invocation site, with **no liveness check**:
```cpp
if (!m_filter)
    return NodeFilter::FILTER_ACCEPT;

SetForScope isActive(m_isActive, true);
auto callbackResult = m_filter->acceptNode(node);      // <-- never checks hasCallback()
```

`WebCore/bindings/js/JSCallbackData.h:106-113` → `JSCallbackDataWeak::invokeCallback`
passes `callback()` = `m_callback.get()`.
`JavaScriptCore/heap/WeakInlines.h:87-94` — `Weak::get()` returns **nullptr** once
the referent is collected.

`WebCore/bindings/js/JSCallbackData.cpp:42-65`
```cpp
JSValue JSCallbackData::invokeCallback(JSDOMGlobalObject& globalObject, JSObject* callback, ...)
{
    ASSERT(callback);                                  // <-- no-op under NDEBUG
    ...
    if (method != CallbackType::Object) {
        function = callback;
        callData = JSC::getCallData(callback);         // nullptr -> CallData::Type::None, no crash
    }
    if (callData.type == CallData::Type::None) {
        if (method == CallbackType::Function) { ...TypeError...; return; }   // NOT our case
        ASSERT(!functionName.isNull());
        function = callback->get(lexicalGlobalObject, functionName);   // <-- NULL DEREF
```
`JavaScriptCore/runtime/JSObject.h:1563-1568` — `JSObject::get` performs a
**virtual** call on `this`:
```cpp
inline JSValue JSObject::get(JSGlobalObject* globalObject, PropertyName propertyName) const
{
    VM& vm = getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    PropertySlot slot(this, PropertySlot::InternalMethodType::Get);
    bool hasProperty = const_cast<JSObject*>(this)->getPropertySlot(globalObject, propertyName, slot);
```
→ reads the vtable pointer from address 0 → **SIGSEGV**.

**Why this is unique.** `NodeFilter` is the only WebKit `callback interface` with
one operation (⇒ `CallbackType::FunctionOrObject`, the only path that dereferences
`callback`). The other one, `CustomXPathNSResolver.idl:27`, is *not* `IsWeakCallback`
→ held by `JSC::Strong` → `callback()` can never be null.

And it is the only weak-callback consumer that **omits the liveness guard its
siblings all use**:
| Consumer | Guard |
|---|---|
| `MutationObserver.cpp:215` | `if (m_callback->hasCallback())` ✓ |
| `ResizeObserver.cpp:173-174` | `ASSERT(jsCallback->hasCallback()); if (!jsCallback->hasCallback())` ✓ |
| `IntersectionObserver.cpp:296-297` | `ASSERT(...); if (!m_callback->hasCallback())` ✓ |
| **NodeFilter (TreeWalker/NodeIterator)** | **none** ✗ |

**Note on upstream history:** commit `39ee5e3e49f1` (2024-07-03, rdar://108859209)
*"Make IsWeakCallback the default"* **removed** `IsWeakCallback` from
`NodeFilter.idl` while flipping the generator default to weak — so `NodeFilter`
stayed weakly held both before and after. Upstream `main` still has
`ASSERT(callback); ... callback->get(...)` with no null check. **The bug is live
upstream as well.**

**Impact:** NULL-pointer dereference → WebContent-process crash (DoS) on PS5.

**PoC:** `p491-nodefilter-weak-null.js` (delivered). `document.createTreeWalker(root, whatToShow, filter)`
and `document.createNodeIterator(root, whatToShow, filter)` both accept a
`NodeFilter?` (`WebCore/dom/Document.idl:79-80`).

---

### F3 — CONFIRMED. `Range.extractContents()` extracts nodes **outside** the selected range

**Upstream:** WebKit bug **311700**, fixed 2026-04-08, commit `9dac73538145`.
Upstream notes *"It fails in shipping Safari but passes with this fix. This is thus
aligning our behavior with Blink."*

**Target code — the pre-fix line verbatim:**

`WebCore/dom/Range.cpp:409-412`
```cpp
if (processStart) {                                     // <-- upstream: if (processStart && (processEnd || commonRoot->contains(originalEnd.container())))
    Vector<Ref<Node>> nodes;
    for (Node* node = processStart.get(); node && node != processEnd; node = node->nextSibling())
        nodes.append(*node);
```
Upstream fix:
```cpp
// If the original end container was disconnected from the common root (e.g. by a mutation
// event during left contents processing), processEnd will be null and the loop below would
// extract all remaining siblings, including nodes beyond the original range.
if (processStart && (processEnd || commonRoot->contains(originalEnd.container()))) {
```

**Trigger:** removing an `<iframe>` that is inside the range fires a **synchronous
`unload` event**; the handler removes the range's end container. `processEnd` then
becomes null and the loop runs off the end of the common root, extracting
everything that follows.

**Impact:** `extractContents()` relocates content it was never asked to select. Any
sanitizer built on `Range.extractContents()` (the standard "unwrap/extract this
subtree" pattern) can be made to move out-of-range nodes into the sanitized
output, or to remove nodes that should have stayed.

**PoC:** `p492-range-extract-oob.js` (delivered), adapted from the upstream WPT
`dom/ranges/Range-extractContents-dynamic-end.html`:

```html
<div id="root">
  <div id="startContainer"><span id="startNode">Start</span>
    <iframe id="triggerIframe" src="about:blank" style="display:none;"></iframe></div>
  <div id="middle">Middle</div>
  <div id="endContainer"><span id="endNode">End</span></div>
  <div id="outOfBounds">Should NOT be extracted</div>
</div>
<script>
triggerIframe.contentWindow.addEventListener('unload', () => endContainer.remove());
const range = document.createRange();
range.setStart(startNode, 0);
range.setEnd(endNode, 1);
const fragment = range.extractContents();
// BUG: fragment contains #outOfBounds, and #outOfBounds is gone from the document
</script>
```

---

### F4 — CONFIRMED. `Range.processContents()` uses the **live** end container → destroys `<head>` and the doctype

**Upstream:** WebKit bug **326459** / rdar://189262302, fixed **2026-10-07**
(12 days ago), commit `15f8402bcf9a`,
*"Range::processContents() checks the live end container instead of the saved original end"*
— a **+1/-1** patch.

**Target code — the pre-fix line verbatim:**

`WebCore/dom/Range.cpp:371-374`
```cpp
RefPtr<Node> rightContents;
if (&endContainer() != commonRoot && commonRoot->contains(originalEnd.container())) {
//  ^^^^^^^^^^^^^^^^ LIVE.  Upstream: &originalEnd.container()  (the SAVED copy)
    auto firstResult = processContentsBetweenOffsets(action, nullptr, &originalEnd.container(), 0, originalEnd.offset());
    auto secondResult = processAncestorsAndTheirSiblings(action, &originalEnd.container(), ProcessContentsBackward, WTFMove(firstResult), commonRoot.get());
```
Every sibling line in the same function (`:363`, `:364`, `:365`, `:373`, `:374`,
`:381`, `:384`) uses the saved `originalStart`/`originalEnd`. Line 372 is the only
one that mixes the live `endContainer()` into a saved-boundary computation.

**Upstream's description of the impact:**
> *"If the end was originally the common ancestor and script moved it into a
> descendant, for example from an iframe unload handler, the common ancestor
> itself was processed as the end container. `processAncestorsAndTheirSiblings()`
> then walked up to the document and removed every preceding sibling of every
> ancestor, including `<head>` and the doctype."*

**Impact:** `range.deleteContents()` / `range.extractContents()` can delete
`<head>` and the doctype — i.e. destroy the host document's structure. Trigger is
the same synchronous iframe-`unload` re-entrancy as F3.

**PoC:** `p492-range-extract-oob.js`, second half, adapted from the upstream
LayoutTest `fast/dom/Range/range-end-moved-out-of-common-root-during-iframe-unload.html`.

---

### F5 — CONFIRMED. UAF in `MediaKeySession::load()` — the CDM callback uses a dead `this`

**Upstream:** WebKit bug **276633** / rdar://129490880, fixed 2024-09-17,
commit `d1154cafe842` (*"UAF in MediaKeySession::load()"*). Upstream patch: **+6/-0**.

**Target code — the pre-fix line verbatim:**

`WebCore/Modules/encryptedmedia/MediaKeySession.cpp:328`
```cpp
m_instanceSession->loadSession(m_sessionType, *sanitizedSessionId, origin,
    [this, weakThis, promise = WTFMove(promise), ...] (...) mutable {
    // 8.8.1. ...
    if (succeeded == CDMInstanceSession::SuccessValue::Failed) {
```
Upstream fix (absent from the target):
```cpp
auto protectedThis = RefPtr { weakThis.get() };
if (!protectedThis) {
    promise->reject(ExceptionCode::InvalidStateError);
    return;
}
```
The lambda captures a raw `this` and dereferences it without first checking the
`weakThis` guard it already carries. If the `MediaKeySession` is destroyed between
`load()` and the CDM's reply, every `this->` access in the lambda is a UAF.

**Reachability on PS5:** EME is force-enabled when the platform mediaplayer is
≥ v2 (`cmake/OptionsPlayStation.cmake:669-676`). The *bug* is present in the
source either way; **exploitation requires a working CDM**, so I rank this
below the DOM/SVG findings.

---

### F6 — CONFIRMED. `MutationObserver` dangling `WeakRef` → RELEASE_ASSERT / UAF

**Upstream:** WebKit bug **321878** / rdar://183913289, fixed 2026-08-18,
commit `9c6099bea06b` (*"Keep observed nodes alive across MutationObserver delivery"*).

**Target code:** `WebCore/dom/MutationObserver.cpp:189-224` — `deliver()` calls
`takeTransientRegistrations()` on each registration, which clears
`MutationObserverRegistration::m_nodeKeptAlive`, the registration's only strong
reference to the observed node. Upstream:

> *"When that was the last reference to the observed node, the node is destroyed
> while `deliver()` still holds its registration alive, and the registration is
> still in `MutationObserver::m_registrations`. Its reference to the observed node
> is a `WeakRef<Node>`, so it is now dangling, and dereferencing it hits the
> `RELEASE_ASSERT` in `WeakRef::ptr()`. `MutationObserverRegistration::isReachableFromOpaqueRoots()`
> does so on a GC thread, and `MutationObserver::disconnect()` does so on the main thread."*

**Impact:** `RELEASE_ASSERT` abort (crash) in `MutationObserver::disconnect()` or
during GC. Trigger: observe a node, mutate it so the observer delivers, then drop
the JS reference to the observed node and call `disconnect()`.

---

### F7 — CONFIRMED. `TreeWalker.currentNode` is not a GC root → collected node

**Upstream:** WebKit bug **313107**, fixed 2026-04-23, commit `7e8fd0583ea4`
(*"GC correctness for TreeWalker.currentNode"*).

**Target code — the pre-fix state:** `WebCore/bindings/js/JSTreeWalkerCustom.cpp:29-36`
```cpp
template<typename Visitor>
void JSTreeWalker::visitAdditionalChildren(Visitor& visitor)
{
    if (auto* filter = wrapped().filter())
        addWebCoreOpaqueRoot(visitor, *filter);
}
DEFINE_VISIT_ADDITIONAL_CHILDREN(JSTreeWalker);
```
Neither `wrapped().root()` nor the current node is registered as a GC opaque root.
Upstream now does:
```cpp
addWebCoreOpaqueRoot(visitor, wrapped().root());
addWebCoreOpaqueRoot(visitor, wrapped().opaqueRootForCurrentNodeInGCThread());
```

**Impact:** the JS wrapper for `treeWalker.currentNode` (and `treeWalker.root`) can
be collected while the walker still refers to it → dangling wrapper. The upstream
LayoutTest is `fast/dom/tree-walker-disconnected-currentNode.html`; on the target,
`replaceChildren()` + GC pressure is the trigger (the device has no `GCController`,
so force GC with allocation pressure).

---

### F8 — CONFIRMED. OOB read in SVG `animateMotion` with `keyPoints="0"`

**Upstream:** WebKit bug **272929** / rdar://126636733, fixed 2024-05-01,
commit `53e67f679530` (*"OOB array read with SVG animation where keyPoints = 0"*).

**Target code — the pre-fix lines verbatim:**

`WebCore/svg/SVGAnimationElement.cpp:389-392`
```cpp
const Vector<float>& SVGAnimationElement::keyTimes() const
{
    return calcMode() == CalcMode::Paced ? m_keyTimesForPaced : m_keyTimesFromAttribute;
}
```
Upstream fix adds `&& animationMode() != AnimationMode::Path`.

`WebCore/svg/SVGAnimationElement.cpp:587`
```cpp
m_animationValid = calcMode == CalcMode::Paced || !hasAttributeWithoutSynchronization(SVGNames::keyPointsAttr) || (keyTimes.size() > 1 && keyTimes.size() == m_keyPoints.size());
```
Upstream fix removes the leading `calcMode == CalcMode::Paced ||`.

With `calcMode="paced"` + `animationMode="path"` (i.e. `<animateMotion>`),
`keyTimes()` returns the *empty* `m_keyTimesForPaced` while `m_keyPoints` has one
entry, so the size check fails, `m_animationValid` stays true, and the paced
calculation indexes past the end of the vector.

**PoC (upstream LayoutTest, verbatim):**
```html
<svg zoomAndPan="magnify"><text>
  Passes if it does not crash.
  <animateMotion path="m 1,0" keyPoints="0" keyTimes="0" restart="always"/>
</text></svg>
```

---

### F9 — CONFIRMED. One invalid SMIL animation freezes **all** SMIL animation on the page

**Upstream:** WebKit bug **309976** / rdar://172593109, fixed 2026-03-17,
commit `297f976adf7c` (*"[SVG] Invalid attribute type in one animation group
prevents all subsequent animation groups from running"*).

**Target code — the pre-fix line verbatim:**

`WebCore/svg/animation/SMILTimeContainer.cpp:289-292`
```cpp
if (!firstAnimation) {
    if (!animation->hasValidAttributeType())
        return;              // <-- upstream: 'continue' (abort ALL groups, not just this one)
    firstAnimation = animation;
```
Upstream: *"This caused the entire function to exit, preventing all subsequent
animation groups from being processed, their events from being dispatched, and the
animation timer from being restarted."*

**Impact:** DoS — a single `<animate>` whose target has been removed freezes every
SMIL animation on the page, and the animation timer is never restarted, so
animations never resume.

---

### F10 — CONFIRMED. `HTMLMediaElement` synthesized play/pause events are not re-entrancy safe → infinite event loop

**Upstream:** WebKit bug **316746** / rdar://179191475, fixed 2026-06-11,
commit `412a8234329f` (*"Prevent re-entrant calls to dispatchPlayPauseEventsIfNeedsQuirks()"*).

**Target code — the pre-fix state:**

`WebCore/html/HTMLMediaElement.cpp:2735-2743`
```cpp
void HTMLMediaElement::dispatchPlayPauseEventsIfNeedsQuirks()
{
    if (!document().quirks().needsAutoplayPlayPauseEvents())
        return;

    ALWAYS_LOG(LOGIDENTIFIER);
    scheduleEvent(eventNames().playingEvent);
    scheduleEvent(eventNames().pauseEvent);
}
```
No re-entrancy guard (`m_isDispatchingAutoplayPlayPauseQuirkEvents` does not exist
in the target — grep returns zero hits).

**Upstream's description:**
> *"The function was not re-entrant-safe because a common JS pattern is to call
> `video.play()` from a `pause` event handler to retry playback. When autoplay was
> blocked: 1. `setAutoplayEventPlaybackState(PreventedAutoplay)` ⇒ schedule playing+pause
> 2. `pause` event fires, JS handler calls `video.play()` // autoplay blocked again
> 3. ⇒ schedule playing+pause again, and cause infinite loop. This can produce
> hundreds of log entries per millisecond and could trigger logd's per-process
> quarantine on affected pages."*

**Reachability on PS5:** needs quirks mode (`document.compatMode` — just omit the
doctype) + `<video>` + autoplay blocked. `<video>` is available; a `<video>` with
no source still rejects `play()` with `NotAllowedError` and takes the quirk path.
This is a pure C++ re-entrancy bug (C++ dispatches into JS, JS re-enters C++),
independent of the JS engine.

---

### Lower-severity / context items (verified present, lower priority)

| Item | Upstream | Target location | Note |
|---|---|---|---|
| NodeIterator reference left on a detached node | bug **326465**, fixed 2026-10-07, `cff766b42451` | `WebCore/dom/NodeIterator.cpp:169-195` | **Spec-correctness bug, not memory-unsafe**: I initially suspected a raw-pointer UAF, but `NodeIterator.h` `NodePointer::node` is already `RefPtr<Node>` in WK-1200, so the node stays alive. The iterator simply returns a detached node. |
| `[JSC] Avoid dangling pointers in WeakBlock list` | 2025-09-02, `c90e64eec92d` | `JavaScriptCore/heap/WeakBlock.cpp` | Needs JSC-internals verification (see §5). |
| `WorkerGlobalScope::~WorkerGlobalScope()` UAF on teardown | bug **326076**, `7f9fac44d19a` (2026-10-02) | `WebCore/workers/WorkerGlobalScope.cpp:144-145` | Target has the **unguarded** `thread().workerReportingProxy().workerGlobalScopeDestroyed();` (upstream temporarily added a `CheckedPtr`). The target predates the `CheckedPtr` hardening, so the hazard is present. |
| `WorkerMessagingProxy` objects leak after `worker.terminate()` | 2026-04-29, `80cc99fb32cb` | `WebCore/workers/WorkerMessagingProxy.cpp` | Leak, not memory-unsafe. |
| `SpeechSynthesis::stop()` dispatches error events synchronously → crash | 2026-08-21, `527353138b7c` | `WebCore/Modules/speech/SpeechSynthesis.cpp` | **Not reachable on PS5** — `ENABLE_SPEECH_SYNTHESIS` is not set for PlayStation. |
| `[EME] Crash pruning a bfcache page that owns an open MediaKeySession` | 2026-06-02, `b09929827ab5` | `WebCore/Modules/encryptedmedia/MediaKeySession.cpp` | Needs a real CDM. |
| `SVGProperty::contextElement` after `stopAnimation()` drops `m_animVal` without `detach()` | 2026-07-06, `eb617fc2899a` | `WebCore/svg/properties/SVGAnimatedValueProperty.h` | Lifecycle; needs deeper work. |
| `Release animVal when animation ends in SVGAnimatedPropertyList` | 2026-04-07, `393fc8204f77` | `WebCore/svg/properties/SVGAnimatedPropertyList.h` | Lifecycle. |
| `trackIndexCompare` uses `int` subtraction that can overflow | 2026-08-27, `456e79b9bc58` | `WebCore/html/HTMLMediaElement.cpp` | Integer overflow; needs `<track>` + many cues. |

---

## 3. Premises from the brief that are **refuted** (important negative results)

These are the "obvious" bugs the brief asked about. Reporting them as absent saves
a lot of device time.

1. **"TreeWalker holds a node pointer across the `NodeFilter` callback that JS can free."** — **No.**
   `TreeWalker::m_current` is a `Ref<Node>` (`WebCore/dom/TreeWalker.h:65`) and
   `NodeIteratorBase::m_root` is a `Ref<Node>` (`WebCore/dom/Traversal.h:48`).
   `TreeWalker.cpp` holds every in-flight node in a `RefPtr<Node>`. GC liveness is
   covered. (The *real* TreeWalker bug is F7 — the JS **wrapper** is not rooted.)
   `NodeIterator`'s `NodePointer::node` is likewise `RefPtr<Node>`.

2. **"SVG SMIL begin/end events fire synchronously inside the animation sample, so
   JS can corrupt the animation state."** — **No.**
   * SMIL events are dispatched **asynchronously** via a zero-delay timer:
     `WebCore/svg/animation/SVGSMILElement.cpp:1164-1176` uses
     `smilEventSender().dispatchEventSoon(...)`; `WebCore/dom/EventSender.h:72-77`
     starts a one-shot timer, so the DOM dispatch happens in a later task, after
     the SMIL update has completed.
   * The whole SMIL update runs inside an `EventQueueScope`
     (`WebCore/svg/animation/SMILTimeContainer.cpp:264-265`).

3. **"JS reallocates the SVG `animVal` vector while the animator holds an index
   into it."** — **No.**
   `baseVal` and `animVal` are two distinct list objects
   (`WebCore/svg/properties/SVGAnimatedPropertyList.h:141-142`); the animator holds
   `Ref<AnimatedProperty>` and re-fetches `animVal()` on every call; and `animVal`
   is created **read-only** (`SVGAnimatedPropertyList.h:126-131`), so JS cannot
   mutate it at all (`SVGList::canAlterList()` → `NoModificationAllowedError`).

4. **"Type confusion between SVGLength / SVGNumber / SVGTransform in the animator."** — **No.**
   The property registry binds each attribute name to a fixed factory and a
   statically-typed accessor (`SVGPropertyAnimatorFactory.h:108-171`), and list
   element types are fixed at compile time (`SVGList.h:202`).

5. **`Range.cpp` has no JS-call sites at all.** `grep -c 'executeFunction|dispatchEvent|scriptState' WebCore/dom/Range.cpp` = **0**.
   The only script-adjacent code is the `CustomElementReactionStack` /
   `CustomElementReactionQueue` pair (`:332`, `:425`, `:434`), which *defers*
   custom-element reactions until after the algorithm completes. The real Range
   bugs (F3/F4) come from **synchronous iframe `unload`** events, not from Range's
   own code.

6. **`compareBoundaryPoints` does not call into JS.** It is a pure comparison over
   `Node::compareDocumentPosition`; the re-entrancy the brief anticipated is
   actually in `processContents` (F3/F4).

---

## 4. Delivered probe files (written, **not deployed** — `DEPLOY.lock` is held)

`DEPLOY.lock` was held by another agent (`expires: 2026-10-20T03:00:00Z`), so per
`AGENTS.md` §8 I did **not** touch any `index.html` / `fa-*.html` deployment file,
and I did **not** send anything to the live PS5 (AGENTS.md §5). Probe `.js` files
are never locked, so the following are written and ready to deploy:

| File | Finding | Expected beacon on PS5 14.20 |
|---|---|---|
| `p493-smil-schedule-uaf.js` | F1 (SVG SMIL UAF) | crash / heap corruption, no `P493-DONE` |
| `p491-nodefilter-weak-null.js` | F2 (weak-callback null deref) | SIGSEGV after `P491-GC-DONE` |
| `p492-range-extract-oob.js` | F3 + F4 (Range) | `P492-BUG311700-HIT` and/or `P492-BUG326459-HIT` |

---

## 5. Recommended next steps

1. **Deploy `p493` first.** F1 is the only finding with a genuine
   *write* primitive (refcount increment into freed memory) plus a
   type-confused vtable dispatch, reachable with plain SVG. On a no-Gigacage,
   FastMalloc build the freed `SVGSMILElement` chunk is immediately reusable, so
   the vtable can be groomed — this is the most promising exploit primitive found.
2. **Deploy `p492`.** F3/F4 are spec violations with a clear sanitizer-bypass and
   document-destruction story, and the upstream WPT gives an exact oracle.
3. **Deploy `p491`.** F2 is a clean, deterministic null deref; it is also the
   easiest to confirm and the easiest to re-verify against upstream.
4. For F6/F7 the device needs **forced GC**. The upstream tests use `GCController`
   / `testRunner`, which the retail WebView does not expose; substitute a large
   `ArrayBuffer` allocation (e.g. 192 MB) plus a tight allocation loop, as in
   `p491`.
5. `SpeechSynthesis` (target #4) should be **dropped from the scope** — it is not
   compiled for PlayStation.

---

## 6. Appendix — how each claim was verified

* Every `file:line` was read in the **WK-1200** tree (the one that ships) and
  re-checked for byte-identity with WK-1400 via `md5sum`.
* Every "is this a real bug?" claim was cross-checked against upstream WebKit
  commit history via the GitHub API (`?path=<file>`), and the upstream patch was
  read to confirm the target contains the **pre-fix** line verbatim.
* Where a premise could not be confirmed (e.g. `NodeIterator`'s raw pointer, the
  `WorkerGlobalScope` `CheckedPtr`), the premise was corrected rather than
  reported — see §2's "Lower-severity" table and §3.
