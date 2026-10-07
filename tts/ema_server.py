import argparse
import fcntl
import hashlib
import io
import json
import os
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler

import numpy as np

MAX_BODY_BYTES = 64 * 1024
SPEED = 1.0
DEVICE = "cpu"
DEFAULT_IDLE_EXIT_SECONDS = 15 * 60
IDLE_CHECK_SECONDS = 30
DETACH_READY_SECONDS = 10
READY_POLL_SECONDS = 0.05
LOG_PATH = os.path.join(tempfile.gettempdir(), "recap-voice-server.log")
MODEL_REPO = "canberkkkkkk/ema-lightning"
# ema-lightning unpickles these with torch.load(weights_only=False), which can run code;
# only the exact bytes reviewed for this release are ever loaded.
REVIEWED_WEIGHTS_SHA256 = {
    "ema.pt": "95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6",
    "decoder.pt": "9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67",
}
TEST_SENTENCE = "Recap kuruldu. Sesli özetler hazır."


class UnreviewedWeights(Exception):
    pass


class UnsafeSocketFolder(Exception):
    pass


def reviewed_weights(local_only: bool) -> dict:
    from huggingface_hub import hf_hub_download

    weights = {}
    for name, expected in REVIEWED_WEIGHTS_SHA256.items():
        path = hf_hub_download(MODEL_REPO, name, local_files_only=local_only)
        with open(path, "rb") as f:
            data = f.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise UnreviewedWeights(f"{name} is not the reviewed file ({path})")
        weights[name] = data
    return weights


def voice_from(weights: dict):
    from ema_lightning import EMA
    from ema_lightning.decoder import load_decoder
    from ema_lightning.frontend import Frontend
    from ema_lightning.model import load_acoustic

    model = load_acoustic(io.BytesIO(weights["ema.pt"]), DEVICE)
    decoder = load_decoder(io.BytesIO(weights["decoder.pt"]), DEVICE)
    return EMA._from_parts(model, decoder, Frontend(model.vocab), DEVICE)


def wav_bytes(audio: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm.tobytes())
    return buffer.getvalue()


def private_folder(path: str):
    os.makedirs(path, mode=0o700, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise UnsafeSocketFolder(f"{path} is not a folder owned by this user")
    os.chmod(path, 0o700)


class VoiceServer(socketserver.UnixStreamServer):
    def __init__(self, socket_path: str, idle_exit_seconds: float):
        self.socket_path = socket_path
        if os.path.exists(socket_path):
            os.unlink(socket_path)
        super().__init__(socket_path, SpeakHandler)
        os.chmod(socket_path, 0o600)
        self.idle_exit_seconds = idle_exit_seconds
        self.last_used = time.monotonic()
        self.tts = None

    def stop_soon(self):
        threading.Thread(target=self.shutdown, daemon=True).start()

    def stop_when_idle(self):
        while True:
            time.sleep(min(IDLE_CHECK_SECONDS, self.idle_exit_seconds))
            if time.monotonic() - self.last_used >= self.idle_exit_seconds:
                self.shutdown()
                return

    def server_close(self):
        super().server_close()
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)


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


def is_listening(socket_path: str) -> bool:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        try:
            probe.connect(socket_path)
            return True
        except OSError:
            return False


def start_detached(socket_path: str, idle_exit_seconds: float):
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        child = subprocess.Popen(
            [
                sys.executable,
                "-I",
                os.path.abspath(__file__),
                "--socket",
                socket_path,
                "--idle-exit-seconds",
                str(idle_exit_seconds),
            ],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=log,
        )
    # curl does not retry a socket file that does not exist yet, so return only once it accepts.
    deadline = time.monotonic() + DETACH_READY_SECONDS
    while time.monotonic() < deadline and child.poll() is None and not is_listening(socket_path):
        time.sleep(READY_POLL_SECONDS)


def serve(socket_path: str, idle_exit_seconds: float):
    folder = os.path.dirname(socket_path)
    try:
        private_folder(folder)
    except UnsafeSocketFolder as error:
        sys.exit(f"recap voice: {error}")
    lock = open(os.path.join(folder, "voice.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("recap voice: already running")
    try:
        server = VoiceServer(socket_path, idle_exit_seconds)
    except OSError as error:
        sys.exit(f"recap voice: cannot listen on {socket_path} ({error})")
    try:
        server.tts = voice_from(reviewed_weights(local_only=True))
    except UnreviewedWeights as error:
        server.server_close()
        sys.exit(f"recap voice: refusing to load the model: {error}")
    threading.Thread(target=server.stop_when_idle, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()


def prepare(test_wav: str):
    import torch

    try:
        weights = reviewed_weights(local_only=False)
    except UnreviewedWeights as error:
        sys.exit(f"recap voice: the model on Hugging Face changed since it was reviewed: {error}")
    for data in weights.values():
        torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    speech = voice_from(weights).say(TEST_SENTENCE, speed=SPEED)
    with open(test_wav, "wb") as f:
        f.write(wav_bytes(speech.audio, speech.sample_rate))


def main():
    parser = argparse.ArgumentParser(description="Local EMA Lightning voice for the recap plugin.")
    parser.add_argument("--socket", help="Unix socket to serve on; its folder is made private to this user")
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
    elif args.socket is None:
        parser.error("--socket is required")
    elif args.detach:
        start_detached(args.socket, args.idle_exit_seconds)
    else:
        serve(args.socket, args.idle_exit_seconds)


if __name__ == "__main__":
    main()
