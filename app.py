#!/usr/bin/env python3
"""
Backup Monitor – Backend
MongoDB-backed backup monitoring with Web UI, Uptime Kuma, Prometheus & Webhook integration.
"""
from flask import Flask, request, jsonify, render_template, Response
from pymongo import MongoClient, DESCENDING
from datetime import datetime, timedelta
from functools import wraps
import os, time, requests, logging, threading, secrets as _secrets

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("backup-monitor")

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://mongo:27017")
KUMA_URL = os.environ.get("KUMA_URL", "")
KUMA_TOKEN = os.environ.get("KUMA_TOKEN", "")
STALE_HOURS = int(os.environ.get("STALE_HOURS", "26"))

# API Key Auth – set API_KEY to enable, leave empty to disable (open access)
API_KEY = os.environ.get("API_KEY", "")

db = MongoClient(MONGO_URI).backup_monitor


# ── Auth Decorator ─────────────────────────────────────────────────────────

def require_api_key(f):
    """Protect write endpoints. Checks X-API-Key header or ?api_key= query param."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not API_KEY:
            return f(*args, **kwargs)
        key = request.headers.get("X-API-Key") or request.args.get("api_key")
        if not key or key != API_KEY:
            return jsonify({"error": "Unauthorized – invalid or missing API key"}), 401
        return f(*args, **kwargs)
    return decorated
db.hosts.create_index("name", unique=True)
db.history.create_index([("host", 1), ("timestamp", -1)])
db.history.create_index("timestamp", expireAfterSeconds=90 * 86400)  # 90 Tage TTL


# ── API: Push (called by borgmatic after_backup hook) ──────────────────────

@app.route("/api/push", methods=["POST", "GET"])
@require_api_key
def push():
    host = request.args.get("host") or request.json.get("host", "") if request.is_json else request.args.get("host")
    if not host:
        return jsonify({"error": "host required"}), 400

    data = request.json if request.is_json else {}
    now = datetime.utcnow()

    entry = {
        "host": host,
        "timestamp": now,
        "status": data.get("status", request.args.get("status", "ok")),
        "duration_sec": data.get("duration_sec", 0),
        "original_size": data.get("original_size", 0),
        "deduplicated_size": data.get("deduplicated_size", 0),
        "compressed_size": data.get("compressed_size", 0),
        "nfiles_new": data.get("nfiles_new", 0),
        "nfiles_changed": data.get("nfiles_changed", 0),
        "message": data.get("message", request.args.get("msg", "")),
    }
    db.history.insert_one(entry)

    # Update host record
    db.hosts.update_one(
        {"name": host},
        {"$set": {"last_backup": now, "last_status": entry["status"], "last_message": entry["message"]},
         "$setOnInsert": {"name": host, "enabled": True, "created": now, "kuma_push_url": ""}},
        upsert=True
    )

    # Uptime Kuma push
    h = db.hosts.find_one({"name": host})
    if h and h.get("kuma_push_url"):
        try:
            status_param = "up" if entry["status"] == "ok" else "down"
            msg = f"Backup OK – {_fmt_bytes(entry['original_size'])}" if entry["status"] == "ok" else entry["message"]
            requests.get(h["kuma_push_url"], params={"status": status_param, "msg": msg}, timeout=5)
        except Exception as e:
            log.warning(f"Kuma push failed for {host}: {e}")

    # Webhooks
    if entry["status"] == "error":
        _send_webhooks("error", host, entry.get("message", "Backup fehlgeschlagen"))

    # Check for stale hosts
    _check_stale_hosts()

    return jsonify({"ok": True, "host": host})


# ── API: Hosts CRUD ────────────────────────────────────────────────────────

@app.route("/api/hosts", methods=["GET"])
def list_hosts():
    hosts = []
    now = datetime.utcnow()
    for h in db.hosts.find().sort("name", 1):
        age_h = (now - h.get("last_backup", now)).total_seconds() / 3600 if h.get("last_backup") else 999
        if not h.get("enabled", True):
            status = "disabled"
        elif age_h > STALE_HOURS:
            status = "stale"
        elif h.get("last_status") == "error":
            status = "error"
        else:
            status = "ok"

        # Last 7 days summary
        week_ago = now - timedelta(days=7)
        recent = list(db.history.find({"host": h["name"], "timestamp": {"$gte": week_ago}}).sort("timestamp", -1))

        hosts.append({
            "name": h["name"],
            "enabled": h.get("enabled", True),
            "status": status,
            "last_backup": h.get("last_backup", "").isoformat() + "Z" if h.get("last_backup") else None,
            "last_status": h.get("last_status", "unknown"),
            "last_message": h.get("last_message", ""),
            "age_hours": round(age_h, 1),
            "kuma_push_url": h.get("kuma_push_url", ""),
            "backup_count_7d": len(recent),
            "total_size_7d": sum(r.get("original_size", 0) for r in recent),
            "avg_duration_7d": round(sum(r.get("duration_sec", 0) for r in recent) / max(len(recent), 1)),
        })
    return jsonify(hosts)


@app.route("/api/hosts", methods=["POST"])
@require_api_key
def add_host():
    data = request.json
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    db.hosts.update_one(
        {"name": name},
        {"$setOnInsert": {"name": name, "enabled": True, "created": datetime.utcnow(),
                          "kuma_push_url": data.get("kuma_push_url", "")}},
        upsert=True
    )
    return jsonify({"ok": True, "name": name})


@app.route("/api/hosts/<name>", methods=["PUT"])
@require_api_key
def update_host(name):
    data = request.json
    update = {}
    if "enabled" in data:
        update["enabled"] = data["enabled"]
    if "kuma_push_url" in data:
        update["kuma_push_url"] = data["kuma_push_url"]
    if update:
        db.hosts.update_one({"name": name}, {"$set": update})
    return jsonify({"ok": True})


@app.route("/api/hosts/<name>", methods=["DELETE"])
@require_api_key
def delete_host(name):
    db.hosts.delete_one({"name": name})
    db.history.delete_many({"host": name})
    return jsonify({"ok": True})


# ── API: History ───────────────────────────────────────────────────────────

@app.route("/api/history/<host>")
def host_history(host):
    days = int(request.args.get("days", 30))
    since = datetime.utcnow() - timedelta(days=days)
    entries = []
    for e in db.history.find({"host": host, "timestamp": {"$gte": since}}).sort("timestamp", DESCENDING):
        entries.append({
            "timestamp": e["timestamp"].isoformat() + "Z",
            "status": e.get("status", "ok"),
            "duration_sec": e.get("duration_sec", 0),
            "original_size": e.get("original_size", 0),
            "deduplicated_size": e.get("deduplicated_size", 0),
            "compressed_size": e.get("compressed_size", 0),
            "nfiles_new": e.get("nfiles_new", 0),
            "nfiles_changed": e.get("nfiles_changed", 0),
            "message": e.get("message", ""),
        })
    return jsonify(entries)


@app.route("/api/calendar/<host>")
def host_calendar(host):
    """30-day calendar heatmap data."""
    days = int(request.args.get("days", 30))
    since = datetime.utcnow() - timedelta(days=days)
    pipeline = [
        {"$match": {"host": host, "timestamp": {"$gte": since}}},
        {"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$timestamp"}},
            "count": {"$sum": 1},
            "total_size": {"$sum": "$original_size"},
            "has_error": {"$max": {"$cond": [{"$eq": ["$status", "error"]}, 1, 0]}},
            "avg_duration": {"$avg": "$duration_sec"},
        }},
        {"$sort": {"_id": 1}}
    ]
    result = {}
    for day in db.history.aggregate(pipeline):
        result[day["_id"]] = {
            "count": day["count"],
            "total_size": day["total_size"],
            "has_error": bool(day["has_error"]),
            "avg_duration": round(day.get("avg_duration", 0)),
        }
    return jsonify(result)


# ── API: Dashboard summary ─────────────────────────────────────────────────

@app.route("/api/summary")
def summary():
    now = datetime.utcnow()
    hosts = list(db.hosts.find({"enabled": True}))
    total = len(hosts)
    ok = stale = error = 0
    for h in hosts:
        age_h = (now - h.get("last_backup", now)).total_seconds() / 3600 if h.get("last_backup") else 999
        if age_h > STALE_HOURS:
            stale += 1
        elif h.get("last_status") == "error":
            error += 1
        else:
            ok += 1

    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_backups = db.history.count_documents({"timestamp": {"$gte": today}})
    today_size = sum(e.get("original_size", 0) for e in db.history.find({"timestamp": {"$gte": today}}))

    return jsonify({
        "total_hosts": total, "ok": ok, "stale": stale, "error": error,
        "today_backups": today_backups, "today_size": today_size,
    })


# ── Prometheus Metrics ──────────────────────────────────────────────────────

@app.route("/metrics")
def prometheus_metrics():
    now = datetime.utcnow()
    hosts = list(db.hosts.find())
    lines = [
        "# HELP backup_hosts_total Total number of monitored hosts",
        "# TYPE backup_hosts_total gauge",
        f"backup_hosts_total {len([h for h in hosts if h.get('enabled', True)])}",
        "# HELP backup_host_last_seconds Seconds since last backup",
        "# TYPE backup_host_last_seconds gauge",
        "# HELP backup_host_status Backup status (1=ok, 0=error, -1=stale, -2=disabled)",
        "# TYPE backup_host_status gauge",
        "# HELP backup_host_duration_seconds Duration of last backup",
        "# TYPE backup_host_duration_seconds gauge",
        "# HELP backup_host_size_bytes Original size of last backup",
        "# TYPE backup_host_size_bytes gauge",
        "# HELP backup_host_dedup_bytes Deduplicated size of last backup",
        "# TYPE backup_host_dedup_bytes gauge",
        "# HELP backup_host_files_new New files in last backup",
        "# TYPE backup_host_files_new gauge",
    ]
    for h in hosts:
        name = h["name"]
        labels = f'host="{name}"'
        age = (now - h["last_backup"]).total_seconds() if h.get("last_backup") else 999999

        if not h.get("enabled", True):
            status_val = -2
        elif age > STALE_HOURS * 3600:
            status_val = -1
        elif h.get("last_status") == "error":
            status_val = 0
        else:
            status_val = 1

        lines.append(f"backup_host_last_seconds{{{labels}}} {int(age)}")
        lines.append(f"backup_host_status{{{labels}}} {status_val}")

        last = db.history.find_one({"host": name}, sort=[("timestamp", DESCENDING)])
        if last:
            lines.append(f'backup_host_duration_seconds{{{labels}}} {last.get("duration_sec", 0)}')
            lines.append(f'backup_host_size_bytes{{{labels}}} {last.get("original_size", 0)}')
            lines.append(f'backup_host_dedup_bytes{{{labels}}} {last.get("deduplicated_size", 0)}')
            lines.append(f'backup_host_files_new{{{labels}}} {last.get("nfiles_new", 0)}')

    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_count = db.history.count_documents({"timestamp": {"$gte": today}})
    today_size = sum(e.get("original_size", 0) for e in db.history.find({"timestamp": {"$gte": today}}))
    lines += [
        "# HELP backup_today_total Backups completed today",
        "# TYPE backup_today_total gauge",
        f"backup_today_total {today_count}",
        "# HELP backup_today_bytes Total bytes backed up today",
        "# TYPE backup_today_bytes gauge",
        f"backup_today_bytes {today_size}",
    ]
    return Response("\n".join(lines) + "\n", mimetype="text/plain; version=0.0.4")


# ── Webhooks (Notifications) ──────────────────────────────────────────────

WEBHOOK_URLS = [u.strip() for u in os.environ.get("WEBHOOK_URLS", "").split(",") if u.strip()]
WEBHOOK_EVENTS = os.environ.get("WEBHOOK_EVENTS", "error,stale").split(",")


def _send_webhooks(event, host, message):
    """Fire webhooks in background thread."""
    if event not in WEBHOOK_EVENTS or not WEBHOOK_URLS:
        return
    payload = {
        "event": event,
        "host": host,
        "message": message,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }
    def _fire():
        for url in WEBHOOK_URLS:
            try:
                requests.post(url, json=payload, timeout=10)
            except Exception as e:
                log.warning(f"Webhook failed ({url}): {e}")
    threading.Thread(target=_fire, daemon=True).start()


# ── Stale Check (runs after each push) ────────────────────────────────────

def _check_stale_hosts():
    """Check all hosts for stale status and fire webhooks."""
    now = datetime.utcnow()
    for h in db.hosts.find({"enabled": True}):
        if not h.get("last_backup"):
            continue
        age_h = (now - h["last_backup"]).total_seconds() / 3600
        if age_h > STALE_HOURS and not h.get("_stale_notified"):
            _send_webhooks("stale", h["name"], f"Kein Backup seit {int(age_h)}h")
            db.hosts.update_one({"name": h["name"]}, {"$set": {"_stale_notified": True}})
        elif age_h <= STALE_HOURS and h.get("_stale_notified"):
            db.hosts.update_one({"name": h["name"]}, {"$unset": {"_stale_notified": ""}})


# ── Web UI ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", api_key_required=bool(API_KEY))


# ── Helpers ────────────────────────────────────────────────────────────────

def _fmt_bytes(b):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9999, debug=False)
