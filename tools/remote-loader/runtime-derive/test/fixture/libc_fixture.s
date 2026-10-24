/* runtime-derive/test/fixture/libc_fixture.s — stand-in libSceLibcInternal:
 * exports setjmp/longjmp (the two libc symbols main.js:193,204,220 needs by name). */
.text
.globl setjmp
.type setjmp,@function
setjmp:
    xor %eax,%eax
    ret
.size setjmp,.-setjmp
.globl longjmp
.type longjmp,@function
longjmp:
    ret
.size longjmp,.-longjmp
.globl lc_marker
.type lc_marker,@function
lc_marker:
    ret
