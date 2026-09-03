# Camera to 3D

Point your phone at an object, take a photo, and watch a 3D model appear in Blender in under a minute.

Take photo → background removed → 3D model generated → auto-imported into Blender.

The camera UI is built for phone. You run the server on the computer where Blender is open, then open the web app on your phone. A laptop webcam works too.

## You'll need

- Python 3.10+
- Blender 3.0+
- A [Tripo3D](https://platform.tripo3d.ai/) API key — required, this makes the 3D models
- A [Gemini](https://aistudio.google.com/) API key — optional, removes the photo background
- [ngrok](https://ngrok.com/download) — required for phone use, since phone cameras need HTTPS

## Setup

### 1. Install

```bash
pip install -r requirements.txt
cp .env.example .env
```

Put your API keys in `.env`:

```
TRIPO_API_KEY=your_tripo_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. Start the server

```bash
uvicorn relay_server:app --host 0.0.0.0 --port 8000
```

In a second terminal:

```bash
ngrok http 8000
```

ngrok gives you a URL like `https://abc123.ngrok-free.app`. You'll use it for both the phone and Blender.

### 3. Connect Blender

1. **Edit → Preferences → Add-ons → Install**, pick `ws_import_addon.zip`, enable it
2. Press `N` in the 3D viewport → **WS Import** tab
3. Paste your ngrok URL, but swap `https` for `wss` and add `/ws?client=blender`:

   ```
   wss://abc123.ngrok-free.app/ws?client=blender
   ```

4. Click **Connect**. It should say **Status: Connected**

### 4. Use it

Open the ngrok URL on your phone, allow camera access, and point at an object. Tap the shutter, confirm the photo, then wait ~30–60 seconds. When the model is ready, tap **Send to Blender**.

## Settings

All optional except the Tripo key. Set these in `.env`:

| Variable | Description |
| --- | --- |
| `TRIPO_API_KEY` | Required. Generates the 3D models |
| `GEMINI_API_KEY` | Removes the photo background. Leave empty to skip it and use the photo as-is |
| `PORT` | Server port, defaults to `8000` |

## Running without a phone

To test from your laptop webcam, skip ngrok. Open `http://localhost:8000` and point Blender at `ws://localhost:8000/ws?client=blender`.

## If something breaks

**Camera won't open on phone** — you need the `https://` ngrok URL, not a local IP.

**"Failed to send to Blender"** — the add-on isn't connected. Check the WS Import panel says Connected, and that your URL starts with `wss://` and ends with `?client=blender`.

**ngrok URL stopped working** — free ngrok URLs change every restart. Reconnect Blender with the new one.

**Background removal fails** — usually a Gemini quota or key problem. You can leave `GEMINI_API_KEY` empty to skip it.

## What's in here

```
relay_server.py          The server: talks to the APIs, relays models to Blender
webapp/                  The phone camera app
blender_addon/           Add-on source
ws_import_addon.zip      The add-on to install in Blender
```

If you edit the add-on source, repackage it before installing:

```bash
zip -r ws_import_addon.zip blender_addon -x "*/__pycache__/*" "*.pyc"
```

## License

MIT — see [LICENSE](LICENSE).
