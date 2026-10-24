# CRITICAL: p150d needs DOUBLE CALL for ASLR leak

## The Bug in p150d

p150d calls the 38M op_call function ONCE. But `linkFor()` in RepatchInlines.h:131 
has a TWO-STAGE linking process:

```
Mode::Init, first call:  seenOnce() = false → setSeen() → NO pointer write
Mode::Init, second call: seenOnce() = true  → linkMonomorphicCall() → WRITES POINTERS
```

linkMonomorphicCall (Repatch.cpp:84) calls:
- setMonomorphicCallee → writes m_callee, m_codeBlock, m_monomorphicCallDestination
- setLastSeenCallee → writes m_lastSeenCallee

These are the ASLR leak values. They only get written on the SECOND visit to each entry.

## Fix: p150e-double-call.js

1. Compile function (same as p150d)
2. Spray zeroed ABs (same as p150d)  
3. FIRST call (throw at 960): entries 894-959 get seenOnce set in spray bytes
4. SECOND call (throw at 960): entries 894-959 get linkMonomorphicCall → pointer writes
5. Scan spray for 8-byte pointer values → ASLR leak

## Why the first call doesn't crash

ownerForSlowPath (CallLinkInfo.h:455):
```cpp
if (m_owner) return m_owner;  // zeroed → null → falls through
return calleeFrame->callerFrame()->codeOwnerCell();  // valid fallback!
```

LLInt dispatch (LowLevelInterpreter64.asm:2554):
```
m_callee = 0, actual_callee != 0 → slow path → defaultCallThunk → safe
```

## Pointer locations in spray buffer

Entry 894 at offset 32 from spray start. Each entry 112 bytes.
Within BaselineCallLinkInfo (72B on JIT=OFF):
- m_codeBlock: ~offset 40-48
- m_monomorphicCallDestination: ~offset 48-56  
- m_callee: ~offset 56-64
- m_lastSeenCallee: ~offset 64-72

(Exact offsets depend on PackedRawSentinelNode size and padding)

## Deploy

Replace p150d with p150e in fa-v62-huff.html:
```html
<script src="p150e-double-call.js?v=150e"></script>
```
