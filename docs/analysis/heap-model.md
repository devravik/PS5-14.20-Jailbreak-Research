# Heap Model

PS5 14.20 WebKit heap behavior, validated against WebKit-1200 source and device tests.

## Allocator: libpas (bmalloc)

The PS5 WebView uses libpas as the backing allocator for FastMalloc. Configuration from source:

| Setting | Value | Source |
|---------|-------|--------|
| BENABLE_LIBPAS | 1 | BPlatform.h:341 |
| Gigacage | DISABLED (FreeBSD not in Darwin/Linux gate) | GigacageConfig.h |
| BUSE_RELEASE_LARGE_FREE | 0 (large freed blocks stay mapped) | BPlatform.h:362 |
| Decommit method | madvise(MADV_FREE) | pas_page_malloc.c:261 |
| Marge bitfit page size | 4MB (shift=22) | pas_internal_config.h |

## Key Implications

### Gigacage Disabled
ArrayBuffer backing stores and JSC internal objects share the same FastMalloc heap. No address space isolation between user-controlled data and interpreter metadata. This means a heap corruption primitive can reach ArrayBuffer contents from JSC allocations and vice versa.

### MADV_FREE Behavior
When memory is freed, libpas calls madvise(MADV_FREE). This tells the FreeBSD kernel the pages can be reclaimed, but the virtual mapping stays alive. The kernel reclaims the physical pages only under memory pressure.

Impact on exploitation:
- Freed pages remain accessible (no SIGSEGV on access)
- The MetadataTable sweep can write through freed regions without crashing
- But: reclamation is not fast enough when 500MB+ is freed before a 146MB compilation

### Memory Limits (Validated on Device)

| Test | Spray Size | Result |
|------|-----------|--------|
| 2400 buffers x 100KB | 240MB | Compilation succeeds |
| 5000 buffers x 100KB | 477MB | OOM during blob creation |
| 8000 buffers x 100KB | 764MB | OOM during blob creation |
| 3 waves of 5000 | ~1.5GB virtual (estimated) | OOM during blob creation |

Process kill threshold is approximately 500MB of live allocations. The 146MB blob + bytecode compilation needs headroom.

## Allocation Tiers

| Size Range | Tier | Behavior |
|------------|------|----------|
| 0-400 bytes | Segregated | Size class isolation, per-page free lists |
| 400 bytes - 4MB | Marge bitfit | 4MB pages, first-fit in page |
| >4MB | Large | Direct mmap, no reuse (BUSE_RELEASE_LARGE_FREE=0) |

The ~100KB MetadataTable allocation lands in marge bitfit. ArrayBuffer backing stores of 100KB also land in marge bitfit. JSString cells (MarkedSpace) go through MarkedBlock which uses tryFastAlignedMalloc (also through bmalloc).

## Heap Layout Ordering

Allocations in the same marge page are placed in address order. Within a marge bitfit page:
- First allocation at page base
- Next allocation above it
- Free slots are reused (first fit within page)

This is why the bait-and-switch strategy works: allocate baits to claim slots, allocate targets above them, free baits, and the metadata buffer fills a freed bait slot with targets at higher addresses.
