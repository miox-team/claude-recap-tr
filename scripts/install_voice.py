#!/usr/bin/env python3
import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

SYSTEM = platform.system()
IS_WINDOWS = SYSTEM == "Windows"
VENV = Path.home() / ".local" / "share" / "recap-ema"
PYTHON_VERSION = "3.12"
PACKAGE = "ema-lightning==1.0.1"
SERVER = Path(__file__).resolve().parent.parent / "tts" / "ema_server.py"
UV_INSTALL_HINT = (
    "winget install --id astral-sh.uv -e" if IS_WINDOWS else "brew install uv"
) + "  (ya da https://docs.astral.sh/uv/)"


def stop(message: str):
    sys.exit(f"recap kurulumu durdu: {message}")


def run(*argv: str):
    print("$", " ".join(argv), flush=True)
    if subprocess.run(argv).returncode != 0:
        stop(f"bu komut başarısız oldu: {' '.join(argv)}")


def find_uv():
    # A fresh winget or installer run is not on the PATH of an already running shell.
    candidates = [shutil.which("uv"), os.environ.get("UV")]
    if IS_WINDOWS:
        local = os.environ.get("LOCALAPPDATA", "")
        candidates.append(str(Path(local, "Microsoft", "WinGet", "Links", "uv.exe")))
        candidates.append(str(Path.home() / ".local" / "bin" / "uv.exe"))
    else:
        candidates.append(str(Path.home() / ".local" / "bin" / "uv"))
    return next((c for c in candidates if c and Path(c).is_file()), None)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="recap için yerel Türkçe sesi (EMA Lightning) kurar.")
    parser.add_argument("--no-sound", action="store_true", help="sonunda deneme cümlesini çalma")
    args = parser.parse_args()

    if SYSTEM == "Darwin" and shutil.which("afplay") is None:
        stop("macOS'ta afplay bulunamadı.")
    if SYSTEM not in ("Darwin", "Windows"):
        stop(f"recap yalnız macOS ve Windows'ta çalışır; bu sistem {SYSTEM} (WSL de desteklenmez).")
    uv = find_uv()
    if uv is None:
        stop(f"uv bulunamadı. Kurmak için: {UV_INSTALL_HINT}")

    python = venv_python()
    if not python.exists():
        run(uv, "venv", "--python", PYTHON_VERSION, str(VENV))
    run(uv, "pip", "install", "--python", str(python), PACKAGE)

    check = [str(python), "-I", str(SERVER), "--check"]
    run(*(check + ["--no-sound"] if args.no_sound else check))

    print(f"\nrecap sesi hazır: {VENV}")
    print("Model dosyaları incelenen sürümle aynı ve kod içermiyor; ses bundan sonra internetsiz üretilir.")


if __name__ == "__main__":
    main()
