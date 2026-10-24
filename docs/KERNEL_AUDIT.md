# Kernel Audit

PS5 14.20 runs a FreeBSD 11 fork (r230171). All kernel candidates require WebKit code execution and sandbox escape first.

## Tier 1 -- High Priority

### CVE-2026-7270: execve memmove Out-of-Bounds Write

Present since FreeBSD 11 (2013). The `execve` system call computes a `memmove` length from user-controlled argv/envp data without proper bounds checking, producing an out-of-bounds write. A full exploit has been publicly released. It requires an adapted exec target on PS5 because sshd is not available. Local access only.

### CVE-2026-45251: poll/select Use-After-Free

Affects all supported FreeBSD versions. A race condition between `close()` on a file descriptor and a concurrent `poll` or `select` wakeup on the same descriptor allows the wakeup path to access the freed file structure. A full exploit has been publicly released. Exploitation on PS5 depends on whether `pdfork()` is available inside the WebContent sandbox.

### CVE-2024-43102: UMTX Use-After-Free (CVSS 10)

This bug was already exploited on older PS5 firmware (1.00 through 7.61) by prior jailbreak efforts. A full chain exists. It is likely patched on firmware 14.20, but this has not been verified.

## Tier 2 -- Medium Priority

### CVE-2025-15547 / CVE-2025-15576: FreeBSD Jail Escapes

PS5 uses FreeBSD jails for process sandboxing. These CVEs allow escaping jail confinement. Exploitation depends on whether nullfs is available on PS5.

### CVE-2020-7460: sendmsg 32-bit TOCTOU

Affects FreeBSD 11, but it is old and Sony may have backported the fix. A race condition in `sendmsg` with the 32-bit compatibility layer allows a time-of-check-time-of-use attack.

## Sony-Specific Syscall Bugs

Found during binary analysis of PS5 firmware 13.60. All need validation on firmware 14.20.

| Syscall | Bug | Status |
|---------|-----|--------|
| sys_532 | Out-of-bounds read | Verified on 13.60, needs 14.20 check |
| sys_558 | Unchecked index | Not yet validated |
| sys_536 | Negative count accepted | Not yet validated |

## Not Applicable to PS5

| CVE | Reason |
|-----|--------|
| CVE-2026-45250 (setcred) | Syscall does not exist in FreeBSD 11. |
| CVE-2026-45253 (ptrace PT_SC_REMOTE) | Feature added in 2022, not present in FreeBSD 11. |
| CTL HA RCEs (3 bugs) | Requires a network listener that PS5 does not expose. |
| CVE-2026-4747 (RPCSEC_GSS) | Requires an NFS server. |
| CVE-2026-49413 (Linuxulator) | PS5 has no Linux compatibility layer. |
| CVE-2026-49427 (largepage SHM) | Not present in FreeBSD 11. |
| bhyve escape bugs | PS5 uses Aeolia/Belize hardware, not bhyve. |

## Recommended Chain

```
WebKit code execution
    -> userland arbitrary R/W
    -> CVE-2026-7270 or CVE-2026-45251
    -> kernel R/W
    -> GPU DMA for SMAP bypass
```
