# CSSFontFace iterateClients UAF (CVE-2026-43715)

**Status:** Unpatched in WK-1400 (PS5 14.20). Device test deployed; crash not yet confirmed.
**CVE:** CVE-2026-43715
**Upstream:** Patched in commit `5aedb82710ba578f`.

## Bug

`iterateClients()` in CSSFontFace.cpp copies a WeakHashSet into a `Vector<Ref<Client>>` and then invokes a callback on each client in the vector. When `FontFace::fontStateChanged` runs as one of those callbacks, it resolves `m_loadedPromise`. The promise resolution path checks whether the result is a thenable -- if it has a `.then` property, the engine calls that getter synchronously.

An attacker places a getter on `FontFace.prototype.then` that removes a style element and forces a synchronous layout. This causes a client to be removed from the underlying WeakHashSet while the callback loop is still iterating over its snapshot. On the next iteration, the loop invokes a callback on the now-disconnected client -- a use-after-free.

## Trigger

```js
Object.defineProperty(FontFace.prototype, 'then', { get() {
    document.getElementById('victim-style').remove();
    document.body.offsetHeight; // force synchronous layout
}, configurable: true });

const face = new FontFace('test', 'url(font.ttf)');
document.fonts.add(face);
face.load();
```

Calling `face.load()` starts font loading. When the font finishes loading, the engine calls `setStatus`, which triggers `iterateClients`, which resolves the promise, which checks for a thenable, which invokes the attacker's `.then` getter.

## Call Chain

1. `face.load()` initiates font loading.
2. The font loads successfully. The engine calls `CSSFontFace::setStatus(Status::Success)` (CSSFontFace.cpp:571-628).
3. `setStatus` calls `iterateClients(callback)` (CSSFontFace.cpp:55-59).
4. The first client callback is `FontFace::fontStateChanged` (FontFace.cpp:332-356).
5. `fontStateChanged` resolves `m_loadedPromise` at line 344.
6. `DOMPromiseProxy::resolve()` calls `JSDOMPromiseDeferred::resolve()`, which enters JavaScript execution.
7. The JavaScript engine checks whether the resolved value is a thenable. It reads the `.then` getter, which runs the attacker's synchronous JavaScript.
8. The getter removes a style element and forces a layout update. This disconnects a client from the WeakHashSet.
9. The loop continues to the next client and invokes a callback on the now-disconnected object -- use-after-free.

## Fix (Upstream)

Commit `5aedb82710ba578f` adds a `clients.contains(client)` check before each callback invocation, skipping any client that was removed during iteration. The WK-1400 build on PS5 14.20 does not include this fix.

## UAF Targets

The disconnected client can be any of the following types. Each receives a different callback after disconnection:

1. **CSSFontSelector** -- receives `fontLoaded`, which calls `dispatchInvalidationCallbacks()`.
2. **CSSSegmentedFontFace** -- receives `fontStateChanged`, which clears `m_cache`.
3. **CSSFontFaceSet** -- receives `fontStateChanged`, which calls `decrementActiveCount()` and then `completedLoading()`.
4. **FontFace** -- resolves the JavaScript promise. This is the first client in iteration order and is the one that triggers the thenable getter.

## Exploitation Path

1. The UAF produces a controlled callback invocation on a disconnected CSSFontSelector or CSSSegmentedFontFace object.
2. Heap grooming replaces the freed object with attacker-controlled data in the same FastMalloc size class.
3. Gigacage is disabled on PS5, so all allocations (including ArrayBuffer backing stores) share the same heap.
4. If the attacker controls the replacement memory, a StructureID corruption leads to type confusion.
5. Type confusion yields `addrof` and `fakeobj` primitives, which provide arbitrary read/write.

## Source Locations (WK-1400)

- `CSSFontFace.cpp:55-59` — VULNERABLE `iterateClients` (no `contains()` check)
- `CSSFontFace.cpp:571-628` — `setStatus()` calls `iterateClients`
- `CSSFontFace.cpp:428-438` — `fontLoadEventOccurred` → `iterateClients`
- `FontFace.cpp:332-356` — `fontStateChanged` → resolves `m_loadedPromise`
- `DOMPromiseProxy.h:335-343` — `resolve()` iterates deferred promises
- `JSDOMPromiseDeferred.cpp:55-90` — `callFunction` → enters JSC

## PS5 Requirements

All required APIs have been confirmed available on PS5 14.20:

- **FontFace API:** Available (confirmed in V399).
- **Object.defineProperty on FontFace.prototype:** Available (standard JavaScript).
- **document.fonts:** Available (confirmed in prior FontFace tests).
- **Font loading from ArrayBuffer or data: URI:** Available.

## Device Test

Deployed as `fa-v445-fontface.html` (probe `p445-fontface-uaf.js`). The test tries local font names first and falls back to a data: URI TTF. Awaiting crash confirmation on device.
