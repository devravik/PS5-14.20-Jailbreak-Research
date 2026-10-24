# TransformStream Double-Iteration Stream Substitution (CVE-2026-43705)

**Status:** Confirmed live on PS5 14.20.
**CVE:** CVE-2026-43705 (CVSS 8.8). Patched in upstream WebKit (Safari 26.5.2, June 2026).
**Upstream:** Patched. PS5 14.20 is still vulnerable.

## Bug

Sony's TransformStream constructor iterates the JavaScript builtin return array twice:

1. Inside the JavaScript builtin `createInternalTransformStreamFromTransformer`, which destructures `[readable, writable]` (length 2).
2. In C++ via `SequenceConverter<IDLObject>::convert()` at TransformStream.cpp:114, which iterates `[transformObj, ReadableStream, WritableStream]` (length 3).

By overriding `Array.prototype[Symbol.iterator]` between these two iterations, an attacker substitutes their own real ReadableStream and WritableStream objects on the second pass.

## PS5-Specific

Upstream WebKit (after the August 2020 commit e9c70347) does not use `Array.prototype[Symbol.iterator]` in the TransformStream constructor. The error messages `"returned values of unexpected types"` and `"unexpected number of values"` do not exist in upstream WebKit. Sony wrote a custom C++ implementation that reintroduces the iterator dependency.

## The Disconnect

After substitution:
- The **C++ side** (`m_readable`, `m_writable`) holds `Ref<>` strong references to the attacker's streams.
- The **JavaScript side** (`internalTransformStream.internalReadable`, `.internalWritable`) holds references to the real streams.
- All transform operations (write, error, close, backpressure) flow through the real streams.
- The IDL getters (`ts.readable`, `ts.writable`) return the attacker's streams.

## GC Tracing

`JSTransformStream::visitAdditionalChildren` only visits `m_internalTransformStream`. The `m_readable` and `m_writable` fields are `Ref<>` (reference-counted, not GC-traced). The real streams remain rooted through the `internalTransformStream` private slots, so they are not collected.

## Device Results

Confirmed in p429-transformstream-bypass.js:
- Test A: The readable and writable properties return the attacker's streams.
- Test B: The real readable, writable, and transform objects were captured separately.
- Test C: A stolen reader works on the attacker's stream.
- Test D: The disconnect survives GC pressure.
- Test E: `iterCalls: 2` confirmed. Call 0 comes from the builtin (length 2), call 1 comes from C++ (length 3).
- V431: The real pipeline stays consistent with zero anomalies. No memory corruption from the disconnect alone.

## Source Locations (WK-1400)

- `TransformStream.cpp:99-130` -- `createInternalTransformStream()`.
- `TransformStream.cpp:114` -- `SequenceConverter<IDLObject>::convert()` (second iteration).
- `TransformStream.cpp:121-122` -- `jsDynamicCast` type checks (pass because the attacker's streams are real typed objects).
- `TransformStream.cpp:129` -- `readable->wrapped()`, `writable->wrapped()` (extracts C++ DOM objects from the attacker's JavaScript wrappers).
- `TransformStreamInternals.js:85` -- destructuring (first iteration).
- `TransformStreamInternals.js:100` -- the return array that C++ iterates.

## Limitation

The disconnect is proven but does not produce memory corruption on its own. The attacker's streams are real typed objects, so there is no type confusion at the C++ level.
