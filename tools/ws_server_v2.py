#!/usr/bin/env python3
"""WS server v2: sends crafted/malformed frames to probe client parser. TLS enabled."""
import socket, hashlib, base64, struct, json, datetime, binascii, threading, os, time, ssl

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ws-captures.log')
MAGIC = b'258EAFA5-E914-47DA-95CA-5AB5353BE740'

def log_entry(entry):
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    print(json.dumps(entry, default=str)[:300])

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
    resp = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: ' + accept + '\r\n'
        '\r\n'
    )
    conn.sendall(resp.encode())
    return path, headers

def send_ws_frame(conn, data, opcode=1, fin=True, mask=False):
    """Send a well-formed WS frame."""
    frame = bytearray()
    b0 = opcode
    if fin:
        b0 |= 0x80
    frame.append(b0)
    if isinstance(data, str):
        data = data.encode()
    ln = len(data)
    b1 = 0x80 if mask else 0x00
    if ln < 126:
        frame.append(b1 | ln)
    elif ln < 65536:
        frame.append(b1 | 126)
        frame.extend(struct.pack('>H', ln))
    else:
        frame.append(b1 | 127)
        frame.extend(struct.pack('>Q', ln))
    if mask:
        mk = os.urandom(4)
        frame.extend(mk)
        data = bytes(data[i] ^ mk[i % 4] for i in range(len(data)))
    frame.extend(data)
    conn.sendall(bytes(frame))

def send_raw_bytes(conn, raw):
    """Send arbitrary raw bytes (for malformed frames)."""
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
    if payload_len > 16 * 1024 * 1024:
        return opcode, b'<TOO_LARGE>'
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

def probe_sequence(conn):
    """Send a sequence of probe frames, collecting client responses between each."""
    probes = []

    # P0: Normal greeting (baseline)
    send_ws_frame(conn, "PROBE-START:V583")
    time.sleep(0.1)

    # P1: Text frame with invalid UTF-8 sequences
    # WebKit should either replace or reject — check what comes back
    bad_utf8 = b"BEFORE\xfe\xff\x80\x81\xc0\xaf\xe0\x80\x80\xf0\x80\x80\x80AFTER"
    send_ws_frame(conn, bad_utf8, opcode=1)  # text opcode with bad utf8
    probes.append("P1:bad-utf8")
    time.sleep(0.15)

    # P2: Binary frame with heap-spray pattern (pointer-like values)
    spray = bytearray()
    for i in range(64):
        spray.extend(struct.pack('<Q', 0x00007f0000000000 + i * 0x1000))
    send_ws_frame(conn, bytes(spray), opcode=2)
    probes.append("P2:ptr-spray-binary")
    time.sleep(0.1)

    # P3: Fragmented text — first fragment (FIN=0, opcode=1)
    send_ws_frame(conn, "FRAG-PART1:", opcode=1, fin=False)
    time.sleep(0.05)
    # Continuation (FIN=0, opcode=0)
    send_ws_frame(conn, "FRAG-PART2:", opcode=0, fin=False)
    time.sleep(0.05)
    # Final continuation (FIN=1, opcode=0)
    send_ws_frame(conn, "FRAG-PART3-END", opcode=0, fin=True)
    probes.append("P3:fragmented-text")
    time.sleep(0.15)

    # P4: Zero-length text frame
    send_ws_frame(conn, b"", opcode=1)
    probes.append("P4:zero-text")
    time.sleep(0.1)

    # P5: Zero-length binary frame
    send_ws_frame(conn, b"", opcode=2)
    probes.append("P5:zero-binary")
    time.sleep(0.1)

    # P6: Ping with maximum payload (125 bytes — RFC max for control)
    ping_data = b"PING" + os.urandom(121)
    send_ws_frame(conn, ping_data, opcode=9)
    probes.append("P6:ping-125B")
    time.sleep(0.15)

    # P7: Multiple rapid pings (allocation pressure on pong path)
    for i in range(20):
        send_ws_frame(conn, struct.pack('>H', i), opcode=9)
    probes.append("P7:rapid-pings-20x")
    time.sleep(0.3)

    # P8: Close frame with reason text
    close_payload = struct.pack('>H', 1000) + b"SERVER-INITIATED-CLOSE-TEST"
    # DON'T actually close — send it as a raw frame to see if client responds
    # but use a text frame wrapper to avoid actually closing
    send_ws_frame(conn, "CLOSE-FAKE:" + close_payload.hex(), opcode=1)
    probes.append("P8:fake-close-text")
    time.sleep(0.1)

    # P9: CRITICAL — 126-byte extended length with WRONG actual payload
    # Header says 300 bytes, but we only send 50.
    # This tests whether the client reads exactly `length` bytes or stops at what's available.
    raw = bytearray()
    raw.append(0x82)  # FIN + binary
    raw.append(126)   # extended 16-bit length follows
    raw.extend(struct.pack('>H', 300))  # CLAIM 300 bytes
    actual_data = b"ONLY-50-BYTES-" + b"\xBB" * 36
    raw.extend(actual_data)  # but only send 50
    # Immediately follow with a normal text frame
    # If the parser read 300 bytes, it consumed part of this next frame as "payload"
    # and will misparse the text frame, potentially reading OOB
    normal_after = bytearray()
    normal_after.append(0x81)  # FIN + text
    msg = b"POST-UNDERFLOW-MARKER"
    normal_after.append(len(msg))
    normal_after.extend(msg)
    send_raw_bytes(conn, bytes(raw) + bytes(normal_after))
    probes.append("P9:length-underflow-300vs50")
    time.sleep(0.3)

    # P10: Large extended length (64-bit) with small actual payload
    # 127 length indicator, claims 0x100 (256) bytes, sends 32
    raw2 = bytearray()
    raw2.append(0x82)  # FIN + binary
    raw2.append(127)   # 64-bit extended length
    raw2.extend(struct.pack('>Q', 256))  # claim 256
    raw2.extend(b"SMALL" + b"\xCC" * 27)  # send 32
    marker2 = bytearray()
    marker2.append(0x81)
    msg2 = b"POST-64BIT-UNDERFLOW"
    marker2.append(len(msg2))
    marker2.extend(msg2)
    send_raw_bytes(conn, bytes(raw2) + bytes(marker2))
    probes.append("P10:64bit-length-underflow")
    time.sleep(0.3)

    # P11: Oversized length in control frame (>125, which violates RFC)
    # Control frames MUST have payload <= 125. What does the parser do?
    raw3 = bytearray()
    raw3.append(0x89)  # FIN + ping
    raw3.append(126)   # extended length (INVALID for control frame)
    raw3.extend(struct.pack('>H', 200))  # 200 bytes
    raw3.extend(b"\xDD" * 200)
    send_raw_bytes(conn, bytes(raw3))
    probes.append("P11:oversized-control-frame")
    time.sleep(0.2)

    # P12: Reserved opcode (0x3) — undefined behavior
    send_ws_frame(conn, b"RESERVED-OPCODE-3", opcode=3)
    probes.append("P12:reserved-opcode-3")
    time.sleep(0.1)

    # P13: Reserved opcode (0xB) — undefined control
    send_ws_frame(conn, b"RESERVED-CTRL-B", opcode=0xB)
    probes.append("P13:reserved-opcode-B")
    time.sleep(0.1)

    # P14: Continuation frame without prior fragment start
    # Opcode 0 (continuation) with FIN=1, no preceding non-FIN frame
    send_ws_frame(conn, b"ORPHAN-CONTINUATION", opcode=0, fin=True)
    probes.append("P14:orphan-continuation")
    time.sleep(0.15)

    # P15: Interleaved control frame inside fragmented message
    # Start fragment, inject ping, continue fragment
    send_ws_frame(conn, "INTERLEAVE-START:", opcode=1, fin=False)
    time.sleep(0.05)
    send_ws_frame(conn, b"MID-PING", opcode=9)  # ping mid-fragment (allowed by RFC)
    time.sleep(0.05)
    send_ws_frame(conn, "INTERLEAVE-END", opcode=0, fin=True)
    probes.append("P15:interleaved-ping")
    time.sleep(0.15)

    # P16: Masked server frame (servers should NOT mask, but what if we do?)
    send_ws_frame(conn, "MASKED-FROM-SERVER", opcode=1, mask=True)
    probes.append("P16:server-masked")
    time.sleep(0.1)

    # P17: Binary frame at exactly 65536 bytes (boundary)
    boundary = b"\xEE" * 65536
    send_ws_frame(conn, boundary, opcode=2)
    probes.append("P17:64k-boundary")
    time.sleep(0.3)

    # P18: Send signal that probes are done
    send_ws_frame(conn, "PROBES-COMPLETE:" + ",".join(probes))
    time.sleep(0.1)

    return probes

def handle_client(conn, addr):
    ts = datetime.datetime.now().isoformat()
    try:
        path, headers = ws_handshake(conn)
        log_entry({"ts": ts, "event": "connect", "addr": str(addr), "path": path,
                    "ua": headers.get("user-agent", "")[:200]})

        if '/probe' in path or '/leak' in path:
            probes = probe_sequence(conn)
            log_entry({"ts": datetime.datetime.now().isoformat(), "event": "probes-sent",
                        "count": len(probes), "probes": probes})
        else:
            send_ws_frame(conn, "HELLO-FROM-SERVER")

        # Receive and log everything the client sends back
        while True:
            opcode, data = read_frame(conn)
            if opcode is None or opcode == 8:
                if opcode == 8 and data:
                    code = struct.unpack('>H', data[:2])[0] if len(data) >= 2 else 0
                    reason = data[2:].decode('utf-8', errors='replace') if len(data) > 2 else ''
                    log_entry({"ts": datetime.datetime.now().isoformat(), "type": "close",
                                "code": code, "reason": reason[:200]})
                break
            ts = datetime.datetime.now().isoformat()
            if opcode == 1:
                text = data.decode('utf-8', errors='replace')
                log_entry({"ts": ts, "type": "text", "size": len(text), "data": text[:2000]})
            elif opcode == 2:
                hexdump = binascii.hexlify(data[:2048]).decode()
                log_entry({"ts": ts, "type": "binary", "size": len(data), "hex": hexdump})
            elif opcode == 10:  # pong
                log_entry({"ts": ts, "type": "pong", "size": len(data),
                            "hex": binascii.hexlify(data[:64]).decode()})
            else:
                log_entry({"ts": ts, "type": f"opcode-{opcode}", "size": len(data),
                            "hex": binascii.hexlify(data[:256]).decode()})

    except Exception as e:
        log_entry({"ts": datetime.datetime.now().isoformat(), "event": "error",
                    "error": str(e)[:300], "type": type(e).__name__})
    finally:
        log_entry({"ts": datetime.datetime.now().isoformat(), "event": "disconnect", "addr": str(addr)})
        try: conn.close()
        except: pass

def main():
    CERT = '/home/violence/Work/ps5-lan-research/PS5Relapse/leaf-chain.pem'
    KEY = '/home/violence/Work/ps5-lan-research/PS5Relapse/key.pem'
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    ctx.check_hostname = False
    raw_srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raw_srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    raw_srv.bind(('0.0.0.0', 9090))
    raw_srv.listen(5)
    srv = ctx.wrap_socket(raw_srv, server_side=True)
    print("WSS server v2 (TLS) on 0.0.0.0:9090 — frame injection probes — log: " + LOG)
    while True:
        try:
            conn, addr = srv.accept()
            threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()
        except ssl.SSLError as e:
            print(f"TLS handshake error: {e}")

if __name__ == '__main__':
    main()
