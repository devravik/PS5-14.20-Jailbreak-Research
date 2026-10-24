/*
 * runtime-derive/test/mock-run.js  —  offline harness (R3a)
 *
 * Runs derive-runtime.js against REAL ELF64 x86-64 shared objects mapped through a
 * mock p implementing the exact mem.js surface (read1/2/4/8). No console, no
 * WebKit, no firmware tables.
 *
 *   node runtime-derive/test/mock-run.js
 *
 * Fixtures (built by runtime-derive/test/fixture/build.sh):
 *   fixture.so      = stand-in libSceNKWebKit: header at vaddr 0, imports
 *                     memset / __stack_chk_guard / getpid, all 26 gadget patterns
 *                     and two syscall stubs planted in .text.
 *   libc_fixture.so = stand-in libSceLibcInternal: exports setjmp/longjmp.
 *   libk_fixture.so = stand-in libkernel: exports the syscall wrapper names.
 */
"use strict";
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "derive-runtime.js"));
const DR = globalThis.deriveRuntime;
const I = DR._internals;
// minimal int64 shim (mirrors src/utils/int64.js:12-16) so the manifest's
// int64-wrapped addresses are exercised exactly as on the console.
globalThis.int64 = function (low, hi) { this.low = low >>> 0; this.hi = hi >>> 0; };
const addrOf = (v) => (v && typeof v === "object" && "low" in v) ? v.hi * 0x100000000 + v.low : v;

// ---- synthetic address space (map by PT_LOAD vaddr) -----------------------
function Space() { this.regions = []; }
Space.prototype.map = function (base, bytes) {
  const e_phoff = Number(bytes.readBigUInt64LE(0x20));
  const e_phnum = bytes.readUInt16LE(0x38);
  for (let i = 0; i < e_phnum; i++) {
    const o = e_phoff + i * 56, type = bytes.readUInt32LE(o);
    if (type !== 1) continue;
    const off = Number(bytes.readBigUInt64LE(o + 8)), va = Number(bytes.readBigUInt64LE(o + 0x10));
    const fsz = Number(bytes.readBigUInt64LE(o + 0x20)), msz = Number(bytes.readBigUInt64LE(o + 0x28));
    this.regions.push({ lo: base + va, hi: base + va + msz, bytes: bytes.subarray(off, off + fsz) });
  }
};
Space.prototype.poke = function (addr, value) {
  for (const r of this.regions) if (addr >= r.lo && addr < r.hi) {
    const o = addr - r.lo;
    for (let i = 0; i < 8 && o + i < r.bytes.length; i++) r.bytes[o + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    return;
  }
};
Space.prototype.readByte = function (addr) {
  for (const r of this.regions) if (addr >= r.lo && addr < r.hi) {
    const o = addr - r.lo; return o < r.bytes.length ? r.bytes[o] : 0;
  }
  return 0;
};
Space.prototype.p = function () {
  const s = this;
  return {
    read1: (a) => s.readByte(a) & 0xff,
    read2: (a) => (s.readByte(a) | (s.readByte(a + 1) << 8)) & 0xffff,
    read4: (a) => (s.readByte(a) | (s.readByte(a + 1) << 8) | (s.readByte(a + 2) << 16) | (s.readByte(a + 3) << 24)) >>> 0,
    read8: (a) => ({ low: (s.readByte(a) | (s.readByte(a + 1) << 8) | (s.readByte(a + 2) << 16) | (s.readByte(a + 3) << 24)) >>> 0,
                     hi: (s.readByte(a + 4) | (s.readByte(a + 5) << 8) | (s.readByte(a + 6) << 16) | (s.readByte(a + 7) << 24)) >>> 0 }),
  };
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? "  ok   " : "  FAIL ") + n + (x ? "  " + x : "")); };

const FIX = path.join(__dirname, "fixture");
const wkBytes = fs.readFileSync(path.join(FIX, "fixture.so"));
const lcBytes = fs.readFileSync(path.join(FIX, "libc_fixture.so"));
const lkBytes = fs.readFileSync(path.join(FIX, "libk_fixture.so"));

const WK_BASE = 0x800000000, LIBC_BASE = 0x812340000, LK_BASE = 0x820000000;
function firstLoad(bytes) {
  const e_phoff = Number(bytes.readBigUInt64LE(0x20)), e_phnum = bytes.readUInt16LE(0x38);
  for (let i = 0; i < e_phnum; i++) { const o = e_phoff + i * 56; if (bytes.readUInt32LE(o) === 1) return Number(bytes.readBigUInt64LE(o + 0x10)); }
}
const space = new Space();
space.map(WK_BASE, wkBytes); space.map(LIBC_BASE, lcBytes); space.map(LK_BASE, lkBytes);
const p = space.p();

console.log("== fixtures mapped: wk=0x" + WK_BASE.toString(16) + " libc=0x" + LIBC_BASE.toString(16) + " libk=0x" + LK_BASE.toString(16) + " ==");

// (1) header-at-base / readRange
const magic = I.readRange(p, WK_BASE, 4);
ok("readRange reads \\x7fELF at base", magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46);

// (2) parseElf
const wkMod = I.parseElf(p, WK_BASE);
ok("parseElf -> ET_DYN ELF64", !!(wkMod && wkMod.e_type === 3 && wkMod.ph.length >= 4));

// (3) findModuleBase from interior .text
const interior = WK_BASE + 0x1040 + 0x20;   // inside derive_gadget_blob
const found = I.findModuleBase(p, interior);
ok("findModuleBase(interior) == wk base", found && found.base === WK_BASE, "got 0x" + (found ? found.base.toString(16) : "null"));

// (4) elfDyn imports/exports
const dyn = I.elfDyn(p, wkMod);
ok("elfDyn parsed", !!dyn);
ok("import memset matched (JUMP_SLOT)", dyn.imports.memset && dyn.imports.memset.type === 7, "slot=0x" + (dyn.imports.memset && dyn.imports.memset.slot.toString(16)));
ok("import __stack_chk_guard matched (GLOB_DAT)", dyn.imports.__stack_chk_guard && dyn.imports.__stack_chk_guard.type === 6, "slot=0x" + (dyn.imports.__stack_chk_guard && dyn.imports.__stack_chk_guard.slot.toString(16)));
ok("import getpid matched", !!dyn.imports.getpid);

// (5) resolveImport reads the resolved GOT slot
const MEMSET_ADDR = BigInt(LIBC_BASE) + BigInt(firstLoad(lcBytes) + 8);
space.poke(WK_BASE + dyn.imports.memset.slot, MEMSET_ADDR);
const CHK_ADDR = BigInt(LK_BASE) + BigInt(firstLoad(lkBytes) + 8);
space.poke(WK_BASE + dyn.imports.__stack_chk_guard.slot, CHK_ADDR);
const ri = I.resolveImport(p, wkMod, dyn, "memset");
ok("resolveImport(memset) == poked target", ri && ri.addr === Number(MEMSET_ADDR), "0x" + (ri ? ri.addr.toString(16) : "?"));

// (6) gadget scanner finds ALL 26 planted patterns
const g = I.scanText(p, wkMod);
const names = Object.keys(I.GADGETS);
const gmissing = names.filter((n) => !(n in g));
ok("scanText finds all " + names.length + " gadget patterns", gmissing.length === 0, gmissing.length ? "missing=" + gmissing.join(",") : "");
ok("pop rdi gadget at expected offset", g["pop rdi"] === WK_BASE + 0x1040, "0x" + (g["pop rdi"] || 0).toString(16));

// (7) syscall stub fallback
const stub = I.findSyscallStub(p, I.parseElf(p, LK_BASE), 0x14);
ok("findSyscallStub(getpid) in libk", stub != null, stub ? "0x" + stub.toString(16) : "null");

// (8) full ladder end-to-end
(async () => {
  globalThis.__ps5NativeCtor = WK_BASE + 0x1040;
  const man = await DR.run(p);
  ok("run() ok", man && man.ok === true);
  ok("wk base derived", man.wkBaseNum === WK_BASE, "0x" + man.wkBaseNum.toString(16));
  ok("libc base derived", man.libcNum === LIBC_BASE, "0x" + man.libcNum.toString(16));
  ok("libkernel base derived", man.libkernelNum === LK_BASE, "0x" + man.libkernelNum.toString(16));
  ok("setjmp resolved by name", man.libcExports.setjmp === LIBC_BASE + 0x1000, "0x" + (man.libcExports.setjmp || 0).toString(16));
  ok("all 26 gadgets in manifest", Object.keys(man.gadgets).length === names.length, "n=" + Object.keys(man.gadgets).length);
  ok("all 10 syscalls in manifest", ["SOCKET", "SETSOCKOPT", "BIND", "LISTEN", "GETSOCKNAME", "ACCEPT", "READ", "WRITE", "CLOSE", "GETPID"].every((k) => man.syscalls[k] != null));
  ok("getpid syscall resolved by name", addrOf(man.syscalls.GETPID) === LK_BASE + 0x1000, "=0x" + addrOf(man.syscalls.GETPID).toString(16));
  console.log("\n== " + pass + " passed, " + fail + " failed ==");
  process.exit(fail ? 1 : 0);
})();
