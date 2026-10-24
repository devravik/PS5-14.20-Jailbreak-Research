/* runtime-derive/test/fixture/fixture.c
 * Offline ELF fixture for the derivation harness. Builds an ET_DYN ELF64 LE
 * shared object (header at vaddr 0, like a decrypted PS5 system module) that
 * (a) imports memset/getpid (GOT + .rela.dyn/.rela.plt), and
 * (b) plants every gadget byte-pattern design.md d3.2 scans for, plus two
 *     syscall-stub-shaped sequences. Nothing firmware-specific.
 */
extern int  getpid(void);
extern void *memset(void *, int, unsigned long);

__asm__(
    ".text\n"
    ".align 16\n"
    ".globl derive_gadget_blob\n"
    ".type derive_gadget_blob,@function\n"
    "derive_gadget_blob:\n"
    "  pop %rdi; ret\n"          /* 5f c3            */
    "  pop %rsi; ret\n"          /* 5e c3            */
    "  pop %rdx; ret\n"          /* 5a c3            */
    "  pop %rcx; ret\n"          /* 59 c3            */
    "  pop %rax; ret\n"          /* 58 c3            */
    "  pop %rsp; ret\n"          /* 5c c3            */
    "  pop %r8; ret\n"           /* 41 58 c3         */
    "  pop %r9; ret\n"           /* 41 59 c3         */
    "  mov %rsi,(%rdi); ret\n"   /* 48 89 37 c3      */
    "  mov %rax,(%rdi); ret\n"   /* 48 89 07 c3      */
    "  mov (%rax),%rax; ret\n"   /* 48 8b 00 c3      */
    "  add %rcx,%rax; ret\n"     /* 48 01 c8 c3      */
    "  cmp %eax,(%rcx); ret\n"   /* 39 01 c3         */
    "  incl (%rax); ret\n"       /* ff 00 c3         */
    "  seta %al; ret\n"          /* 0f 97 c0 c3      */
    "  setb %al; ret\n"          /* 0f 92 c0 c3      */
    "  sete %al; ret\n"          /* 0f 94 c0 c3      */
    "  setg %al; ret\n"          /* 0f 9f c0 c3      */
    "  setl %al; ret\n"          /* 0f 9c c0 c3      */
    "  shl $3,%rax; ret\n"       /* 48 c1 e0 03 c3   */
    "  shl $4,%rax; ret\n"       /* 48 c1 e0 04 c3   */
    "  shr $3,%rax; ret\n"       /* 48 c1 e8 03 c3   */
    "  shr $4,%rax; ret\n"       /* 48 c1 e8 04 c3   */
    "  jmp .\n"                  /* eb fe  (infloop) */
    ".size derive_gadget_blob,.-derive_gadget_blob\n"

    /* GOTPCREL forces an undefined __stack_chk_guard + a GLOB_DAT reloc, which is
     * how a PS5 module acquires that import (glibc/Linux uses %fs:0x28 instead). */
    ".globl derive_guard_probe\n"
    ".type derive_guard_probe,@function\n"
    "derive_guard_probe:\n"
    "  mov __stack_chk_guard@GOTPCREL(%rip), %rax\n"
    "  ret\n"
    ".size derive_guard_probe,.-derive_guard_probe\n"

    ".align 16\n"
    ".globl derive_syscalls\n"
    ".type derive_syscalls,@function\n"
    "derive_syscalls:\n"
    "  mov $0x14,%eax; syscall; ret\n"  /* getpid stub shape  */
    "  mov $0x3,%eax;  syscall; ret\n"  /* read stub shape    */
    ".size derive_syscalls,.-derive_syscalls\n"
);

__attribute__((visibility("default")))
int derive_keep(void) {
    return getpid();
}

__attribute__((visibility("default")))
void derive_memset_keep(void *p, unsigned long n) {
    memset(p, 0, n);
}

/* Built with -fstack-protector-strong, this forces an import of
 * __stack_chk_guard + __stack_chk_fail — the exact import the loader keys on
 * for the libkernel base (main.js:114-117). */
__attribute__((visibility("default")))
int derive_sp(int x) {
    volatile char b[24];
    b[0] = (char)x;
    return b[0] + (int)b[23];
}
