# MetadataTable Integer Overflow (Bug 317632 / CVE-2026-64784)

## Summary

`UnlinkedMetadataTable::finalize()` in JavaScriptCore uses an `unsigned` accumulator to compute total metadata buffer size. When a function contains enough op_call bytecodes, the multiplication wraps past 2^32 and the allocator receives a small size while the interpreter writes the full unwrapped amount.

**Status: BLOCKED.** Bug is confirmed real on device. Heap corruption happens. But the 4.29GB forward sweep crashes the process when it runs past mapped memory. No practical way to survive the sweep has been found.

## Overflow Arithmetic

```
N = 38,348,816 op_call instructions
Stride = 112 bytes (OpCall::Metadata, JIT disabled)

38,348,816 x 112 = 4,295,067,392
uint32 max =       4,294,967,296

Wrapped size: 4,295,067,392 - 4,294,967,296 = 100,096 bytes
```

The allocator reserves ~100KB. finishCreation() writes 38.3 million entries at 112 bytes each, totaling 4.29GB forward from the buffer base.

## Source References

| File | Function | Role |
|------|----------|------|
| UnlinkedMetadataTable.cpp:99-164 | finalize() | Wrapping accumulator |
| UnlinkedMetadataTableInlines.h | link() | Allocates wrapped size |
| CodeBlock.cpp:466 | finishCreation() | Iterates all 38M instructions, writes OOB |
| CodeBlock.h:836 | get<Metadata>() | Unbounded pointer arithmetic |
| BytecodeList.rb | OpCall::Metadata | 112-byte stride definition |

## OpCall::Metadata Layout (JIT=OFF, 112 bytes)

```
Offset  Size  Field
0       72    BaselineCallLinkInfo
  0       12    PackedRawSentinelNode (zeros)
  12       4    m_slowPathCount (0xFFFFFFFF when JIT off)
  24       8    m_slowPathCallDestination (thunk address = ASLR leak)
  64       4    bit fields (m_callType = Call(1))
  68       4    m_bytecodeIndex (sequential instruction index)
72      12    ArrayProfile (static_assert sizeof == 12)
84       4    padding
88      24    ValueProfile (m_buckets[2] + m_prediction)
```

Per-entry writes during finishCreation:
- offset+12: m_slowPathCount = 0xFFFFFFFF
- offset+24: m_slowPathCallDestination = getCTILinkCall().code() (code pointer, same for all entries)
- offset+64: m_callType = 1
- offset+68: m_bytecodeIndex = sequential counter (0, 1, 2, ...)

## What Happens on Device

1. JavaScript builds a function with 38,348,816 `a()` calls via Blob URL
2. Script tag load triggers parse + compile
3. finishCreation() runs during CodeBlock construction (not when function is called)
4. Sweep writes 4.29GB forward from the ~100KB metadata buffer
5. MADV_FREE preserves virtual mappings for recently freed pages, so the sweep passes through freed allocations without immediate SIGSEGV
6. Eventually the sweep exits all mapped virtual memory and the process crashes

## Why It Cannot Be Survived

1. **finishCreation() has no early exit.** The loop iterates the entire instruction stream unconditionally. There is no check, no exception, no callback. Verified in CodeBlock.cpp:466-730.

2. **Sweep distance is structural.** 4,294,967,296 bytes regardless of N or stride (it is exactly 2^32 because that is the wraparound point).

3. **Maximum working spray: ~240MB.** 2400 ArrayBuffer objects (100KB each) is the most the PS5 can allocate while still leaving enough memory for blob creation and compilation. This covers less than 6% of sweep distance.

4. **Multi-wave spray does not extend VM.** The allocator reuses freed virtual address slots. Spraying 3x5000 buffers in waves does not create 3x the virtual mapping.

5. **5000+ buffers causes OOM during compilation.** MADV_FREE pages are not reclaimed fast enough by the FreeBSD kernel when ~500MB of freed pages coexist with 146MB blob creation.

## Device Test History

| Probe | Strategy | Result |
|-------|----------|--------|
| p142 | Direct call after spray | COMPILED-OK, CALLING, then SIGSEGV |
| p143 | Targets before metadata | No corruption (forward-only sweep) |
| p144 | Bait-and-switch: targets above metadata | Forward write confirmed |
| p146 | Worker .length polling | All 14 strings corrupted, .length=81400 |
| p147 | Substring views | StringImpl data intact, JSString.m_fiber corrupted |
| p148 | Main-thread targets | 14 JSCORRUPT, 0 LEAKED |
| p149g | Read after compile, before call | ZERO corruption (compile-time, not call-time) |
| p150a | Throwing callback | Crash: OOB metadata read dereferences garbage |
| p150g | 400 targets + 2000 padding, call | CALLING then silence (240MB not enough) |
| p150h | Spray until OOM | Crash loop, process killed before JS catch |
| p150i | 3 waves of 5000 buffers | OOM during blob creation (1.4GB MADV_FREE pressure) |
| p150j | Single wave 8000 buffers | OOM during blob creation (764MB too much) |
| p150k | Single wave 5000 + heavy GC | OOM during blob creation (477MB still too much) |

## Allocator Details

- MetadataTableMalloc = FastMalloc (not IsoHeap). Source: DebugHeap.h:91-92
- ArrayBuffer backing stores = FastMalloc (Gigacage disabled on FreeBSD). Source: Gigacage.cpp:37-39
- Both route through libpas bmalloc, same allocator namespace
- ~100KB allocations land in marge bitfit tier (4MB pages). Source: pas_internal_config.h
- MADV_FREE decommit preserves virtual mappings. Source: pas_page_malloc.c:261
- BUSE_RELEASE_LARGE_FREE=0: large freed blocks stay mapped. Source: BPlatform.h:362
