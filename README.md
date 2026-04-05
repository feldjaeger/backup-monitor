# 🛡️ The Sentinel – Backup Monitor

A self-hosted backup monitoring dashboard with a premium dark-theme UI, MongoDB backend, and deep integrations for Borgmatic, Uptime Kuma, Prometheus, and webhooks.

![Dark Theme](https://img.shields.io/badge/theme-Sentinel%20Dark-0b1326?style=flat-square) ![Python](https://img.shields.io/badge/python-3.12-blue?style=flat-square) ![MongoDB](https://img.shields.io/badge/mongodb-4.4+-green?style=flat-square) ![Tailwind](https://img.shields.io/badge/tailwind-CSS-38bdf8?style=flat-square)

## Features

- **Sentinel UI** – Premium dark-theme dashboard built on Material 3 design tokens, Tailwind CSS, glassmorphism effects, and Manrope + Inter typography
- **Multi-Page SPA** – Dashboard, Alert Center, Backup Hosts, Configuration
- **Dashboard** – Bento metric cards, SVG volume trend chart, host clusters by status, live backup stream
- **Alert Center** – Severity-based alerts (Critical/Stale) with pulse animations
- **Host Management** – Add, edit, disable, delete hosts via Web UI
- **Detail Drawer** – 30-day calendar heatmap, data volume chart, backup history per host
- **Prometheus Metrics** – `/metrics` endpoint with per-host and global backup metrics
- **Uptime Kuma Integration** – Automatic push forwarding per host after each backup
- **Webhook Notifications** – Configurable alerts on error/stale events (n8n, Telegram, etc.)
- **API Key Auth** – Optional authentication for write endpoints
- **90-Day History** – MongoDB with automatic TTL cleanup
- **Auto-Refresh** – Dashboard updates every 30 seconds
- **Zero Config** – Hosts auto-register on first push

## Quick Start

```bash
git clone https://github.com/feldjaeger/backup-monitor.git
cd backup-monitor
docker compose up -d
# Open http://localhost:9999
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
      - STALE_HOURS=26
      # - API_KEY=your-secret-key      # optional: protect write endpoints
      # - WEBHOOK_URLS=https://n8n.example.com/webhook/backup-alert
      # - WEBHOOK_EVENTS=error,stale
    depends_on:
      - mongo

  mongo:
    image: mongo:4.4    # Use 7+ if your CPU supports AVX
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
# Minimal push
curl -X POST "http://localhost:9999/api/push?host=myserver&status=ok"

# Full push with stats
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "host": "myserver",
    "status": "ok",
    "duration_sec": 342,
    "original_size": 5368709120,
    "deduplicated_size": 104857600,
    "compressed_size": 83886080,
    "nfiles_new": 47,
    "nfiles_changed": 12
  }' \
  http://localhost:9999/api/push

# With API key
curl -X POST -H "X-API-Key: your-key" \
  "http://localhost:9999/api/push?host=myserver&status=ok"
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

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | ❌ | Web UI |
| `GET` | `/metrics` | ❌ | Prometheus metrics |
| `GET` | `/api/summary` | ❌ | Dashboard summary |
| `GET` | `/api/hosts` | ❌ | List all hosts with status |
| `GET` | `/api/history/<host>?days=30` | ❌ | Backup history |
| `GET` | `/api/calendar/<host>?days=30` | ❌ | Calendar heatmap data |
| `POST` | `/api/push` | 🔑 | Push backup status |
| `POST` | `/api/hosts` | 🔑 | Add a host |
| `PUT` | `/api/hosts/<name>` | 🔑 | Update host settings |
| `DELETE` | `/api/hosts/<name>` | 🔑 | Delete host and history |

🔑 = requires `API_KEY` if set (via `X-API-Key` header or `?api_key=` query param)

## Prometheus Integration

```
backup_hosts_total 21
backup_host_status{host="myserver"} 1          # 1=ok, 0=error, -1=stale
backup_host_last_seconds{host="myserver"} 3600
backup_host_duration_seconds{host="myserver"} 342
backup_host_size_bytes{host="myserver"} 5368709120
backup_host_dedup_bytes{host="myserver"} 104857600
backup_today_total 22
backup_today_bytes 47280909120
```

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'backup-monitor'
    static_configs:
      - targets: ['backup-monitor:9999']
    scrape_interval: 60s
```

## Webhook Notifications

```yaml
environment:
  - WEBHOOK_URLS=https://n8n.example.com/webhook/backup-alert
  - WEBHOOK_EVENTS=error,stale
```

Payload:

```json
{
  "event": "error",
  "host": "myserver",
  "message": "Backup failed",
  "timestamp": "2026-04-05T06:00:00Z"
}
```

## Uptime Kuma Integration

1. Create a Push monitor in Uptime Kuma
2. In Backup Monitor: Host → Edit → paste Kuma Push URL
3. After each backup, status is automatically forwarded to Kuma

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://mongo:27017` | MongoDB connection |
| `STALE_HOURS` | `26` | Hours without backup → stale |
| `API_KEY` | _(empty)_ | Set to enable auth on write endpoints |
| `WEBHOOK_URLS` | _(empty)_ | Comma-separated notification URLs |
| `WEBHOOK_EVENTS` | `error,stale` | Events that trigger webhooks |

## Design System

The UI follows **The Sentinel** design language:

- **Colors:** Material 3 tonal palette with deep slate surfaces (`#0b1326` → `#2d3449`)
- **Typography:** Manrope (headlines) + Inter (body/data)
- **No-Line Rule:** Card boundaries via background color shifts, no 1px borders
- **Glass Effect:** Backdrop-blur on navigation and overlays
- **Pulse Animations:** Status indicators with two-tone glow effects
- **Tonal Depth:** Layered surfaces creating architectural permanence

## Tech Stack

- **Backend:** Python 3.12, Flask, Gunicorn
- **Database:** MongoDB 8
- **Frontend:** Tailwind CSS, Vanilla JS, Material Symbols, Google Fonts
- **No build step** – Tailwind loaded via CDN

## Grafana Dashboard

Import `grafana-dashboard.json` into Grafana for a pre-built dashboard with:
- Overview stat panels (Hosts OK, Stale, Errors, Volume, Backups Today)
- Host status table with color-coded status, age, duration, size
- Backup volume per host (stacked time series)
- Backup duration per host
- Time since last backup with threshold coloring (green/yellow/red)

## License

MIT
