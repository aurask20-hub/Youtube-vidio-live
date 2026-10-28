import hmac
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

from flask import Flask, jsonify, render_template, request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
VIDEO_PATH = "/tmp/video.mp4"
UPLOAD_TMP_PATH = "/tmp/video_upload.tmp"
RTMP_URL = "rtmp://a.rtmp.youtube.com/live2/"

# Optional: set ADMIN_PASSWORD in Render Environment to protect Start/Stop.
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

# Optional: YouTube Data API v3 key (for viewers / likes / subscribers).
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
STATS_INTERVAL = 30  # seconds between YouTube API polls (2-3 quota units each)

CHANNEL_PATTERN = re.compile(r"(@[A-Za-z0-9_.\-]+|UC[A-Za-z0-9_\-]{22})")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB upload limit

# ---------------------------------------------------------------------------
# Global state (ffmpeg process is global so /stop can kill it)
# ---------------------------------------------------------------------------
lock = threading.RLock()
ffmpeg_process = None      # subprocess.Popen | None
want_live = False          # True while the user wants the stream running
stream_key = None
started_at = None
restarts = 0
log_lines = deque(maxlen=12)

# YouTube stats state
def _normalize_channel(text):
    m = CHANNEL_PATTERN.search(text or "")
    return m.group(1) if m else ""


channel_ref = _normalize_channel(os.environ.get("YOUTUBE_CHANNEL", ""))
stats_wakeup = threading.Event()
yt = {
    "viewers": None,
    "likes": None,
    "views": None,
    "subscribers": None,
    "hidden_subs": False,
    "title": None,
    "video_id": None,
    "error": None,
    "updated": None,
}


def _reset_stats():
    for k in ("viewers", "likes", "views", "subscribers", "title", "video_id", "error", "updated"):
        yt[k] = None
    yt["hidden_subs"] = False


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------
def build_command(key):
    return [
        "ffmpeg",
        "-stream_loop", "-1",
        "-re",
        "-i", VIDEO_PATH,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-b:v", "2500k",
        "-c:a", "aac",
        "-b:a", "128k",
        "-f", "flv",
        RTMP_URL + key,
    ]


def _drain_stderr(proc, key):
    """Read ffmpeg output so the pipe never fills up and blocks ffmpeg."""
    try:
        for line in proc.stderr:
            line = line.strip()
            if line:
                log_lines.append(line.replace(key, "****"))
    except Exception:
        pass


def _spawn_ffmpeg():
    """Start ffmpeg. Caller must hold the lock."""
    global ffmpeg_process
    proc = subprocess.Popen(
        build_command(stream_key),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        bufsize=1,
    )
    ffmpeg_process = proc
    threading.Thread(
        target=_drain_stderr, args=(proc, stream_key), daemon=True
    ).start()


def _kill_ffmpeg():
    """Stop ffmpeg if it is running. Caller must hold the lock."""
    global ffmpeg_process
    proc = ffmpeg_process
    ffmpeg_process = None
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def is_running():
    return ffmpeg_process is not None and ffmpeg_process.poll() is None


def _watchdog():
    """If ffmpeg dies by itself (network drop etc.) while live is wanted,
    start it again automatically. This keeps the stream 24/7."""
    global restarts
    while True:
        time.sleep(5)
        with lock:
            if want_live and not is_running():
                log_lines.append("ffmpeg stopped unexpectedly - restarting...")
                try:
                    _spawn_ffmpeg()
                    restarts += 1
                except Exception as exc:  # noqa: BLE001
                    log_lines.append(f"restart failed: {exc}")


threading.Thread(target=_watchdog, daemon=True).start()


# ---------------------------------------------------------------------------
# YouTube stats (Data API v3)
# ---------------------------------------------------------------------------
def _yt_get(endpoint, **params):
    params["key"] = YOUTUBE_API_KEY
    url = "https://www.googleapis.com/youtube/v3/%s?%s" % (
        endpoint,
        urllib.parse.urlencode(params),
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        msg = ""
        try:
            msg = json.loads(exc.read().decode())["error"]["message"]
        except Exception:
            pass
        raise RuntimeError("YouTube API error %s: %s" % (exc.code, msg or "request failed"))
    except urllib.error.URLError:
        raise RuntimeError("Could not reach the YouTube API.")


def _poll_youtube(ref):
    # 1) Channel: subscribers + uploads playlist
    params = {"part": "statistics,contentDetails"}
    if ref.startswith("@"):
        params["forHandle"] = ref
    else:
        params["id"] = ref
    ch = _yt_get("channels", **params)
    items = ch.get("items") or []
    if not items:
        raise RuntimeError("Channel not found. Check the channel ID or @handle.")
    channel = items[0]
    cstats = channel.get("statistics", {})
    hidden = bool(cstats.get("hiddenSubscriberCount"))
    subs = None if hidden else int(cstats.get("subscriberCount", 0))

    # 2) Find the live video (cached after first detection)
    with lock:
        cached_id = yt["video_id"]
    if cached_id:
        ids = [cached_id]
    else:
        uploads = channel["contentDetails"]["relatedPlaylists"]["uploads"]
        pl = _yt_get("playlistItems", part="contentDetails", playlistId=uploads, maxResults=5)
        ids = [i["contentDetails"]["videoId"] for i in pl.get("items", [])]

    live = None
    if ids:
        vids = _yt_get("videos", part="snippet,statistics,liveStreamingDetails", id=",".join(ids))
        for v in vids.get("items", []):
            d = v.get("liveStreamingDetails")
            if d and d.get("actualStartTime") and not d.get("actualEndTime"):
                live = v
                break

    with lock:
        yt["subscribers"] = subs
        yt["hidden_subs"] = hidden
        yt["error"] = None
        yt["updated"] = time.time()
        if live:
            d = live["liveStreamingDetails"]
            s = live.get("statistics", {})
            yt["video_id"] = live["id"]
            yt["viewers"] = int(d["concurrentViewers"]) if "concurrentViewers" in d else None
            yt["likes"] = int(s["likeCount"]) if "likeCount" in s else None
            yt["views"] = int(s["viewCount"]) if "viewCount" in s else None
            yt["title"] = live["snippet"].get("title")
        else:
            yt["video_id"] = None
            yt["viewers"] = yt["likes"] = yt["views"] = yt["title"] = None


def _stats_worker():
    while True:
        stats_wakeup.wait(STATS_INTERVAL)
        stats_wakeup.clear()
        with lock:
            active = is_running()
            ref = channel_ref
        if not (YOUTUBE_API_KEY and ref and active):
            continue
        try:
            _poll_youtube(ref)
        except Exception as exc:  # noqa: BLE001
            with lock:
                yt["error"] = str(exc)


threading.Thread(target=_stats_worker, daemon=True).start()


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------
def _auth_error():
    if not ADMIN_PASSWORD:
        return None
    supplied = (
        request.headers.get("X-Admin-Password")
        or request.form.get("password")
        or request.args.get("password")
        or ""
    )
    if hmac.compare_digest(supplied.encode(), ADMIN_PASSWORD.encode()):
        return None
    return jsonify(ok=False, message="Wrong or missing admin password."), 401


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return "ok", 200


@app.route("/status")
def status():
    with lock:
        live = is_running()
        uptime = int(time.time() - started_at) if (live and started_at) else 0
        video_mb = (
            round(os.path.getsize(VIDEO_PATH) / (1024 * 1024), 1)
            if os.path.exists(VIDEO_PATH)
            else None
        )
        return jsonify(
            live=live,
            uptime=uptime,
            uptime_minutes=uptime // 60,
            restarts=restarts,
            video_mb=video_mb,
            logs=list(log_lines),
            auth_required=bool(ADMIN_PASSWORD),
            stats={
                "enabled": bool(YOUTUBE_API_KEY and channel_ref),
                "api_key_set": bool(YOUTUBE_API_KEY),
                "channel": channel_ref,
                "viewers": yt["viewers"],
                "likes": yt["likes"],
                "views": yt["views"],
                "subscribers": yt["subscribers"],
                "hidden_subs": yt["hidden_subs"],
                "title": yt["title"],
                "detected": bool(yt["video_id"]),
                "error": yt["error"],
                "updated_ago": int(time.time() - yt["updated"]) if yt["updated"] else None,
            },
        )


@app.route("/start", methods=["POST"])
def start():
    global want_live, stream_key, started_at, restarts, channel_ref

    denied = _auth_error()
    if denied:
        return denied

    key = request.form.get("stream_key", "").strip()
    if not key:
        return jsonify(ok=False, message="Enter your YouTube Stream Key."), 400
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", key):
        return jsonify(ok=False, message="Stream Key has invalid characters."), 400

    channel_text = request.form.get("channel", "").strip()
    new_channel = _normalize_channel(channel_text)
    if channel_text and not new_channel:
        return jsonify(
            ok=False,
            message="Channel must be an @handle (like @mychannel) or a channel ID starting with UC.",
        ), 400

    video = request.files.get("video")
    has_new_video = bool(video and video.filename)

    # Stop any running stream first, so the video file is not in use.
    with lock:
        want_live = False
        _kill_ffmpeg()

    if has_new_video:
        video.save(UPLOAD_TMP_PATH)
        os.replace(UPLOAD_TMP_PATH, VIDEO_PATH)
    elif not os.path.exists(VIDEO_PATH):
        return jsonify(ok=False, message="Upload a video file first."), 400

    with lock:
        try:
            stream_key = key
            if new_channel:
                channel_ref = new_channel
            log_lines.clear()
            _reset_stats()
            restarts = 0
            _spawn_ffmpeg()
            want_live = True
            started_at = time.time()
            stats_wakeup.set()
        except FileNotFoundError:
            return jsonify(ok=False, message="ffmpeg is not installed on the server."), 500
        except Exception as exc:  # noqa: BLE001
            return jsonify(ok=False, message=f"Could not start ffmpeg: {exc}"), 500

    return jsonify(ok=True, message="Live started. Your video will loop 24/7.")


@app.route("/stop", methods=["GET", "POST"])
def stop():
    global want_live, started_at

    denied = _auth_error()
    if denied:
        return denied

    with lock:
        want_live = False
        _kill_ffmpeg()
        started_at = None
        _reset_stats()
        log_lines.append("Live stopped.")

    return jsonify(ok=True, message="Live stopped.")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)), threaded=True)
