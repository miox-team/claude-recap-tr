import argparse
import hashlib
import hmac
import io
import json
import os
import secrets
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

IS_WINDOWS = sys.platform == "win32"
MAX_BODY_BYTES = 64 * 1024
SPEED = 1.0
DEVICE = "cpu"
DEFAULT_IDLE_EXIT_SECONDS = 15 * 60
IDLE_CHECK_SECONDS = 30
DETACH_READY_SECONDS = 10
READY_POLL_SECONDS = 0.05
BUSY_LOAD_PER_CORE = 2
SOCKET_NAME = "voice.sock"
ENDPOINT_NAME = "voice.json"
LOCK_NAME = "voice.lock"
TOKEN_HEADER = "X-Recap-Token"
LOG_PATH = os.path.join(tempfile.gettempdir(), "recap-voice-server.log")
VCREDIST_HINT = "winget install Microsoft.VCRedist.2015+.x64"
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


class UnsafeFolder(Exception):
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


def import_torch():
    try:
        import torch
    except OSError as error:
        if IS_WINDOWS:
            sys.exit(f"recap voice: PyTorch could not load ({error}). Install the Visual C++ runtime: {VCREDIST_HINT}")
        raise
    return torch


def voice_from(weights: dict):
    import_torch()
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


def temp_wav(wav: bytes) -> str:
    fd, path = tempfile.mkstemp(prefix="recap-", suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(wav)
    return path


def remove_quietly(path: str):
    try:
        os.remove(path)
    except OSError:
        pass


class AfplayPlayer:
    def __init__(self):
        self._lock = threading.Lock()
        self._process = None

    def play(self, wav: bytes, duration: float) -> bool:
        path = temp_wav(wav)
        try:
            with self._lock:
                self._stop_current()
                process = subprocess.Popen(["afplay", path])
                self._process = process
            return process.wait() == 0
        finally:
            remove_quietly(path)

    def stop(self):
        with self._lock:
            self._stop_current()

    def _stop_current(self):
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()


class TimedPlayer:
    def __init__(self, start=None, halt=None):
        self._lock = threading.Lock()
        self._interrupted = None
        self._start = start
        self._halt = halt

    def play(self, wav: bytes, duration: float) -> bool:
        path = temp_wav(wav)
        interrupted = threading.Event()
        try:
            with self._lock:
                self._interrupt_current()
                self._interrupted = interrupted
                if self._start is not None:
                    self._start(path)
            was_interrupted = interrupted.wait(duration)
            with self._lock:
                if self._interrupted is interrupted:
                    self._interrupted = None
            return not was_interrupted
        finally:
            remove_quietly(path)

    def stop(self):
        with self._lock:
            self._interrupt_current()

    def _interrupt_current(self):
        if self._interrupted is not None:
            if self._halt is not None:
                self._halt()
            self._interrupted.set()
            self._interrupted = None


def winsound_player() -> TimedPlayer:
    import winsound

    flags = winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT
    return TimedPlayer(start=lambda path: winsound.PlaySound(path, flags), halt=lambda: winsound.PlaySound(None, 0))


def player_for(silent: bool):
    if silent:
        return TimedPlayer()
    return winsound_player() if IS_WINDOWS else AfplayPlayer()


def is_busy() -> bool:
    if not hasattr(os, "getloadavg"):
        return False
    return os.getloadavg()[0] / (os.cpu_count() or 1) > BUSY_LOAD_PER_CORE


class Voice:
    def __init__(self, player, token, idle_exit_seconds: float, ignore_load: bool):
        self.player = player
        self.ignore_load = ignore_load
        self.token = token
        self.proof = secrets.token_hex(32)
        self.idle_exit_seconds = idle_exit_seconds
        self.last_used = time.monotonic()
        self.synthesis = threading.Lock()
        self.tts = None

    def is_authorized(self, presented) -> bool:
        if self.token is None:
            return True
        return presented is not None and hmac.compare_digest(presented.encode(), self.token.encode())


class VoiceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        voice: Voice = self.server.voice
        voice.last_used = time.monotonic()
        if not voice.is_authorized(self.headers.get(TOKEN_HEADER)):
            return self.answer(403, with_proof=False)
        if self.path == "/hello":
            return self.answer(200)
        if self.path == "/shutdown":
            self.answer(200)
            return threading.Thread(target=self.server.shutdown, daemon=True).start()
        if self.path == "/stop":
            voice.player.stop()
            return self.answer(200)
        if self.path != "/speak":
            return self.answer(404)
        text = self.read_text()
        if text is None:
            return self.answer(400)
        if not voice.ignore_load and is_busy():
            return self.answer(503)
        with voice.synthesis:
            speech = voice.tts.say(text, speed=SPEED)
        played = voice.player.play(wav_bytes(speech.audio, speech.sample_rate), speech.duration)
        voice.last_used = time.monotonic()
        self.answer(200 if played else 409)

    def read_text(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY_BYTES:
            return None
        try:
            text = str(json.loads(self.rfile.read(length))["text"]).strip()
        except (ValueError, KeyError, TypeError):
            return None
        return text or None

    def answer(self, code: int, with_proof: bool = True):
        body = self.server.voice.proof.encode() if with_proof else b""
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if hasattr(socketserver, "UnixStreamServer"):

    class UnixVoiceServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True


class TcpVoiceServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def private_folder(path: str):
    os.makedirs(path, mode=0o700, exist_ok=True)
    if IS_WINDOWS:
        return
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise UnsafeFolder(f"{path} is not a folder owned by this user")
    os.chmod(path, 0o700)


def hold_single_instance_lock(folder: str):
    lock = open(os.path.join(folder, LOCK_NAME), "a")
    try:
        if IS_WINDOWS:
            import msvcrt

            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit("recap voice: already running")
    return lock


def write_endpoint(path: str, endpoint: dict):
    staging = f"{path}.{os.getpid()}.tmp"
    with open(staging, "w", encoding="utf-8") as f:
        json.dump(endpoint, f)
    os.replace(staging, path)


def read_endpoint(folder: str):
    try:
        with open(os.path.join(folder, ENDPOINT_NAME), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def is_serving(folder: str, use_tcp: bool) -> bool:
    if use_tcp:
        endpoint = read_endpoint(folder)
        if endpoint is None:
            return False
        family, address = socket.AF_INET, ("127.0.0.1", endpoint["port"])
    else:
        family, address = socket.AF_UNIX, os.path.join(folder, SOCKET_NAME)
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(address)
            return True
        except OSError:
            return False


def bind(folder: str, use_tcp: bool):
    if use_tcp:
        return TcpVoiceServer(("127.0.0.1", 0), VoiceHandler)
    path = os.path.join(folder, SOCKET_NAME)
    remove_quietly(path)
    server = UnixVoiceServer(path, VoiceHandler)
    os.chmod(path, 0o600)
    return server


def serve(folder: str, idle_exit_seconds: float, use_tcp: bool, silent: bool, ignore_load: bool):
    try:
        private_folder(folder)
    except UnsafeFolder as error:
        sys.exit(f"recap voice: {error}")
    lock = hold_single_instance_lock(folder)
    artifact = os.path.join(folder, ENDPOINT_NAME if use_tcp else SOCKET_NAME)
    remove_quietly(os.path.join(folder, ENDPOINT_NAME))
    try:
        server = bind(folder, use_tcp)
    except OSError as error:
        sys.exit(f"recap voice: cannot listen in {folder} ({error})")
    voice = Voice(player_for(silent), secrets.token_hex(32) if use_tcp else None, idle_exit_seconds, ignore_load)
    server.voice = voice
    try:
        if use_tcp:
            endpoint = {"port": server.server_address[1], "token": voice.token, "proof": voice.proof, "pid": os.getpid()}
            write_endpoint(artifact, endpoint)
        voice.tts = voice_from(reviewed_weights(local_only=True))
        threading.Thread(target=stop_when_idle, args=(server, voice), daemon=True).start()
        server.serve_forever()
    except UnreviewedWeights as error:
        sys.exit(f"recap voice: refusing to load the model: {error}")
    finally:
        server.server_close()
        remove_quietly(artifact)
        lock.close()


def stop_when_idle(server, voice: Voice):
    while True:
        time.sleep(min(IDLE_CHECK_SECONDS, voice.idle_exit_seconds))
        if time.monotonic() - voice.last_used >= voice.idle_exit_seconds:
            server.shutdown()
            return


def start_detached(folder: str, idle_exit_seconds: float, use_tcp: bool, silent: bool, ignore_load: bool):
    argv = [sys.executable, "-I", os.path.abspath(__file__), "--dir", folder]
    argv += ["--idle-exit-seconds", str(idle_exit_seconds)]
    if use_tcp and not IS_WINDOWS:
        argv.append("--tcp")
    if silent:
        argv.append("--silent")
    if ignore_load:
        argv.append("--ignore-load")
    if IS_WINDOWS:
        detach = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        detach = {"start_new_session": True}
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, **detach)
    # Wait for whichever copy serves: on Windows the venv python.exe is a launcher, so child is not the server.
    deadline = time.monotonic() + DETACH_READY_SECONDS
    while time.monotonic() < deadline and not is_serving(folder, use_tcp):
        if child.poll() is not None and not is_serving(folder, use_tcp):
            return
        time.sleep(READY_POLL_SECONDS)


def check(no_sound: bool):
    torch = import_torch()
    try:
        weights = reviewed_weights(local_only=False)
    except UnreviewedWeights as error:
        sys.exit(f"recap voice: the model on Hugging Face changed since it was reviewed: {error}")
    for data in weights.values():
        torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    speech = voice_from(weights).say(TEST_SENTENCE, speed=SPEED)
    if not no_sound:
        player_for(silent=False).play(wav_bytes(speech.audio, speech.sample_rate), speech.duration)


def main():
    parser = argparse.ArgumentParser(description="Local EMA Lightning voice for the recap plugin.")
    parser.add_argument("--dir", help="private folder for the socket (macOS) or voice.json (Windows)")
    parser.add_argument("--idle-exit-seconds", type=float, default=DEFAULT_IDLE_EXIT_SECONDS)
    parser.add_argument("--detach", action="store_true", help="start in the background, return once it accepts")
    parser.add_argument("--tcp", action="store_true", help="use loopback TCP with a token (always on Windows)")
    parser.add_argument("--silent", action="store_true", help="synthesize but do not play (tests and CI)")
    parser.add_argument("--ignore-load", action="store_true", help="speak even on a busy machine (tests and CI)")
    parser.add_argument("--check", action="store_true", help="download and check the model, then say a test sentence")
    parser.add_argument("--no-sound", action="store_true", help="with --check: do not play the test sentence")
    args = parser.parse_args()
    use_tcp = IS_WINDOWS or args.tcp
    if args.check:
        check(args.no_sound)
    elif args.dir is None:
        parser.error("--dir is required")
    elif args.detach:
        start_detached(args.dir, args.idle_exit_seconds, use_tcp, args.silent, args.ignore_load)
    else:
        serve(args.dir, args.idle_exit_seconds, use_tcp, args.silent, args.ignore_load)


if __name__ == "__main__":
    main()
