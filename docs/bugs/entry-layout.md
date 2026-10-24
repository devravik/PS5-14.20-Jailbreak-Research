# OpCall::Metadata Entry Layout

The MetadataTable overflow writes entries of 112 bytes. This is the layout of each entry when JIT is disabled (LLInt only mode, as on PS5 14.20).

## Layout

```
Offset  Size  Type                     Field                    Written Value
------  ----  ----                     -----                    -------------
0       12    PackedRawSentinelNode    (linked list node)       zeros
12       4    unsigned                 m_slowPathCount          0xFFFFFFFF
16       8    (padding)                                         zeros
24       8    void*                    m_slowPathCallDestination getCTILinkCall().code()
32      32    (CallLinkInfo fields)                             zeros / defaults
64       4    bitfield                 m_callType + flags       Call(1) + defaults
68       4    unsigned                 m_bytecodeIndex          sequential index
72      12    ArrayProfile                                      zeros
84       4    (padding)                                         zeros
88      16    JSValue[2]               m_buckets                zeros
104      8    SpeculatedType           m_prediction             zeros
------  ---
112 total (static_assert in BytecodeList.rb)
```

## Source Verification

- ArrayProfile size: `static_assert(sizeof(ArrayProfile) == 12)` at ArrayProfile.h:257
- ValueProfile: `ValueProfileBase<1>` = m_buckets[2] (16B) + m_prediction (8B) = 24B at ValueProfile.h
- BaselineCallLinkInfo: 72B. m_stub removed when ENABLE(JIT)=OFF. At CallLinkInfo.h
- Total stride 112B verified against BytecodeList.rb metadata definition

## Fields of Interest for Exploitation

### m_slowPathCallDestination (offset 24, 8 bytes)
Contains `getCTILinkCall().code()`, a code pointer into the JSC thunk area. Same value for every entry. This is the ASLR leak candidate. If an ArrayBuffer backing store overlaps this offset, reading 8 bytes reveals a JSC code address.

### m_bytecodeIndex (offset 68, 4 bytes)
Sequential instruction index (0, 1, 2, ..., up to 38,348,815). Predictable values. Can be used to determine which sweep entry landed on a target: the index divided by the stride gives the entry number, and thus the distance from the metadata buffer base.

### m_slowPathCount (offset 12, 4 bytes)
Always 0xFFFFFFFF when JIT is off. Recognizable signature in heap corruption scans.
