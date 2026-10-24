/* runtime-derive/test/fixture/libk_fixture.s — stand-in libkernel:
 * exports every syscall wrapper name the loader resolves by name (design.md d4.2). */
.text
.macro STUB name
.globl \name
.type \name,@function
\name:
    ret
.size \name,.-\name
.endm
STUB getpid
STUB socket
STUB setsockopt
STUB bind
STUB listen
STUB getsockname
STUB accept
STUB read
STUB write
STUB close
STUB sysctlbyname
STUB pthread_create
STUB pthread_join
STUB pthread_exit
STUB sleep
STUB sceKernelGetCurrentCpu
STUB lk_marker
.globl lk_syscall_stub
.type lk_syscall_stub,@function
lk_syscall_stub:
    mov $0x14,%eax
    syscall
    ret
.size lk_syscall_stub,.-lk_syscall_stub
