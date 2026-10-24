# RUNTIME-DERIVE — design.md

Offsetless, runtime-derived loader variant for our 14.20 console.
Derives every userland constant **in runtime** through the WebKit ARW primitive
instead of the static `offsets/<fw>.js` tables. Nothing here is firmware-specific.

Every claim carries a `path:line` into a tree that exists locally **right now**:
- `L` = `/home/violence/Work/ps5-lan-research/ps5-webkit-remote-loader`
- `W` = `/home/violence/Work/ps5-lan-research/14.20-bid/wk1200-source/WebKit-1200`
- `B` = `/home/violence/Work/ps5-lan-research/14.20-bid`

> Status legend: **[DERIVED]** = fully runtime, no table · **[DERIVED+VALIDATE]** = runtime
> but the heuristic needs one console confirmation · **[RESIDUAL]** = not derivable by our
> method today, keep a static candidate + plausibility gate, halt cleanly if it fails.

---

## 0. What actually breaks on 14.20 (ground truth, not assumption)

`L/src/main.js:92-127` and `L/src/site.js:156-168` derive four things from the static
table and nothing else:

| # | Static input | File:line | Why it kills 14.20 |
|---|---|---|---|
| A | `OFFSET_wk_host_constructor_candidates` | `L/src/main.js:95-105`, `L/src/site.js:161-166` | `base = __ps5NativeCtor − offset`; the offset is per-build. 10.40 = `[0x2C00,0x5178,0x5690]` (`L/offsets/10.40.js:1`), 13.60 = `[0x56A58,0x56CA0,0x57CE8]` (`L/offsets/13.60.js:1`). Off by any byte → `main.js:105` throws and **the whole chain dies silently** (renderer reload; no wire signal — exactly the observed failure). |
| B | `OFFSET_wk_memset_import` + `OFFSET_lc_memset` | `L/src/main.js:109-112` | GOT-slot RVA + symbol RVA in libc. Both per-build. |
| C | `OFFSET_wk___stack_chk_guard_import` + `OFFSET_lk___stack_chk_guard` | `L/src/main.js:114-117` | GOT-slot RVA + libkernel data RVA. Both per-build. |
| D | `wk_gadgetmap`, `syscall_map` | `L/src/main.js:119-127` | 26 gadget RVAs + ~400 syscall-stub RVAs, all per-build. |

**The primitive itself is not the problem.** `L/src/webkit.js:60-62` gates only on
`/PlayStation 5\/[0-8]\./`; a 14.20 console takes the modern path. `establishPrimitive`
(`webkit.js:710`), the corrupted-view validation (`webkit.js:466-581`) and the leak emit
(`webkit.js:673-681`) are version-agnostic. Once `site.js:148` returns,
`L/src/utils/mem.js:199-218` gives us `p.read1/2/4/8` over the whole renderer address
space. **Everything below is written against that API only.**

### 0.1 The anchor we start from
`webkit.js:522` sets `globalThis.__ps5NativeCtor = nativeInfo.nativeConstructor`, where
`nativeInfo` is read from a `NativeExecutable` at offset `0x30` (`webkit.js:442,454`).
In engine terms (`W/Source/JavaScriptCore/runtime/NativeExecutable.h:98-99`) that field is
`TaggedNativeFunction m_constructor` — **a raw C++ function pointer into the module's
`.text`**. For the leaked `parseInt` object it is the default host constructor:
`W/Source/JavaScriptCore/runtime/JSGlobalObject.cpp:1011-1015` creates `parseInt` with
`JSFunction::create(..., globalFuncParseInt, Public, ParseIntIntrinsic)` and no explicit
`nativeConstructor`, so the default applies:
`W/Source/JavaScriptCore/runtime/JSFunction.h:52` / `JSFunction.cpp:89-92` →
`callHostFunctionAsConstructor`. So the anchor is a `.text` pointer **and we even know
its name**. That single fact turns A from a table lookup into an ELF scan.

---

## d1. WebKit base discovery — leak → ELF header  **[DERIVED]**

**Leak that yields a module pointer:** the *only* module (`.text`) pointers the harness
emits are `native_function`, `native_constructor` (`webkit.js:680-681`) — and
`native_constructor` is exactly `__ps5NativeCtor`. The other leaks —
`leak_addr`, `host_addr`, `holder_addr`, `fake_addr` (`:673-676`) — are **heap** (JSC
GC) addresses, useful for the ROP arena but *not* module bases; `function_addr`,
`executable_addr` (`:678-679`) are also JSCells. So d1 consumes `native_constructor`,
with `native_function` as a second probe.

**Algorithm** (all addresses are JS numbers; module space is `< 2^48`, exact in a double):

1. Take `ptr = __ps5NativeCtor` (or the `native_constructor` emit).
2. `a = ptr & ~0x3FFF` (16 KiB page — PS5 page size; matches the `% 0x4000` gate at
   `main.js:98`).
3. Walk **down** `a -= 0x4000`, reading a u32 at each page, until it equals
   `"\x7fELF"` little-endian (`0x464C457F`), bounded by `MAX_MODULE_SPAN = 0x10000000`.
4. **Validate** the hit: `parseElf` must see `e_ident[EI_CLASS]=2` (ELF64),
   `EI_DATA=1` (LE), `e_type=3` (ET_DYN), and `ptr` must fall inside some `PT_LOAD`
   `[base+vaddr, base+vaddr+memsz)`. If not, keep walking (defends against a stray
   `\x7fELF` inside `.rodata`).
5. Return `base`.

Why down-walking is correct: the pointer lives inside one contiguous mapping; no
smaller module can be mapped *within* that range, so the first page-aligned ELF header
at or below `ptr` is that module's base.

**Byte-level read wrapper** (`derive-runtime.js: readRange`): `p.read8` in 8-byte steps
packing into a `Uint8Array`, tail with `read4`/`read2`/`read1`. Cost is
Θ(len/8) `selectAddress`+`resetAddress` pairs (`mem.js:90-98,128-135` — each `read8`
does a 2-write set/reset of the corrupted view vector). **Mitigation:** never scan bytes
one at a time; the down-walk uses a single `read4` per page; every structural parse
reads only headers; the one big read (`.text` snapshot, d3) is capped and done once.

**[RESIDUAL] Note:** if the module is mapped with the ELF header *not* present at base
(some SELF layouts strip the first page), step 4's `PT_LOAD` validation fails and the
ladder halts at rung d1 with a beacon rather than proceeding on a wrong base. See
test-plan §3 ladder step 2.

---

## d2. Symbol resolution at runtime — walk GOT + dynsym  **[DERIVED]**

Replace B and C, and resolve every internal function the chain needs by **name**.

**ELF dynamic structures** (all parsed from the in-memory image, offsets are numbers):
`e_phoff @ 0x20`, `e_phentsize @ 0x36`, `e_phnum @ 0x38`; `PT_DYNAMIC=2` (`p_type@0`,
`p_vaddr@0x10`, `p_memsz@0x28`). `.dynamic` entries are `{d_tag:u64, d_val:u64}`:
`DT_SYMTAB=6`, `DT_STRTAB=5`, `DT_STRSZ=10`, `DT_SYMENT=11`, `DT_RELA=7`,
`DT_RELASZ=8`, `DT_RELAENT=9`, `DT_JMPREL=23`, `DT_PLTRELSZ=2`, `DT_HASH=4`,
`DT_GNU_HASH=0x6ffffef5`. All `d_val`s are vaddrs → absolute `= base + val`.

`Elf64_Sym` = 24 B: `st_name@0`, `st_info@4`, `st_shndx@6`, `st_value@8`.
`Elf64_Rela` = 24 B: `r_offset@0`, `r_info@8` (`sym = r_info>>32`, `type = r_info&0xffffffff`),
`r_addend@16`.

**Procedure**
1. `elfDyn(p, wk)` → build `imports: name → {slot, type}` from the relocs whose symbol is
   `SHN_UNDEF` (`st_shndx==0`), and `exports: name → value` from relocs/symbols with
   `st_shndx!=0`. Handle both `DT_RELA` (R_X86_64_GLOB_DAT=6, R_X86_64_64=1) and
   `DT_JMPREL` (R_X86_64_JUMP_SLOT=7).
2. `memsetSlot = wk.imports.get("memset")`; `libcMemsetAddr = p.read8(wk.base + memsetSlot.slot)`
   → **the loader has already written the resolved address there** (dynamic relocations run
   before our JS). Then `libc = findModuleBase(p, libcMemsetAddr)`.
3. `chkSlot = wk.imports.get("__stack_chk_guard")`;
   `libkChkAddr = p.read8(wk.base + chkSlot.slot)` → `libkernel = findModuleBase(p, libkChkAddr)`.
4. Resolve remaining symbols **by name, in the derived module's own dynsym**:
   - libc: `setjmp`, `longjmp` (used at `main.js:193,204,220`).
   - libkernel: `pthread_create`, `pthread_join`, `pthread_exit`, `sleep`,
     `sceKernelGetCurrentCpu`, and the syscall wrappers (d4).

This removes `OFFSET_wk_memset_import`, `OFFSET_lc_memset`,
`OFFSET_wk___stack_chk_guard_import`, `OFFSET_lk___stack_chk_guard` **entirely** — no
libc/kernel base math at all, just "read the GOT slot the linker already filled, then
ELF-scan down."

**Cross-check heuristic — "N consecutive import PLTs".** An x86-64 PLT stub is
`FF 25 <rel32>` (`jmp qword ptr [rip+rel32]`); a run of ≥4 of them at regular stride is
the module's PLT. Implemented as `findPltRun(p, mod, 4)`; used to (a) confirm `wk` really
is a dynamically-linked module, (b) cross-check that the resolved import addresses land in
the *target* modules we expect. It is a consistency check, not a derivation source.

### 2.1 What the tree actually gives us to match (the mission's `.exp` premise is FALSE)
The mission asked to grep `Configurations/export-*.exp` for `memset`/`__stack_chk_guard`.
**Those files do not exist for PlayStation.** The only `.exp` files in the whole drop are
`W/Source/WebKitLegacy/{mac,ios}/...exp` (Apple Obj-C legacy) plus
`W/Source/ThirdParty/libwebrtc/Configurations/libwebrtc.exp`; grepping all of them for
`memset` / `stack_chk` returns **nothing**. There is no PlayStation export list in the
drop. The export surface is defined by CMake + visibility, not `.exp`:

- `W/Source/cmake/OptionsPlayStation.cmake:415-421` → **`WebKit_LIBRARY_TYPE SHARED`**,
  WTF/bmalloc/PAL/WebCore are `OBJECT` "to emulate `--whole-archive`" (`:402`). So
  `libSceNKWebKit` *is* a shared ELF with a real dynsym.
- `W/Source/cmake/OptionsPlayStation.cmake:427` → **`add_definitions(-fstack-protector-strong)`**
  — this is *why* `__stack_chk_guard` is an import at all.
- `W/Source/WTF/wtf/ExportMacros.h:61-67` → `WTF_EXPORT_PRIVATE` = default visibility when
  building the lib ⇒ exported symbols appear in dynsym.
- `W/Source/JavaScriptCore/unexported-libc++.txt:1-30` → Itanium-mangling unexport rules
  for `std::` — i.e. the mechanism is symbol visibility, and libc++ symbols are
  *deliberately hidden*. Nothing here names `memset` either.

**REAL names we can match at runtime, sourced from the tree:**
- `callHostFunctionAsConstructor` — `W/Source/JavaScriptCore/runtime/JSFunction.h:52`
  (`JS_EXPORT_PRIVATE JSC_DECLARE_HOST_FUNCTION(...)`), body `JSFunction.cpp`. This is the
  identity of `__ps5NativeCtor` (see §0.1). Its presence in `wk.dynsym` with
  `value == ctor − base` is a free **verification** of d1.
- WebCore generated binding constructors: `W/Source/WebCore/bindings/scripts/CodeGeneratorJS.pm:3497,4468`
  emit `js<Interface>Constructor` getters (`js" . $interfaceName . "Constructor`), and
  `:1934-1935` emit `WK_lcfirst($className) . "Constructor"` / `... . Mangle... . "Constructor"`.
- Imported C names the loader depends on (present in the *fixture* module, see §R3):
  `getpid, puts, __error, strerror, printf, malloc, memcpy, free, kqueue, rfork_thread,
  kevent, waitpid, close, kill, open, execve, strlen, sysctl, strcmp, recv, realloc,
  memset, vsnprintf, sceKernelSendNotificationRequest` — verified byte-for-byte in
  `L/shared/elfldr-ps5-v0.26.elf`'s `.strtab` (see §R3; that is a *sibling PS5 ELF*, not
  libSceNKWebKit, but it proves both the naming convention and our parser).
- Compiler-emitted `__stack_chk_guard` (from `-fstack-protector-strong`, above). Not a
  source symbol; it is whatever the linker records, which is exactly why we match it by
  the dynstr string, not by an RVA.

**[DERIVED+VALIDATE]** `_thread_list` and `worker_wait_return` (`main.js:18,40,56`) are
**local** libkernel symbols: they have no import slot, so d2 cannot reach them by name.
Two runtime substitutes, in priority order:
1. *Structural scan of libkernel's writable `PT_LOAD`*: find a qword `H` such that
   `p.read8(H)` is a plausible pointer to a node whose `+0xb0 == 0x80000` and `+0xa8` is a
   plausible stack (the exact `pthread` layout the loader already trusts at
   `main.js:11-12`). That node chain *is* `_thread_list`.
2. *Worker-return by fingerprint inversion*: instead of "find the stack that contains
   `kbase+OFFSET`" (`main.js:40-53`), *snapshot* each plausible `0x80000` stack
   (`main.js:20-35` already enumerates them) and select the return address that recurs
   across worker stacks and lands in libkernel `.text` — that recurring address *is*
   `worker_wait_return`. Bounded, read-only, no writes.
If neither yields a unique answer → **halt d2** (never guess a stack pivot site).

---

## d3. Gadget scanning at runtime — pattern from the gadget's *name*  **[DERIVED+VALIDATE]**

### 3.1 Correction: `wk_gadgetmap` values are RVAs, not byte encodings
The mission states the values are "byte-level instruction encodings". They are not. Proof:
`"pop rax"` is `0x00045B53` in 10.40 (`L/offsets/10.40.js:27`) but `0x0003C98E` in 13.60
(`L/offsets/13.60.js:27`); `"ret"` is `0xC7` vs `0xC7` but `"pop rdi"` is `0x5FC4E` vs
`0x288B2`. Byte encodings are build-invariant; these differ per build ⇒ they are
`base + rva` targets, consumed verbatim as `libSceNKWebKitBase.add32(wk_gadgetmap[g])` at
`L/src/main.js:123`. So the byte patterns must be derived **from the gadget names**
(canonical x86-64), and the scanner must find them in `.text`.

### 3.2 Patterns (canonical, little-endian) + usability suffix
For ROP a gadget must return: after the instruction the stack must be popped. So each
scanned pattern is `core` **followed by `C3`** (`ret`), except `ret`/`infloop`.

| gadget | core bytes | tight gadget | notes |
|---|---|---|---|
| ret | `C3` | `C3` | |
| pop rdi | `5F` | `5F C3` | |
| pop rsi | `5E` | `5E C3` | |
| pop rdx | `5A` | `5A C3` | |
| pop rcx | `59` | `59 C3` | |
| pop rax | `58` | `58 C3` | |
| pop rsp | `5C` | `5C C3` | pivot |
| pop r8 | `41 58` | `41 58 C3` | |
| pop r9 | `41 59` | `41 59 C3` | |
| mov [rdi], rsi | `48 89 37` | `48 89 37 C3` | write-8 |
| mov [rdi], rax | `48 89 07` | `48 89 07 C3` | write-result |
| mov [rdi], eax | `89 07` | `89 07 C3` | |
| mov rax, [rax] | `48 8B 00` | `48 8B 00 C3` | |
| add rax, rcx | `48 01 C8` | `48 01 C8 C3` | |
| cmp [rcx], eax | `39 01` | `39 01 C3` | |
| inc dword [rax] | `FF 00` | `FF 00 C3` | |
| seta al | `0F 97 C0` | `0F 97 C0 C3` | |
| setb al | `0F 92 C0` | `0F 92 C0 C3` | |
| sete al | `0F 94 C0` | `0F 94 C0 C3` | |
| setg al | `0F 9F C0` | `0F 9F C0 C3` | |
| setl al | `0F 9C C0` | `0F 9C C0 C3` | |
| shl rax, 3 | `48 C1 E0 03` | `... C3` | |
| shl rax, 4 | `48 C1 E0 04` | `... C3` | |
| shr rax, 3 | `48 C1 E8 03` | `... C3` | |
| shr rax, 4 | `48 C1 E8 04` | `... C3` | |
| infloop | `EB FE` | `EB FE` | `jmp $` |

Do **not** require the pattern to be 16-byte aligned; scan at every byte offset.
`mov [rdi], eax` core `89 07` is a substring of `mov [rdi], rax` core `48 89 07`; the
scanner takes the tight match and records the instruction start (for `mov [rdi], rdi`-style
ambiguity we keep the longest tight match first).

### 3.3 Why "tight" and the mandatory self-test
An offline check of the sibling fixture `L/shared/elfldr-ps5-v0.26.elf` shows its `.text`
has **815× `C3` but 0× `5F C3`, 0× `5E C3`, 0× `48 89 37 C3`, 0× `EB FE`.** So adjacency
is *not* guaranteed structurally — a small program simply lacks the sequences. A 50 MB
WebKit `.text` will contain thousands of tight gadgets, but we cannot prove that offline
without the module. Therefore:
- **Tier A** (preferred): tight `core+C3`.
- **Tier B** (fallback): `core` + forward scan ≤ 16 bytes to the first `C3`, rejecting the
  candidate if a control-flow instruction (`E8 E9 EB FF`, `0F 8x`, `C3`) is met first.
- **Tier C** (mandatory, runtime): **gadget self-test.** Before trusting the ROP chain,
  execute one `mov [rdi], rsi` to a known scratch (the `malloc` arena at
  `main.js:131-141`) and read it back with `p.read8`. If it does not land, halt d3. This is
  version-agnostic and is the only thing that *proves* a gadget, as opposed to finding one.

**Scan implementation:** snapshot the executable `PT_LOAD` (`p_flags & 1`) with `readRange`
once, capped at `TEXT_CAP = 0x3000000` (48 MB — covers the largest gadget RVA observed,
`0x1D61EE3` in 10.40 / `0x2CBBE87` is 13.60's `cmp`, both < 48 MB), then search all
patterns in a single JS pass over the buffer (Aho-Corasick-lite: index by first byte).
One `readRange` of 48 MB ≈ 6M `read8` calls; acceptable one-shot. **[DERIVED+VALIDATE]**

---

## d4. Syscall-stub discovery — names first, pattern second  **[DERIVED+VALIDATE]**

### 4.1 The key local evidence
`L/offsets/13.60.js:61` gives `syscall_map[0x014] = 0x0001B860`. `L/offsets/13.60.js`
`SYMBOLS.libkernel.getpid = 0x0001B860`. **They are the same value.** `0x014` is
`SYS_GETPID` (`L/src/utils/syscalls.js:14`). Therefore the `syscall_map` entries are the
**exported libkernel symbols** for each syscall, and we can resolve them by *name* in
libkernel's dynsym — no scanning needed for the syscalls the loader actually uses.

### 4.2 Names for the loader's syscalls (`L/src/net.js:8-19`)
`socket, setsockopt, bind, listen, getsockname, accept, read, write, close, getpid`
(and `sysctlbyname` / `pthread_*` for kexp at `L/src/loader.js:60-63`, `kexp.js:34`).
Primary path: `libkernelElf.exports.get(name)`. These are standard FreeBSD/libc names, so
the dynstr match is robust.

### 4.3 Pattern fallback (for names that are absent)
The task's premise is a `mov eax,imm; mov r10,imm; syscall` stub. That is the **Linux**
ABI (glibc's `syscall()` copies arg4 into `r10`). PS5/FreeBSD x86-64 uses `r10` as the
native 4th argument, so the generated wrapper is the shorter:

```
B8 <imm32 LE>    ; mov eax, <sysno>
0F 05            ; syscall
C3               ; ret        (tight variant; may carry an error branch)
```

Scanner `findSyscallStub(p, libk, nr)`: find first `B8 <nr LE> 0F 05` in libkernel's
executable `PT_LOAD`; prefer the occurrence followed by `C3`; accept a `73`/`72` branch
(`jae`/`jb`) after `0F 05` as an error-handling variant. **We do NOT have a 13.60
libkernel_web binary to byte-verify** (`kernel1360-live.bin` is the *kernel* ELF, not the
userland module). So this pattern is derived theoretically from upstream FreeBSD
`sys/amd64/amd64/support.S` (`syscall()` uses `rax`=sysno, `rdi/rsi/rdx/r10/r8/r9`) and
matches what PS4-scene tooling assumed (systools/ps4-payload-sdk-style "libkernel syscall
thunks are `mov eax,imm32; syscall; ret`"). **Marked [DERIVED+VALIDATE]: validated on the
console by the rung-4 gating syscall (`getpid`) returning our pid; if the pattern misses,
the ladder halts rather than running a wrong stub.** External citations, not local
`file:line` (no such file in the trees).

---

## d5. Integration — exact call sites and a fail-closed switch

New module `runtime-derive/derive-runtime.js` (classic script, defines `window.deriveRuntime`,
mirrors `L/src/rop.js`/`main.js` style; no imports). It is **never** loaded by the live
`index.html` yet — this is the variant.

Proposed edit list (do **not** apply yet; live `src/` is untouched):

| Site | Today | Variant |
|---|---|---|
| `L/src/site.js:156-168` `getWebKitBase()` | static candidates | `return (await deriveRuntime.deriveWebKitBase(p, {ctor})).baseNum` — keep the static branch only behind `?static=1`. |
| `L/src/site.js:216-220` | logs WebKit base | unchanged; now logs a **derived** base. |
| `L/src/main.js:92-105` `prepareRop()` base block | candidates loop | `const { base, baseI64 } = await deriveRuntime.deriveWebKitBase(p, { ctor: globalThis.__ps5NativeCtor });` |
| `L/src/main.js:109-117` | read 2 GOT slots, subtract 2 RVAs | `const { libc, libkernel } = await deriveRuntime.deriveDependencies(p, base);` |
| `L/src/main.js:119-127` | loop over `wk_gadgetmap` / `syscall_map` | `const { gadgets, syscalls } = await deriveRuntime.deriveCode(p, base, libkernel);` |
| `L/src/main.js:18,40,56` | `OFFSET_lk__thread_list`, `_worker_wait_return` | consume `deps.threadList` / `deps.workerWaitReturn` from the d2 residual heuristics (halt if unresolved). |
| `L/src/main.js:193,204,220` | `libcBase + OFFSET_lc_setjmp/longjmp` | `deps.libcExports.setjmp` / `.longjmp`. |
| `L/src/main.js:257-260` runtime object | unchanged shape | still exposes `libSceLibcInternalBase`, `libKernelBase`, `gadgets`, `syscalls` → `rop.js:15-16` and `loader.js:269-273` need **zero** change. |
| `L/src/loader.js:58-70` `xotextRanges()` | uses `p.libSceNKWebKitBase` | unchanged. |
| `L/index.html:102-106` | 4 scripts + module | variant page adds `<script src="./runtime-derive/derive-runtime.js">` before `main.js`. |

**Fail-closed contract.** `deriveRuntime.run(p, { signal })` returns a manifest
`{ ok, wkBase, libc, libkernel, gadgets, syscalls, threadList, workerWaitReturn, exported }`
or throws `DerivationError{rung, detail}`. On any `DerivationError` the variant:
1. POSTs `fetch(location.origin + "/gate/halt/🙊" + NONCE, {method:"POST", body})` —
   the **halt saying** (the mission's `/gate/halt/🙊<nonce>` wire);
2. POSTs one per-rung **progress saying** `STEP<n> <name>` on entry to each rung
   (wire: `/beacon/step1-wkbase-derived`, `/beacon/step2-dynsym-resolved`,
   `/beacon/step3-gadgets-bound`, `/beacon/step4-syscalls-bound`);
3. **stops** — never proceeds to `makeRopWorker()` on a partially-derived table.

The "four sayings" are formalized here as the four fail-closed rungs (d1 wkbase, d2
dynsym, d3 gadgets, d4 syscalls); I could not find the earlier artifact on disk
(grepped all of `/home/violence` for `gate/halt` / `sayings` — nothing), so the variant
defines them explicitly and marks each with the `🙊` halt beacon plus a nonce so a
mid-run reload is distinguishable.

---

## 0.2 Dependency of this design on sibling legs
`B/kernelprobe-final.md:3-7` states the KERNEL-PROBE ladder "runs AFTER RUNTIME-DERIVE
userland stage succeeds". d5 therefore produces exactly the userland
`p`/`chain`/`gadgets`/`syscalls` that `kernelprobe` rung 1 expects, and halts *before*
any kernel-touching syscall if derivation fails. The two legs do not overlap.
