# ReadableStream.tee() Type Confusion via fromObject()

**Status:** Confirmed live on PS5 14.20.
**CVE:** None assigned (novel finding).
**Upstream:** Affects WebKit trunk (InternalReadableStream.cpp).

## Bug

`InternalReadableStream::fromObject()` at InternalReadableStream.cpp:76-79 wraps any JSObject as an InternalReadableStream with no type validation. The object does not need to be a ReadableStream or have any stream-related properties. It is wrapped unconditionally.

The `tee()` code path exposes this through the `SequenceConverter`, which iterates the `[branch1, branch2]` return array using the JavaScript iterator protocol. By overriding `Array.prototype[Symbol.iterator]`, an attacker can substitute an arbitrary JSObject for either branch during iteration. `fromObject()` wraps it without any type check.

## Object Substitution

1. Override `Array.prototype[Symbol.iterator]` during the `rs.tee()` return path.
2. The `SequenceConverter` iterates the array once to collect the two branches.
3. The attacker's iterator yields a plain object (or any JSObject) in place of one branch.
4. `fromObject()` wraps it as an InternalReadableStream.
5. The result is a real ReadableStream (`instanceof ReadableStream` returns true) that wraps the attacker's fake object.

After wrapping:
- `.locked` returns false, because the private slot is undefined and therefore falsy.
- `.getReader()` throws a TypeError, because the `globalObject` private slot is missing.
- All stream operations go through JavaScript builtins that read private slots via `@getByIdDirectPrivate`. These return `undefined` on fake objects rather than accessing C++ memory.

## OOB Read Variant

If the attacker's iterator returns only one element instead of two, the `ASSERT(results.size() == 2)` check is compiled out on PS5 release builds. The code then reads `results[1]`, which is 8 bytes past the end of the Vector allocation (a `Strong<JSObject>` slot). This crashes on an ungroomed heap due to the `CrashOnOverflow` bounds check in `Vector::at()`.

## Limitation

Every InternalReadableStream operation goes through `invokeReadableStreamFunction()` into JavaScript builtins. There is no C++ code path that directly accesses fields on the wrapped object. Type confusion only triggers through `@getByIdDirectPrivate` reads, which return `undefined` on fake objects. This is the "JS builtin wall."

## Device Results

Confirmed in V432 (cand-a-fakestream-livetest.html):
- A plain object and an ArrayBuffer were both successfully wrapped as ReadableStream.
- Stream operations require private slots that are absent on fake objects, producing TypeError chains.
- The OOB variant crashes at the CrashOnOverflow check.

## Source Locations (WK-1400)

- `InternalReadableStream.cpp:76-79` -- `fromObject()` wraps any JSObject with no validation.
- `ReadableStreamInternals.js` -- all stream operations use `@getByIdDirectPrivate`.
- `IDLTypes.h` -- `SequenceConverter` iterates using the JavaScript iterator protocol.

## Disclosure

Novel finding. No matching CVE in NVD, WebKit Bugzilla, or Apple security advisories as of 2026-10-19.
