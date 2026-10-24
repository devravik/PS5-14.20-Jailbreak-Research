# Source Map

Key source files in WebKit-1200 relevant to PS5 14.20 exploitation.

## MetadataTable Overflow

| File | Function | Role |
|------|----------|------|
| Source/JavaScriptCore/bytecode/UnlinkedMetadataTable.cpp:99-164 | finalize() | Wrapping unsigned accumulator |
| Source/JavaScriptCore/bytecode/UnlinkedMetadataTableInlines.h | link() | Allocates buffer using wrapped size |
| Source/JavaScriptCore/bytecode/UnlinkedMetadataTable.h | s_offset16TableSize | Table size constants |
| Source/JavaScriptCore/bytecode/CodeBlock.cpp:466 | finishCreation() | Sweep loop, iterates all instructions |
| Source/JavaScriptCore/bytecode/CodeBlock.h:836 | get<Metadata>() | Unbounded pointer arithmetic |

## Bytecode Metadata

| File | What |
|------|------|
| Source/JavaScriptCore/bytecode/BytecodeList.rb | OpCall metadata definition, stride calculation |
| Source/JavaScriptCore/bytecode/CallLinkInfo.h | BaselineCallLinkInfo layout (72 bytes) |
| Source/JavaScriptCore/bytecode/ArrayProfile.h | ArrayProfile layout (12 bytes, static_assert) |
| Source/JavaScriptCore/bytecode/ValueProfile.h | ValueProfileBase layout (24 bytes) |

## Allocator

| File | What |
|------|------|
| Source/bmalloc/bmalloc/GigacageConfig.h | Gigacage enable/disable gate |
| Source/bmalloc/bmalloc/Gigacage.h:43-47 | Platform guard (Darwin or Linux only) |
| Source/bmalloc/bmalloc/Gigacage.cpp:37-39 | FastMalloc fallback when disabled |
| Source/bmalloc/libpas/src/libpas/pas_page_malloc.c:261 | MADV_FREE decommit |
| Source/bmalloc/libpas/src/libpas/pas_internal_config.h | Marge bitfit config (shift=22) |
| Source/WTF/wtf/PlatformEnable.h | BPlatform PlayStation macros |
| Source/WTF/wtf/FastMalloc.h | MetadataTableMalloc = FastMalloc |

## JSC Runtime

| File | What |
|------|------|
| Source/JavaScriptCore/runtime/JSString.h | JSString layout, length() implementation |
| Source/JavaScriptCore/runtime/StringImpl.h | StringImpl header layout |
| Source/JavaScriptCore/runtime/ArrayBuffer.h | ArrayBuffer and contents layout |
| Source/JavaScriptCore/heap/MarkedBlock.h | MarkedSpace cell layout |
| Source/JavaScriptCore/heap/FastMallocAlignedMemoryAllocator.cpp | MarkedBlock allocation path |

## Font Parsing

| File | What |
|------|------|
| Source/WebCore/css/CSSFontFaceSet.cpp:381 | matchingFacesExcludingPreinstalledFonts (UAF candidate) |
| Source/WebCore/platform/graphics/freetype/ | FreeType font parsing (if used) |
| Source/WebCore/svg/SVGToOTFFontConversion.cpp | SVG to OTF conversion |

## Platform

| File | What |
|------|------|
| Source/WTF/wtf/PlatformEnable.h | Feature flags (ENABLE_JIT, etc.) |
| Source/bmalloc/bmalloc/BPlatform.h:341 | BENABLE_LIBPAS=1 |
| Source/bmalloc/bmalloc/BPlatform.h:362 | BUSE_RELEASE_LARGE_FREE=0 |
