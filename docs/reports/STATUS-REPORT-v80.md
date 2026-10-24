# PS5 14.20 WebKit Attack Surface Status Report
## 2026-10-18 v80

### CONFIRMED DEAD

| Path | Evidence | Why |
|------|----------|-----|
| ClonedArgs butterfly UAF | V220/V221 device: sequential values, 0 corruption | propertyCapacity=4 blocks canRealloc (ButterflyInlines.h:209) |
| BYOB Streams type confusion | V190A-P4-ERR on device | ReadableByteStreamController NOT IMPLEMENTED |
| FTP redirect (CVE-2023-42890) | V190A-P3-FTP-ERR: TypeError:Load failed | Clean failure, no crash. completionHandler early-returns on null request |
| RAB byteLength inversion | Source analysis + device TypeError | All stale-read sinks (SubtleCrypto, TextDecoder) validate length |
| Yarr C3 position corruption | Source analysis | 1-unit displacement always causes match failure |
| MetadataTable forward sweep OOB | p149g device: ZERO corruption in pre-call spray | 4.3GB contiguous VM needed, max achievable spray 400MB. Forward-only sweep misses lower-address targets |
| PreciseAllocation butterfly (p240) | V240 device: same sequential values | Same propertyCapacity=4 blocker as ClonedArgs |

### CONFIRMED LIVE (Device-Validated)

**1. SVG Font Parsing Active**
- V190A-P1-BBOX: 120x48 (non-zero dimensions)
- V190A-P1-CHILDNODES: 12
- SVGToOTFFontConversion.cpp unconditionally compiled (Sources.txt:2944)
- Conversion pipeline: SVG font XML parsed, converted to OTF binary, passed to FreeType

**2. FontFace API to FreeType Wide Open**
- FT_New_Memory_Face receives raw JS font bytes (FontCustomPlatformDataFreeType.cpp:144)
- FT_Add_Default_Modules exposes ALL FreeType modules (line 131)
- FreeType uses fastMalloc (same allocator as JSC) (lines 116-124)

Device results (V190A-P2 + V180A):
| Variant | Status | Notes |
|---------|--------|-------|
| VALID | LOADED + CANVAS-OK | Baseline |
| MAXP-FFFF (numGlyphs=65535) | LOADED + CANVAS-OK | Potential OOB in loca/glyf |
| HHEA-HMET-FFFF (numHMetrics=65535) | LOADED + CANVAS-OK | Potential OOB read in hmtx |
| LOCA-OOB (offsets=0xFFFFFFFE) | LOADED + CANVAS-OK | FreeType survived 4GB OOB offset |
| CMAP-BIGSEG (segCount=32K) | LOADED + CANVAS-OK | OOB in segment arrays |
| HEAD-LOCAFMT-FF | LOADED + CANVAS-OK | Unknown loca format accepted |
| MAXP-0 (numGlyphs=0) | LOADED + CANVAS-OK | Edge case accepted |
| HEAD-BAD-MAGIC | LOADED + CANVAS-OK | Magic number not validated |
| NUMTABLES-HUGE | LOADED + CANVAS-OK | Table count not validated |
| DIR-OFFSET-PAST-EOF | LOADED + CANVAS-OK | Directory offset OOB |
| HEAD-UPEM-0 | REJECTED | unitsPerEm=0 caught |
| DIR-SIZE-OVERFLOW | REJECTED | Size overflow caught |

**3. CSSFontFaceSet reference_wrapper Bug Present**
- CSSFontFaceSet.h:88: `Vector<std::reference_wrapper<CSSFontFace>>` (non-owning)
- CSSFontFaceSet.cpp:381,428: returns raw reference_wrapper, not Ref
- Upstream fix changed to Ref<CSSFontFace>
- Exploitation requires synchronous JS during C++ iteration loop (complex trigger)

**4. SVG-to-OTF Placeholder uint16_t Truncation**
- SVGToOTFFontConversion.cpp:118: ASSERT-only bounds check (debug only)
- Line 119: overwrite16(delta) silently truncates in release
- Coverage table offset at subtable+2 overflows with enough ligature data
- Need ~11000 ligature pairs for 65536 byte overflow
- Font with truncated offsets produces corrupted OTF that FreeType parses

### PROBES AWAITING DEVICE RESULTS

| Probe | Target | Deployed In |
|-------|--------|-------------|
| p252 | FreeType hmtx OOB read: spray heap then measure advance widths via measureText() | fa-v81-fullchain.html |
| p250S | SVG font support confirm + 7000 ligature Placeholder overflow | fa-v80-fontchain.html |
| p251 | FontFaceSet reference_wrapper stress: load+delete race, onloadingdone handler, rapid interleave | fa-v81-fullchain.html |

### RECOMMENDED NEXT STEPS

1. **FreeType hmtx OOB info leak** (p252 results pending): If advance widths vary for OOB glyphs, we have a heap data leak via measureText(). Build targeted probe to read specific heap offsets and break ASLR.

2. **FreeType crafted TTF for controlled OOB write**: Build font where corrupted loca entries create overlapping glyph data regions. FreeType writes rasterized outlines to fastMalloc buffer. Controlled glyph outlines could write attacker data at known offsets.

3. **SVG-to-OTF Placeholder overflow**: Increase ligature count to ~11000 to overflow the coverage table offset. Corrupted OTF goes to FreeType. The truncated offset makes FreeType interpret arbitrary GSUB data as the coverage table. Potential for controlled OOB reads.

4. **CSSFontFaceSet UAF via MutationObserver**: Use MutationObserver or ResizeObserver to get synchronous JS callbacks during font state transitions. Remove faces during callback to create dangling reference_wrapper.

### AVAILABLE APIs

structuredClone, MessageChannel, Canvas 2D, SVG, Custom Elements, Shadow DOM, MutationObserver, Workers (Blob URL), FontFace, WebSocket, SubtleCrypto, Proxy, eval, BigInt, ResizableArrayBuffer, WeakRef, FinalizationRegistry, Streams API (partial)

NOT available: WASM, SharedArrayBuffer, WebGL, Web Audio, IndexedDB, XSLT, ServiceWorker, ReadableByteStreamController
