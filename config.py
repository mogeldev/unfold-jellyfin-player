"""Einstellungen und Token. Config-Datei: %APPDATA%\\jfplayer bzw. ~/.config/jfplayer. Token im Keyring, falls vorhanden."""
import json
import os
import uuid
from pathlib import Path

try:
    import keyring
except ImportError:
    keyring = None

SERVICE = "unfold"
LEGACY_SERVICE = "jfplayer"  # alter Name der App: vorhandene Anmeldung weiterverwenden


def _dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / "unfold"
    old = base / "jfplayer"
    if old.exists() and not d.exists():
        old.rename(d)
    d.mkdir(parents=True, exist_ok=True)
    return d


FILE = _dir() / "config.json"


def load() -> dict:
    try:
        cfg = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {}
    if "device_id" not in cfg:
        cfg["device_id"] = uuid.uuid4().hex
        save(cfg)
    return cfg


def save(cfg: dict) -> None:
    FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        os.chmod(FILE, 0o600)
    except OSError:
        pass


def set_token(cfg: dict, token: str) -> None:
    """Token in den Keyring; ohne Keyring (oder bei Fehler) Fallback auf die Config-Datei."""
    if keyring:
        try:
            keyring.set_password(SERVICE, f"{cfg['user']}@{cfg['server']}", token)
            cfg.pop("token", None)
            return
        except Exception:
            pass
    cfg["token"] = token


def get_token(cfg: dict) -> str | None:
    if keyring and cfg.get("user") and cfg.get("server"):
        account = f"{cfg['user']}@{cfg['server']}"
        try:
            t = keyring.get_password(SERVICE, account)
            if t:
                return t
            t = keyring.get_password(LEGACY_SERVICE, account)  # Token aus der Zeit vor der Umbenennung übernehmen
            if t:
                keyring.set_password(SERVICE, account, t)
                return t
        except Exception:
            pass
    return cfg.get("token")


def clear_token(cfg: dict) -> None:
    if keyring and cfg.get("user") and cfg.get("server"):
        try:
            keyring.delete_password(SERVICE, f"{cfg['user']}@{cfg['server']}")
        except Exception:
            pass
    cfg.pop("token", None)
