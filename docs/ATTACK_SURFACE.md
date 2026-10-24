# Attack Surface

PS5 14.20 WebView attack surface map. APIs confirmed on device, audit status tracked per surface.

## API Availability

Confirmed via p163 device fingerprint probe.

### Available
| API | Notes |
|-----|-------|
| Workers | Via Blob URL only (no fetch of external scripts) |
| WebSocket | Full support |
| fetch / XHR | Same-origin and local network |
| SubtleCrypto | Full Web Crypto API |
| Canvas 2D | No WebGL |
| SVG | Inline and via Image |
| FontFace | Load from ArrayBuffer or data URL, document.fonts.add works |
| structuredClone | With MessageChannel |
| ReadableStream / WritableStream | Including BYOB readers |
| ResizableArrayBuffer | With grow(), not transfer() |
| WeakRef / FinalizationRegistry | GC callback timing available |
| Proxy / Reflect | Full trap support |
| BigInt | Arithmetic and TypedArray interop |
| eval / Function() | Dynamic code execution |
| Custom Elements | Full v1 API |
| Shadow DOM | Open and closed modes |
| MutationObserver | Attribute, childList, subtree |
| CSS Animations / Transitions | requestAnimationFrame available |
| Blob / File / FileReader | Blob URL creation works |
| URL / URLSearchParams | Full API |
| TextEncoder / TextDecoder | UTF-8 and other encodings |
| createImageBitmap | With crop parameters |
| DOMParser | XML and HTML parsing |
| Performance API | performance.now() at 1ms resolution |
| console | log, warn, error (no remote access) |

### Not Available
| API | Notes |
|-----|-------|
| WebAssembly | Not exposed |
| SharedArrayBuffer | Not exposed (no cross-origin isolation) |
| WebGL / WebGL2 | Context creation fails |
| Web Audio | AudioContext not available |
| IndexedDB | Not exposed |
| ServiceWorker | Not registered |
| XSLT | XSLTProcessor not available |
| Web Notifications | Not available |
| Geolocation | Not available |
| WebRTC | Not available |

## Audit Status

### Fully Audited (No Bugs Found)
- JSC integer overflow patterns (MetadataTable is unique)
- ASLR leak primitives (none in JS-reachable paths)
- SerializedScriptValue / structuredClone
- Streams API + BYOB readers
- RAB byteLength handling (inverted check exists but all sinks guarded)
- Yarr regex engine
- ClonedArguments allocation

### Audited (Bugs Found)
- **Canvas getContext() UAF (CVE-2026-43720) -- EXPLOITABLE.** IsoHeap is OFF on PS5 (WTF_MAKE_ISO_ALLOCATED = FastMalloc). Same-type reclaim, AB reclaim, and bidirectional R/W all confirmed on device. Primary exploitation vector. See CONFIRMED_VULNS.md.
- MetadataTable overflow (real bug, DEAD -- OOM before 38M entries on PS5)
- CSSFontFace UAF (CVE-2026-43715) -- DoS-only. Timer RELEASE_ASSERT blocks exploitation. Sole 192B occupant.
- tee() type confusion / private-name inversion -- contained by JS builtin wall
- TransformStream disconnect (CVE-2026-43705) -- contained by JS builtin wall

### Audit Complete (No Exploitable Bugs)
- Font parsers -- loca OOB validated on device, PS5 renderer rejects
- Image decoders -- all 7 formats tested, truncated PNG loads but no leak
- DOM mutation + Custom Elements -- post-construction validation blocks double-parent
- SVG filters -- CheckedUint32, RELEASE_ASSERT, 4096 clamp, NaN-to-empty
- Canvas 2D internals -- IsoHeap OFF discovery led to CVE-43720 exploitation (see above)
- Worker lifecycle -- confirmed working, no bugs found
- WebSocket frame parsing -- all binary-to-JS paths zero-init
- WeakRef/FinalizationRegistry -- no pointer in callback

### Not Yet Audited
- Beacon API
- Web Locks API
- Cache API
- History/Navigation API
- IntersectionObserver / ResizeObserver
- CSS custom properties / Houdini (if available)
- Console string formatting internals
