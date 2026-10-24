# WebKit-1400 Source Audit Results

Systematic audit of the open-source WebKit-1400 snapshot corresponding to the PS5 14.20 browser (Safari 17.0 / AppleWebKit 605.1.15). The PS5 runs LLInt-only (no DFG, FTL, or B3 JIT), which eliminates entire vulnerability classes that depend on JIT compilation.

## Scope

15 subsystems audited for memory-safety bugs exploitable from JavaScript in a no-JIT, no-WASM, no-WebGL environment. Focus on code paths reachable from the PS5 browser sandbox.

## Results: 0 Exploitable Bugs

### 1. JSC RegExp Fast Paths

All unchecked `jsCast<>` calls in JSC runtime are preceded by C++ type checks (`@isRegExpObject`, `@isMap`, etc.). Private-name inversion cannot bypass these C++ class checks. No exploitable type confusion from JavaScript.

### 2. SourceBuffer / MSE

All events use `queueTaskToDispatchEvent` (async delivery). All raw pointers are guarded by `isRemoved()` checks. The 11 `PLATFORM(PLAYSTATION)` guards are logging-only (see PLATFORM_PLAYSTATION.md).

### 3. ReadableStream / tee()

JS builtin wall: ALL InternalReadableStream operations go through `invokeReadableStreamFunction` which dispatches to JS builtins. No direct C++ field access is exploitable from JavaScript. Private-name inversion can write ReadableStream slots onto arbitrary objects, but all subsequent operations validate through JS builtins.

### 4. Canvas 2D / OffscreenCanvas

IsoHeap isolation confirmed. Both `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` use `WTF_MAKE_ISO_ALLOCATED`, preventing cross-type heap replacement.

### 5. CSSFontFace (CVE-2026-43715 variant)

UAF exists via eager promise resolution + `setProperty` adopt path writing `m_status` to freed FastMalloc memory. However, free and use are synchronous with no JS re-entry window. All grooming strategies fail because the 192-byte size class has no suitable type confusion target. Confirmed DoS-only.

### 6. structuredClone

`m_objectPool` roots all objects during the clone operation. Re-entry during serialization is impossible. Pool mismatch (gcBuffer split) fix confirmed present on PS5 14.20.

### 7. RAB (ResizableArrayBuffer)

ALL WebCore APIs reject resizable views at `toWrapped()`. `set()` has per-element `inBounds` checks. `copyWithin` is bounded by `maxByteLength`. The inverted OOB check in `byteLength` is real but all downstream sinks have correct guards.

### 8. Yarr (RegExp Engine)

- C3 position corruption: 1-unit displacement always causes match failure, not exploitable state.
- Lookbehind forward reference: Fixed in WK-1400 at YarrPattern.cpp:1534-1537 ({0} quantification cleanup).

### 9. NodeIterator / TreeWalker

`RefPtr` protects all nodes. Adoption during filter callbacks is safe. All 5 device tests passed.

### 10. XMLParser / Custom Elements

`innerHTML` skips custom element check (`!m_parsingFragment` guard at line 810). Cannot trigger XMLParser CE UAF via innerHTML. XHTML iframes are dead on PS5. Main-frame XHTML untested but requires specific content-type serving.

### 11. sort() / TypedArray

On detach: `m_vector` cleared, `m_length` zeroed. All subsequent access returns `undefined`. Safe.

### 12. DirectArguments

`isMappedArgument(i)` checks `i < m_length` before `setIndexQuickly`. DFG also bounds-checks (though DFG is unavailable on PS5 anyway).

### 13. ClonedArguments

Conservative GC scanning pins butterfly memory. All 9 bypass angles exhausted. Cannot reclaim butterfly for UAF.

### 14. MetadataTable Integer Overflow

38M entries x 104 bytes/node = 3.7 GB AST required. PS5 WebContent process OOM-kills at ~1.5 GB. Mathematically impossible within PS5 memory limits. The `ThrowableExpressionData` adds 36 bytes per call node, and no opcode can overflow within available memory.

### 15. Font Parsing (loca table)

PS5 renderer validates loca table offsets. All OOB attempts produce notdef fallback glyph. Device-confirmed with V260.

## Latent Bugs (F98-F102)

5 latent bugs identified, none exploitable from JavaScript:

| ID | Description | Severity |
|----|-------------|----------|
| F98 | Inverted predicate in comparison logic | Most dangerous latent; no JS trigger path |
| F99 | Edge case in internal bookkeeping | No JS-reachable path |
| F100 | Boundary condition in size calculation | No JS-reachable path |
| F101 | Missing null check in rare path | No JS-reachable path |
| F102 | Off-by-one in internal iteration | No JS-reachable path |

## WSA-2026-0003/0004 CVE Audit

All 39 CVEs from WebKit Security Advisories WSA-2026-0003 and WSA-2026-0004 were audited against PS5 capabilities. **All are dead on PS5** due to requiring one or more of:

- WebAssembly (not available)
- JIT compilation  - DFG, FTL, or B3 (not available, LLInt-only)
- WebGL / WebGL2 (not available)
- User-interaction APIs (not available in PS5 browser context)

Additionally, CVE-2023-42917 is patched in WK-1400 (fix at Structure.cpp:917-933), and all 2023-2024 WebKit CVEs target JIT tiers unavailable on PS5.
