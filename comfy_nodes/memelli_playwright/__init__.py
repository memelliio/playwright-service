"""Memelli Playwright nodes - a ComfyUI graph drives Playwright's own browser, step by step.

Mel Briggs, 2026-10-16: "comfy UI is capable of working with Playwright to do any step process we want including up to a 1080p
video. Sequence by sequence." · "you program it as Claude, but you program Playwright. You don't leave it in your local scripts."

ComfyUI runs inside the Playwright service's own container. These nodes call the service's own browser verbs on that same container
(http://127.0.0.1:$PORT - /session, /navigate, /click, /fill, /type, /press, /select, /eval, /screenshot, /screencast, /session DELETE),
on the lock the service already carries (env A). Nothing here drives a browser itself: Playwright does. The session handle passes from
node to node, so the graph IS the sequence - reprogram the graph (a row in control_store.comfyui_workflows), never the code.
  Playwright Open      -> a session, at a page
  Playwright Step      -> one step: navigate / click / fill / type / press / select / eval / wait
  Playwright Record    -> start recording the session (default 1920x1080, 30 fps - the service's own screencast)
  Playwright Film      -> stop recording; the film (mp4) lands in ComfyUI's output, so the graph's result IS the 1080p video
  Playwright Shot      -> one still of the page, as an IMAGE for any picture node
  Playwright Close     -> close the session
"""
import base64
import json
import os
import shutil
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:%s" % os.environ.get("PORT", "80")
RECORDINGS = os.environ.get("PLAYWRIGHT_RECORDINGS_DIR", "/var/lib/memelli-chrome/recordings")
SESSION = "PW_SESSION"


def _call(path, body, method="POST", timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method=method,
                                 headers={"content-type": "application/json", "x-memelli-lock": os.environ.get("A", "")})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError("Playwright %s answered %s: %s" % (path, e.code, e.read().decode("utf-8", "replace")[:300]))


def _settle(ms):
    if ms and ms > 0:
        time.sleep(ms / 1000.0)


class PlaywrightOpen:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = (SESSION,)
    RETURN_NAMES = ("session",)
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"url": ("STRING", {"default": ""}), "settle_ms": ("INT", {"default": 3000, "min": 0, "max": 120000})}}

    def run(self, url, settle_ms):
        sid = _call("/session", {"ephemeral": True}).get("sessionId")
        if not sid:
            raise RuntimeError("Playwright gave no session")
        if url:
            _call("/navigate", {"sessionId": sid, "url": url})
            _settle(settle_ms)
        return (sid,)


class PlaywrightStep:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = (SESSION, "STRING")
    RETURN_NAMES = ("session", "result")
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache
    OPS = ["navigate", "click", "fill", "type", "press", "select", "eval", "wait"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "session": (SESSION,),
            "op": (cls.OPS,),
            "target": ("STRING", {"default": "", "tooltip": "the selector; the url for navigate; the expression for eval; the key for press"}),
            "value": ("STRING", {"default": "", "tooltip": "what fill / type writes; the option label for select"}),
            "settle_ms": ("INT", {"default": 800, "min": 0, "max": 120000}),
        }}

    def run(self, session, op, target, value, settle_ms):
        if op == "navigate":
            r = _call("/navigate", {"sessionId": session, "url": target})
        elif op == "click":
            r = _call("/click", {"sessionId": session, "selector": target})
        elif op == "fill":
            r = _call("/fill", {"sessionId": session, "selector": target, "value": value})
        elif op == "type":
            r = _call("/type", {"sessionId": session, "selector": target, "value": value})
        elif op == "press":
            r = _call("/press", {"sessionId": session, "key": target})
        elif op == "select":
            r = _call("/select", {"sessionId": session, "selector": target, "label": value})
        elif op == "eval":
            r = _call("/eval", {"sessionId": session, "expression": target})
        else:
            r = {"status": "waited"}
        _settle(settle_ms)
        out = r.get("result", r.get("status", ""))
        return (session, out if isinstance(out, str) else json.dumps(out))


class PlaywrightRecord:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = (SESSION,)
    RETURN_NAMES = ("session",)
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"session": (SESSION,), "width": ("INT", {"default": 1920, "min": 320, "max": 3840}),
                             "height": ("INT", {"default": 1080, "min": 240, "max": 2160}), "fps": ("INT", {"default": 30, "min": 1, "max": 60})}}

    def run(self, session, width, height, fps):
        r = _call("/screencast", {"sessionId": session, "action": "start", "width": width, "height": height, "fps": fps})
        if r.get("status") != "recording":
            raise RuntimeError("Playwright did not start recording: %s" % json.dumps(r)[:200])
        return (session,)


class PlaywrightFilm:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = (SESSION, "STRING")
    RETURN_NAMES = ("session", "film")
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"session": (SESSION,), "filename_prefix": ("STRING", {"default": "memelli/sequence"})}}

    def run(self, session, filename_prefix):
        r = _call("/screencast", {"sessionId": session, "action": "stop"}, timeout=900)
        rid = r.get("recordingId")
        if r.get("status") != "recorded" or not rid:
            raise RuntimeError("Playwright did not finish the film: %s" % json.dumps(r)[:200])
        import folder_paths  # ComfyUI's own output folder
        out_dir, name, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory())
        fname = "%s_%05d_.mp4" % (name, counter)
        shutil.copyfile(os.path.join(RECORDINGS, rid + ".mp4"), os.path.join(out_dir, fname))
        info = "%sx%s %sfps %s frames %ss" % (r.get("width"), r.get("height"), r.get("fps"), r.get("frames"), r.get("seconds"))
        return {"ui": {"images": [{"filename": fname, "subfolder": subfolder, "type": "output"}], "animated": (True,)}, "result": (session, info)}


class PlaywrightShot:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = (SESSION, "IMAGE")
    RETURN_NAMES = ("session", "image")
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"session": (SESSION,)}}

    def run(self, session):
        import io
        import numpy as np
        import torch
        from PIL import Image
        r = _call("/screenshot", {"sessionId": session})
        img = Image.open(io.BytesIO(base64.b64decode(r.get("data", "")))).convert("RGB")
        return (session, torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)[None, ...])


class PlaywrightClose:
    CATEGORY = "memelli/playwright"
    RETURN_TYPES = ()
    FUNCTION = "run"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # a browser step acts on the world: it runs every time, never from ComfyUI's cache
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"session": (SESSION,)}}

    def run(self, session):
        _call("/session", {"sessionId": session}, method="DELETE")
        return {}


NODE_CLASS_MAPPINGS = {
    "PlaywrightOpen": PlaywrightOpen, "PlaywrightStep": PlaywrightStep, "PlaywrightRecord": PlaywrightRecord,
    "PlaywrightFilm": PlaywrightFilm, "PlaywrightShot": PlaywrightShot, "PlaywrightClose": PlaywrightClose,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PlaywrightOpen": "Playwright Open", "PlaywrightStep": "Playwright Step", "PlaywrightRecord": "Playwright Record (1080p)",
    "PlaywrightFilm": "Playwright Film", "PlaywrightShot": "Playwright Shot", "PlaywrightClose": "Playwright Close",
}
