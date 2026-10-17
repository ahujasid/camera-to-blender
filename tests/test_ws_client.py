"""
Tests for the add-on's stdlib WebSocket client.

The module under test is what runs inside Blender's bundled Python, so it
must work with the standard library alone. These tests exercise it against
an in-memory RFC 6455 test server and run under plain Python:

    python -m unittest discover -s tests -t .
"""

import base64
import hashlib
import importlib.util
import socket
import ssl
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Load ws_client.py directly from its file: importing the blender_addon
# package would pull in bpy, which only exists inside Blender.
_MODULE_PATH = Path(__file__).resolve().parents[1] / "blender_addon" / "ws_client.py"
_SPEC = importlib.util.spec_from_file_location("ws_client", _MODULE_PATH)
ws_client = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ws_client)


class _Deadline:
    def __init__(self, seconds):
        self._end = time.monotonic() + seconds

    def alive(self):
        return time.monotonic() < self._end

    def sleep(self, seconds=0.05):
        time.sleep(seconds)


# ── Test server helpers ──────────────────────────────────────────────────────

def _accept_key(client_key):
    digest = hashlib.sha1((client_key + _GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionResetError("peer closed mid-frame")
        buf.extend(chunk)
    return bytes(buf)


def _read_http_request(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionResetError("client hung up during handshake")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head, rest


def _complete_handshake(sock):
    """Reply to the client's opening handshake like a WebSocket server."""
    head, rest = _read_http_request(sock)
    lines = head.decode("latin-1").split("\r\n")
    assert lines[0].startswith("GET "), lines[0]
    headers = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    key = headers["sec-websocket-key"]
    sock.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            f"Sec-WebSocket-Accept: {_accept_key(key)}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "\r\n"
        ).encode("latin-1")
    )
    return headers, rest


def _send_frame(sock, opcode, payload=b"", fin=True):
    """Send one server-side frame (unmasked, per RFC 6455 section 5.1)."""
    header = bytearray()
    header.append((0x80 if fin else 0) | opcode)
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length <= 0xFFFF:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    sock.sendall(bytes(header) + payload)


def _read_client_frame(sock):
    """Read one frame sent by the client; unmask it when masked."""
    hdr = _recv_exact(sock, 2)
    fin = bool(hdr[0] & 0x80)
    opcode = hdr[0] & 0x0F
    masked = bool(hdr[1] & 0x80)
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    mask_key = _recv_exact(sock, 4) if masked else None
    payload = _recv_exact(sock, length) if length else b""
    if mask_key:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return fin, opcode, masked, payload


class _TestWSServer:
    """Threaded server that accepts connections and runs a test handler."""

    def __init__(self, handler, tls_ctx=None):
        self.handler = handler
        self.tls_ctx = tls_ctx
        self._listen = socket.socket()
        self._listen.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listen.bind(("127.0.0.1", 0))
        self._listen.listen(5)
        self.address = self._listen.getsockname()
        self._running = True
        self._conn_threads = []
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while self._running:
            try:
                sock, _addr = self._listen.accept()
            except OSError:
                return
            t = threading.Thread(target=self._serve, args=(sock,), daemon=True)
            t.start()
            self._conn_threads.append(t)

    def _serve(self, sock):
        try:
            if self.tls_ctx:
                sock = self.tls_ctx.wrap_socket(sock, server_side=True)
            self.handler(sock)
        except (OSError, ConnectionResetError, AssertionError, RuntimeError):
            pass
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def stop(self):
        self._running = False
        try:
            self._listen.close()
        except OSError:
            pass


class _ClientRunner:
    """Runs WebSocketClient.run_forever in a thread, records callbacks."""

    def __init__(self, url, ssl_context=None):
        self.messages = []
        self.message_event = threading.Event()
        self.open_event = threading.Event()
        self.close_event = threading.Event()
        self.was_opened = False
        self.close_code = "not-called"
        self.close_msg = "not-called"
        self._consumed = 0

        def on_message(_ws, message):
            self.messages.append(message)
            self.message_event.set()

        def on_open(_ws):
            self.was_opened = True
            self.open_event.set()

        def on_close(_ws, code, msg):
            self.close_code = code
            self.close_msg = msg
            self.close_event.set()

        self.thread = None
        self.client = ws_client.WebSocketClient(
            url, on_message=on_message, on_open=on_open, on_close=on_close,
            ssl_context=ssl_context)

    def start(self):
        self.thread = threading.Thread(target=self.client.run_forever, daemon=True)
        self.thread.start()
        return self

    def wait_open(self, timeout=5.0):
        return self.open_event.wait(timeout)

    def wait_message(self, timeout=5.0):
        """Wait for the next message to arrive (in-order consumption)."""
        self._consumed += 1
        deadline = _Deadline(timeout)
        while deadline.alive():
            if len(self.messages) >= self._consumed:
                return True
            deadline.sleep(0.02)
        return False

    def wait_close(self, timeout=5.0):
        ok = self.close_event.wait(timeout)
        if ok and self.thread:
            self.thread.join(timeout=2.0)
        return ok


class _ProtocolTestCase(unittest.TestCase):
    """Shared server/client plumbing; tests only write the server handler."""

    def setUp(self):
        self.server = None
        self.runners = []

    def tearDown(self):
        for runner in self.runners:
            runner.client.close()
            if runner.thread:
                runner.thread.join(timeout=2.0)
        if self.server:
            self.server.stop()

    def start_client(self):
        runner = _ClientRunner(f"ws://127.0.0.1:{self.server.address[1]}").start()
        self.runners.append(runner)
        return runner


class TestConnectionAndMessages(_ProtocolTestCase):
    def test_handshake_validation_headers_and_text_message(self):
        """Handshake checks + a plain text frame delivered as str."""
        checked = {}

        def handler(sock):
            headers, _rest = _complete_handshake(sock)
            checked.update(headers)
            _send_frame(sock, 0x1, "hello".encode("utf-8"))
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open(), "on_open fired after 101")
        self.assertTrue(runner.wait_message(), "text message received")
        self.assertEqual(runner.messages[0], "hello")
        # Headers the RFC handshake is built from
        self.assertEqual(checked["upgrade"].lower(), "websocket")
        # Token is case-insensitive per RFC 7230; the addon only needs the
        # server to run it, so lower-cased compare matters harmlessly here.
        self.assertIn("upgrade", checked["connection"].lower())
        self.assertEqual(checked["sec-websocket-version"], "13")
        self.assertEqual(len(checked["sec-websocket-key"]),
                         24, "16 random bytes base64-encoded")
        self.assertTrue(runner.wait_close())  # handler closed the connection

    def test_fragmented_message_reassembled(self):
        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x1, b"frag", fin=False)
            _send_frame(sock, 0x0, b"ment", fin=True)
            _send_frame(sock, 0x1, b"second")
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open())
        self.assertTrue(runner.wait_message())
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages, ["fragment", "second"])

    def test_ping_interleaved_with_fragments_is_answered(self):
        seen = {}

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x1, b"part", fin=False)
            _send_frame(sock, 0x9, b"ka")  # control frame between fragments
            _send_frame(sock, 0x0, b" two", fin=True)
            seen["pong"] = _read_client_frame(sock)
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open())
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages[0], "part two")
        deadline = _Deadline(2.0)
        while "pong" not in seen and deadline.alive():
            deadline.sleep()
        _fin, opcode, masked, payload = seen["pong"]
        self.assertEqual((opcode, payload), (0xA, b"ka"), "pong echoes payload")
        self.assertTrue(masked, "client frames must be masked (RFC section 5.1)")

    def test_binary_message_stays_bytes(self):
        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x2, bytes([9, 8, 7]))
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open())
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages[0], bytes([9, 8, 7]))

    def test_extended_length_frame(self):
        """16-bit length frames decode correctly."""
        big = b"\xc3\xa9" * 100  # 200 bytes > 125, so 2-byte length

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x2, big)
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages[0], big)


class TestProtocolErrorPaths(_ProtocolTestCase):
    def test_server_close_with_status_echoed_and_reported(self):
        seen = {}

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x8, struct.pack("!H", 1000) + b"bye")
            seen["echo"] = _read_client_frame(sock)
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open())
        self.assertTrue(runner.wait_close())
        self.assertEqual(runner.close_code, 1000)
        self.assertEqual(runner.close_msg, "bye")
        deadline = _Deadline(2.0)
        while "echo" not in seen and deadline.alive():
            deadline.sleep()
        _fin, opcode, _masked, payload = seen["echo"]
        self.assertEqual(opcode, 0x8)
        self.assertEqual(struct.unpack("!H", payload[:2])[0], 1000)

    def test_unknown_opcode_triggers_close_1002(self):
        seen = {}

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x3, b"weird")  # reserved opcode, never legal
            seen["reply"] = _read_client_frame(sock)
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_close())
        deadline = _Deadline(2.0)
        while "reply" not in seen and deadline.alive():
            deadline.sleep()
        _fin, opcode, _masked, payload = seen["reply"]
        self.assertEqual(opcode, 0x8)
        self.assertEqual(struct.unpack("!H", payload[:2])[0], 1002)
        self.assertIn("opcode", (runner.close_msg or ""))

    def test_bare_continuation_frame_rejected(self):
        """A continuation without a start frame is a protocol error."""
        seen = {}

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x0, b"orphan", fin=True)  # no text before
            seen["reply"] = _read_client_frame(sock)
            _Deadline(1.0).sleep()

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_close())
        deadline = _Deadline(2.0)
        while "reply" not in seen and deadline.alive():
            deadline.sleep()
        self.assertEqual(seen["reply"][1], 0x8)
        self.assertEqual(struct.unpack("!H", seen["reply"][3][:2])[0], 1002)


class TestCloseBehaviour(_ProtocolTestCase):
    def test_local_close_sends_close_frame_then_notifies(self):
        close_seen = []

        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x1, "welcome".encode())
            # Read frames until the client's close frame arrives.
            deadline = _Deadline(5.0)
            while deadline.alive():
                fin, opcode, _masked, payload = _read_client_frame(sock)
                if opcode == 0x8:
                    close_seen.append(payload)
                    sock.sendall(bytes([0x88, 0x00]))  # bare close reply
                    return
            raise ConnectionResetError("never saw the client close frame")

        self.server = _TestWSServer(handler)
        runner = self.start_client()
        self.assertTrue(runner.wait_open())
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages[0], "welcome")

        runner.client.close()
        self.assertTrue(runner.wait_close())
        self.assertIsNone(runner.close_code)  # locally initiated
        self.assertIsNone(runner.close_msg)
        deadline = _Deadline(2.0)
        while not close_seen and deadline.alive():
            deadline.sleep()
        self.assertEqual(len(close_seen), 1, "exactly one close frame sent")
        self.assertEqual(close_seen[0], b"")  # no status code locally


class TestHandshakeFailures(unittest.TestCase):
    """Handshake answers that must not open a connection."""

    def setUp(self):
        self.server = None
        self.runners = []

    def tearDown(self):
        for runner in self.runners:
            runner.client.close()
            if runner.thread:
                runner.thread.join(timeout=2.0)
        if self.server:
            self.server.stop()

    def _server(self, handler):
        self.server = _TestWSServer(handler)
        runner = _ClientRunner(f"ws://127.0.0.1:{self.server.address[1]}").start()
        self.runners.append(runner)
        return runner

    def test_wrong_accept_key_never_opens_the_connection(self):
        def handler(sock):
            head, _ = _read_http_request(sock)
            for line in head.decode("latin-1").split("\r\n")[1:]:
                if line.lower().startswith("sec-websocket-key:"):
                    key = line.split(":", 1)[1].strip()
            wrong = base64.b64encode(b"0" * 20).decode()
            sock.sendall(
                "HTTP/1.1 101 Switching Protocols\r\n"
                f"Sec-WebSocket-Accept: {wrong}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n".encode("latin-1")
            )
            _Deadline(1.0).sleep()

        runner = self._server(handler)
        self.assertTrue(runner.wait_close(), "handshake mismatch reported")
        self.assertFalse(runner.was_opened, "on_open must not fire")
        self.assertIn("Sec-WebSocket-Accept", runner.close_msg or "")

    def test_http_404_surfaces_descriptively(self):
        def handler(sock):
            _read_http_request(sock)
            sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            _Deadline(1.0).sleep()

        runner = self._server(handler)
        self.assertTrue(runner.wait_close())
        self.assertFalse(runner.was_opened)
        self.assertIn("404", runner.close_msg or "")
        # The common setup failure is a stale ngrok/localhost URL.
        self.assertIn("URL", runner.close_msg or "")

    def test_plain_http_200_rejected(self):
        def handler(sock):
            _read_http_request(sock)
            sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            _Deadline(1.0).sleep()

        runner = self._server(handler)
        self.assertTrue(runner.wait_close())
        self.assertFalse(runner.was_opened)
        self.assertIn("200", runner.close_msg or "")


class TestTLS(unittest.TestCase):
    """The wss:// path used for ngrok + cloud servers."""

    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl binary not available")
        cls.ctx = None  # filled only when cert generation works
        try:
            tmp = tempfile.TemporaryDirectory()
            cert = Path(tmp.name) / "cert.pem"
            key = Path(tmp.name) / "key.pem"
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", str(key), "-out", str(cert), "-days", "30",
                 "-subj", "/CN=localhost",
                 "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
                check=True, capture_output=True)
            server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_ctx.load_cert_chain(str(cert), str(key))
            client_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            client_ctx.check_hostname = False  # self-signed test cert only
            client_ctx.verify_mode = ssl.CERT_NONE
            cls.tmp = tmp  # pin lifetime
            cls.ctx = (server_ctx, client_ctx)
        except (subprocess.CalledProcessError, OSError):
            raise unittest.SkipTest("openssl could not build a cert")

    @classmethod
    def tearDownClass(cls):
        if cls.ctx:
            cls.tmp.cleanup()

    def setUp(self):
        assert self.ctx, "TLS fixtures missing"
        self.server, self.client_ctx = self.ctx
        self.tls_server = None
        self.runner = None

    def tearDown(self):
        if self.runner:
            self.runner.client.close()
            if self.runner.thread:
                self.runner.thread.join(timeout=2.0)
        if self.tls_server:
            self.tls_server.stop()

    def test_wss_message_exchange(self):
        def handler(sock):
            _complete_handshake(sock)
            _send_frame(sock, 0x1, "wss hello".encode())
            deadline = _Deadline(2.0)
            while deadline.alive():
                fin, opcode, _masked, payload = _read_client_frame(sock)
                if opcode == 0x8:
                    return

        self.tls_server = _TestWSServer(handler, tls_ctx=self.server)
        runner = _ClientRunner(
            f"wss://127.0.0.1:{self.tls_server.address[1]}",
            ssl_context=self.client_ctx).start()
        self.runner = runner
        self.assertTrue(runner.wait_open(), "wss handshake must succeed")
        self.assertTrue(runner.wait_message())
        self.assertEqual(runner.messages[0], "wss hello")


if __name__ == "__main__":
    unittest.main()
