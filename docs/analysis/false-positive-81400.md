# False Positive: .length=81400 is the real string length, not corruption

**Date:** 2026-10-20  
**Affects:** All probes reporting .length=81400 or .length=81700 as "MetadataTable corruption"  
**Status:** CONFIRMED FALSE POSITIVE (V480 definitive test)

## Root Cause

The string literal in p156-bait-switch.js (line 73) is **814 characters**, not 1000:

```
wc -c: p156 line 73 'A' literal = 814 chars
```

The worker loop runs 100 iterations (`for j = 0; j < 100000; j += 1000`), appending the 814-char literal each time:

```
814 chars × 100 iterations = 81,400 chars total
```

`substring(0, 100000)` on an 81,400-char string returns the string unchanged (no truncation needed). The corruption check `len !== 100000` fires because the string was never 100,000 characters.

## Affected Probes

| Probe | Literal length | Reported "corruption" | Actual string length |
|-------|---------------|----------------------|---------------------|
| p156-bait-switch.js | 814 ('A') | .length=81400 | 814 × 100 = 81,400 |
| p466c | 814 ('A') | .length=81400 | 814 × 100 = 81,400 |
| p478/p479 | 817 ('A') | .length=81700 | 817 × 100 = 81,700 |

Bait 'B' literal (line 199): **798 chars** → 79,800-char baits → ~80KB StringImpl backing stores. MetadataTable allocation is ~100KB. Different size classes in marge bitfit → bait-and-switch groom never created correctly-sized holes.

## Evidence: V480 Definitive Test

p480-fixed-literal.js uses loop-built 1000-char chunks instead of string literals:

```js
var CHUNK = '';
for (var ci = 0; ci < 1000; ci++) CHUNK += 'A';
// CHUNK.length === 1000, guaranteed
```

Device results (two independent runs):

```
V480-CHUNK-LEN:         1000           ← chunk correctly 1000 chars
V480-W-ALLOC-s14-len100000             ← worker strings correctly 100,000 chars
V480-BAITS-20-len100000                ← baits correctly 100,000 chars
V480-COMPILED-OK                       ← compilation succeeded
V480-post-compile-HITS: 0-of-14       ← ZERO corruption detected
V480-post-compile-CHK0: s0:c0=41,c50k=41,cEnd=41  ← charCodeAt intact
V480-post-compile-CHK1: s1:c0=41,c50k=41,cEnd=41
V480-post-compile-CHK2: s2:c0=41,c50k=41,cEnd=41
V480-NO-CORRUPTION:     strings intact after compile
```

## Red Flags We Missed

1. **charCodeAt returning 0x41 ('A') everywhere** — if the sweep had corrupted StringImpl headers or data pointers, char reads would return garbage or crash
2. **Identical values across 3 independent consoles** — ASLR-dependent corruption cannot produce the exact same value on different hardware
3. **Identical between compile-only and call runs** — the value changed only when the literal length changed between probe versions

## What Is Still Real

- The MetadataTable integer overflow is real (compilation succeeds)
- The 4.29GB forward sweep writes to memory (calling the function crashes ~88s in from reading garbage metadata as function pointers)
- MADV_FREE preserved virtual mappings allow the sweep to proceed without SIGSEGV during compilation
- The bait-and-switch groom concept is sound, but needs correct sizes

## Files

- `probes/metadata-overflow/extraction/p480-fixed-literal.js` — the definitive test probe
- `results/beacon-logs/v480-fixed-literal-results.txt` — device beacon output
