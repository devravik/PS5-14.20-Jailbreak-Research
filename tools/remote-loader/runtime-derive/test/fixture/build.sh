#!/bin/sh
# runtime-derive/test/fixture/build.sh — build the offline ELF fixtures.
set -e
cd "$(dirname "$0")"
gcc -shared -fPIC -nostartfiles -fno-asynchronous-unwind-tables -fstack-protector-strong -o fixture.so fixture.c
gcc -shared -fPIC -nostdlib -o libc_fixture.so libc_fixture.s
gcc -shared -fPIC -nostdlib -o libk_fixture.so libk_fixture.s
echo "built fixture.so libc_fixture.so libk_fixture.so"
