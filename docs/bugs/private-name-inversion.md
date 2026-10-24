# Private-Name Inversion via ReadableStream.tee()

**Status:** Confirmed live on PS5 14.20.
**CVE:** None assigned (novel finding).
**Upstream:** Affects WebKit trunk (ReadableStreamInternals.js).

## Bug

When `Array.prototype[Symbol.iterator]` is poisoned to yield the same object X twice during `rs.tee()`, the WebKit engine writes internal private slots onto X.

The `SequenceConverter` receives `[X, X]`, which has a size of 2 and passes the `at()` bounds check. Both `pair[0]` and `pair[1]` wrap X as an InternalReadableStream. The tee JavaScript builtin then writes private slots (`disturbed`, `state`, `readableStreamController`) onto X via `@putByIdDirectPrivate`.

## Mechanism

1. Poison `Array.prototype[Symbol.iterator]` to yield the same object X twice.
2. `rs.tee()` runs. The `SequenceConverter` collects `[X, X]` into a Vector of size 2.
3. Both `pair[0]` and `pair[1]` wrap X as an InternalReadableStream.
4. `pair[0].cancel()` calls `readableStreamCancel(X)`:
   - Writes `@putByIdDirectPrivate(X, "disturbed", true)` at ReadableStreamInternals.js:867.
   - Reads `state` as undefined, so it calls `readableStreamClose(X)`, which writes `@put("state", @streamClosed)` at line 919.
   - Reads `reader` as undefined, which causes a TypeError. This is expected.
5. `pair[1].cancel()` now sees `state == @streamClosed`, so it returns `Promise.resolve()` with no error.

## Signal

The first cancel throws a TypeError. The second cancel does not throw. This proves that the engine wrote private slots onto the attacker's object X during the first cancel, and the second cancel read those slots back.

## Escalation Path

Once X has a `readableStreamController` written onto it, the cancel path at ReadableStreamInternals.js:874 calls `@getByIdDirectPrivate(X, "readableStreamController").@cancel(X, reason)`. This is a call on attacker-chosen data. The tee JavaScript builtin creates a real controller via `@createReadableStreamDefaultController()` and writes it onto the branch via `@putByIdDirectPrivate`. If both branches are X, the controller for branch 2 overwrites the controller for branch 1.

This produces a controlled call, but it runs through JavaScript builtins rather than C++ code. It is limited by the same JS builtin wall as the type confusion.

## Device Results

Confirmed in cand-a-fakestream-livetest.html (run fmvfg84vl-jntb8l):
- B0: hookArmed -- the iterator is consulted by the engine.
- B1: BUGLIVE=true -- plain objects are wrapped as ReadableStream.
- B2: pidInverted=true -- firstThrow=TypeError, secondThrow=none.
- B3: BUGLIVE=true -- the inversion travels through Response.clone().

## Source Locations (WK-1400)

- `InternalReadableStream.cpp:187-195` -- S1 defect (upstream untouched).
- `ReadableStreamInternals.js:862-919` -- cancel path with private slot writes.
- `ReadableStreamInternals.js:867` -- `@putByIdDirectPrivate(stream, "disturbed", true)`.

## Disclosure

Novel finding. No matching CVE as of 2026-10-19.
