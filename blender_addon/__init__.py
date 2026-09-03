bl_info = {
    "name": "WebSocket Auto Import",
    "author": "ahujasid",
    "version": (0, 1, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > WS Import",
    "description": "Connects to the Camera to 3D relay server and auto-imports GLB/OBJ models",
    "category": "Import-Export",
}

import bpy
import threading
import time
import json
import tempfile
import os
import urllib.request
from urllib.parse import urlparse

from websocket import WebSocketApp


def download_file(url: str) -> str:
    """Download a file to a temp path and return the file path."""
    # Parse URL to get path component (before query parameters)
    parsed = urlparse(url)
    path_lower = parsed.path.lower()
    
    # Determine file extension from path, not full URL
    if path_lower.endswith(".glb"):
        suffix = ".glb"
    elif path_lower.endswith(".obj"):
        suffix = ".obj"
    else:
        suffix = ".glb"  # Default to GLB
    
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    urllib.request.urlretrieve(url, path)
    return path


class WSImportState:
    def __init__(self):
        self.ws_thread = None
        self.ws_app = None
        self.connected = False
        self.queue = []

    def start(self, ws_url: str):
        if self.ws_thread and self.ws_thread.is_alive():
            return

        def on_message(_, message):
            print(f"[WSImport] Received message: {message[:200]}...")
            try:
                data = json.loads(message)
                print(f"[WSImport] Parsed JSON: type={data.get('type')}, has_url={bool(data.get('url'))}")
            except Exception as e:
                print(f"[WSImport] JSON parse error: {e}")
                return
            if data.get("type") == "model" and data.get("url"):
                print(f"[WSImport] Queuing model URL: {data['url'][:50]}...")
                self.queue.append(data["url"])

        def on_open(_):
            self.connected = True

        def on_close(_, __, ___):
            self.connected = False

        self.ws_app = WebSocketApp(ws_url, on_message=on_message, on_open=on_open, on_close=on_close)
        self.ws_thread = threading.Thread(target=self.ws_app.run_forever, daemon=True)
        self.ws_thread.start()
        bpy.app.timers.register(self._tick, first_interval=1.0)

    def stop(self):
        if self.ws_app:
            self.ws_app.close()
        self.connected = False
        self.ws_app = None
        self.ws_thread = None
        self.queue.clear()

    def _tick(self):
        if not self.queue:
            return 1.0
        url = self.queue.pop(0)
        print(f"[WSImport] Processing URL: {url[:80]}...")
        try:
            print(f"[WSImport] Downloading from URL...")
            path = download_file(url)
            print(f"[WSImport] Downloaded to: {path}")
            if path.lower().endswith(".glb"):
                print(f"[WSImport] Importing GLB...")
                bpy.ops.import_scene.gltf(filepath=path)
                print(f"[WSImport] ✓ GLB imported successfully!")
            elif path.lower().endswith(".obj"):
                print(f"[WSImport] Importing OBJ...")
                bpy.ops.wm.obj_import(filepath=path)
                print(f"[WSImport] ✓ OBJ imported successfully!")
        except Exception as e:
            print(f"[WSImport] ✗ Failed to import {url[:50]}: {e}")
        return 0.1


state = WSImportState()


class WSImportPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    ws_url: bpy.props.StringProperty(
        name="WebSocket URL",
        default="ws://localhost:8000/ws?client=blender",
        description="WebSocket URL for Blender connection. Use wss:// for ngrok HTTPS, ws:// for local"
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "ws_url")


class WSImportOperator(bpy.types.Operator):
    bl_idname = "wm.ws_auto_import_toggle"
    bl_label = "Toggle WS Auto Import"
    bl_description = "Connect/disconnect WebSocket auto importer"

    def execute(self, context):
        prefs = context.preferences.addons[__name__].preferences
        if state.connected:
            state.stop()
            self.report({"INFO"}, "WebSocket import stopped")
        else:
            state.start(prefs.ws_url)
            self.report({"INFO"}, f"Connecting to {prefs.ws_url}")
        return {"FINISHED"}


class WSImportPanel(bpy.types.Panel):
    bl_label = "WS Auto Import"
    bl_idname = "VIEW3D_PT_ws_auto_import"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "WS Import"

    def draw(self, context):
        layout = self.layout
        prefs = context.preferences.addons[__name__].preferences
        
        # WebSocket connection
        layout.prop(prefs, "ws_url")
        layout.operator(WSImportOperator.bl_idname, text="Connect/Disconnect")
        
        # Status indicator
        if state.connected:
            layout.label(text="Status: Connected", icon="LINKED")
        else:
            layout.label(text="Status: Disconnected", icon="UNLINKED")


classes = (WSImportPreferences, WSImportOperator, WSImportPanel)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    state.stop()
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

