# ValueProfile "Dead End" Investigation

Investigation of the claim that the MetadataTable integer overflow (Bug 317632) is a dead end because ValueProfile allocation crashes the process.

## Verdict: THE DEAD-END CLAIM IS WRONG

ValueProfile is **not** allocated separately. It is an inline member of the `op_call::Metadata` struct, inside the single contiguous metadata table buffer. There is no 920MB separate VP allocation. The entire overflow mechanism works as originally described, and p146 already proved it on device.

## Evidence

### 1. ValueProfile Is Inline in the Metadata Struct

From `BytecodeList.rb` in WebKit-1200 (line 548):

```ruby
op :call,
    args: {
        dst: VirtualRegister,
        callee: VirtualRegister,
        argc: unsigned,
        argv: unsigned,
    },
    metadata: {
        callLinkInfo: BaselineCallLinkInfo,   # 72 bytes
        arrayProfile: ArrayProfile,            # 12 bytes
        profile: ValueProfile,                 # 24 bytes (after 4 bytes padding)
    }
```

The code generator turns this into a C++ struct:

```
struct OpCall::Metadata {
    BaselineCallLinkInfo callLinkInfo;   // 72 bytes
    ArrayProfile arrayProfile;           // 12 bytes
    // 4 bytes padding (alignment to 8)
    ValueProfile profile;                // 24 bytes
};  // total: 112 bytes
```

ValueProfile is a **field** of the Metadata struct. It is not a pointer to a separate allocation. It occupies bytes 88-111 of each 112-byte metadata entry.

### 2. link() Allocates a Single Buffer

From `UnlinkedMetadataTableInlines.h` (line 113):

```cpp
ALWAYS_INLINE RefPtr<MetadataTable> UnlinkedMetadataTable::link()
{
    unsigned totalSize = this->totalSize();   // reads from offset table (WRAPPED value)
    unsigned offsetTableSize = this->offsetTableSize();
    uint8_t* buffer;
    if (!m_isLinked) {
        m_isLinked = true;
        m_rawBuffer = buffer = reinterpret_cast<uint8_t*>(
            MetadataTableMalloc::realloc(m_rawBuffer, sizeof(LinkingData) + totalSize));
    } else {
        buffer = reinterpret_cast<uint8_t*>(
            MetadataTableMalloc::malloc(sizeof(LinkingData) + totalSize));
        memcpy(buffer, m_rawBuffer, sizeof(LinkingData) + offsetTableSize);
    }
    memset(buffer + sizeof(LinkingData) + offsetTableSize, 0, totalSize - offsetTableSize);
    return adoptRef(*new (buffer + sizeof(LinkingData)) MetadataTable(*this));
}
```

There is ONE allocation: `MetadataTableMalloc::realloc(m_rawBuffer, sizeof(LinkingData) + totalSize)`.

`totalSize` comes from `this->totalSize()`, which reads the last entry in the offset table. That entry was computed in `finalize()` using the **unsigned accumulator that wrapped**. So `totalSize` is ~100KB (the wrapped value), not 4.29GB (the true value).

The memset zeros the metadata region. The ValueProfile fields are part of this zeroed region. **There is no second allocation.**

### 3. finalize() Accumulates VP as Part of the Stride

From `UnlinkedMetadataTable.cpp` (line 109):

```cpp
unsigned offset = s_offset16TableSize;
for (unsigned i = 0; i < s_offsetTableEntries - 1; i++) {
    unsigned numberOfEntries = buffer[i];
    // ...
    offset += numberOfEntries * metadataSize(static_cast<OpcodeID>(i));
}
buffer[s_offsetTableEntries - 1] = offset;
```

`metadataSize(op_call)` returns 112 (the full struct size including VP). The accumulator `offset` is `unsigned` (uint32_t). With 38,348,816 entries:

```
38,348,816 * 112 = 4,295,067,392
4,295,067,392 mod 2^32 = 100,096
```

The wrapped value (~100KB) is stored as the total size. `link()` allocates ~100KB. The LLInt then writes 112 bytes per call site, with entries past #894 going OOB.

### 4. op_call_ignore_result Does NOT Exist in WebKit-1200

The `op_call_ignore_result` opcode was introduced in a later WebKit version. In the newer WebKit (post-1200) source:

```ruby
op :call_ignore_result,
    args: { callee: VirtualRegister, argc: unsigned, argv: unsigned },
    metadata: {
        callLinkInfo: DataOnlyCallLinkInfo,
        arrayProfile: ArrayProfile,
    }
```

Note: no `profile: ValueProfile` field, and it uses `DataOnlyCallLinkInfo` (smaller than `BaselineCallLinkInfo`).

**This opcode does not exist in WebKit-1200.** There is no match in `BytecodeList.rb`, no LLInt handler, no slow path. On PS5 14.20, `void a()` compiles to the same `op_call` as `a()`. The p202 probe's hypothesis (that void uses a different opcode) is based on a newer WebKit version that the PS5 does not run.

### 5. p146 Already Proved the Overflow Works

From the README probe results:

> p146: Worker .length polling -- **All 14 strings corrupted, .length = 81400**

This is conclusive. The overflow:
- Allocated ~100KB metadata buffer
- Wrote 112-byte entries OOB past the buffer
- Corrupted 14 JSString objects in adjacent MarkedSpace
- The Worker thread observed the corruption and reported it via beacons

If ValueProfile were separately allocated and crashing during link(), the metadata buffer would never have been created, and no corruption would have occurred.

## Why the Confusion Arose

The dead-end claim likely originated from observing that later probes (p165, p167, p169) crashed "at CALLING". But these crashes have a different cause:

| Probe | Approach | Result |
|-------|----------|--------|
| p146 | Worker polling + bait-and-switch | **All 14 strings corrupted** |
| p165 | 400MB heap padding + multi read | Crashed at CALLING |
| p167 | 15+ read primitives + auto retry | Crashed at CALLING |
| p169 | p156 pattern + extraction + retry | 3 attempts, all crashed at CALLING |

The p165/p167/p169 crashes are caused by **memory exhaustion and heap layout failures**, not by VP allocation. The 400MB heap padding, combined with the 38M function compilation (which creates a ~170MB bytecode blob before linking), exceeded available memory. The crash occurs when the LLInt tries to access OOB metadata that lands in unmapped memory -- a heap layout problem, not an allocation problem.

p146 succeeded because its heap groom was modest (~20MB targets + bait-and-switch) and the targets were positioned correctly within the same marge bitfit pages.

## What the OOB Sweep Actually Writes

When the LLInt executes each `op_call`, it accesses the metadata entry via:

```asm
metadata(t5, t0)   # t5 = pointer to this instruction's Metadata struct
loadp OpCall::Metadata::m_callLinkInfo.m_calleeOrCodeBlock[t5], t1
```

For entry #0 (first call site), the metadata is within the buffer (zeroed). The LLInt takes the slow path (null callee check fails), which:

1. Resolves the callee function
2. **Writes** the callee pointer into `m_calleeOrCodeBlock`
3. **Writes** the code block pointer into `u.dataIC.m_codeBlock`
4. **Writes** the entrypoint into `u.dataIC.m_monomorphicCallDestination`
5. **Writes** the return value into `ValueProfile.m_buckets[0]`

For entries past #894, these writes go OOB into adjacent memory. Each write deposits actual **pointer values** (code addresses, heap addresses) into the target memory.

This means the corrupted targets contain:

| Offset in 112-byte entry | Field | Content |
|--------------------------|-------|---------|
| 0-11 | PackedRawSentinelNode | Linked list pointers (heap addresses) |
| 12-15 | m_slowPathCount | Counter (small integer) |
| 16-23 | m_doneLocation | **Code address** (ASLR leak) |
| 24-31 | m_slowPathCallDestination | **Code address** (ASLR leak) |
| 32-47 | u.dataIC | **CodeBlock pointer + entrypoint** |
| 48-55 | m_calleeOrCodeBlock | **JS callee pointer** (heap address) |
| 56-63 | m_lastSeenCalleeOrExecutable | Heap pointer or null |
| 64-71 | bitfields + padding | Flags |
| 72-83 | ArrayProfile | m_lastSeenStructureID + flags |
| 88-95 | ValueProfile.m_buckets[0] | Return value (EncodedJSValue) |
| 96-103 | ValueProfile.m_buckets[1] | Spec fail bucket |
| 104-107 | ValueProfile.m_prediction | SpeculatedType |

Bytes 16-31 and 32-55 contain **code and heap pointers**. These are the ASLR leaks.

## The Actual Remaining Challenge

The overflow works. The problem is **data extraction**: reading the corrupted pointers before the process crashes.

The OOB sweep continues until it hits unmapped memory. In a 4MB marge bitfit page, the sweep can cover:

```
(4MB - 100KB) / 112 = ~36,500 entries
```

After ~37,400 total entries (894 in-buffer + ~36,500 OOB), the sweep reaches the page boundary. If the next page is unmapped, SIGSEGV kills the process.

**BUT**: the Worker thread runs concurrently on a different CPU core. While the main thread is executing call sites 37,000+, the Worker can already observe corruption from call sites 895..37,000.

The window of opportunity:
- ~36,500 OOB entries at ~1 microsecond each (slow path call + metadata write) = ~36 milliseconds
- Worker polling at ~1ms intervals can capture ~36 samples
- Each sample reads string .length or ArrayBuffer data

This is enough for ASLR leak extraction.

## Alternative Opcodes for the Overflow

For completeness, other opcodes with metadata in WebKit-1200:

| Opcode | Metadata stride | Entries for wrap | Feasibility |
|--------|----------------|-----------------|-------------|
| op_call | 112 | 38,348,816 | **Proven on device** |
| op_construct | ~112 | ~38M | Same as call, different callType |
| op_tail_call | ~112 | ~38M | Same as call |
| op_iterator_open | ~200+ | ~21M | Fewer entries needed, complex syntax |
| op_get_by_val | ~48 | ~89M | 2.4x more entries, source too large |
| op_put_by_val | 12 | ~357M | Impractical, too many entries |

op_call remains the best choice. op_iterator_open has a larger stride but requires complex for-of loop syntax that may not scale to millions of entries.

## PROBE SPECIFICATIONS

### PROBE P210: Worker-Based ArrayBuffer Leak Extraction

**Goal**: Extract code/heap pointers from corrupted ArrayBuffer backing stores.

**Strategy**:
1. Worker thread polls ArrayBuffer content via SharedArrayBuffer (or postMessage)
2. Main thread runs bait-and-switch overflow (p146 pattern)
3. Worker extracts pointer bytes from corrupted region before crash

**Implementation**:

```
Step 1: BAIT allocation
  - 60x 100KB ArrayBuffers (fill marge bitfit pages)

Step 2: TARGET allocation  
  - 40x 100KB ArrayBuffers filled with sentinel pattern 0xBB
  - Wrap each in Uint8Array for reading

Step 3: FREE baits (every other one)

Step 4: Worker setup
  - Worker receives target ArrayBuffer references via postMessage
  - Worker polls target[0..N] every 1ms
  - When any byte != 0xBB, worker captures the full 112-byte stride
  - Worker sends captured data via beacon to server

Step 5: COMPILE 38M function (op_call pattern)

Step 6: CALL function
  - Main thread crash expected
  - Worker has already captured data

Step 7: Server parses beacons
  - Extract 8-byte values at offsets 16, 24, 32, 48 within each 112-byte stride
  - These are code addresses and heap pointers
```

**Beacon format**: `P210-LEAK-<target_index>-<offset>-<hex_bytes>`

**Expected output**: WebKit code base address, heap base address, JSGlobalObject pointer.

### PROBE P211: SharedArrayBuffer Cross-Thread Read

**Goal**: If SharedArrayBuffer is available (needs confirmation), use Atomics for zero-copy cross-thread observation.

**Check first**: `typeof SharedArrayBuffer !== 'undefined'`

If available, this is faster than postMessage and provides real-time observation of the corruption as it happens.

### PROBE P212: String CharCode Deep Scan with Worker

**Goal**: Use the p146 Worker approach but extract 8-byte pointer values from corrupted JSString headers.

**Strategy**:
- Target strings placed after metadata buffer
- Worker polls `.length` on each target
- When `.length` changes (corruption detected), Worker reads:
  - String.fromCharCode scan of the first 112 bytes
  - The corrupted m_fiber bytes contain CallLinkInfo data
  - Extract pointer bytes from the corruption pattern

**Key detail**: JSString.m_fiber is at offset 0 of the JSString cell (after the JSCell header). The metadata entry bytes that land on the JSString header depend on alignment. Need to determine the exact offset mapping between metadata entry fields and JSString fields.

### PROBE P213: Controlled Crash with Pre-Crash Beacon

**Goal**: Send extracted data via synchronous XMLHttpRequest BEFORE the crash.

**Strategy**:
- Use a throwing callback: `function() { if (++count === 1000) throw 'STOP'; }`
- 1000 callbacks = 1000 metadata entries written
- Entries 895-999 are OOB (105 entries, ~11.5KB of OOB writes)
- After the throw, execution returns to JavaScript
- Read corrupted targets and send beacons
- No crash because execution stopped before hitting unmapped memory

**Critical calculation**:
- Buffer: ~100KB = 894 entries in-bounds
- Throw at entry 1000: 106 entries OOB = 11,872 bytes of OOB writes
- This covers ~12KB past the buffer end
- Target ArrayBuffers must be within 12KB of the buffer

**Heap groom**: Very tight. Must ensure a target ArrayBuffer backing store is within the first 12KB after the metadata buffer.

**Advantage**: No crash. Full JavaScript execution after the overflow. Can read and beacon at leisure.

### PROBE P214: Incremental Overflow with Multiple Throw Points

**Goal**: Extend P213 by re-calling the function at increasing callback thresholds.

**Key question**: After a throw stops execution mid-function, can the function be called again? If yes, the metadata entries that were already written (0..999) are now populated. On re-call, the LLInt re-executes from entry 0. Entries 0..999 hit the fast path (callee already linked). Entry 1000+ takes the slow path again and writes new OOB entries.

**Strategy**:
1. Call with throw at 1000 -> 106 OOB entries
2. Read corruption, send beacon
3. Call again with throw at 2000 -> 1106 OOB entries total 
4. Read deeper corruption, send beacon
5. Repeat until desired depth reached

**Risk**: Re-calling may re-trigger the slow path for ALL entries if the CallLinkInfo was not properly linked (possible if the throw corrupted the linking state).

### PROBE P215: Void Opcode Baseline (Control)

**Goal**: Confirm that `void a()` uses `op_call` on PS5, not a separate opcode.

**Strategy**:
- Compile function with 100 `void a();` statements
- Compile function with 100 `a();` statements
- Compare blob sizes (should be identical or very close)
- If different, `void` may emit extra bytecodes that change the stride
- Send sizes via beacon

This is a cheap control test to validate the WebKit-1200 source analysis.

## Recommended Priority

1. **P213** (Controlled crash with pre-crash beacon) -- highest value, safest approach
2. **P210** (Worker-based ArrayBuffer extraction) -- proven approach from p146
3. **P214** (Incremental overflow) -- if P213 works, extends the read range
4. **P215** (Void baseline control) -- cheap validation test
5. **P211** (SharedArrayBuffer) -- only if SAB is available
6. **P212** (String deep scan) -- fallback approach
