# AI Learning: PLK ps5-webkit-autoloader Methodology

Study of https://github.com/itsPLK/ps5-webkit-autoloader and its submodule
https://github.com/itsPLK/ps5-webkit-remote-loader (commit 09eca89).
Focus on exploitation methodology, architecture and techniques we can adopt.

## Architecture

PLK's system has three layers:

1. **ps5-webkit-remote-loader**: The core runtime. Handles the WebKit exploit,
   memory primitives (read/write/leakval), ROP chain construction, Worker hijacking,
   firmware offset tables, and a JS payload queue. This is the real engine.

2. **ps5-webkit-autoloader**: An installer that caches the exploit page on the PS5
   using AppCache so it runs offline from a homescreen shortcut. Uses libmicrohttpd
   in a native ELF to serve content from localhost:18181. No exploit logic here.

3. **Payload system**: Three payloads run in sequence: elfldr-check.js (checks if
   already exploited), poops.js or relapse.js (kernel exploit), autoload.js (sends
   ELF to the loader via localhost socket).

**How it compares to ours**: We serve pages over LAN via DNS capture (host.py) with
the PS5 browser hitting our server. PLK also supports this via host.py for initial
setup. The main difference is PLK adds the AppCache layer for offline use, which we
do not need since we are doing active research and want to update payloads instantly.
Our q7f.html approach with script tags is simpler and sufficient for our use case.

## WebKit Exploitation Chain (webkit.js)

This is the most valuable part. The exploit chain goes through 5 stages:

### Stage 1: JSScope Leak via Proxy (leakScopeObject)

```
class Leaker { leak() { return super.foo; } }
Leaker.prototype.__proto__ = new Proxy({}, {
  get: function(target, property, receiver) { return receiver; }
});
```

This is the ProxyObject + get_by_id_with_this bug we tested with p360.
`super.foo` compiles to `get_by_id_with_this`. The Proxy get trap receives
the raw `this` as receiver without toThis() sanitization. On FW 7.00 through 13.60,
this leaks a JSScope internal object.

**Our test result**: DEAD on FW 14.20. The receiver is the ProxyObject constructor
function, not a JSScope. Sony patched this at binary level.

### Stage 2: Address Leak via Symbol.prototype.toString

After getting the leaked scope, they abuse it as a property bag:
- Store 512 properties on the scope object
- Store 8 float properties
- Define a getter that returns a getterCarrier function
- The getterCarrier function has fakeHost and targetHolder stored as indexed properties
- Call Symbol.prototype.toString on a Symbol wrapper built from the scope
- The resulting string has a specific oversized length (LEAK_STRING_LENGTH = 924176)
- Read back charCodes at offset 7 to extract pointer values for fakeHost and targetHolder

This is a clever pointer leak. The oversized Symbol string representation contains
raw memory including the pointers to the objects stored on the getterCarrier.

**Key constant**: They read 16 uint16 words from the string, expecting two
copies of fakeHost pointer and two copies of targetHolder pointer. Both must
match and be plausible cell addresses (> 2^32, < 2^48, aligned to 8).

### Stage 3: Heap Grooming (groomHeap)

The grooming pattern is specific:

1. Allocate 512 ArrayBuffers of 0x10000 (64KB) as keepalive padding
2. Allocate then transfer a 0x400000 (4MB) slab via MessageChannel to create a gap
3. Allocate specific hole sizes: 0x81000, 0x81000, 0x10000, 0x70000, 0x90000
4. Allocate a predecessor buffer of 0x80000
5. Allocate a finalHole of 0x80000
6. Fill the predecessor buffer with repeated copies of the fakeAddress pointer
7. Free butterflyHole1, butterflyHole2, earlyHole, finalHole via postMessage transfer

Then they check if history.state returns a corrupted clone (the duplicate index
object should now point to the fake object instead of the original).

**Heap grooming method**: MessageChannel.port1.postMessage with transfer list is
their primary mechanism for freeing buffers and creating holes. This is cleaner
than structuredClone transfer because it goes through a different code path. They
create SPECIFIC sized holes (not random spray) to control where the corrupted
clone ends up.

### Stage 4: Corrupted Clone Inspection (inspectClonedGraph)

They use history.replaceState() to store a graph of objects. On deserialization
(history.state), the structured clone process can be corrupted by the heap grooming.

The graph has 0x10001 entries with a control index at 0xFFFF holding -64000.
They check if the duplicate entry (index 2) has been corrupted to point at
their fakeHost object instead of the original referenceTarget.

If the clone IS corrupted, they:
1. Read the corrupted Uint8Array's header (CELL_BYTES = 0x30)
2. Validate the structure ID, prototype pointer, vector pointer, and length
3. Verify identity via a canary (magic bytes written at offset 0x20)
4. Modify the header's flags to upgrade the view (subtract 2 from a 16-bit field)
5. Use the corrupted view as a read/write primitive by redirecting its backing store pointer

**Corrupted view as ARW primitive**: They modify bytes at offset 0x10 in the
Uint8Array's header (the m_vector field) to redirect where the view reads/writes.
This gives them arbitrary read/write of 0x100 bytes at any address. The
setAddress/resetAddress functions swap the backing store pointer back and forth.

### Stage 5: ROP Chain via Worker Hijacking

Once they have ARW:

1. Leak WebKit base address using the native constructor pointer stored during
   the corruption phase (__ps5NativeCtor). Compare against candidate offsets.
2. Resolve libSceLibcInternal base via WebKit's memset import GOT entry
3. Resolve libkernel base via WebKit's __stack_chk_guard import
4. Walk the pthread linked list (libkernel thread_list) to find the Worker thread's stack
5. Identify the Worker's stack by fingerprinting the return address (kbase+worker_wait_return)
6. Hijack the Worker's return address on its stack to point to a "pop rsp" gadget
7. Set the stack pointer to their ROP chain buffer
8. Worker.postMessage() triggers the hijacked return, executing the ROP chain
9. The chain ends by longjmp'ing back to the original context

**Worker fingerprint matching**: They scan the top 4KB of each 0x80000 stack for
the expected return address. Only one stack should match. They retry up to 50 times
with 1ms delays if the signature is ambiguous or missing.

**ROP chain structure**: Uses setjmp/longjmp for clean entry/exit. The chain has
a reserved 0x10000 header for the pre_chain setup, followed by gadgets pushed
by the caller. Each push writes 8 bytes (low32 + high32) to the chain buffer.
The chain can call arbitrary functions (fcall) or syscalls (add_syscall).

## Reliability Techniques

1. **Retry loop**: The exploit wraps everything in an attempt counter with retry().
   Failed attempts release state (history state, keepAlive arrays, leaked references)
   and wait 750ms before retrying. The retry reason is logged.

2. **Canary verification**: They write magic bytes (0x5a, 0xa5, 0xc3, 0x3c, 0xde, 0xad,
   0xbe, 0xef) into the corrupted view and check them back. This confirms the corrupted
   view is THEIR view and not some random object.

3. **Safe vs unsafe failures**: Each failure path is classified as "safe" (can release
   and retry) or "unsafe" (state may be inconsistent, need shorter retry delay).
   finishEarlySafeAttempt() waits 750ms, unsafe retries wait only 50ms.

4. **Cross-validation**: After getting the corrupted view, they read the function object,
   its executable, and the native executable's function/constructor pointers. All must
   be plausible addresses. They also verify the full round trip by reading back the
   same values through the redirected view.

5. **DOM log cap**: Output is capped at 1200 DOM nodes (trimmed to 1000) to prevent
   WebKit OOM from logging. This is important for reliability on the PS5 browser.

6. **Worker chain timeout**: 20 second deadline for ROP chain execution. If the worker
   never responds, they throw instead of hanging forever.

7. **Firmware-specific filler**: fillerBigIntCount() adjusts the BigInt filler count
   based on firmware version (legacy vs modern WebKit). Different heap layouts need
   different filler to get the right alignment.

8. **Poison check**: Before trusting the ROP chain, they write 0xDEADBEEF00C0FFEE to
   the return slot and call getpid(). If the return value still matches the poison,
   the chain never executed.

## Memory Primitive Details

The memory primitive (mem.js) provides:
- read1/read2/read4/read8 at arbitrary addresses
- write1/write2/write4/write8 at arbitrary addresses
- leakval: stores an object reference in a known location, reads its address back

The leakval primitive works by:
1. Setting targetHolder.q2 = the object
2. Reading 8 bytes at memory.leakAddress (= holderAddress + 0x20)
3. The JSValue encoding in memory gives the raw cell pointer
4. Validating alignment (must be 8-byte aligned) and range (> 2^32, < 2^48)
5. Clearing the slot back to the marker object

**malloc implementation**: They create a large TypedArray (Uint32Array of 0x10000+size),
leak the typed array address, read its m_vector at offset 0x10 to get the backing
store pointer. The backing store IS the "malloced" memory. This avoids needing the
real malloc and works entirely in JS. The backing array is kept alive in an allocations
list.

## Offset Tables

Each firmware has a JS file with:
- WebKit base calculation offsets (OFFSET_wk_host_constructor_candidates)
- GOT import offsets for resolving libc and libkernel
- Thread list offset in libkernel
- ROP gadget map (ret, pop rdi/rsi/rdx/rcx/rax/rsp/r8/r9, mov [rdi] rsi/rax, etc)
- Full syscall number to offset map (hundreds of entries)
- Kernel offsets (allproc, security_flags, rootvnode, etc)
- Process/credential structure field offsets
- Symbols for libkernel and libc functions

**For our FW 14.20**: No offset table exists in this repo (only covers 7.00-13.60).
We would need to build our own offset table if we get past the WebKit exploit stage.
The structure shows exactly what offsets are needed.

## Things They Do That We Should Consider

1. **history.replaceState for heap manipulation**: Using the browser history API
   for structured clone corruption is a pattern we have not explored. The state
   object is serialized/deserialized through the same structured clone code we
   have been auditing. The "duplicate index" trick creates a reference that gets
   resolved through a corrupted heap, giving a type confusion on the clone result.

2. **MessageChannel transfer for hole creation**: Cleaner than structuredClone
   transfer. The dual-port close + postMessage(0, [buffer]) frees the buffer
   through a different path that may have different timing characteristics.

3. **TypedArray header manipulation for ARW**: Instead of trying to corrupt
   ArrayBuffer backing stores (our MetadataTable approach, which failed because
   of marge bitfit page isolation), they corrupt the Uint8Array JSCell itself.
   The m_vector field at offset 0x10 in the cell header IS the pointer that
   determines where reads/writes go. Corrupting this single 8-byte field gives
   full ARW. This is much simpler than trying to hit backing stores.

4. **Filler BigInt objects for heap alignment**: BigInt allocations of different
   sizes (1n << 40n) are used as filler to push the heap layout into the right
   alignment. The count varies per firmware version (1 to 7). This is a precision
   grooming technique.

5. **Probe before exploit**: elfldr-check.js connects to localhost:9021 first.
   If an ELF loader is already running, skip the kernel exploit entirely. This
   prevents double-exploitation crashes. We could use a similar "already exploited"
   check.

6. **Standalone build system**: build_standalone.py creates one self-contained
   HTML file per chain, with all payloads, offsets, and binaries inlined. No
   network dependencies at runtime. For our research, having per-probe standalone
   files would be more reliable than our current multi-script loading through q7f.

7. **DOM log management**: Capping log output to 1000-1200 entries prevents
   WebKit OOM. We should do the same in our beacon-heavy probes.

8. **Module system**: They use ES modules (import/export) with a fallback to
   inline module registry for standalone builds. Clean separation of concerns.

## Key Takeaways for Our Research

The PLK exploit targets a DIFFERENT bug than what we are looking for.
Their WebKit exploit relies on the JSScope leak (get_by_id_with_this bug) which
is confirmed DEAD on FW 14.20. The entire exploitation chain starting from Stage 1
does not work on our firmware.

However, the METHODOLOGY is what matters:

- **The chain structure is reusable**: If we find our own info leak and heap
  corruption bug, stages 3-5 (heap grooming, TypedArray header corruption,
  Worker ROP hijacking) would work the same way with FW 14.20 offsets.

- **The offset table format shows what we need**: When we get ARW, we need
  exactly the same set of offsets (gadgets, GOT entries, kernel structure offsets).
  We can start building a 14.20 offset table now from the WK-1200 source.

- **TypedArray m_vector corruption is the right target**: Instead of trying to
  corrupt ArrayBuffer backing stores (which live in a different allocator tier),
  we should target the JSCell header of a TypedArray. The m_vector field at +0x10
  controls the data pointer. One 8-byte overwrite gives full ARW.

- **The malloc trick is universal**: Allocate a large TypedArray, leak its address,
  read m_vector to get a "malloced" buffer. No need for actual malloc() calls.
  This works on any firmware.

## What We Still Need To Find

1. An info leak primitive for FW 14.20 (the JSScope leak is dead)
2. A heap corruption primitive that can overwrite a TypedArray's m_vector field
3. FW 14.20 offset tables (gadgets, imports, kernel offsets)
4. A kernel exploit for FW 14.20 (Poops and Relapse kernel bugs are patched)

The MetadataTable overflow could still serve as the heap corruption if we target
JSCell headers (proven by p146/p148 JSString corruption) instead of ArrayBuffer
backing stores. The missing piece is a reliable info leak on 14.20.
