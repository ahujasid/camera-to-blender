"""
Minimal WebSocket (RFC 6455) client built on the Python standard library.

The add-on runs inside Blender's bundled Python, where pip packages installed
into the system interpreter are not visible, so third-party networking
libraries (e.g. ``websocket-client``) cannot be imported. This module
implements just enough of the WebSocket protocol for the relay connection:

- ws:// and wss:// (TLS) endpoints
- Opening handshake with cryptographic response validation
- Text and binary payloads, including fragmented frames
- Ping/pong keepalive
- Clean server-initiated close handling
- Masked client->server frames, as required by the spec

The public surface mirrors the parts of ``websocket-client``'s WebSocketApp
that the add-on uses, so swapping it in requires no other code changes:

    client = WebSocketClient(url, on_message=on_message,
                             on_open=on_open, on_close=on_close)
    threading.Thread(target=client.run_forever, daemon=True).start()

Callbacks follow the WebSocketApp contract:
    on_message(ws, message)   message is str (text) or bytes (binary)
    on_open(ws)
    on_close(ws, code, msg)   code is None for local failures; msg carries
                              the reason (connect/handshake error, or None
                              when close() was called locally)

``run_forever`` is blocking and the read side is single-threaded; ``close``
may be called from any thread. Do not raise from the callbacks.

This module must not import ``bpy`` (or any non-stdlib module): it also runs
under plain Python in the add-on's test suite.
"""

import base64
import hashlib
import os
import socket
import ssl
import struct
import threading
from urllib.parse import urlparse

# The opener never offers extensions (no Sec-WebSocket-Extensions header),
# so servers may not compress; frames are always plain.
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Frame opcodes (RFC 6455 section 5.2)
OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

# Defensive upper bounds. The relay only sends small JSON payloads (model
# URLs), so enlarging limits is never expected; refusing oversized frames
# stops a misbehaving endpoint from growing Blender's memory unbounded.
_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
_CONNECT_TIMEOUT = 15.0


class HandshakeError(Exception):
    """Opening handshake rejected or failed."""


class _SocketBuffer:
    """Buffered reader that always returns exact byte counts."""

    def __init__(self, sock):
        self._sock = sock
        self._buf = b""

    def read_exact(self, n):
        if n > _MAX_MESSAGE_BYTES:
            raise ConnectionResetError(f"Frame too large ({n} bytes)")
        while len(self._buf) < n:
            chunk = self._sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise ConnectionResetError("Socket closed while reading")
            self._buf += chunk
        data, self._buf = self._buf[:n], self._buf[n:]
        return data

    def read_http_response(self):
        while b"\r\n\r\n" not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionResetError("Socket closed during handshake")
            self._buf += chunk
        head, _, remainder = self._buf.partition(b"\r\n\r\n")
        self._buf = remainder  # leftover bytes are the first WS frames
        return head


class WebSocketClient:
    """Blocking WebSocket client with WebSocketApp-style callbacks."""

    def __init__(self, url, on_message=None, on_open=None, on_close=None,
                 ssl_context=None):
        self._url = url
        self._on_message = on_message
        self._on_open = on_open
        self._on_close = on_close
        self._ssl_context = ssl_context

        self._sock = None
        self._reader = None
        self._send_lock = threading.Lock()
        self._closing = False              # close() has been called
        self._close_sent = False
        self._server_close = (None, None)  # (code, reason) if server closed
        self._self_close = (None, None)    # (code, reason) close we sent on our own

    # ── Public API ────────────────────────────────────────────────────────

    def run_forever(self):
        """Connect, exchange frames, and return once the connection ends.

        Blocking; intended to run in a dedicated thread. ``on_close`` fires
        exactly once per ``run_forever`` call before it returns.
        """
        self._closing = False
        self._close_sent = False
        self._server_close = (None, None)
        self._self_close = (None, None)

        try:
            self._open()
            if self._closing:
                # close() raced with the handshake; honour it immediately.
                raise ConnectionResetError("Closed during handshake")
            if self._on_open:
                self._on_open(self)
            self._read_loop()
        except (OSError, HandshakeError) as exc:
            if not self._closing and self._server_close[0] is None:
                self._server_close = (None, str(exc))
        finally:
            self._teardown_socket()
            code, reason = self._server_close
            # A locally-initiated close with a code (e.g. a protocol error)
            # explains what happened; a plain local close() does not override
            # a healthier server-side or handshake verdict.
            self_code, self_reason = self._self_close
            if code is None and self_code is not None:
                code, reason = self_code, self_reason
            self._notify_close(code, reason)

    def close(self):
        """Close the connection from any thread (idempotent)."""
        self._closing = True
        self._send_close(None)
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)  # unblocks run_forever
            except OSError:
                pass  # already gone

    # ── Handshake ─────────────────────────────────────────────────────────

    def _open(self):
        parsed = urlparse(self._url)
        if parsed.scheme not in ("ws", "wss"):
            raise HandshakeError(f"Unsupported scheme: {parsed.scheme!r}")
        if not parsed.hostname:
            raise HandshakeError("URL has no hostname")

        failure = None
        port = None
        try:
            port = parsed.port  # handles IPv6 brackets; None when default
        except ValueError as exc:
            failure = exc
        if failure:
            raise HandshakeError(f"Invalid URL: {failure}")
        port = port or (443 if parsed.scheme == "wss" else 80)
        resource = parsed.path or "/"
        if parsed.query:
            resource += "?" + parsed.query

        sock = None
        try:
            sock = socket.create_connection(
                (parsed.hostname, port), timeout=_CONNECT_TIMEOUT)
            if parsed.scheme == "wss":
                ctx = self._ssl_context or ssl.create_default_context()
                sock = ctx.wrap_socket(sock, server_hostname=parsed.hostname)
            sock.settimeout(None)  # steady-state reads block indefinitely
            self._sock = sock
            self._reader = _SocketBuffer(sock)

            key = base64.b64encode(os.urandom(16)).decode("ascii")
            request = (
                f"GET {resource} HTTP/1.1\r\n"
                f"Host: {parsed.netloc}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "\r\n"
            )
            sock.sendall(request.encode("ascii"))
            self._validate_handshake(key)
        except (OSError, HandshakeError):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
                self._sock = None
                self._reader = None
            raise

    def _validate_handshake(self, key):
        head = self._reader.read_http_response()
        lines = head.decode("latin-1").split("\r\n")
        if not lines or not lines[0].startswith("HTTP/"):
            raise HandshakeError("Malformed handshake response")
        try:
            status = int(lines[0].split(" ")[1])
        except (IndexError, ValueError) as exc:
            raise HandshakeError(f"Bad status line: {lines[0]!r}") from exc
        if status == 404:
            # The most common setup mistake: a typo in the server URL/path.
            raise HandshakeError("HTTP 404 (did the server URL change? "
                                 "free ngrok URLs change every restart)")
        if status != 101:
            raise HandshakeError(f"Unexpected HTTP status {status}")

        # SHA-1(key + GUID) base64-encoded must be echoed back (RFC 6455
        # section 4.2.2). This is the cryptographic check tying our request
        # to the response, so nothing else is required for validation.
        expected = base64.b64encode(
            hashlib.sha1((key + _GUID).encode("ascii")).digest()
        ).decode("ascii")

        headers = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            name, _, value = line.partition(":")
            headers.setdefault(name.strip().lower(), value.strip())
        if headers.get("sec-websocket-accept") != expected:
            raise HandshakeError("Invalid Sec-WebSocket-Accept value")

    # ── Frames ────────────────────────────────────────────────────────────

    def _read_loop(self):
        """Read frames until a close frame, EOF or transport error."""
        payload_buf = b""   # unmasked payload accumulated across fragments
        payload_op = None   # opcode of the message being reassembled

        while True:
            header = self._reader.read_exact(2)
            fin = bool(header[0] & 0x80)
            opcode = header[0] & 0x0F
            masked = bool(header[1] & 0x80)  # servers never mask (spec 5.1)
            length = header[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._reader.read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._reader.read_exact(8))[0]

            mask_key = self._reader.read_exact(4) if masked else None
            payload = self._reader.read_exact(length) if length else b""
            if mask_key:
                payload = bytes(
                    b ^ mask_key[i % 4] for i, b in enumerate(payload))

            if opcode in (OP_TEXT, OP_BINARY, OP_CONT):
                if opcode != OP_CONT:
                    if payload_op is not None:
                        # A new message started mid-reassembly: protocol
                        # error (RFC 6455 section 5.4, 7.1.4).
                        self._send_close(1002, "Fragmentation in progress")
                        return
                    payload_op = opcode
                payload_buf += payload
                if len(payload_buf) > _MAX_MESSAGE_BYTES:
                    self._send_close(1009, "Message too large")
                    return
                if fin:
                    if payload_op is None:
                        # Continuation frame with no message start.
                        self._send_close(1002, "Unexpected continuation")
                        return
                    self._deliver(payload_op, payload_buf)
                    payload_buf, payload_op = b"", None
                continue

            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
            elif opcode == OP_PONG:
                pass  # keepalive reply to our (unused) pings
            elif opcode == OP_CLOSE:
                code, reason = self._parse_close_payload(payload)
                self._server_close = (code, reason)
                # Both sides must send a close frame to finish the close
                # handshake (RFC 6455 section 5.5.1). Echo the server's code
                # when it provided one; omit it when it did not.
                self._send_close(code)
                return
            else:
                # Unknown opcode: protocol error, then close (spec 5.2).
                self._send_close(1002, f"Unknown opcode {opcode}")
                return

    def _deliver(self, opcode, payload):
        if self._on_message is None:
            return
        if opcode == OP_TEXT:
            payload = payload.decode("utf-8", "replace")
        self._on_message(self, payload)

    @staticmethod
    def _parse_close_payload(payload):
        if len(payload) >= 2:
            code = struct.unpack("!H", payload[:2])[0]
            reason = payload[2:].decode("utf-8", "replace")
            return code, reason
        return None, ""

    def _send_frame(self, opcode, payload=b""):
        """Send one masked frame (RFC 6455 sections 5.1 and 5.3)."""
        # Sends (pings, replies and closes) may race with close() from
        # another thread: the lock covers every outgoing frame; reads are
        # single-threaded by design.
        with self._send_lock:
            return self._send_frame_locked(opcode, payload)

    def _send_frame_locked(self, opcode, payload=b""):
        sock = self._sock
        if sock is None:
            return False
        header = bytearray()
        header.append(0x80 | opcode)  # FIN + opcode
        length = len(payload)
        MASK_BIT = 0x80  # client frames MUST be masked (spec section 5.1)
        if length < 126:
            header.append(MASK_BIT | length)
        elif length <= 0xFFFF:
            header.append(MASK_BIT | 126)
            header += struct.pack("!H", length)
        else:
            header.append(MASK_BIT | 127)
            header += struct.pack("!Q", length)
        mask_key = os.urandom(4)
        masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        try:
            sock.sendall(bytes(header) + mask_key + masked)
            return True
        except OSError:
            return False

    def _send_close(self, code, reason=""):
        """Send a close frame once; further requests become no-ops."""
        with self._send_lock:
            if self._close_sent:
                return
            self._close_sent = True
            payload = b""
            if code:
                payload = struct.pack("!H", code)
                if reason:
                    payload += reason.encode("utf-8")[:120]
                # Remember locally-initiated closes (protocol errors) so
                # on_close reports what caused them.
                self._self_close = (code, payload[2:].decode("utf-8", "replace"))
            self._send_frame_locked(OP_CLOSE, payload)

    # ── Teardown / callbacks ──────────────────────────────────────────────

    def _teardown_socket(self):
        sock = self._sock
        self._sock = None
        self._reader = None
        if sock is None:
            return
        try:
            sock.close()
        except OSError:
            pass

    def _notify_close(self, code, msg):
        if self._on_close:
            self._on_close(self, code, msg)
