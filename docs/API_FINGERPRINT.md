# PS5 14.20 Browser API Fingerprint

Device-confirmed from probes V399, V520, V521 on retail PS5 firmware 14.20.

## User Agent

```
Mozilla/5.0 (PlayStation; PlayStation 5/14.20) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15
```

Engine: WebKit-1400 / Safari 17.0 / AppleWebKit 605.1.15

## Available APIs (Device-Confirmed)

### Core Web Platform
- **Workers** (dedicated only, no SharedWorker, no ServiceWorker)
- **WebSocket**
- **fetch / XMLHttpRequest**
- **MessageChannel / MessagePort**
- **Blob / URL.createObjectURL**
- **structuredClone**
- **Response.clone** (body correctly duplicated)

### Crypto
- **crypto.subtle**  - ECDH P-256, AES-GCM, AES-CBC (device-confirmed key operations)

### Streams
- **ReadableStream** (default reader only, NOT BYOB/type:bytes)
- **WritableStream**
- **TransformStream**

### Graphics
- **Canvas 2D**
- **CSS Animations** (Animation, CSSAnimation, CSSTransition, getAnimations, animate)
- **FontFace / document.fonts**

### Media
- **MediaSource Extensions**
  - H.264 Baseline: `avc1.42E01E`
  - H.264 High: `avc1.64001E`
  - AAC: `mp4a.40.2`
  - NO WebM/VP8 support
- **SourceBuffer** (mode: segments/sequence, mode switching works)

### JavaScript Language
- **ResizableArrayBuffer (RAB)**
- **Atomics**
- **WeakRef**
- **FinalizationRegistry**
- **Proxy**
- **BigInt**
- **Intl.Segmenter, Intl.NumberFormat, Intl.Collator**
- **URLSearchParams** (iteration works correctly during mutation)
- **Object.create(null) + defineProperty** (1000+ properties, reconfigure works)

## NOT Available (Device-Confirmed)

| API | Notes |
|-----|-------|
| WebAssembly | Completely absent |
| SharedArrayBuffer | Not available |
| ReadableStream BYOB | type: "bytes" not supported |
| WebGL / WebGL2 | Not available |
| WebAudio (AudioContext) | Not available |
| WebRTC | Not available |
| WebGPU | Not available |
| IndexedDB | Not available |
| ServiceWorker | Not available |
| Popover API | No popoverAttribute, no showPopover, no ToggleEvent |
| Clipboard API | Not available despite isSecure:true |
| AbortSignal.any | Not available |
| WebM/VP8 codecs | Not available |

## JSC Engine Characteristics (Device-Confirmed)

### Execution
- **LLInt only**  - no DFG, FTL, or B3 JIT tiers
- All code runs in the Low-Level Interpreter
- No speculative optimization, no OSR, no watchpoints for JIT

### Object Model
- Structure shapes are shared between same-shape objects
- Butterfly reallocation works (grow to 10000, shrink, re-grow with holes, sparse mode transitions)
- Megamorphic IC handles 200+ structure shapes

### Garbage Collection
- WeakRef targets survive GC pressure (tested: 50000 x 256B ArrayBuffer allocation)
- GC does NOT collect objects with live references (no WeakRef confusion possible)
- Conservative GC scanning is active (pins stack-referenced memory)

### Strict Mode Behavior
- `Object.seal` in sloppy mode: assignment silently fails (no throw, no property added)

## Threading

- `thr_create` (syscall 430) works from browser context
- CS=0x43 / SS=0x3B segment registers
- Up to 8 threads confirmed
- Child thread code execution confirmed

## Memory Limits

- WebContent process AB ceiling: ~1200 MB held simultaneously
- OOM-kill threshold: ~1.5 GB total process memory
- Cycling allocations via MADV_FREE can map more over time
- Gigacage: DISABLED on FreeBSD (AB data shares heap with JSC objects)
