# RUNTIME-DERIVE — test-plan.md (R3)

Two layers: **R3a offline** (proves the parsers/ladder logic, runs today, no console)
and **R3b console** (the real shot on our 14.20 target; every rung crash-safe, aborts on
failure, wire-visible via `host.py`'s beacon sink). Read with `design.md` (d1-d5) and
`derive-runtime.js`.

---

## R3a — LOCAL / offline (runs now, deterministic)

### a.1 What we built
`runtime-derive/test/mock-run.js` + fixtures (`runtime-derive/test/fixture/`):

```
sh  runtime-derive/test/fixture/build.sh      # gcc builds 3 real ELF64 x86-64 .so
node runtime-derive/test/mock-run.js          # 19/19 assertions
```

Fixtures are **real ELF shared objects** mapped into a synthetic 64-bit space through a
mock `p` that implements the exact `src/utils/mem.js` surface (`read1/2/4/8`):
- `fixture.so` = stand-in `libSceNKWebKit` — ET_DYN/ELF64/LE, **ELF header at vaddr 0**,
  imports `memset` (JUMP_SLOT), `__stack_chk_guard` (GLOB_DAT), `getpid`; all **26 gadget
  patterns** and two **syscall stubs** (`b8 14 0f 05 c3`, `b8 03 0f 05 c3`) planted in `.text`.
- `libc_fixture.so` = stand-in `libSceLibcInternal` — exports `setjmp`/`longjmp`.
- `libk_fixture.so` = stand-in `libkernel` — exports the syscall-wrapper names (d4.2) +
  a syscall-stub-shaped function.

### a.2 What the harness proves (green output above)
| check | method | asserts |
|---|---|---|
| `readRange`/ELF magic | read 4 bytes at base | `7f 45 4c 46` |
| `parseElf` | header @ vaddr 0 | ET_DYN, ≥4 phdrs |
| `findModuleBase` (d1) | interior `.text` ptr → down-walk | returns base |
| `elfDyn` imports (d2) | `.rela.plt` JUMP_SLOT + `.rela.dyn` GLOB_DAT | `memset`, `__stack_chk_guard`, `getpid` matched by **name** |
| `resolveImport` (d2) | poke GOT slot, read back | equals poked target |
| `scanText` (d3) | 26 planted patterns | **all 26 found**, `pop rdi` at the exact planted offset |
| `findSyscallStub` (d4) | `b8 14 0f 05` | found |
| **`run()` end-to-end** | full ladder on 3 modules | wk/libc/libkernel bases + `setjmp` by name + 26 gadgets + 10 syscalls |

It exercises **both** the `DT_RELA` (GLOB_DAT) and `DT_JMPREL` (JUMP_SLOT) relocation paths,
and both symbol-count paths (`DT_HASH` and `DT_GNU_HASH`).

### a.3 Why a full x86-64 emulated WebKit is NOT feasible (and what we use instead)
We cannot "dry-run the real thing" offline because:
1. The ARW primitive is a **heap-shape** exploit (`webkit.js:281-620`): the addresses it
   leaks depend on the live JSC heap groom. No emulator reproduces that without a full
   renderer + JS engine built from the same source at the same revision.
2. The object we parse — `libSceNKWebKit` — **does not exist on this host in any form**
   (no decrypted SELF; `WebKit-1200.zip` is *source*, the PUP is encrypted per
   `B/flashB-final.md`). An emulator with nothing to load proves nothing.
3. `kernel1360-live.bin` (103 MB) is the **kernel** ELF, not the userland module; it has no
   `PT_DYNAMIC`/dynsym (statically linked), so it cannot exercise d2/d4.

So instead of an emulator we ship a **mock-run harness** (§a.1). It is the strongest
offline evidence obtainable: the ELF dialect, relocation kinds and name-matching that the
console will hit are all exercised against real linker output. What the harness *cannot*
prove is listed in §a.4.

### a.4 13.60 expected-value assertions (data-only, no 13.60 lib binary)
The 13.60 offsets table gives invariants we can assert **without the module bytes**, and
which mirror what d2 must reproduce:
- `offsets/13.60.js:61` `syscall_map[0x014]` **==** `SYMBOLS.libkernel.getpid` (`0x0001B860`)
  — i.e. d4's "resolve syscalls by exported name" is the *right* model. (Harness analogue:
  `man.syscalls.GETPID` resolves from the libkernel export table.)
- `offsets/13.60.js:1` host-ctor candidates `[0x56A58,0x56CA0,0x57CE8]` — exactly one yields
  a `%0x4000==0` base in `[0x800000000,0x900000000)` for a given ctor (`main.js:98`). d1
  needs no such table; it reproduces the *same* base by ELF scan. Assert as a property: for a
  page-aligned base B, `B + candidates[i]` are `.text` pointers and `(B+candidates[i]) - B`
  is page-consistent for exactly one candidate.
- `offsets/13.60.js:3-4` import slots `0x3350850`/`0x334E198` sit `0x26B8` apart in `.data`
  — d2 finds both via GOT relocs, not RVAs.
- `syscall_map` RVAs cluster in `[0x1A490,0x1D750]` (~13 KB for ~400 wrappers) — consistent
  with a contiguous stub table; d4's fallback pattern scans for the number, not the RVA.

A guarded "expected" test (skipped unless a real `libSceNKWebKit`/`libkernel_web` blob is
present) lives in the harness: if `runtime-derive/test/real/*` exists, assert derived bases
reproduce any provided reference RVAs; otherwise it prints `SKIP (no module blob)`.

### a.5 Known offline coverage gaps → console-only (→ R3b)
- The **ELF-header-at-base** assumption (d1). The real PS5 payload `shared/elfldr-v0.26.elf`
  has its first `PT_LOAD` at file offset `0x4000` (header **not** mapped in memory); system
  modules are believed to map the header, but only the console confirms it.
  → R3b step 2 is the decisive check.
- `_thread_list` / `worker_wait_return` residual heuristics (d2) — need a live libkernel.
- `C3` adjacency for gadgets in the *real* module (Tier A vs Tier B; elfldr has 815×`C3`
  and 0×`5F C3`) → Tier C self-test runs on-console (R3b step 4).

---

## R3b — CONSOLE LADDER (the real shot; 14.20 target)

Order is fixed; **each rung aborts the whole run on failure** and emits exactly one wire
line. All beacons are `fetch(location.origin + path, {method:"POST"})`; `host.py:340-372`
appends each to `host-beacons.log` with the console's source IP. Nothing here writes to the
console; worst case is a WebProcess reload (renderer), never a kernel touch — this stage is
userland-only (KERNEL-PROBE, `B/kernelprobe-final.md`, runs *after* we pass step 5).

| # | Action (console side) | Wire beacon (`host-beacons.log`) | Abort if | Crash risk |
|---|---|---|---|---|
| 0 | operator serves the variant page; console opens User's Guide | `GET /document/en/ps5/index.html -> 200` UA `PlayStation 5/14.20` (`host.py:249`) | no GET | none |
| 1 | page loads; `establishPrimitive` + `installWindowP` return | `POST /beacon/step0-arp-ready` | no POST ⇒ primitive or page failed | none (ARW already runs today) |
| 2 | **d1** `deriveWebKitBase` | `POST /beacon/step1-wkbase-derived` `{base,span}` | `/gate/halt/🙊<nonce>` like `{rung:"d1"}` ⇒ no `\x7fELF` below `__ps5NativeCtor` (layout risk §a.5) | none |
| 3 | **d2** imports + libc/libkernel | `POST /beacon/step2-dynsym-resolved` `{libc,libkernel}` | `{rung:"d2"}` ⇒ no memset/chk import or module below target | none |
| 4 | **d3** gadget scan + **self-test** (`mov [rdi],rsi` to scratch, read back) | `POST /beacon/step3-gadgets-bound` `{n,selfTest:"ok"}` | `{rung:"d3"}` ⇒ pattern/self-test failed | low: a wrong gadget in the self-test faults only the WebProcess (reload) |
| 5 | **d4** syscalls (names first) + `getpid()` gate | `POST /beacon/step4-syscalls-bound` `{n,pid}` | `{rung:"d4"}` ⇒ syscall unresolved | none (`getpid` is `main.js:267`'s existing gate) |
| 6 | `openListener` binds 9027 (`net.js:70-113`) | `POST /beacon/step5-listener-up` `{port:9027}` — **and** an inbound TCP accept | no beacon / no accept | low-moderate (wrong chain faults WebProcess, not console) |
| 7 | **DEFINITIVE**: from the PC, `python3 tools/send.py <ip> 9027 payloads/<x>.js` succeeds | loader serves the payload; `[HTTP]`/socket log on host | — | — |

**Event names (exact):** `step0-arp-ready`, `step1-wkbase-derived`, `step2-dynsym-resolved`,
`step3-gadgets-bound`, `step4-syscalls-bound`, `step5-listener-up`; failure →
`/gate/halt/🙊<nonce>` with `{rung}`.

**Reload discipline.** The page is served `Cache-Control: no-store` (`host.py:414`), so the
console re-fetches on reload. The operator reloads **once per rung** (or the page self-reloads
after a successful rung via `location.reload()`), so each `host-beacons.log` line is
unambiguous and a mid-run crash is detectable as "step N seen, step N+1 absent, no halt".

**Success = the definitive wire:** we reach step 6 (listener on 9027) using **zero**
`offsets/14.20.js` — the derivation is offsets-agnostic by construction. Any run that gets to
`step5-listener-up` **and** accepts a payload is a working offsetless loader on 14.20.

### b.1 Failure triage from the wire alone (blind, display-off)
| symptom | reading |
|---|---|
| no step0 | page/cert/DNS — not our problem |
| step0 ok, no step1 | `establishPrimitive`/`getPrimitive` failed (ARW) |
| step1 ok, halt `d1` | header not at module base → switch d1 to the fallback (see §a.5) |
| step2 ok, halt `d3` | gadget Tier A/B missed → enable Tier C self-test + widen tail |
| step4 ok, halt `d4` | syscall name absent → enable `findSyscallStub` pattern |
| step5 seen, no accept | 9027 bound but chain weak → ROP/WORKER (d2 residual) issue |
| any step then *silence* | WebProcess reloaded (renderer crash) — read the last step |

---

## R3c — running it
```
# offline (today)
sh   runtime-derive/test/fixture/build.sh
node runtime-derive/test/mock-run.js          # expect: 19 passed, 0 failed

# console (after d5 is applied to a COPY of the tree, never live src/)
#   serve variant page; open User's Guide; read host-beacons.log
```
