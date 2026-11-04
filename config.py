"""Settings and tokens. Config file: %APPDATA%\\unfold or ~/.config/unfold. Tokens go to the keyring if available."""
import json
import os
import threading
from pathlib import Path

try:
    import keyring
except ImportError:
    keyring = None

SERVICE = "unfold"


def _dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / "unfold"
    d.mkdir(parents=True, exist_ok=True)
    return d


FILE = _dir() / "config.json"
_lock = threading.Lock()  # JS calls arrive on several threads


def load() -> dict:
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError:  # broken file: keep it for inspection instead of overwriting it with an empty config
        FILE.replace(FILE.with_suffix(".json.bad"))
        return {}


def save(cfg: dict) -> None:
    """Write to a temp file and swap it in, so a crash never leaves a half-written config."""
    tmp = FILE.with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, FILE)


def set_token(cfg: dict, token: str) -> None:
    """Store the token in the keyring; without a keyring (or on error) fall back to the config file."""
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
        try:
            t = keyring.get_password(SERVICE, f"{cfg['user']}@{cfg['server']}")
            if t:
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
