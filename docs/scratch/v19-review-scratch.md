# V19-REVIEW scratch — fa-v19-rab.html vs árbol wk1200-source (dsh v4-pro MAX)
(NOTA: sandbox bloqueó escribir en 14.20-bid/ — este archivo es la copia workspace;
contenido idéntico al que iba a 14.20-bid/v19-review-scratch.md. Copia/mueve a donde vaya el leg.)
Página NO editada (solo se describen fixes). Árbol: 14.20-bid/wk1200-source/WebKit-1200/Source/JavaScriptCore (+ WebCore citado).
Contexto: press-9 ya cerró el sink en wire (host-beacons.log:2882-2883, 23:38:46) → ver §0.

## 0. Contexto wire del sink (press-9, YA CORRIDO)
- S2 `ab=rej:ReadableStream chunk enqueueing in the s[ink failed]` — mensaje de ReadableStreamInternals.js:321
  (`sink.error("ReadableStream chunk enqueueing in the sink failed")`). El sink nativo EXISTIÓ y se ejercitó:
  ReadableStreamSink.cpp:43-57 (pipeFrom→pipeTo, enqueue :48-57 con span `{buffer->data(), buffer->byteLength()}`
  :54-55 = len+contenido EXACTOS al callback) — pero la maquinaria del fork rechazó el chunk en el enqueue.
- S3 `rej:ReadableStream uploading is not supported` · lkA=false (Response no lockeó el stream al ctor).
- ⇒ "SINK cerrado en la práctica" (como dice el board V18) — el condicional de la TAREA 3 es hipotético.

## 1. F2 (ArrayBuffer.transfer ausente) — explicado por el árbol: NO es divergencia
- transfer EXISTE en 1200 pero gated por opción: JSArrayBufferPrototype.cpp:464-465 solo instala
  `propertyNames->transfer` si `Options::useArrayBufferTransfer()`; OptionsList.h:570
  `v(Bool, useArrayBufferTransfer, false, Normal, "Expose ArrayBuffer.transfer feature.")`.
- ⇒ "transfer NO existe" on-device = consistente con el árbol (option off por default). Descuéntalo de F2 como hallazgo.

## 2. S3 (fill) — orden spec asumido BIEN; detección con agujero; crash-risk acotado
- ORDEN CONFIRMADO: JSC cachea len ANTES de coercionar value.
  JSGenericTypedArrayViewPrototypeFunctions.h:519 `size_t length = thisObject->length();` → :520
  `toAdaptorNativeFromValue(globalObject, callFrame->argument(0))` (= ToNumber → valueOf). Spec:
  %TypedArray%.prototype.fill step 3 (len) ANTES de step 4 (ToNumber(value)). Tu asunción es correcta.
- Upstream revalida: :531-538 (`integerIndexedObjectLength` + `end = std::min(end, updatedLength.value())`);
  escritura final :544 typedVector() + memset :563 (elementSize==1) / std::fill :567. ⇒ en 1200 puro: spec-ok
  (solo 0..7 = 0x41). Wiring: JSTypedArrayViewPrototype.cpp:532 (fill → typedArrayViewProtoFuncFill).
- AGUJERO DE VALIDEZ (hallazgo mayor de la review): ArrayBuffer::resize hace memset-CERO al crecer:
  ArrayBuffer.cpp:540-541 (`if (m_sizeInBytes < newByteLength) memset(data()+old, 0, new-old)`), spec-mandado
  (CreateByteDataBlock es zero-init). El 0x41 escrito en 8..63 DURANTE la fase encogida se BORRA al re-crecer.
  ⇒ `leaked8_63=0` NO discrimina "revalidó" de "zero-on-grow tapó el bug". FALSO NEGATIVO posible en un fork
  JSC-style sin la revalidación de fill. (En un fork V8-style que NO zeroa, S3 sí discrimina bien.)
- nowLen (v.length post-fill) revalida vía JSArrayBufferView::length() :300-307 → integerIndexedObjectLength
  (JSArrayBufferViewInlines.h:149-167) independientemente del interior de fill ⇒ no discrimina la revalidación
  DE FILL; sí detecta stale-length EN LA VISTA (nowLen=64 = señal directa de bug).
- CRASH-RISK acotado pero real: (a) si el fork implementa resize como REALLOC (spec lo permite), un fill
  no-revalidante escribe 56 bytes por pointer muerto / sobre bloque de 8 bytes → heap OOB/UAF = clase crash;
  (b) en fork JSC-style el backing es fijo y 64B < 1 página ⇒ el gate de mprotect (ArrayBuffer.cpp:480-538,
  `if (newPageCount != oldPageCount)`) nunca dispara ⇒ la escritura cae en memoria mapeada. Tu F3 ("la reserva
  queda mapeada") es cierta SOLO para buffers < tamaño de página. REGLA v19b: todo buffer RAB < 4096B (los 64B
  actuales cumplen) y NUNCA resize(0) (page-count 0 ⇒ PROT_NONE ⇒ SIGSEGV si hay stale write).
- Orden de stages correcto (S3 antes que S4/S5) + HB 2s ⇒ un crash se localiza por "último HB + S3 ausente".

## 3. S4 (sort) — comparador respetado; doble barrera upstream; métrica invertida
- El comparador SÍ llega a user code: JSTypedArrayViewPrototype.cpp:522 (sort = builtin) →
  TypedArrayPrototype.js:222-243: :229 cachea `length` ANTES de cualquier user code (✓ asunción), :235-238
  `comparator !== @undefined → @typedArrayMergeSort(this, length, comparator)`.
- typedArrayMergeSort TypedArrayPrototype.js:192-219: ordena SOBRE COPIA (:197 `buffer = new constructor
  (valueCount)`; :200-204 si resizable ⇒ src = copia fresca, el original NO se toca durante el merge) y el
  write-back REVALIDA: :216 `valueCount = @min(@typedArrayLength(array), valueCount)` ⇒ upstream spec-ok con
  DOBLE barrera (además cada `array[i] = src[i]` pasa el set fast-path que valida rango contra length()
  revalidada: JSGenericTypedArrayViewInlines.h:152-162 + canAccessRangeQuickly :838-841).
- MÉTRICA INVERTIDA: prefill v[i]=(i*7)%64 deja 8..63 TODO NO-CERO (gcd(7,64)=1 ⇒ i*7 mod 64 ≠ 0 para i<64).
  En un engine que NO zeroa en grow y SÍ revalida, nonZero=56 — valor ESPERADO, no bug (falso positivo).
  En un engine que zeroa, nonZero=0 aunque sort esté roto (falso negativo). La métrica mide zeroing, no
  revalidación ⇒ necesita el control S6.
- DISCRIMINADOR GRATIS (fix descrito): añadir `ord8` = hex de v[0..7] tras re-crecer al beacon de S4.
  Si el fork sorteó IN-PLACE sobre el RAB (sin la rama copia :200-204), los reads del merge post-shrink son
  JS-clamped (undefined→NaN) ⇒ orden basura en 0..7. 0..7 SOBREVIVE al grow (el memset solo toca [8,64)).
  Orden perfecto = rama copia presente. Cero costo, crash-safe, no depende del zeroing.
- Si el fork ignora el comparador (sort nativo sin callbacks, older-JSC), fired=0 lo delata (ya beaconizado). ✓

## 4. S5 (copyWithin) — NEUTRO POR CONSTRUCCIÓN (lo más grave de la página)
- Routing OK: JSTypedArrayViewPrototype.cpp:527/:307-315 → genericTypedArrayViewProtoFuncCopyWithin
  (JSGenericTypedArrayViewPrototypeFunctions.h:245-292): len :254 antes de coerciones :255-259 (✓),
  revalidación upstream :270-285 (updatedLength≠length ⇒ count recortado), memmove :288.
- PERO copyWithin(0,{...}) con prefill 0x11 uniforme es memmove(ptr,ptr,count) = IDENTIDAD DE CONTENIDO:
  el count stale (64) escribe 0x11 sobre 0x11 en 8..63 ⇒ delta observable CERO en TODOS los mundos, incluso
  en un fork no-zeroing SIN revalidación. El probe no puede emitir señal jamás. (Y si no-zeroing, non=56 se
  leería como bug falso.) `fired` sí mide que valueOf corrió, pero nada más.
- FIX (v19b, página nueva): copyWithin(1, {valueOf-encoge}, undefined) con v[i]=i (i=0..63):
  revalidado ⇒ v[1..7]=0..6 y v[j]=j para j=8..63; count-stale ⇒ memmove(v+1, v+0, 63) ⇒ v[8..63]=7..62
  (shifted). Shifted>0 = stale en TODOS los engines no-zeroing; todo-0 ⇒ zeroing tapó (se resuelve con S6).

## 5. Q2 — los 2 probes de v19b (mismo patrón crash-safe: <1 página, resize(8), try-catch, HB, beacons V19-*)
- S6-CONTROL (zeroing/estabilidad del grow): prefill v[i]=i → resize(8) → resize(64) → contar j=8..63 con
  v[j]===j. 56/56 ⇒ fork NO zeroa en grow ⇒ las señales raw de S3/S4/S5 son válidas y S7 discrimina.
  0/56 ⇒ zeroing activo ⇒ TODO "0" de la batería es ambiguo y el veredicto de revalidación sale de
  nowLen/fired/ord8. (Preservado también implica backing in-place; el spec permite realloc-copy que zeroaría.)
- S7 (S5-CORREGIDO, shifted): el copyWithin(1) con patrón de §4 — la única métrica de la batería que separa
  "revalidado" de "count-stale" sin depender del zeroing.

## 6. Q3 — casamiento con el sink (¿quién da el alias chunk↔puntero?)
- El sink (hipotético verde) NO da alias: da flujo de bytes JS→nativo con len/contenido exactos
  (ReadableStreamSink.cpp:54-55 span) = INYECCIÓN de datos, no aliasing.
- El alias lo da EL PROPIO VIEW RAB: JSArrayBufferView.h:368 `VectorPtr m_vector` (puntero crudo al backing) +
  length() :300-307 como ÚNICA barrera de revalidación. Un fill/memmove no-revalidante escribe en
  vector+staleLen sin pasar la barrera ⇒ el engine entrega el puntero él solo. El "chunk↔puntero" ES el view:
  el chunk es el view y su m_vector es el puntero. No hace falta el sink para eso.
- NO colindan por layout: backing RAB = mmap dedicado (ArrayBuffer.cpp:491 BufferMemoryManager
  .tryAllocatePhysicalBytes) vs SharedBuffer del sink = heap WebCore ⇒ el casamiento NO es "OOB del RAB pega
  el chunk del sink". El casamiento real es CAPA-2: (a) fixed-view con byteOffset≠0 sobre el MISMO RAB
  (alias intra-buffer entre DOS views) + op bulk (set/copyWithin/memmove) con count stale cruzando el borde de
  la view — el candidato si v19 da leaked>0 con S6=no-zeroing; (b) subir maxByteLength para cruzar de página
  (NO recomendado: PROT_NONE ⇒ SIGSEGV en vez de señal). El veredicto de v19 elige (a) vs (b).
- El sink, si algún día revive, es el tercer brazo (inyección de datos con len exacta para grooming nativo),
  no la condición del write8.

## 7. Q4 — veredicto
- RAB es la ruta principal AHORA: sink cerrado en wire (press-9) y la capa streams del fork amputada
  (O6/O7, byte-streams "not implemented", upload "not supported", enqueue-reject); la capa JSC-core
  (resize/fill/sort/copyWithin/views) está VIVA y es exactamente la que mide v19.
- Complementos en teoría (sink = datos len-exacta; RAB = longitud confiada), pero con el sink muerto el
  presupuesto va 100% a RAB; el rechazo en enqueue queda como FINGERPRINT del fork (maquinaria presente,
  copia rechazada) para un press futuro.
- Pre-registro v19 (árbol 1200): S1 ok;b=8/64/8 · S2 len=8/64/8;v40=0xAA · S3 leaked8_63=0;nowLen=8;fired=1
  (AMBIGUO sin S6 — no leer como spec-ok puro) · S4 nonZero=0;fired≈384 (mismo caveat) · S5 non=0 (neutro) ·
  Z. Filas de mayor valor: leaked>0 / nowLen=64 / fired=0 / ord8-no-ordenado (v19b).
