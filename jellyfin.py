"""Minimal Jellyfin client (stdlib only). Auth header and playback reports modelled on JellyCon."""
import json
import urllib.error
import urllib.parse
import urllib.request

from errors import AppError as JellyfinError  # errors carry a code, the frontend translates it

TICKS = 10_000_000  # Jellyfin ticks per second
CLIENT, VERSION = "Unfold", "0.2"


def normalize(server: str) -> str:
    server = server.strip().rstrip("/")
    if not server:
        raise JellyfinError("no_server")
    if "://" not in server:
        server = "http://" + server
    return server


class Jellyfin:
    def __init__(self, server: str, device_id: str, token: str | None = None, user_id: str | None = None):
        self.server = normalize(server)
        self.device_id = device_id
        self.token = token
        self.user_id = user_id

    # ---- HTTP ----
    def _auth(self) -> str:
        h = f'MediaBrowser Client="{CLIENT}", Device="Desktop", DeviceId="{self.device_id}", Version="{VERSION}"'
        return h + (f', Token="{self.token}"' if self.token else "")

    def _req(self, method: str, path: str, params: dict | None = None, body: dict | None = None):
        url = self.server + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": self._auth(), "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise JellyfinError("auth") from e
            raise JellyfinError("server_error", code=e.code) from e
        except urllib.error.URLError as e:
            raise JellyfinError("unreachable", reason=str(e.reason)) from e

    # ---- Account ----
    def login(self, user: str, password: str) -> None:
        r = self._req("POST", "/Users/AuthenticateByName", body={"Username": user, "Pw": password})
        self.token = r["AccessToken"]
        self.user_id = r["User"]["Id"]

    def logout(self) -> None:
        try:
            self._req("POST", "/Sessions/Logout")
        except JellyfinError:
            pass
        self.token = None

    # ---- Library ----
    def libraries(self) -> list[dict]:
        r = self._req("GET", "/UserViews", {"userId": self.user_id})
        return r.get("Items", [])

    def items(self, parent_id: str) -> list[dict]:
        r = self._req("GET", "/Items", {
            "userId": self.user_id, "ParentId": parent_id, "Recursive": "true",
            "IncludeItemTypes": "Movie,Series", "SortBy": "SortName", "SortOrder": "Ascending",
            "Fields": "ProductionYear"})
        return r.get("Items", [])

    def search(self, term: str, limit: int = 100) -> list[dict]:
        r = self._req("GET", "/Items", {
            "userId": self.user_id, "searchTerm": term, "Recursive": "true",
            "IncludeItemTypes": "Movie,Series", "Limit": limit, "Fields": "ProductionYear"})
        return r.get("Items", [])

    def detail(self, item_id: str) -> dict:
        return self._req("GET", f"/Users/{self.user_id}/Items/{item_id}")

    def episodes(self, series_id: str) -> list[dict]:
        r = self._req("GET", f"/Shows/{series_id}/Episodes", {
            "userId": self.user_id, "IsMissing": "false", "IsVirtualUnAired": "false",
            "Fields": "MediaSources,MediaStreams,Overview"})
        return r.get("Items", [])

    def poster_url(self, item: dict, max_height: int = 500) -> str | None:
        tag = (item.get("ImageTags") or {}).get("Primary")
        if not tag:
            return None
        return f"{self.server}/Items/{item['Id']}/Images/Primary?maxHeight={max_height}&tag={tag}&api_key={self.token}"

    # ---- Playback ----
    def playback_info(self, item_id: str) -> dict:
        """Returns PlaySessionId and MediaSources (direct play is allowed, mpv plays almost anything)."""
        return self._req("POST", f"/Items/{item_id}/PlaybackInfo", {"UserId": self.user_id}, {"UserId": self.user_id})

    def stream_url(self, item_id: str, media_source_id: str, play_session_id: str) -> str:
        q = urllib.parse.urlencode({
            "static": "true", "MediaSourceId": media_source_id, "PlaySessionId": play_session_id,
            "DeviceId": self.device_id, "api_key": self.token})
        return f"{self.server}/Videos/{item_id}/stream?{q}"

    def subtitle_url(self, item_id: str, media_source_id: str, index: int, fmt: str) -> str:
        return f"{self.server}/Videos/{item_id}/{media_source_id}/Subtitles/{index}/Stream.{fmt}?api_key={self.token}"

    def report(self, kind: str, item_id: str, media_source_id: str, play_session_id: str,
               position_s: float = 0, runtime_ticks: int | None = None, paused: bool = False) -> None:
        """kind: '' (start), 'Progress' or 'Stopped'."""
        body = {"ItemId": item_id, "MediaSourceId": media_source_id, "PlaySessionId": play_session_id,
                "PositionTicks": int(position_s * TICKS), "PlayMethod": "DirectStream",
                "CanSeek": True, "IsPaused": paused}
        if runtime_ticks:
            body["RunTimeTicks"] = runtime_ticks
        path = "/Sessions/Playing" + (f"/{kind}" if kind else "")
        try:
            self._req("POST", path, body=body)
        except JellyfinError:
            pass  # reporting must never disturb playback


# External subtitles: text only (the server can convert them); codec -> format of the stream URL
SUB_FORMATS = {"srt": "srt", "subrip": "srt", "ass": "ass", "ssa": "ass", "vtt": "vtt", "webvtt": "vtt"}


def _media_streams(dto: dict) -> list[dict]:
    src = (dto.get("MediaSources") or [{}])[0]
    return src.get("MediaStreams") or dto.get("MediaStreams") or []


def external_subs(dto: dict) -> list[dict]:
    """External text subtitles in order: [{'index': <Jellyfin stream index>, 'fmt': 'srt'|'ass'|'vtt'}]."""
    return [{"index": s["Index"], "fmt": SUB_FORMATS[(s.get("Codec") or "").lower()]}
            for s in _media_streams(dto)
            if s.get("Type") == "Subtitle" and s.get("IsExternal") and (s.get("Codec") or "").lower() in SUB_FORMATS]


def streams(dto: dict) -> tuple[dict, str]:
    """Track names per type and the MediaSourceId. Subtitles: embedded ones first (mpv order), then the
    external ones (loaded by mpv afterwards); 'Off' is always the last subtitle entry."""
    src = (dto.get("MediaSources") or [{}])[0]
    out = {"v": [], "a": [], "s": []}
    ext = []
    for s in _media_streams(dto):
        name = s.get("DisplayTitle") or s.get("Title") or s.get("Language") or "?"
        t = s.get("Type")
        if t == "Video":
            out["v"].append(name)
        elif t == "Audio":
            out["a"].append(name)
        elif t == "Subtitle":
            if not s.get("IsExternal"):
                out["s"].append(name)
            elif (s.get("Codec") or "").lower() in SUB_FORMATS:  # same selection and order as external_subs()
                ext.append(name)
    out["s"] += ext
    out["s"].append("Aus")
    return out, src.get("Id") or dto["Id"]


def minutes(dto: dict) -> int:
    return round((dto.get("RunTimeTicks") or 0) / TICKS / 60)
