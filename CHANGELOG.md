# Changelog

## Oct 22-23 -- ASLR Defeat Work
- APNG overread leaks 1651 heap pointers on device (V674)
- Heap topology mapping via binary subdivision scanner (V650-V655)
- DAZ confirmed ON -- all float64 channels flush denormals to zero
- BigUint64Array confirmed as bypass for raw pointer handling

## Oct 21-22 -- Full R/W Confirmed
- All 12 Canvas2D APIs confirmed working through alias (V630)
- Crash oracle working -- forge m_stateStack, lineWidth reads 8B at target
- 10+ info leak approaches exhausted (AB zero-init, freed memory, butterfly, etc.)
- OOB state stack read designed as info leak candidate

## Oct 20-21 -- Canvas UAF Breakthrough
- CVE-2026-43720 Canvas getContext() UAF confirmed LIVE on PS5
- IsoHeap is OFF on PlayStation (WTF_MAKE_ISO_ALLOCATED = FastMalloc)
- Same-type reclaim CONFIRMED on device (V573) -- bidirectional R/W
- Full alias diagnostic V562 -- all 12 APIs pass

## Oct 18-19 -- Surface Audit + New Bugs
- CSSFontFace UAF (CVE-2026-43715) confirmed DoS-only (Timer RELEASE_ASSERT)
- tee() type confusion and private-name inversion confirmed but contained (JS builtin wall)
- WK-1400 source audit complete -- 15+ subsystems, 0 exploitable entry bugs
- PLATFORM(PLAYSTATION) audit -- 22 guards, all logging-only or stricter

## Oct 17-18 -- MetadataTable Declared DEAD
- 38M entries x 104B/node = 3.7GB AST exceeds 1200MB process limit
- .length=81400 confirmed as false positive (correct literal length)
- All Relapse CVEs confirmed patched on 14.20
- Pivot to broad surface audit

## Oct 15-16 -- MetadataTable Discovery
- Bug 317632 integer overflow discovered and confirmed on device
- Correct stride 112 bytes (p142)
- Forward-only sweep directionality proven (p143/p144)
- Bait-and-switch heap groom demonstrated
- JSString header corruption confirmed (14/14 targets, p146)
