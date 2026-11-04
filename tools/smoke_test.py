"""Checks login, libraries, items, details and PlaybackInfo against a real server (without mpv).
Usage: python tools/smoke_test.py http://jellyfin.local:8096 <user>  (the password is prompted)"""
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jellyfin import Jellyfin, streams  # noqa: E402


def main():
    server, user = sys.argv[1], sys.argv[2]
    jf = Jellyfin(server, "smoke-test")
    jf.login(user, getpass.getpass("Password: "))
    print("Login OK, user", jf.user_id)
    libs = jf.libraries()
    print("Libraries:", [(v["Name"], v.get("CollectionType")) for v in libs])
    for v in libs:
        items = jf.items(v["Id"])
        print(f"- {v['Name']}: {len(items)} Items", [i["Name"] for i in items[:3]])
        if not items:
            continue
        first = items[0]
        d = jf.detail(first["Id"])
        if d["Type"] == "Series":
            eps = jf.episodes(first["Id"])
            print("  Series", d["Name"], "episodes:", len(eps))
            d = jf.detail(eps[0]["Id"]) if eps else d  # episode lists come without tracks
        st, ms = streams(d)
        print("  Tracks:", st)
        if d["Type"] != "Series":
            info = jf.playback_info(d["Id"])
            print("  PlaybackInfo: PlaySessionId", bool(info.get("PlaySessionId")), "| Stream:", jf.stream_url(d["Id"], ms, info["PlaySessionId"]).split("api_key")[0] + "api_key=…")
    jf.logout()
    print("Logout OK")


if __name__ == "__main__":
    main()
