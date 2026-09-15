"""
Live plant-output stream OCR.

The "Live plant output" panel embeds a VDO.Ninja view (WebRTC, peer-to-peer) showing a
phone/camera pointed at a physical plant meter. That video is cross-origin inside an
<iframe>, so client-side JS in the browser can never read its pixels (a security
boundary, not a bug) - there is no client-side way to OCR it.

Instead, this module runs a headless Chromium (Playwright) in a background thread that
opens the *same* VDO.Ninja view URL directly (same-origin with itself, so canvas capture
is allowed there), grabs a frame from its <video> element every few seconds, and OCRs it
for a "<number> MW" reading using the same OCR engines already used for billing PDFs
(RapidOCR primary, Tesseract fallback).

Enable via the app settings drawer (admin) or directly in .env:
    ARECO_LIVE_STREAM_URL=https://vdo.ninja/?view=XXXXXXX
    ARECO_STREAM_OCR_ENABLED=1

Requires the Playwright Chromium browser to be installed once:
    python -m playwright install chromium
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone

_POLL_INTERVAL_SECS = 5.0
_VIDEO_WAIT_TIMEOUT_SECS = 20.0
_RETRY_GOTO_EVERY_SECS = 30.0
_MAX_PLAUSIBLE_MW = 100.0
_READING_HISTORY_WINDOW_SECS = 30 * 60  # keep 30 min of readings for short-term trend prediction

_MW_PATTERN_DECIMAL = re.compile(r"(\d{1,4}[.,]\d{1,3})\s*m\s*w", re.IGNORECASE)
_MW_PATTERN_INTEGER = re.compile(r"(\d{1,4})\s*m\s*w", re.IGNORECASE)

_CAPTURE_JS = """
() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find(v => v.videoWidth > 0 && v.readyState >= 2);
  if (!v) return null;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_mw(text: str) -> float | None:
    """Find the first plausible "<number> MW" reading in OCR'd text."""
    for pattern in (_MW_PATTERN_DECIMAL, _MW_PATTERN_INTEGER):
        m = pattern.search(text)
        if not m:
            continue
        raw = m.group(1).replace(",", ".")
        try:
            val = float(raw)
        except ValueError:
            continue
        if 0 <= val <= _MAX_PLAUSIBLE_MW:
            return val
    return None


def _ocr_image_to_text(png_bytes: bytes) -> str:
    """Best-effort OCR of a PNG frame. Tries RapidOCR, falls back to Tesseract."""
    import numpy as np

    try:
        import cv2

        arr = np.frombuffer(png_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return ""
        # Upscale small WebRTC frames (often ~320x180) to help OCR on small on-screen text.
        h, w = img.shape[:2]
        if max(h, w) < 900:
            scale = 900 / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
        try:
            from rapidocr_onnxruntime import RapidOCR

            ocr = _get_rapidocr()
            result, _ = ocr(img)
            if result:
                return " ".join(line[1] for line in result)
        except Exception:
            pass
        try:
            import pytesseract
            from PIL import Image

            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            return pytesseract.image_to_string(Image.fromarray(rgb))
        except Exception:
            return ""
    except Exception:
        return ""


_rapidocr_singleton = None
_rapidocr_lock = threading.Lock()


def _get_rapidocr():
    global _rapidocr_singleton
    if _rapidocr_singleton is None:
        with _rapidocr_lock:
            if _rapidocr_singleton is None:
                from rapidocr_onnxruntime import RapidOCR

                _rapidocr_singleton = RapidOCR()
    return _rapidocr_singleton


def _ocr_engines_available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401

        return True
    except Exception:
        pass
    try:
        import pytesseract  # noqa: F401

        return True
    except Exception:
        return False


class LiveStreamMwWatcher:
    """Background singleton that keeps a headless browser on the live stream and OCRs it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._state: dict = {
            "ok": False,
            "mw": None,
            "raw_text": "",
            "status": "stopped",
            "error": None,
            "updated_at": None,
            "source_url": None,
        }
        self._last_frame_png: bytes | None = None
        self._recent_readings: deque[tuple[float, float]] = deque()  # (unix_ts, mw), oldest first

    def get_state(self) -> dict:
        with self._lock:
            return dict(self._state)

    def get_last_frame_png(self) -> bytes | None:
        with self._lock:
            return self._last_frame_png

    def get_recent_readings(self, window_secs: float | None = None) -> list[tuple[float, float]]:
        """Recent (unix_ts, mw) OCR readings, oldest first, capped to window_secs (default: full buffer)."""
        with self._lock:
            data = list(self._recent_readings)
        if window_secs is None:
            return data
        cutoff = time.time() - window_secs
        return [p for p in data if p[0] >= cutoff]

    def _record_reading(self, mw: float) -> None:
        now = time.time()
        with self._lock:
            self._recent_readings.append((now, mw))
            cutoff = now - _READING_HISTORY_WINDOW_SECS
            while self._recent_readings and self._recent_readings[0][0] < cutoff:
                self._recent_readings.popleft()

    def _set_state(self, **kwargs) -> None:
        with self._lock:
            self._state.update(kwargs)
            self._state["updated_at"] = _now_iso()

    def ensure_started(self) -> None:
        enabled = os.environ.get("ARECO_STREAM_OCR_ENABLED", "").strip() in ("1", "true", "yes", "on")
        url = os.environ.get("ARECO_LIVE_STREAM_URL", "").strip()
        if not enabled or not url:
            self._set_state(ok=False, status="disabled", mw=None, error=None)
            return
        if not _ocr_engines_available():
            self._set_state(
                ok=False,
                status="error",
                error="No OCR engine available. Install rapidocr-onnxruntime or pytesseract (see requirements.txt).",
            )
            return
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run, daemon=True, name="live-stream-mw-watcher")
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _run(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            self._set_state(ok=False, status="error", error=f"Playwright not installed: {e}")
            return

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=True,
                    args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
                )
                try:
                    self._watch_loop(p, browser)
                finally:
                    browser.close()
        except Exception as e:
            self._set_state(ok=False, status="error", error=str(e))

    def _watch_loop(self, playwright, browser) -> None:
        current_url = None
        page = None
        last_goto_attempt = 0.0

        while not self._stop_event.is_set():
            url = os.environ.get("ARECO_LIVE_STREAM_URL", "").strip()
            enabled = os.environ.get("ARECO_STREAM_OCR_ENABLED", "").strip() in ("1", "true", "yes", "on")
            if not enabled or not url:
                self._set_state(ok=False, status="disabled", mw=None, error=None)
                return  # let ensure_started() spin up a fresh thread later if re-enabled

            if url != current_url or page is None:
                now = time.time()
                if now - last_goto_attempt < 5:
                    time.sleep(1)
                    continue
                last_goto_attempt = now
                try:
                    if page is not None:
                        page.close()
                    page = browser.new_page(viewport={"width": 1280, "height": 720})
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    current_url = url
                    self._set_state(status="connecting", source_url=url, error=None)
                except Exception as e:
                    self._set_state(ok=False, status="error", error=f"Could not open stream: {e}", source_url=url)
                    time.sleep(_RETRY_GOTO_EVERY_SECS)
                    continue

            try:
                data_url = page.evaluate(_CAPTURE_JS)
            except Exception as e:
                self._set_state(ok=False, status="error", error=str(e))
                current_url = None  # force reload next iteration
                time.sleep(2)
                continue

            if not data_url:
                self._set_state(ok=False, status="no_signal", mw=None, error=None, source_url=url)
                time.sleep(_POLL_INTERVAL_SECS)
                continue

            import base64

            try:
                _, b64 = data_url.split(",", 1)
                png_bytes = base64.b64decode(b64)
                with self._lock:
                    self._last_frame_png = png_bytes
                text = _ocr_image_to_text(png_bytes)
                mw = _parse_mw(text)
            except Exception as e:
                self._set_state(ok=False, status="error", error=str(e))
                time.sleep(_POLL_INTERVAL_SECS)
                continue

            if mw is not None:
                self._record_reading(mw)
                self._set_state(ok=True, status="ok", mw=mw, raw_text=text.strip()[:200], error=None, source_url=url)
            else:
                self._set_state(
                    ok=False,
                    status="unreadable",
                    mw=None,
                    raw_text=text.strip()[:200],
                    error="Could not find a '<number> MW' reading in the OCR'd frame.",
                    source_url=url,
                )

            time.sleep(_POLL_INTERVAL_SECS)


watcher = LiveStreamMwWatcher()
