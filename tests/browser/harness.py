"""Headless-browser harness shared by the browser tests and tools/export_lut.py.

Requirements (dev only): `pip install playwright` and `python -m playwright install chromium`
(or point Z1_CHROMIUM at any Chromium/Chrome binary). WebGL2 runs on SwiftShader (software), so the
GPU solvers work anywhere, only slowly.

Environment variables:
    Z1_CHROMIUM       path to a chromium / chrome-headless-shell binary (optional)
    Z1_BROWSER_LIBS   extra LD_LIBRARY_PATH for machines without the system libraries (optional)
"""
from __future__ import annotations

import contextlib
import functools
import glob
import http.server
import os
import socketserver
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
           "--enable-webgl", "--disable-gpu-sandbox"]


def chromium_path() -> str | None:
    if os.environ.get("Z1_CHROMIUM"):
        return os.environ["Z1_CHROMIUM"]
    for pat in ("~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
                "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome"):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    return None  # let playwright pick its own


def _env():
    env = dict(os.environ)
    libs = os.environ.get("Z1_BROWSER_LIBS")
    if libs:
        env["LD_LIBRARY_PATH"] = libs + (":" + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else "")
    return env


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


@contextlib.contextmanager
def serve(directory: Path = DIST, port: int = 0):
    """Serve `directory` on localhost in a background thread; yields the base URL."""
    handler = functools.partial(_Quiet, directory=str(directory))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        th = threading.Thread(target=httpd.serve_forever, daemon=True)
        th.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_address[1]}"
        finally:
            httpd.shutdown()


@contextlib.asynccontextmanager
async def browser_page(width: int = 1440, height: int = 900, log=print):
    """Async context manager yielding a playwright Page with console/pageerror logging attached."""
    from playwright.async_api import async_playwright
    os.environ.update(_env())
    async with async_playwright() as p:
        exe = chromium_path()
        b = await p.chromium.launch(executable_path=exe, args=GL_ARGS, env=_env()) if exe else await p.chromium.launch(args=GL_ARGS)
        page = await b.new_page(viewport={"width": width, "height": height})
        errors: list[str] = []
        page.on("console", lambda m: log(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: (errors.append(str(e)), log(f"[pageerror] {e}")))
        page.errors = errors  # type: ignore[attr-defined]
        try:
            yield page
        finally:
            await b.close()
