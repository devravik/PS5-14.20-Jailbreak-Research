# Findings

All findings are validated on device (PS5 14.20) or verified against WebKit-1200 source.

## Confirmed Bugs

### 1. MetadataTable Integer Overflow (Bug 317632 / CVE-2026-64784)

`UnlinkedMetadataTable::finalize()` uses an `unsigned` accumulator with no overflow check. With 38,348,816 op_call sites at stride 112, the accumulator wraps from 4,295,067,392 to 100,096. The allocator reserves 100KB. The interpreter writes 4.29GB forward into heap memory.

**Status: BLOCKED.** The overflow triggers and corrupts heap objects, but the 4.29GB forward sweep crashes the process when it exits mapped virtual memory. Maximum working spray is ~240MB (2400 buffers), covering less than 6% of sweep distance. No early exit exists in finishCreation(). See `docs/bugs/metadatatable-overflow.md` for the full writeup.

### 2. JSString Header Corruption (via MetadataTable)

The sweep corrupts JSString.m_fiber in MarkedSpace cells. All 14 target strings report `.length = 81400` after the overflow. StringImpl backing data stays intact (charCodeAt returns original 0x41). The corruption is in the JSString header, not the character data.

Validated: p146, p147, p148 on device.

### 3. Forward Write Directionality (Proven)

finishCreation() sweeps FORWARD only (higher addresses). Targets placed before the metadata buffer are never reached. Bait and switch heap groom (allocate baits, then targets, free baits, trigger overflow) controls where the sweep lands.

Validated: p143 (no corruption when targets below), p144 (corruption when targets above).

### 4. CSSFontFace UAF (Source Verified)

`CSSFontFaceSet::matchingFacesExcludingPreinstalledFonts` (line 381) returns `std::reference_wrapper<CSSFontFace>` (non-owning). The fix changed this to `Ref<CSSFontFace>`. Also `fontLoadEventOccurred()` calls `pump()` and client callbacks without `Ref<CSSFontFace> protectedThis`. Only `timeoutFired()` and `fontLoaded()` have that protection.

**Status: TESTING.** Probe p170 used WOFF2 (rejected on PS5). Probe p175 uses TTF from ArrayBuffer. Awaiting device results.

### 5. Font Parser OOB Read via loca Table (Device Confirmed)

PS5 FreeType accepts fonts with loca table offsets pointing past the glyf table boundary. V180A-T5 confirmed: font with loca[0]=0x7FFFFFFF loaded, rendered, and passed canvas read. V180A-T7 confirmed: directory entry offset past EOF also loads and renders.

FreeType on PS5 does NOT fully validate font internal offsets before use. With Gigacage disabled, the font buffer (from ArrayBuffer via FontFace API) shares bmalloc heap with JSC objects. A font with controlled OOB loca offsets can read adjacent heap memory through glyph rendering, then extract the data via Canvas getImageData.

**Status: TESTING.** Probe p182 deployed, testing multiple OOB offsets past glyf table.

### 6. ClonedArguments Butterfly UAF (DEAD: Conservative Scan)

ClonedArguments.cpp:289 butterfly pointer stale after Proxy trap reentrancy. V221/V243/V246 confirmed: Proxy trap fires, hole position returns Proxy value, but old butterfly is NEVER freed.

Root cause (source verified + device confirmed): conservative stack scanning keeps the stale `data` pointer alive. The C++ stack frame for `copyToArguments` is still on the stack when the Proxy trap fires. JSC's `ConservativeRoots.cpp:66-82` scans the stack for pointer-aligned values and adds any MarkedBlock cell pointer as a GC root. Even with JSArray spray (correct allocator space), `marksConveyLivenessDuringMarking` keeps the butterfly alive across GC cycles.

V246 device results: all 8 rounds show original sequential values at non-hole positions, `0xBEEF` at hole position 5, no CAFE spray markers anywhere. ArrayBuffer spray (V221/V243) and JSArray spray (V246) both fail.

**Status: DEAD.** Cannot free butterfly while `copyToArguments` is on the call stack.

## Confirmed Dead Ends

### Yarr Regex C3 Position Corruption
1-unit displacement in C3 character class handling always causes match failure. Cannot produce controlled out-of-bounds reads. Verified in source.

### RAB byteLength Inversion
ResizableArrayBuffer has an inverted bounds check that allows conceptual OOB access, but all sink paths (SubtleCrypto, TextDecoder, DataView) throw TypeError before reaching the underlying buffer. Every read/write path correctly re-validates length.

Validated: p160a (TypeErrors on all stale-read paths).

### ClonedArguments propertyCapacity
PreciseAllocation for ClonedArguments has outOfLineCapacity=4 and canRealloc always returns false. Cannot trigger reallocation to create a type confusion.

### Relapse WebKit CVE Set
All known Relapse bugs (prior firmware exploit chain) are patched on 14.20.

Validated: p160 on device.

### Streams API BYOB Reader
BYOB reader ctor/elementSize mismatch is real (acknowledged by FIXME comments in source) but TypedArray constructor bounds checking prevents all OOB paths. Every combination results in RangeError or truncated but in-bounds views.

### ReadableByteStreamController
Not implemented on PS5. V190A-P4-ERR: "TypeError: ReadableByteStreamController is not implemented". BYOB exploitation paths blocked.

### SVG Font GSUB Placeholder Truncation
SVGToOTFFontConversion.cpp line 119 truncates delta to uint16_t via implicit conversion. Triggers when GSUB ligature subtable exceeds 64KB (~10923 ligature pairs). However, the truncation corrupts offsets INSIDE the OTF buffer, not heap metadata. overwrite16 writes a wrong VALUE at a correct LOCATION. This is font data corruption, not a WebKit memory safety issue. Would only be exploitable if FreeType itself misparses the resulting malformed GSUB table.

## Audited Surfaces (No Bugs Found)

| Surface | Agent | Result |
|---------|-------|--------|
| Integer overflows (full JSC) | overflow-hunt | MetadataTable is unique. All other subsystems use Checked<>/RELEASE_ASSERT |
| ASLR leak primitives | aslr-binary-audit | Error.stack has no addresses, ArrayBuffer always zeroed, performance.now() is 1ms resolution |
| MetadataTable alternative strategies | metatbl-alt-strategy | No shortcut for sweep. No early exit, link() safe, destructor safe |
| SerializedScriptValue (structuredClone) | clone-deserialize-audit | Well hardened. No type confusion, no UAF, no uninit memory |
| Streams API + SubtleCrypto | streams-api-audit | BYOB mismatch is real but TypedArray bounds checking blocks all OOB |

## Device Recon Results (Session 10)

### FontFace API (p161a)
FontFace and document.fonts.add work on PS5. Parser rejects most malformed fonts (NetworkError). Two edge cases accepted:
- numGlyphs=0xFFFF (65535) loads without error
- unitsPerEm=0 loads AND renders on canvas (potential div-by-zero in layout math)
- WOFF2 is rejected
- ArrayBuffer source loading works (no data URL needed)

### Font Parser Fuzz (p180a, V180A)
12 corruption variants tested against FreeType via FontFace API from ArrayBuffer.

| Test | Corruption | Result |
|------|-----------|--------|
| T0 | Valid baseline | LOADED + RENDER + CANVAS-OK |
| T1 | numGlyphs=0xFFFF | LOADED |
| T2 | numHMetrics=0xFFFF | LOADED |
| T3 | Bad loca format | LOADED |
| T4 | Huge cmap segCount | LOADED |
| T5 | LOCA OOB OFFSET | LOADED (OOB read potential) |
| T6 | Dir size overflow | REJECTED |
| T7 | Dir offset past EOF | LOADED (OOB read potential) |
| T8 | maxp zero glyphs | LOADED |
| T9 | Bad magic number | LOADED |
| T10 | Huge numTables | LOADED |
| T11 | unitsPerEm=0 | REJECTED |

T5 and T7 are the critical findings. FreeType accepts fonts with offsets pointing outside the valid table data.

### Image Decoders (p161b)
All 7 formats supported: PNG, JPEG, GIF, WebP, BMP, SVG, ICO. createImageBitmap available. Edge cases:
- Truncated PNG IDAT loads successfully (potential uninit memory read)
- 0x0, 65535x65535, 32768x32768, INT_MAX width all rejected
- CIB huge crop clamped to 1x1

---

## Canvas UAF Exploitation Chain (CVE-2026-43720)

### IsoHeap OFF on PS5

`WTF_MAKE_ISO_ALLOCATED` compiles to standard FastMalloc on FreeBSD/PlayStation. `BPLATFORM(PLAYSTATION)` at BPlatform.h:341 disables IsoHeap. Gigacage also disabled  - AB backing stores share the same heap as JSC/WebCore objects. Confirmed by Synacktiv writeup and CSSFontFace exploitation research.

### Same-Type Reclaim + Bidirectional R/W (V573)

BMR trigger (bitmaprenderer outer + 2d inner via defineProperty getter) confirmed working on device. 500x Canvas2D spray reclaims freed 768B context slot. Stale wrapper aliases spray context at index 9. All 12 Canvas2D APIs work through alias: lineWidth, miterLimit, globalAlpha, fillStyle, strokeStyle, getTransform, setTransform, getLineDash, setLineDash, measureText, save, restore.

### State Buffer Reclaim (V587/V589)

8x `save()` inside getter grows `Vector<State>` out-of-line to ~6400 bytes (bmalloc class 6656). BMR trigger frees inner context + state buffer. AB spray can reclaim the freed state buffer. V589 confirmed BMR trigger works (`uaf-ok: inner=OK`) but crashes during spray phase  - likely GC pressure from 500+ AB allocations.

### OOB State Stack Read  - Info Leak Candidate

**Key insight:** After BMR free + same-type reclaim, the stale wrapper retains `m_stateStack.m_size = 9` (from 8 saves) while the new context has `m_size = 1`. Reading `m_stateStack.last()` through the stale wrapper indexes at `buffer[8]` = offset 3200 = **2800 bytes past the end** of the new context's 1-State buffer.

This reads from adjacent heap allocations. A 48-bit x86-64 pointer is exactly representable as IEEE 754 float64, so `lineWidth` returns the raw pointer value as a JavaScript number.

**libpas allocator behavior:** Out-of-band bitmap tracking  - freed chunks retain all stale data. No in-band freelist pointers. Freed memory is NOT zeroed.

**Status:** Probe needed to confirm non-zero pointer-like values from OOB read on device.

### Exploitation Path

1. OOB state stack read → heap address leaked as float64
2. Fake lineDash `Vector<double>` in AB: set `m_buffer = TARGET`, `m_capacity = N`, `m_size = N`
3. `setLineDash([v1,...,vN])` → in-place memcpy to TARGET = arbitrary write
4. `getLineDash()` → reads from `m_buffer` = arbitrary read
5. Read JSGlobalObject vtable → binary base → ROP gadgets
6. Vtable hijack → ROP chain (x86-64, no PAC, no JIT)
7. Kernel escalation via reachable syscall surface
