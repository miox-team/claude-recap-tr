#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
SERVER = Path(__file__).resolve().parent.parent / "tts" / "ema_server.py"
VENV_PYTHON = Path.home() / ".local" / "share" / "recap-ema" / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")
LONG_TEXT = "Bu cümle, durdurma isteğinin konuşmayı yarıda kesip kesmediğini görmek için yeterince uzun tutuldu."
failures = []


def report(name: str, ok: bool, detail: str = ""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}", flush=True)
    if not ok:
        failures.append(name)


class Harness:
    def __init__(self, python: str, folder: str, use_tcp: bool, silent: bool):
        self.python = python
        self.folder = folder
        self.use_tcp = use_tcp
        self.silent = silent

    def server_argv(self, server: Path = SERVER) -> list:
        argv = [self.python, "-I", str(server), "--dir", self.folder]
        if self.use_tcp and not IS_WINDOWS:
            argv.append("--tcp")
        if self.silent:
            argv.append("--silent")
        return argv

    def start(self, *extra: str):
        subprocess.run(self.server_argv() + ["--detach", *extra], check=True)

    def endpoint(self):
        try:
            return json.loads(Path(self.folder, "voice.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def request(self, path: str, text=None, token=None):
        argv = ["curl", "-s", "--connect-timeout", "1", "--max-time", "60", "-w", "\n%{http_code}", "-X", "POST"]
        stdin = None
        if text is not None:
            argv += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
            stdin = json.dumps({"text": text})
        if self.use_tcp:
            endpoint = self.endpoint() or {"port": 9, "token": ""}
            argv += ["-H", f"X-Recap-Token: {endpoint['token'] if token is None else token}"]
            argv.append(f"http://127.0.0.1:{endpoint['port']}/{path}")
        else:
            argv += ["--unix-socket", str(Path(self.folder, "voice.sock")), f"http://localhost/{path}"]
        out = subprocess.run(argv, input=stdin, capture_output=True, text=True, encoding="utf-8").stdout
        body, _, code = out.rpartition("\n")
        return code.strip(), body

    def artifact_exists(self) -> bool:
        return Path(self.folder, "voice.json" if self.use_tcp else "voice.sock").exists()

    def serving_pid(self):
        if self.use_tcp:
            return (self.endpoint() or {}).get("pid")
        out = subprocess.run(["lsof", "-t", str(Path(self.folder, "voice.sock"))], capture_output=True, text=True).stdout
        return int(out.split()[0]) if out.split() else None


def wait(condition, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.1)
    return condition()


def kill(pid: int):
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    else:
        os.kill(pid, signal.SIGKILL)


def run_checks(h: Harness):
    print(f"platform={sys.platform} AF_UNIX={hasattr(socket, 'AF_UNIX')} transport={'tcp' if h.use_tcp else 'unix'}")

    h.start()
    code, proof = h.request("speak", "Hemen.")
    expected_proof = (h.endpoint() or {}).get("proof") if h.use_tcp else proof
    report("speak right after --detach returns", code == "200" and bool(proof) and proof == expected_proof, code)

    if h.use_tcp:
        code, body = h.request("speak", "Bir.", token="")
        report("no token is refused without proof", code == "403" and body == "", code)
        code, body = h.request("speak", "Bir.", token="0" * 64)
        report("wrong token is refused", code == "403" and body == "", code)

    answer = {}
    speaking = threading.Thread(target=lambda: answer.setdefault("speak", h.request("speak", LONG_TEXT)))
    speaking.start()
    stop_code = ""
    deadline = time.monotonic() + 30
    while speaking.is_alive() and time.monotonic() < deadline:
        time.sleep(0.5)
        stop_code, _ = h.request("stop")
    speaking.join(30)
    report("stop interrupts speech", stop_code == "200" and answer.get("speak", ("",))[0] == "409", f"{stop_code}/{answer.get('speak', ('?',))[0]}")

    second = subprocess.run(h.server_argv(), capture_output=True, text=True, timeout=60)
    report("second server refuses to start", second.returncode != 0 and "already running" in second.stderr, second.stderr.strip()[-60:])
    report("first server still speaks", h.request("speak", "İki.")[0] == "200")

    old = h.endpoint()
    kill(h.serving_pid())
    wait(lambda: h.request("stop")[0] != "200", 10)
    report("killed server leaves a stale artifact", h.artifact_exists())
    h.start()
    new = h.endpoint()
    code, _ = h.request("speak", "Üç.")
    rotated = (not h.use_tcp) or (new is not None and old is not None and new["token"] != old["token"])
    report("restart after a crash replaces the stale artifact", code == "200" and rotated, code)

    code, _ = h.request("shutdown")
    report("shutdown removes the artifact", code == "200" and wait(lambda: not h.artifact_exists(), 10), code)

    h.start("--idle-exit-seconds", "2")
    report("idle server exits and cleans up", wait(lambda: h.artifact_exists(), 10) and wait(lambda: not h.artifact_exists(), 20))

    tampered = Path(h.folder).parent / "tampered_server.py"
    tampered.write_text(SERVER.read_text(encoding="utf-8").replace('"95aec03d', '"00000000'), encoding="utf-8")
    refused = subprocess.run(h.server_argv(tampered), capture_output=True, text=True, timeout=120)
    report(
        "unreviewed model is refused and cleaned up",
        refused.returncode != 0 and "refusing to load the model" in refused.stderr and not h.artifact_exists(),
        refused.stderr.strip()[-60:],
    )

    node = shutil.which("node")
    if node:
        launch = "const r=require('child_process').spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status)"
        subprocess.run([node, "-e", launch, *h.server_argv(), "--detach"], check=True)
        report("server outlives the process that started it", h.request("speak", "Dört.")[0] == "200")
        h.request("shutdown")
        wait(lambda: not h.artifact_exists(), 10)


def main():
    parser = argparse.ArgumentParser(description="Checks the recap voice server end to end on this machine.")
    parser.add_argument("--python", default=str(VENV_PYTHON), help="the recap-ema virtualenv python")
    parser.add_argument("--tcp", action="store_true", help="use the Windows transport on macOS too")
    parser.add_argument("--silent", action="store_true", help="do not play audio (CI)")
    args = parser.parse_args()
    root = tempfile.mkdtemp(prefix="recap-check-")
    try:
        run_checks(Harness(args.python, os.path.join(root, "recap"), IS_WINDOWS or args.tcp, args.silent))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"\n{len(failures)} failed" if failures else "\nall checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
