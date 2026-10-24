# Struct Layouts

Key structure layouts verified against WebKit-1200 source.

## JSString (JSC)

Source: JSString.h

```
Offset  Size  Field
0       8     JSCell header (StructureID + flags)
8       8     m_fiber (union: JSValue for atom, or pointer for rope)
16      8     (end of JSString, size = 16)
```

JSString.length() reads from the StringImpl pointed to by m_fiber, not from a field in JSString itself. The `.length = 81400` result from sweep corruption means m_fiber was overwritten to point somewhere that has 81400 at the m_length offset.

Source: JSString.h:740-746

## StringImpl

Source: StringImpl.h:161-171

```
Offset  Size  Field
0       4     m_refCount
4       4     m_length
8       8     m_data8 (pointer to character data)
16      4     m_hashAndFlags
20+     ...   inline character data (for short strings)
```

For short strings (created by 'A'.repeat(N)), the character data is inline starting at offset 20. For longer strings, m_data8 points to a separate allocation.

## ArrayBuffer

Source: ArrayBuffer.h, ArrayBufferContents.h

```
ArrayBuffer:
  m_contents: ArrayBufferContents
    m_data: DataType (CagedPtr or raw void*)
    m_sizeInBytes: unsigned
    m_destructor: ...

ArrayBufferView (TypedArray):
  m_buffer: RefPtr<ArrayBuffer>
  m_baseAddress: void*
  m_byteOffset: unsigned
  m_byteLength: unsigned
```

With Gigacage disabled, m_data is a raw void* allocated via tryFastCalloc (zeroed). The zeroing happens at allocation time, not lazily.

## MarkedBlock (MarkedSpace cell allocation)

Source: MarkedBlock.h

```
MarkedBlock: 16KB aligned
  m_header: MarkedBlock::Header
    m_bitvectors[numberOfAtomsThatFit]  (mark bits)
    m_cellSize
    m_startAtom
    ...
  cells[]: starting at m_startAtom
    each cell is m_cellSize bytes, contains a JSCell subclass
```

JSString cells are 16 bytes each. MarkedBlocks are allocated via tryFastAlignedMalloc, which routes through the same bmalloc heap.

Source: FastMallocAlignedMemoryAllocator.cpp:49
