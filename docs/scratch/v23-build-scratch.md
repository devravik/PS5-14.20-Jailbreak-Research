# V23-BUILD SCRATCH — press-15: fa-v23-k3native.html (¿la inversión K3 llega al consumidor NATIVO?)

## Contexto
- Tesis (geohot-gh1-final §CADENA): "la memoria sale de FetchBody/SSV alimentados con estado dual — los streams son el delivery". Press-14 (V22) confirmó K3 en wire: `S4B: sink=[C2,C1];sizeO=[C1,C2];p1/p2=ful` (orden invertido entregado al sink JS, contabilidad del writable desincronizada).
- Wire previo sobre el frente nativo (V18A, press-8): `S2: ab=rej "ReadableStream chunk enqueueing in the s[ink failed]"` (Response body PARCIAL) · `S3: rej "ReadableStream uploading is not supported"` (fetch-upload MUERTO). Tree: FetchBody.cpp:70-76/:174, FetchBodyConsumer.cpp:329-364, ReadableStreamSink.cpp:43-66 (pipeTo=reader nativo; enqueue span EXACTO :54-55; close(nullptr)=EOF :59-66), FetchBodySource.cpp:78-93 (upload), WritableStreamInternals.js:552 único anti-reentrancia.

## Diseño S1-S6 (lo que mide cada beacon)
- S1 (K3 4-chunks, sink JS): call=[sink síncrono] vs arr=[resolución async ms] vs setO=[settle p1..p4 ms] vs sizeO + desA/desB + wLk. Pregunta: ¿pairwise [C2,C1,C3,C4] o reorden arbitrario?
- S2 (nativo, 4 K3 independientes vía TransformStream con writableStrategy.size cambiante): A=resp.body.getReader (orden+typeof), B=arrayBuffer (hex+eqInv "C2C1C3C4"/eqNat), C=text, D=fetch POST /beacon/V23-WIRE body=readable duplex:half (host verifica bytes si vive; si no, error exacto + lkF).
  - DECISIÓN CLAVE: chunks = Uint8Array(2) con tag ASCII. V18A alimentó STRING ("01234567") y el rej "chunk enqueueing in the sink failed" fue probablemente el type-gate del span de ReadableStreamSink::enqueue (necesita typed-array). Con bytes, arrayBuffer/text tienen chance real de entregar la inversión en CONTENIDO. (Sim V8 lo confirma: con string → "Received non-Uint8Array chunk"; con Uint8Array → hex=4332433143334334 eqInv=true.)
- S3 (K3 + FR): chunks={tag,m} con m registrado en FinalizationRegistry + WeakRef; drop total (releaseLock+null+churn) a 400ms; probes 1.3s/2.6s: fired orden + alive por marker. CTRL-marker (nunca entró al stream) = discriminador GC-ran vs nunca-GC (gc() NO existe en 14.20).
- S4 (bytes): Uint8Array(1024) fill uniforme 0x11*i + cabecera [0xAA,0xBB,i,f]. Sink inspecciona i/len/fillN/foreignN/h8. foreignN>0 ∨ len≠1024 ⇒ cruza BYTES; puro ⇒ solo reordena enteros.
- S5 (abort-dentro-de-abortSteps, §d1): abort#2 desde abortAlgorithm#1. Árbol spec: state="errored"+storedError=A1 ANTES de abortSteps ⇒ esperado rechazo rápido (o, según §d1, colgado). Mide p1/p2/write-post-abort/writer.closed/abN/abDone. FIX aplicado: attach de p2 DENTRO de abort() (abortAlgorithm corre diferido ⇒ el chequeo síncrono quedaba p2="nop" para siempre — bug cazado en sim).
- S6: Z + ENV-DUMP re-medido + hbN + DR_OK + resumen s1..s5.

## REGLAS cumplidas
0-crash (sin K1; todo try-catch; nativos ya probaron rechazo limpio en V18A) · HB 2s con contador hbN · V23-* · slice 500 · timeouts en TODAS las promises (S1B 1.6s, S2x 1.7s, S3B/C 1.3/2.6s, S4B 1.6s, S5B 1.5s, Z 3.3s) · RID 17B · EX/EVR listeners · DR-gate.

## Verificación local
- node --check (v26.11.1) sobre los 8 bloques <script> extraídos: OK ×8.
- Replay controlado en node (V8 streams — NO WebKit; valida NUESTRA lógica/telemetría, no el veredicto wire):
  - S1: `call=[C2,C1,C3,C4];arr=[C2@70,C1@81,C3@92,C4@103];setO=[p2,p1,p3,p4];desA=-2;desB=2` — pairwise en V8 (el patrón K3 es general-espec, no quirk WebKit).
  - S2A: `got=[C2,C1,C3,C4]` · S2B: `ac=ok;len=8;hex=4332433143334334;eqInv=true;eqNat=false` · S2C: `txt=C2C1C3C4` · S2D: st=204 (V8 upload vive; WebKit muerto).
  - S3: `sinkO=[C2,C1,C3,C4];p1/p2=ful;fired=[];alive=[C1:1,...,CTRL:1]` (GC nunca corrió — discriminador operativo).
  - S4: `ord=[2,1,3,4];fillN=1020;foreignN=0;mixed=0;tot=4096` — reordena enteros, no cruza bytes (V8).
  - S5: `p1=ful;p2=ful:undefined;wr=rej:A1;cl=rej:A1;abN=1;abDone=1` (V8: abort#2 resuelve no-op; veredicto WebKit en wire).
- Bugs cazados en rehearsal y corregidos ANTES de volar: (1) track() de S1 pisaba error de write con "nop"; (2) lkA de S2A se medía después de releaseLock (siempre false); (3) S5 p2="nop" para siempre por abortAlgorithm diferido; (4) S2 string-chunks → type-gate nativo → Uint8Array tags.

## Pre-registro (expectativas para el wire 14.20)
1. S1: call=[C2,C1,C3,C4] (pairwise, no arbitrario), p1..p4 ful, settleO=[p2,p1,p3,p4], desA=-2, desB=2 (si el fork repite v22-S4).
2. S2: si el gate del span era el string-chunk → arrayBuffer/text DEBERÍAN resolver con 8B/hex "C2C1C3C4" (inversión llega al nativo = tesis confirmada); si el sink nativo está amputado por otra razón → rej exacto, y A (body reader) es el testigo de orden.
3. S2D: rej "ReadableStream uploading is not supported" (muerto desde press-9) + lkF mide si fetch lockea antes de rechazar.
4. S3: si GC corre (CTRL recolectado): fired-order informa orden de liberación; algún marker vivo con CTRL muerto ⇒ retención = estado dual real.
5. S5: rechazo rápido de abort#2 con storedError (spec-clean) vs pend@1.5s (colgado §d1) — el wire decide; 0-crash ambos.

## Riesgos acotados
- Zombie-pipe (familia K2) en S2 si el nativo cuelga: timeouts 1.7s + releaseLock en finally del final de S2 + HB/Z como red de liveness.
- FR puede no disparar sin gc() (medido, no bug): CTRL es el discriminador explícito.
- V8≠WebKit: el replay local NO es el veredicto; el wire 14.20 lo es.
