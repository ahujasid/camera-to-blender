"""
End-to-end test: the add-on's stdlib WebSocket client against the real
relay server (uvicorn + this repo's relay_server.py), reproducing exactly
what the Blender add-on does: connect as client=blender, receive the
relayed model URL as JSON, and close cleanly.

    python -m unittest discover -s tests -t .
"""

import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path

import httpx

_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))

# Load ws_client.py by path (the blender_addon package needs bpy).
_SPEC = importlib.util.spec_from_file_location(
    "ws_client", _REPO_ROOT / "blender_addon" / "ws_client.py")
ws_client = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ws_client)

# Import the relay app; no API keys needed for WebSocket plumbing.
os.environ.setdefault("TRIPO_API_KEY", "")
os.environ.setdefault("GEMINI_API_KEY", "")
import relay_server  # noqa: E402

import uvicorn  # noqa: E402


class _RelayClientRunner:
    """Mirrors WSImportState's client usage from blender_addon/__init__.py."""

    def __init__(self, ws_url):
        self.messages = []
        self.message_event = threading.Event()
        self.open_event = threading.Event()
        self.close_event = threading.Event()

        # Same JSON handling as the add-on's on_message
        def on_message(_ws, message):
            data = json.loads(message)
            self.messages.append(data)
            self.message_event.set()

        def on_open(_ws):
            self.open_event.set()

        def on_close(_ws, code, msg):
            self.close_event.set()

        self.client = ws_client.WebSocketClient(
            ws_url, on_message=on_message, on_open=on_open, on_close=on_close)
        self.thread = threading.Thread(target=self.client.run_forever, daemon=True)


def _wait_until(predicate, timeout=10.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(interval)
    raise TimeoutError("condition not met in time")


class TestRelayEndToEnd(unittest.TestCase):
    def setUp(self):
        config = uvicorn.Config(
            relay_server.app, host="127.0.0.1", port=0,
            log_level="warning", ws="websockets")
        self.server = uvicorn.Server(config)
        self.server_thread = threading.Thread(target=self.server.run, daemon=True)
        self.server_thread.start()
        self.assertTrue(self._wait_started(), "uvicorn did not start")
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def _wait_started(self, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.server.started:
                return True
            time.sleep(0.05)
        return False

    def tearDown(self):
        self.server.should_exit = True
        self.server_thread.join(timeout=10.0)
        self.assertFalse(self.server_thread.is_alive(), "uvicorn shut down")

    def test_relayed_model_url_reaches_stdlib_client_and_closes_cleanly(self):
        runner = _RelayClientRunner(
            f"ws://127.0.0.1:{self.port}/ws?client=blender")
        runner.thread.start()

        self.assertTrue(runner.open_event.wait(10), "on_open after handshake")

        # relay_server sees the connection under the 'blender' key
        _wait_until(lambda: relay_server.connections.get("blender"))
        response = httpx.post(
            f"http://127.0.0.1:{self.port}/relay",
            json={"target": "blender", "type": "model",
                  "url": "https://fake-tripo-cdn.example/output/model.glb"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"delivered": 1})

        self.assertTrue(runner.message_event.wait(10), "model URL relayed")
        # The add-on filters to type == "model" and queues data["url"]:
        self.assertEqual(runner.messages[0]["type"], "model")
        self.assertEqual(
            runner.messages[0]["url"],
            "https://fake-tripo-cdn.example/output/model.glb")

        # Clean close: uvicorn acknowledges and drops the blender client
        runner.client.close()
        self.assertTrue(runner.close_event.wait(10), "on_close fired")
        runner.thread.join(timeout=5)
        self.assertFalse(runner.thread.is_alive())
        _wait_until(lambda: not relay_server.connections.get("blender"))
        health = httpx.get(f"http://127.0.0.1:{self.port}/health").json()
        self.assertNotIn("blender", health["connected_clients"])


if __name__ == "__main__":
    unittest.main()
