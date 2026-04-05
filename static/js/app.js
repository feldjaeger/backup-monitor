/* ── Backup Monitor – Frontend Logic ────────────────────────── */

const API = '';
let refreshTimer;

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    refreshTimer = setInterval(loadAll, 30000);
});

async function loadAll() {
    await Promise.all([loadSummary(), loadHosts()]);
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('de-DE');
}

// ── Summary ───────────────────────────────────────────────────
async function loadSummary() {
    const r = await fetch(`${API}/api/summary`);
    const d = await r.json();
    document.getElementById('valTotal').textContent = d.total_hosts;
    document.getElementById('valOk').textContent = d.ok;
    document.getElementById('valStale').textContent = d.stale;
    document.getElementById('valError').textContent = d.error;
    document.getElementById('valToday').textContent = d.today_backups;
    document.getElementById('valSize').textContent = fmtBytes(d.today_size);

    const pulse = document.getElementById('globalPulse');
    pulse.className = 'pulse-dot';
    if (d.error > 0) pulse.classList.add('error');
    else if (d.stale > 0) pulse.classList.add('warn');
}

// ── Host Grid ─────────────────────────────────────────────────
async function loadHosts() {
    const r = await fetch(`${API}/api/hosts`);
    const hosts = await r.json();
    const grid = document.getElementById('hostGrid');

    grid.innerHTML = hosts.map(h => `
        <div class="card host-card" data-status="${h.status}" onclick="openHost('${h.name}')">
            <div class="host-header">
                <span class="host-name">${h.name}</span>
                <span class="host-badge badge-${h.status}">${statusLabel(h.status)}</span>
            </div>
            <div class="host-meta">
                <div class="meta-item">
                    <span class="meta-label">Letztes Backup</span>
                    <span class="meta-value">${h.last_backup ? timeAgo(h.last_backup) : 'Nie'}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">7-Tage</span>
                    <span class="meta-value">${h.backup_count_7d} Backups</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Ø Dauer</span>
                    <span class="meta-value">${fmtDuration(h.avg_duration_7d)}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">7-Tage Volumen</span>
                    <span class="meta-value">${fmtBytes(h.total_size_7d)}</span>
                </div>
            </div>
            <div class="host-minibar" id="mini-${h.name}"></div>
        </div>
    `).join('');

    // Load minibars
    for (const h of hosts) {
        loadMinibar(h.name);
    }
}

async function loadMinibar(host) {
    const r = await fetch(`${API}/api/calendar/${host}?days=14`);
    const cal = await r.json();
    const el = document.getElementById(`mini-${host}`);
    if (!el) return;

    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        days.push({ key, data: cal[key] || null });
    }

    const maxSize = Math.max(...days.map(d => d.data?.total_size || 0), 1);
    el.innerHTML = days.map(d => {
        if (!d.data) return `<div class="minibar-day empty" title="${d.key}: Kein Backup"></div>`;
        const h = Math.max(15, (d.data.total_size / maxSize) * 100);
        const cls = d.data.has_error ? 'error' : 'ok';
        return `<div class="minibar-day ${cls}" style="height:${h}%" title="${d.key}: ${d.data.count}x, ${fmtBytes(d.data.total_size)}"></div>`;
    }).join('');
}

// ── Host Detail Drawer ────────────────────────────────────────
async function openHost(name) {
    document.getElementById('drawerTitle').textContent = name;
    document.getElementById('drawerOverlay').classList.add('open');
    document.getElementById('drawer').classList.add('open');

    const body = document.getElementById('drawerBody');
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Lade...</div>';

    const [histR, calR, hostsR] = await Promise.all([
        fetch(`${API}/api/history/${name}?days=30`),
        fetch(`${API}/api/calendar/${name}?days=30`),
        fetch(`${API}/api/hosts`),
    ]);
    const history = await histR.json();
    const calendar = await calR.json();
    const hosts = await hostsR.json();
    const host = hosts.find(h => h.name === name) || {};

    // Stats
    const totalSize = history.reduce((s, e) => s + e.original_size, 0);
    const avgDuration = history.length ? Math.round(history.reduce((s, e) => s + e.duration_sec, 0) / history.length) : 0;
    const successRate = history.length ? Math.round(history.filter(e => e.status === 'ok').length / history.length * 100) : 0;

    body.innerHTML = `
        <div class="stats-row">
            <div class="stat-box">
                <div class="stat-value">${history.length}</div>
                <div class="stat-label">Backups (30d)</div>
            </div>
            <div class="stat-box">
                <div class="stat-value">${successRate}%</div>
                <div class="stat-label">Erfolgsrate</div>
            </div>
            <div class="stat-box">
                <div class="stat-value">${fmtDuration(avgDuration)}</div>
                <div class="stat-label">Ø Dauer</div>
            </div>
        </div>

        <div class="section-header">Kalender (30 Tage)</div>
        <div class="calendar-grid">${buildCalendar(calendar)}</div>

        <div class="section-header">Datenvolumen (30 Tage)</div>
        <div class="size-chart">${buildSizeChart(history)}</div>

        <div class="section-header">Letzte Backups</div>
        <table class="history-table">
            <thead><tr><th>Datum</th><th>Status</th><th>Dauer</th><th>Größe</th><th>Dateien</th></tr></thead>
            <tbody>
                ${history.slice(0, 20).map(e => `
                    <tr>
                        <td>${new Date(e.timestamp).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
                        <td><span class="host-badge badge-${e.status === 'ok' ? 'ok' : 'error'}">${e.status}</span></td>
                        <td>${fmtDuration(e.duration_sec)}</td>
                        <td>${fmtBytes(e.original_size)}</td>
                        <td>${e.nfiles_new ? `+${e.nfiles_new}` : '–'} ${e.nfiles_changed ? `/ ~${e.nfiles_changed}` : ''}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>

        <div class="drawer-actions">
            <button class="btn" onclick="openEditHost('${name}')">⚙ Bearbeiten</button>
            <button class="btn btn-danger" onclick="confirmDelete('${name}')">🗑 Löschen</button>
        </div>
    `;
}

function buildCalendar(cal) {
    const days = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        const data = cal[key];
        const dayNum = d.getDate();

        if (!data) {
            days.push(`<div class="cal-day empty">${dayNum}<div class="tooltip">${key}<br>Kein Backup</div></div>`);
        } else {
            const cls = data.has_error ? 'error' : 'ok';
            days.push(`<div class="cal-day ${cls}">${dayNum}<div class="tooltip">${key}<br>${data.count}x Backup<br>${fmtBytes(data.total_size)}<br>Ø ${fmtDuration(data.avg_duration)}</div></div>`);
        }
    }
    // Future days to fill the row
    for (let i = 1; i <= 5; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        days.push(`<div class="cal-day future">${d.getDate()}</div>`);
    }
    return days.join('');
}

function buildSizeChart(history) {
    // Group by day, last 30 days
    const byDay = {};
    history.forEach(e => {
        const day = e.timestamp.split('T')[0];
        if (!byDay[day]) byDay[day] = 0;
        byDay[day] += e.original_size;
    });

    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        days.push({ key, size: byDay[key] || 0 });
    }

    const maxSize = Math.max(...days.map(d => d.size), 1);
    return days.map(d => {
        const h = d.size ? Math.max(4, (d.size / maxSize) * 100) : 2;
        const opacity = d.size ? '' : 'opacity:0.2;';
        return `<div class="size-bar" style="height:${h}%;${opacity}"><div class="tooltip">${d.key}<br>${fmtBytes(d.size)}</div></div>`;
    }).join('');
}

function closeDrawer() {
    document.getElementById('drawerOverlay').classList.remove('open');
    document.getElementById('drawer').classList.remove('open');
}

// ── Add/Edit Host Modal ───────────────────────────────────────
function openAddHost() {
    document.getElementById('modalTitle').textContent = 'Host hinzufügen';
    document.getElementById('formMode').value = 'add';
    document.getElementById('formName').value = '';
    document.getElementById('formName').disabled = false;
    document.getElementById('formKumaUrl').value = '';
    document.getElementById('formEnabled').checked = true;
    openModal();
}

async function openEditHost(name) {
    closeDrawer();
    const r = await fetch(`${API}/api/hosts`);
    const hosts = await r.json();
    const h = hosts.find(x => x.name === name);
    if (!h) return;

    document.getElementById('modalTitle').textContent = `${name} bearbeiten`;
    document.getElementById('formMode').value = 'edit';
    document.getElementById('formName').value = h.name;
    document.getElementById('formName').disabled = true;
    document.getElementById('formKumaUrl').value = h.kuma_push_url || '';
    document.getElementById('formEnabled').checked = h.enabled;
    openModal();
}

async function saveHost(e) {
    e.preventDefault();
    const mode = document.getElementById('formMode').value;
    const name = document.getElementById('formName').value.trim();
    const kuma = document.getElementById('formKumaUrl').value.trim();
    const enabled = document.getElementById('formEnabled').checked;

    if (mode === 'add') {
        await fetch(`${API}/api/hosts`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, kuma_push_url: kuma })
        });
        toast(`${name} hinzugefügt`, 'success');
    } else {
        await fetch(`${API}/api/hosts/${name}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ kuma_push_url: kuma, enabled })
        });
        toast(`${name} aktualisiert`, 'success');
    }

    closeModal();
    loadAll();
}

async function confirmDelete(name) {
    if (!confirm(`Host "${name}" und alle History wirklich löschen?`)) return;
    await fetch(`${API}/api/hosts/${name}`, { method: 'DELETE' });
    toast(`${name} gelöscht`, 'success');
    closeDrawer();
    loadAll();
}

function openModal() {
    document.getElementById('modalOverlay').classList.add('open');
    document.getElementById('modal').classList.add('open');
}
function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
    document.getElementById('modal').classList.remove('open');
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `${type === 'success' ? '✓' : '✕'} ${msg}`;
    c.appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

// ── Helpers ───────────────────────────────────────────────────
function fmtBytes(b) {
    if (!b || b === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function fmtDuration(sec) {
    if (!sec || sec === 0) return '–';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
    return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
}

function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'gerade eben';
    if (diff < 3600) return `vor ${Math.floor(diff/60)}m`;
    if (diff < 86400) return `vor ${Math.floor(diff/3600)}h`;
    return `vor ${Math.floor(diff/86400)}d`;
}

function statusLabel(s) {
    return { ok: 'OK', stale: 'Überfällig', error: 'Fehler', disabled: 'Deaktiviert' }[s] || s;
}
