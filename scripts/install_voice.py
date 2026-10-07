#!/usr/bin/env python3
import argparse
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VENV = Path.home() / ".local" / "share" / "recap-ema"
PYTHON_VERSION = "3.12"
PACKAGE = "ema-lightning==1.0.1"
SERVER = Path(__file__).resolve().parent.parent / "tts" / "ema_server.py"


def stop(message: str):
    sys.exit(f"recap kurulumu durdu: {message}")


def run(*argv: str):
    print("$", " ".join(argv), flush=True)
    if subprocess.run(argv).returncode != 0:
        stop(f"bu komut başarısız oldu: {' '.join(argv)}")


def main():
    parser = argparse.ArgumentParser(description="recap için yerel Türkçe sesi (EMA Lightning) kurar.")
    parser.add_argument("--no-sound", action="store_true", help="sonunda deneme cümlesini çalma")
    args = parser.parse_args()

    if platform.system() != "Darwin" or shutil.which("afplay") is None:
        stop("recap yalnız macOS'ta çalışır (afplay gerekir).")
    uv = shutil.which("uv")
    if uv is None:
        stop("uv bulunamadı. Kurmak için: brew install uv  (ya da https://docs.astral.sh/uv/)")

    python = VENV / "bin" / "python"
    if not python.exists():
        run(uv, "venv", "--python", PYTHON_VERSION, str(VENV))
    run(uv, "pip", "install", "--python", str(python), PACKAGE)

    test_wav = Path(tempfile.gettempdir()) / "recap-kurulum-denemesi.wav"
    run(str(python), "-I", str(SERVER), "--prepare", str(test_wav))
    if not args.no_sound:
        run("afplay", str(test_wav))
    test_wav.unlink(missing_ok=True)

    print(f"\nrecap sesi hazır: {VENV}")
    print("Model dosyaları incelenen sürümle aynı ve kod içermiyor; ses bundan sonra internetsiz üretilir.")


if __name__ == "__main__":
    main()
