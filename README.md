# 🛡️ Backup Monitor

A self-hosted backup monitoring dashboard with MongoDB backend, designed for **Borgmatic** (but works with any tool that can send HTTP requests).

![Dark Theme Dashboard](https://img.shields.io/badge/theme-dark-1a1d27?style=flat-square) ![Python](https://img.shields.io/badge/python-3.12-blue?style=flat-square) ![MongoDB](https://img.shields.io/badge/mongodb-4.4+-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)

## Features

- **Dashboard** – Real-time overview of all backup hosts with status cards
- **Host Management** – Add, edit, disable, delete hosts via Web UI (no config files)
- **History** – 90-day retention with per-day calendar heatmap and size charts
- **Detailed Stats** – Duration, original/deduplicated/compressed size, file counts
- **Uptime Kuma Integration** – Automatic push per host after each backup
- **Stale Detection** – Configurable threshold (default: 26h) marks missed backups
- **Auto-Refresh** – Dashboard updates every 30 seconds
- **Dark Theme** – Clean, modern UI with status-colored indicators
- **Zero Config** – Hosts auto-register on first push, or add manually via UI

## Quick Start

```bash
# Clone
git clone https://github.com/feldjaeger/backup-monitor.git
cd backup-monitor

# Start
docker compose up -d

# Open
open http://localhost:9999
```

## Docker Compose

```yaml
services:
  backup-monitor:
    build: .
    container_name: backup-monitor
    restart: always
    ports:
      - "9999:9999"
    environment:
      - MONGO_URI=mongodb://mongo:27017
      - STALE_HOURS=26          # Hours before a host is marked "stale"
    depends_on:
      - mongo

  mongo:
    image: mongo:4.4            # Use 7+ if your CPU supports AVX
    container_name: backup-mongo
    restart: always
    volumes:
      - mongo_data:/data/db

volumes:
  mongo_data:
```

## Push API

After each backup, send a POST request:

```bash
# Minimal push (just hostname + status)
curl -X POST "http://localhost:9999/api/push?host=myserver&status=ok"

# Full push with stats (JSON)
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "host": "myserver",
    "status": "ok",
    "duration_sec": 342,
    "original_size": 5368709120,
    "deduplicated_size": 104857600,
    "compressed_size": 83886080,
    "nfiles_new": 47,
    "nfiles_changed": 12,
    "message": "Backup completed successfully"
  }' \
  http://localhost:9999/api/push
```

### Borgmatic Integration

Add to your `borgmatic.yml`:

```yaml
after_backup:
  - >-
    bash -c '
    STATS=$(borgmatic info --archive latest --json 2>/dev/null | python3 -c "
    import sys,json
    d=json.load(sys.stdin)[0][\"archives\"][-1]
    s=d.get(\"stats\",{})
    print(json.dumps({
      \"host\":\"$(hostname)\",
      \"status\":\"ok\",
      \"duration_sec\":int(s.get(\"duration\",0)),
      \"original_size\":s.get(\"original_size\",0),
      \"deduplicated_size\":s.get(\"deduplicated_size\",0),
      \"compressed_size\":s.get(\"compressed_size\",0),
      \"nfiles_new\":s.get(\"nfiles\",0)
    }))" 2>/dev/null || echo "{\"host\":\"$(hostname)\",\"status\":\"ok\"}");
    curl -fsS -m 10 -X POST -H "Content-Type: application/json" -d "$STATS" "http://YOUR_SERVER:9999/api/push" || true
    '

on_error:
  - >-
    curl -fsS -m 10 -X POST -H "Content-Type: application/json"
    -d '{"host":"'$(hostname)'","status":"error","message":"Backup failed"}'
    "http://YOUR_SERVER:9999/api/push" || true
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Web UI |
| `GET/POST` | `/api/push` | Push backup status (query params or JSON) |
| `GET` | `/api/hosts` | List all hosts with current status |
| `POST` | `/api/hosts` | Add a host `{"name": "...", "kuma_push_url": "..."}` |
| `PUT` | `/api/hosts/<name>` | Update host `{"enabled": bool, "kuma_push_url": "..."}` |
| `DELETE` | `/api/hosts/<name>` | Delete host and all history |
| `GET` | `/api/history/<host>?days=30` | Backup history for a host |
| `GET` | `/api/calendar/<host>?days=30` | Calendar heatmap data (aggregated by day) |
| `GET` | `/api/summary` | Dashboard summary (counts, today stats) |

## Uptime Kuma Integration

1. Create a **Push** monitor in Uptime Kuma for each host
2. Copy the push URL (e.g. `https://status.example.com/api/push/borg-myserver?status=up&msg=OK`)
3. In Backup Monitor: Click on a host → Edit → Paste the Kuma Push URL
4. After each backup push, Backup Monitor automatically forwards the status to Uptime Kuma

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://mongo:27017` | MongoDB connection string |
| `STALE_HOURS` | `26` | Hours without backup before host is marked stale |

## Data Retention

- History entries are automatically deleted after **90 days** (MongoDB TTL index)
- Hosts are never auto-deleted – remove them manually via UI or API

## Screenshots

### Dashboard
Dark-themed overview with summary cards, host grid with status badges, and 14-day minibar charts per host.

### Host Detail
Slide-out drawer with 30-day calendar heatmap, data volume chart, and detailed backup history table.

## Tech Stack

- **Backend:** Python 3.12, Flask, Gunicorn
- **Database:** MongoDB 4.4+
- **Frontend:** Vanilla JS, CSS (no framework dependencies)

## License

MIT
