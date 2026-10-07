import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

HOST = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024
SPEED = 1.0
DEFAULT_IDLE_EXIT_SECONDS = 15 * 60
IDLE_CHECK_SECONDS = 30
LOG_PATH = os.path.join(tempfile.gettempdir(), "recap-voice-server.log")
MODEL_REPO = "canberkkkkkk/ema-lightning"
# ema-lightning opens these with torch.load(weights_only=False), which can run code;
# only the exact files reviewed for this release are ever loaded.
REVIEWED_WEIGHTS_SHA256 = {
    "ema.pt": "95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6",
    "decoder.pt": "9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67",
}
TEST_SENTENCE = "Recap kuruldu. Sesli özetler hazır."


class UnreviewedWeights(Exception):
    pass


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def reviewed_weight_paths() -> dict:
    from huggingface_hub import hf_hub_download

    paths = {}
    for name, expected in REVIEWED_WEIGHTS_SHA256.items():
        path = hf_hub_download(MODEL_REPO, name)
        if sha256_of(path) != expected:
            raise UnreviewedWeights(f"{name} is not the reviewed file ({path})")
        paths[name] = path
    return paths


def wav_bytes(audio: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm.tobytes())
    return buffer.getvalue()


class VoiceServer(HTTPServer):
    def __init__(self, port: int, idle_exit_seconds: float):
        super().__init__((HOST, port), SpeakHandler)
        self.idle_exit_seconds = idle_exit_seconds
        self.last_used = time.monotonic()
        self.tts = None

    def load_voice(self):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        reviewed_weight_paths()
        from ema_lightning import EMA

        self.tts = EMA(device="cpu")

    def stop_soon(self):
        threading.Thread(target=self.shutdown, daemon=True).start()

    def stop_when_idle(self):
        while True:
            time.sleep(min(IDLE_CHECK_SECONDS, self.idle_exit_seconds))
            if time.monotonic() - self.last_used >= self.idle_exit_seconds:
                self.shutdown()
                return


class SpeakHandler(BaseHTTPRequestHandler):
    server: VoiceServer

    def do_POST(self):
        self.server.last_used = time.monotonic()
        if self.path == "/shutdown":
            self.send_response(204)
            self.end_headers()
            return self.server.stop_soon()
        if self.path != "/speak":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY_BYTES:
            return self.send_error(413)
        try:
            text = str(json.loads(self.rfile.read(length))["text"]).strip()
        except (ValueError, KeyError, TypeError):
            return self.send_error(400)
        if not text:
            return self.send_error(400)
        speech = self.server.tts.say(text, speed=SPEED)
        body = wav_bytes(speech.audio, speech.sample_rate)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def start_detached(port: int, idle_exit_seconds: float):
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        subprocess.Popen(
            [
                sys.executable,
                "-I",
                os.path.abspath(__file__),
                "--port",
                str(port),
                "--idle-exit-seconds",
                str(idle_exit_seconds),
            ],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=log,
        )


def serve(port: int, idle_exit_seconds: float):
    try:
        server = VoiceServer(port, idle_exit_seconds)
    except OSError as error:
        sys.exit(f"recap voice: port {port} is not free ({error})")
    try:
        server.load_voice()
    except UnreviewedWeights as error:
        sys.exit(f"recap voice: refusing to load the model: {error}")
    threading.Thread(target=server.stop_when_idle, daemon=True).start()
    server.serve_forever()


def prepare(test_wav: str):
    os.environ["HF_HUB_OFFLINE"] = "0"
    import torch

    try:
        for path in reviewed_weight_paths().values():
            torch.load(path, map_location="cpu", weights_only=True)
    except UnreviewedWeights as error:
        sys.exit(f"recap voice: the model on Hugging Face changed since it was reviewed: {error}")
    from ema_lightning import EMA

    speech = EMA(device="cpu").say(TEST_SENTENCE, speed=SPEED)
    with open(test_wav, "wb") as f:
        f.write(wav_bytes(speech.audio, speech.sample_rate))


def main():
    parser = argparse.ArgumentParser(description="Local EMA Lightning voice for the recap plugin.")
    parser.add_argument("--port", type=int)
    parser.add_argument("--idle-exit-seconds", type=float, default=DEFAULT_IDLE_EXIT_SECONDS)
    parser.add_argument("--detach", action="store_true", help="start in the background and return at once")
    parser.add_argument(
        "--prepare",
        metavar="TEST_WAV",
        help="download and check the model, then write a test sentence to TEST_WAV",
    )
    args = parser.parse_args()
    if args.prepare:
        prepare(args.prepare)
    elif args.port is None:
        parser.error("--port is required")
    elif args.detach:
        start_detached(args.port, args.idle_exit_seconds)
    else:
        serve(args.port, args.idle_exit_seconds)


if __name__ == "__main__":
    main()
