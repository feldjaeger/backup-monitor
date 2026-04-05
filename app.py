#!/usr/bin/env python3
"""
Backup Monitor – Backend
MongoDB-backed backup monitoring with Web UI and Uptime Kuma integration.
"""
from flask import Flask, request, jsonify, render_template, send_from_directory
from pymongo import MongoClient, DESCENDING
from datetime import datetime, timedelta
import os, time, requests, logging

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("backup-monitor")

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://mongo:27017")
KUMA_URL = os.environ.get("KUMA_URL", "")
KUMA_TOKEN = os.environ.get("KUMA_TOKEN", "")
STALE_HOURS = int(os.environ.get("STALE_HOURS", "26"))

db = MongoClient(MONGO_URI).backup_monitor
db.hosts.create_index("name", unique=True)
db.history.create_index([("host", 1), ("timestamp", -1)])
db.history.create_index("timestamp", expireAfterSeconds=90 * 86400)  # 90 Tage TTL


# ── API: Push (called by borgmatic after_backup hook) ──────────────────────

@app.route("/api/push", methods=["POST", "GET"])
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


# ── Web UI ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Helpers ────────────────────────────────────────────────────────────────

def _fmt_bytes(b):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9999, debug=False)
