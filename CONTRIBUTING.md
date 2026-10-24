# Contributing

This is active security research on PS5 firmware 14.20. Contributions are welcome in specific areas.

## What we need

**Info leak primitive.** The primary blocker is leaking a raw heap pointer through Canvas2D or related DOM APIs on WebKit WK-1400 (no JIT, LLInt-only, no WebGL, no WebAssembly). If you know a technique, please open an issue.

**Kernel exploit validation.** CVE-2026-7270 (execve memmove OOB) and CVE-2026-45251 (poll/select UAF) need validation on PS5 14.20. If you have access to a jailbroken console or relevant kernel research, please share.

## How to contribute

- **Open an issue** with your findings, analysis, or suggestions.
- **Do not submit probe HTML files directly** -- probes are built and tested through a specific deployment pipeline.
- See `docs/` for full technical context on the exploit chain, confirmed primitives, and dead ends.
- See `docs/DEAD_ENDS.md` before investigating a new angle -- 44 attack vectors have already been exhausted.

## Guidelines

- All claims must be validated against PS5 constraints (no JIT, LLInt-only, FreeBSD).
- Source analysis should reference WK-1400 (primary) or WK-1200 (secondary).
- Do not include private IP addresses, credentials, or PII in submissions.
