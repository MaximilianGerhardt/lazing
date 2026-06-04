#!/usr/bin/env python3
"""
lazyOS STT Service — Port 4202

Lokale Speech-to-Text via faster-whisper. Nimmt Audio-POST (webm/mp4/mp3/wav),
transkribiert deutsch, gibt JSON {text, duration_ms, segments?}.

Auth: Bearer-Token aus LAZYOS_STT_KEY (oder fallback LAZYOS_CHAT_KEY).
"""

from __future__ import annotations

import io
import os
import sys
import time
import json
import hmac
import tempfile
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

from faster_whisper import WhisperModel  # type: ignore


# ---- Config ---------------------------------------------------------------

PORT = int(os.environ.get("LAZYOS_STT_PORT", "4202"))
HOST = os.environ.get("LAZYOS_STT_HOST", "127.0.0.1")
# 'base' = 74MB, schnell, OK für DE. 'small' = 244MB, deutlich besser.
# 'medium' = 769MB, premium. Default 'small' für lazyOS.
MODEL_NAME = os.environ.get("LAZYOS_STT_MODEL", "small")
# CPU ist für 1-User-VPS völlig ok. 'int8' quant sparsam+schnell.
DEVICE = os.environ.get("LAZYOS_STT_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("LAZYOS_STT_COMPUTE_TYPE", "int8")
AUTH_KEY = (
    os.environ.get("LAZYOS_STT_KEY")
    or os.environ.get("LAZYOS_CHAT_KEY")
    or ""
).strip()
MAX_BODY_BYTES = int(os.environ.get("LAZYOS_STT_MAX_BYTES", str(25 * 1024 * 1024)))  # 25 MB
ALLOW_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "LAZYOS_STT_CORS",
        "http://127.0.0.1:4200,http://localhost:4200,https://lazyos-seven.vercel.app",
    ).split(",")
    if o.strip()
]

print(
    f"[stt] starting — model={MODEL_NAME} device={DEVICE} compute={COMPUTE_TYPE} "
    f"port={PORT} auth={'yes' if AUTH_KEY else 'NO-AUTH-WARN'}",
    flush=True,
)


# ---- Model load (once) ----------------------------------------------------

_model_t0 = time.time()
_model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
_model_load_ms = int((time.time() - _model_t0) * 1000)
print(f"[stt] model loaded in {_model_load_ms}ms", flush=True)


def transcribe_file(audio_path: str, language: str = "de") -> dict:
    """Run the loaded model on an audio file. Returns dict with text + timing."""
    t0 = time.time()
    segments, info = _model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=1,
    )
    seg_list = []
    text_parts = []
    for s in segments:
        text_parts.append(s.text)
        seg_list.append({"start": s.start, "end": s.end, "text": s.text})
    full_text = "".join(text_parts).strip()
    duration_ms = int((time.time() - t0) * 1000)
    return {
        "text": full_text,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration_ms": duration_ms,
        "segments": seg_list,
    }


def transcode_if_needed(raw: bytes, content_type: str | None) -> str:
    """Writes audio to temp wav and returns path. Uses ffmpeg for conversion."""
    suffix = ".webm"
    if content_type:
        ct = content_type.lower()
        if "mp4" in ct or "m4a" in ct:
            suffix = ".m4a"
        elif "ogg" in ct:
            suffix = ".ogg"
        elif "wav" in ct:
            suffix = ".wav"
        elif "mp3" in ct or "mpeg" in ct:
            suffix = ".mp3"
    src = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    src.write(raw)
    src.close()
    dst = src.name + ".wav"
    # Convert to 16kHz mono WAV — faster-whisper expects PCM
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i", src.name,
                "-ac", "1",
                "-ar", "16000",
                "-loglevel", "error",
                dst,
            ],
            check=True,
            timeout=60,
        )
    finally:
        os.unlink(src.name)
    return dst


# ---- HTTP Handler ---------------------------------------------------------

def _const_eq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def _cors_origin_for(origin: str | None) -> str | None:
    if not origin:
        return None
    if origin in ALLOW_ORIGINS:
        return origin
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 — override stdlib
        # Structured-ish access log, but quiet
        sys.stdout.write(f"[stt] {self.address_string()} - {fmt % args}\n")
        sys.stdout.flush()

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        origin = self.headers.get("Origin")
        cors = _cors_origin_for(origin)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cors:
            self.send_header("Access-Control-Allow-Origin", cors)
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin")
        cors = _cors_origin_for(origin)
        self.send_response(204)
        if cors:
            self.send_header("Access-Control-Allow-Origin", cors)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header(
                "Access-Control-Allow-Headers",
                "content-type, authorization, x-lazyos-stt-key",
            )
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            self._send_json(
                200,
                {
                    "status": "healthy",
                    "service": "lazyos-stt",
                    "model": MODEL_NAME,
                    "device": DEVICE,
                    "compute_type": COMPUTE_TYPE,
                    "model_load_ms": _model_load_ms,
                    "auth_enabled": bool(AUTH_KEY),
                },
            )
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/transcribe", "/stt"):
            self._send_json(404, {"error": "not_found"})
            return

        # Auth
        if AUTH_KEY:
            auth = self.headers.get("Authorization", "").strip()
            header_key = self.headers.get("x-lazyos-stt-key", "").strip()
            provided = ""
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
            elif header_key:
                provided = header_key
            if not provided or not _const_eq(provided, AUTH_KEY):
                self._send_json(401, {"error": "unauthorized"})
                return

        # Read body
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "bad_content_length"})
            return

        if length <= 0:
            self._send_json(400, {"error": "empty_body"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload_too_large", "max_bytes": MAX_BODY_BYTES})
            return

        raw = self.rfile.read(length)
        ct = self.headers.get("Content-Type", "audio/webm")

        # Language from query string (?lang=de)
        qs = urlparse(self.path).query
        lang = "de"
        if "lang=" in qs:
            for pair in qs.split("&"):
                if pair.startswith("lang="):
                    lang = pair[5:] or "de"
                    break

        try:
            wav_path = transcode_if_needed(raw, ct)
            try:
                result = transcribe_file(wav_path, language=lang)
            finally:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass
        except subprocess.CalledProcessError as err:
            self._send_json(422, {"error": "transcode_failed", "detail": str(err)})
            return
        except Exception as err:  # pylint: disable=broad-except
            self._send_json(500, {"error": "transcribe_failed", "detail": str(err)})
            return

        self._send_json(200, result)


def main() -> None:
    srv = HTTPServer((HOST, PORT), Handler)
    print(f"[stt] listening on http://{HOST}:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("[stt] shutting down", flush=True)
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
