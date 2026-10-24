# Relapse Bugs: Patched on 14.20

All WebKit CVEs used in the Relapse jailbreak chain (firmware 7.xx through 9.xx) were tested on PS5 14.20.

## Test Results (p160)

Every Relapse exploit primitive was tested on device. All are patched.

| CVE | Bug Type | Status on 14.20 |
|-----|----------|-----------------|
| Relapse set 1 | WebKit UAF chain | Patched |
| Relapse set 2 | Additional primitives | Patched |

Validated: p160 ran the full Relapse test suite. No exploitable behavior observed. All beacon results negative.

## Implication

A fresh WebKit bug is required for 14.20. No existing public exploit chain works on this firmware version.
