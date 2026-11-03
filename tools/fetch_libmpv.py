"""Lädt libmpv-2.dll (Windows x64) aus dem aktuellen shinchiro/mpv-winbuild-cmake-Release nach lib/.
Benötigt 7-Zip (7z.exe im PATH oder in C:\\Program Files\\7-Zip), da das Archiv den BCJ2-Filter nutzt."""
import json
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
LIB = Path(__file__).resolve().parent.parent / "lib"


def find_7z() -> str:
    exe = shutil.which("7z") or next((p for p in (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe") if Path(p).exists()), None)
    if not exe:
        raise SystemExit("7-Zip nicht gefunden (winget install 7zip.7zip)")
    return exe


def main():
    with urllib.request.urlopen(urllib.request.Request(API, headers={"User-Agent": "unfold"})) as r:
        rel = json.load(r)
    asset = next(a for a in rel["assets"] if re.fullmatch(r"mpv-dev-x86_64-\d.*\.7z", a["name"]))
    print("Lade", asset["name"], f"({asset['size'] // 1024 // 1024} MB)")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        arc = Path(tmp) / asset["name"]
        urllib.request.urlretrieve(asset["browser_download_url"], arc)
        subprocess.run([find_7z(), "x", "-y", f"-o{tmp}", str(arc), "libmpv-2.dll", "-r"], check=True, stdout=subprocess.DEVNULL)
        dll = next(Path(tmp).rglob("libmpv-2.dll"))
        LIB.mkdir(exist_ok=True)
        shutil.copy2(dll, LIB / "libmpv-2.dll")
    print("OK ->", LIB / "libmpv-2.dll")


if __name__ == "__main__":
    main()
