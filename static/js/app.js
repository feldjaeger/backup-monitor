/* ── The Sentinel – Backup Monitor Frontend ────────────────── */

const API = '';
let apiKey = localStorage.getItem('bm_api_key') || '';
let allHosts = [];
let currentPage = 'dashboard';

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    setInterval(loadAll, 30000);
});

function authHeaders() {
    const h = {'Content-Type': 'application/json'};
    if (apiKey) h['X-API-Key'] = apiKey;
    return h;
}

async function apiFetch(url, opts = {}) {
    if (!opts.headers) opts.headers = {};
    if (apiKey) opts.headers['X-API-Key'] = apiKey;
    const r = await fetch(url, opts);
    if (r.status === 401) {
        const key = prompt('🔑 API-Key eingeben:');
        if (key) { apiKey = key; localStorage.setItem('bm_api_key', key); opts.headers['X-API-Key'] = key; return fetch(url, opts); }
    }
    return r;
}

async function loadAll() {
    const [sumR, hostsR] = await Promise.all([fetch(`${API}/api/summary`), fetch(`${API}/api/hosts`)]);
    const sum = await sumR.json();
    allHosts = await hostsR.json();
    renderDashboard(sum);
    renderAlerts();
    renderHostGrid();
    document.getElementById('lastScan').textContent = new Date().toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'});
    // System status indicator
    const ss = document.getElementById('sysStatus');
    if (sum.error > 0) { ss.innerHTML = '<span class="material-symbols-outlined text-sm text-error" style="font-variation-settings:\'FILL\' 1">error</span><span class="font-headline text-xs font-medium text-error">Errors Active</span>'; }
    else if (sum.stale > 0) { ss.innerHTML = '<span class="material-symbols-outlined text-sm text-tertiary" style="font-variation-settings:\'FILL\' 1">warning</span><span class="font-headline text-xs font-medium text-tertiary">Stale Hosts</span>'; }
    else { ss.innerHTML = '<span class="material-symbols-outlined text-sm text-secondary" style="font-variation-settings:\'FILL\' 1">cloud_done</span><span class="font-headline text-xs font-medium text-slate-300">All Systems OK</span>'; }
}

// ── Dashboard ─────────────────────────────────────────────
function renderDashboard(sum) {
    document.getElementById('mOk').textContent = `${sum.ok}/${sum.total_hosts}`;
    document.getElementById('mSize').textContent = fmtBytes(sum.today_size);
    document.getElementById('mWarn').textContent = sum.error + sum.stale;
    const wc = document.getElementById('mWarnCard');
    wc.className = 'bg-surface-container-low p-6 rounded-xl' + ((sum.error + sum.stale > 0) ? ' border border-error/20' : '');

    // Latest backup
    const sorted = [...allHosts].filter(h => h.last_backup).sort((a,b) => new Date(b.last_backup) - new Date(a.last_backup));
    if (sorted.length) {
        document.getElementById('mLatest').textContent = sorted[0].last_status === 'ok' ? 'Success' : 'Error';
        document.getElementById('mLatestHost').textContent = sorted[0].name;
    }

    // Cluster list
    const cl = document.getElementById('clusterList');
    const groups = { ok: [], stale: [], error: [], disabled: [] };
    allHosts.forEach(h => groups[h.status]?.push(h));
    let html = '';
    if (groups.error.length) { html += clusterGroup('ERRORS', groups.error, 'error'); }
    if (groups.stale.length) { html += clusterGroup('STALE', groups.stale, 'tertiary'); }
    if (groups.ok.length) { html += clusterGroup('OPERATIONAL', groups.ok, 'secondary'); }
    if (groups.disabled.length) { html += clusterGroup('DISABLED', groups.disabled, 'outline'); }
    cl.innerHTML = html;

    // Live stream
    renderLiveStream();
    loadVolumeChart();
}

function clusterGroup(label, hosts, color) {
    return `
    <div class="mb-4">
      <div class="flex items-center gap-2 mb-3"><div class="w-1 h-4 bg-${color} rounded-full"></div><span class="text-xs font-black uppercase tracking-widest text-${color}">${label}</span></div>
      ${hosts.map(h => `
        <div onclick="openHost('${h.name}')" class="flex items-center justify-between px-4 py-3 rounded-lg bg-surface-container hover:bg-surface-container-high transition-all cursor-pointer mb-2">
          <div>
            <div class="text-sm font-bold text-white font-headline">${h.name}</div>
            <div class="text-[11px] text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">schedule</span> ${h.last_backup ? timeAgo(h.last_backup) : 'Never'}</div>
          </div>
          <span class="px-2 py-0.5 rounded text-[10px] font-black tracking-wider ${statusChipClass(h.status)}">${h.status.toUpperCase()}</span>
        </div>
      `).join('')}
    </div>`;
}

function renderLiveStream() {
    const sorted = [...allHosts].filter(h => h.last_backup).sort((a,b) => new Date(b.last_backup) - new Date(a.last_backup)).slice(0, 8);
    const ls = document.getElementById('liveStream');
    ls.innerHTML = sorted.map(h => {
        const t = new Date(h.last_backup).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const isErr = h.last_status !== 'ok';
        return `
        <div class="flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-surface-container transition-colors ${isErr ? 'bg-error-container/5' : ''}">
          <span class="text-xs font-mono text-slate-500 w-16 shrink-0">${t}</span>
          <div class="w-2.5 h-2.5 rounded-full ${isErr ? 'bg-error pulse-err' : 'bg-secondary'} shrink-0"></div>
          <span class="text-sm flex-1">${isErr ? '<span class="text-error font-bold">ERROR:</span> ' : ''}Backup for <span class="font-bold text-white">${h.name}</span> ${isErr ? 'failed' : 'completed successfully'}.</span>
          ${h.last_message ? `<span class="text-[10px] font-mono text-error/80">${h.last_message}</span>` : ''}
        </div>`;
    }).join('');
}

async function loadVolumeChart() {
    // Aggregate daily totals from all hosts
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().split('T')[0]); }
    const dailyTotals = {};
    days.forEach(d => dailyTotals[d] = 0);

    // Fetch calendar for top hosts (limit to avoid too many requests)
    const topHosts = allHosts.slice(0, 10);
    const cals = await Promise.all(topHosts.map(h => fetch(`${API}/api/calendar/${h.name}?days=30`).then(r => r.json())));
    cals.forEach(cal => { Object.entries(cal).forEach(([day, data]) => { if (dailyTotals[day] !== undefined) dailyTotals[day] += data.total_size; }); });

    const values = days.map(d => dailyTotals[d]);
    const max = Math.max(...values, 1);
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - (v / max) * 80}`);
    const pathD = 'M' + points.join(' L');
    const fillD = pathD + ` L100,100 L0,100 Z`;

    document.getElementById('chartSvg').innerHTML = `
      <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#adc6ff" stop-opacity="0.2"/><stop offset="100%" stop-color="#adc6ff" stop-opacity="0"/></linearGradient></defs>
      ${[20,40,60,80].map(y => `<line x1="0" y1="${y}" x2="100" y2="${y}" stroke="#1e293b" stroke-width="0.3"/>`).join('')}
      <path d="${fillD}" fill="url(#cg)"/>
      <path d="${pathD}" fill="none" stroke="#adc6ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
    document.getElementById('chartSvg').setAttribute('viewBox', '0 0 100 100');
    document.getElementById('chartSvg').setAttribute('preserveAspectRatio', 'none');
}

// ── Alerts ────────────────────────────────────────────────
function renderAlerts() {
    const issues = allHosts.filter(h => h.status === 'error' || h.status === 'stale');
    document.getElementById('aCrit').textContent = String(allHosts.filter(h => h.status === 'error').length).padStart(2, '0');
    document.getElementById('aStale').textContent = String(allHosts.filter(h => h.status === 'stale').length).padStart(2, '0');

    const al = document.getElementById('alertList');
    if (!issues.length) { al.innerHTML = '<div class="text-center py-16 text-on-surface-variant text-sm">No active alerts – all systems operational ✓</div>'; return; }

    al.innerHTML = issues.map(h => {
        const isCrit = h.status === 'error';
        const color = isCrit ? 'error' : 'tertiary';
        const icon = isCrit ? 'error' : 'warning';
        const label = isCrit ? 'CRITICAL' : 'STALE';
        return `
        <div class="bg-surface-container-low hover:bg-surface-container transition-all rounded-xl group">
          <div class="flex flex-col md:flex-row items-start md:items-center gap-4 px-6 py-5">
            <div class="w-12 h-12 rounded-full bg-${color}/10 flex items-center justify-center shrink-0 ${isCrit ? 'pulse-err' : ''}">
              <span class="material-symbols-outlined text-${color}" style="font-variation-settings:'FILL' 1">${icon}</span>
            </div>
            <div class="flex-1">
              <div class="flex items-center gap-3 mb-1">
                <h3 class="text-white font-bold font-headline">${isCrit ? 'Backup Failed' : 'Backup Overdue'} – ${h.name}</h3>
                <span class="px-2 py-0.5 rounded text-[10px] font-black bg-${color}/10 text-${color} border border-${color}/20 tracking-wider">${label}</span>
              </div>
              <div class="flex items-center gap-4 text-xs text-on-surface-variant">
                <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">dns</span> ${h.name}</span>
                <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">schedule</span> ${h.last_backup ? timeAgo(h.last_backup) : 'Never'}</span>
                ${h.last_message ? `<span class="text-${color}/80 italic">${h.last_message}</span>` : `<span class="text-${color}/80 italic">${Math.round(h.age_hours)}h without backup</span>`}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button onclick="openHost('${h.name}')" class="bg-surface-variant hover:bg-surface-container-highest text-on-surface-variant px-5 py-2 rounded-lg text-xs font-bold transition-all">Details</button>
            </div>
          </div>
        </div>`;
    }).join('');
}

// ── Host Grid ─────────────────────────────────────────────
function renderHostGrid() {
    const grid = document.getElementById('hostGrid');
    grid.innerHTML = allHosts.map(h => `
      <div onclick="openHost('${h.name}')" class="bg-surface-container-low hover:bg-surface-container rounded-xl p-6 cursor-pointer transition-all group relative overflow-hidden ${h.status === 'disabled' ? 'opacity-50' : ''}">
        <div class="absolute top-0 left-0 w-1 h-full rounded-l-xl ${h.status === 'ok' ? 'bg-secondary' : h.status === 'error' ? 'bg-error' : h.status === 'stale' ? 'bg-tertiary' : 'bg-outline'}"></div>
        <div class="flex justify-between items-start mb-4">
          <div class="text-base font-bold text-white font-headline">${h.name}</div>
          <span class="px-2 py-0.5 rounded text-[10px] font-black tracking-wider ${statusChipClass(h.status)}">${h.status.toUpperCase()}</span>
        </div>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div><span class="text-on-surface-variant block uppercase tracking-wider text-[10px] mb-0.5">Last Backup</span><span class="font-semibold text-white">${h.last_backup ? timeAgo(h.last_backup) : 'Never'}</span></div>
          <div><span class="text-on-surface-variant block uppercase tracking-wider text-[10px] mb-0.5">7d Backups</span><span class="font-semibold text-white">${h.backup_count_7d}</span></div>
          <div><span class="text-on-surface-variant block uppercase tracking-wider text-[10px] mb-0.5">Avg Duration</span><span class="font-semibold text-white">${fmtDuration(h.avg_duration_7d)}</span></div>
          <div><span class="text-on-surface-variant block uppercase tracking-wider text-[10px] mb-0.5">7d Volume</span><span class="font-semibold text-white">${fmtBytes(h.total_size_7d)}</span></div>
        </div>
      </div>
    `).join('');
}

// ── Host Detail Drawer ────────────────────────────────────
async function openHost(name) {
    document.getElementById('drawerTitle').textContent = name;
    document.getElementById('drawerBg').classList.remove('opacity-0','pointer-events-none');
    document.getElementById('drawer').classList.remove('translate-x-full');
    const body = document.getElementById('drawerBody');
    body.innerHTML = '<div class="text-center py-12 text-on-surface-variant">Loading...</div>';

    const [histR, calR] = await Promise.all([fetch(`${API}/api/history/${name}?days=30`), fetch(`${API}/api/calendar/${name}?days=30`)]);
    const history = await histR.json();
    const calendar = await calR.json();
    const host = allHosts.find(h => h.name === name) || {};

    const totalSize = history.reduce((s,e) => s + e.original_size, 0);
    const avgDur = history.length ? Math.round(history.reduce((s,e) => s + e.duration_sec, 0) / history.length) : 0;
    const rate = history.length ? Math.round(history.filter(e => e.status === 'ok').length / history.length * 100) : 0;

    body.innerHTML = `
      <!-- Stats -->
      <div class="grid grid-cols-3 gap-3 mb-6">
        <div class="bg-surface-container rounded-xl p-4 text-center"><div class="text-xl font-extrabold font-headline text-primary">${history.length}</div><div class="text-[10px] text-on-surface-variant uppercase tracking-wider mt-1">Backups</div></div>
        <div class="bg-surface-container rounded-xl p-4 text-center"><div class="text-xl font-extrabold font-headline text-secondary">${rate}%</div><div class="text-[10px] text-on-surface-variant uppercase tracking-wider mt-1">Success</div></div>
        <div class="bg-surface-container rounded-xl p-4 text-center"><div class="text-xl font-extrabold font-headline text-primary">${fmtDuration(avgDur)}</div><div class="text-[10px] text-on-surface-variant uppercase tracking-wider mt-1">Avg Duration</div></div>
      </div>

      <!-- Calendar -->
      <h4 class="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">30-Day Calendar</h4>
      <div class="grid grid-cols-7 gap-1.5 mb-6">${buildCalendar(calendar)}</div>

      <!-- Size Chart -->
      <h4 class="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">Data Volume</h4>
      <div class="flex items-end gap-[2px] h-16 mb-6">${buildSizeChart(history)}</div>

      <!-- History -->
      <h4 class="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">Recent Backups</h4>
      <div class="space-y-0">
        ${history.slice(0, 15).map(e => `
          <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-container transition-colors text-xs">
            <span class="font-mono text-on-surface-variant w-24 shrink-0">${new Date(e.timestamp).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
            <span class="w-2 h-2 rounded-full ${e.status === 'ok' ? 'bg-secondary' : 'bg-error'} shrink-0"></span>
            <span class="flex-1 font-medium">${fmtDuration(e.duration_sec)}</span>
            <span class="text-on-surface-variant">${fmtBytes(e.original_size)}</span>
            <span class="text-on-surface-variant">${e.nfiles_new ? `+${e.nfiles_new}` : ''}</span>
          </div>
        `).join('')}
      </div>

      <!-- Actions -->
      <div class="flex gap-3 mt-8 pt-6 border-t border-outline-variant/10">
        <button onclick="openEditHost('${name}')" class="bg-surface-container-high hover:bg-surface-container-highest px-5 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2">
          <span class="material-symbols-outlined text-sm">settings</span> Edit
        </button>
        <button onclick="confirmDelete('${name}')" class="hover:bg-error/10 text-error px-5 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2">
          <span class="material-symbols-outlined text-sm">delete</span> Delete
        </button>
      </div>
    `;
}

function buildCalendar(cal) {
    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        const data = cal[key];
        const num = d.getDate();
        if (!data) { days.push(`<div class="aspect-square rounded bg-surface-container flex items-center justify-center text-[10px] text-slate-600" title="${key}: No backup">${num}</div>`); }
        else {
            const cls = data.has_error ? 'bg-error/20 text-error' : 'bg-secondary/20 text-secondary';
            days.push(`<div class="aspect-square rounded ${cls} flex items-center justify-center text-[10px] font-bold cursor-default" title="${key}: ${data.count}x, ${fmtBytes(data.total_size)}">${num}</div>`);
        }
    }
    return days.join('');
}

function buildSizeChart(history) {
    const byDay = {};
    history.forEach(e => { const d = e.timestamp.split('T')[0]; byDay[d] = (byDay[d]||0) + e.original_size; });
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate()-i); days.push({key:d.toISOString().split('T')[0], size: byDay[d.toISOString().split('T')[0]]||0}); }
    const max = Math.max(...days.map(d=>d.size), 1);
    return days.map(d => {
        const h = d.size ? Math.max(6, (d.size/max)*100) : 4;
        return `<div class="flex-1 rounded-t bg-primary ${d.size ? 'opacity-70 hover:opacity-100' : 'opacity-15'} transition-opacity" style="height:${h}%" title="${d.key}: ${fmtBytes(d.size)}"></div>`;
    }).join('');
}

function closeDrawer() {
    document.getElementById('drawerBg').classList.add('opacity-0','pointer-events-none');
    document.getElementById('drawer').classList.add('translate-x-full');
}

// ── Modal ─────────────────────────────────────────────────
function openAddHost() {
    document.getElementById('modalTitle').textContent = 'Add Host';
    document.getElementById('formMode').value = 'add';
    document.getElementById('formName').value = ''; document.getElementById('formName').disabled = false;
    document.getElementById('formKumaUrl').value = '';
    document.getElementById('formEnabled').checked = true;
    openModal();
}

async function openEditHost(name) {
    closeDrawer();
    const h = allHosts.find(x => x.name === name); if (!h) return;
    document.getElementById('modalTitle').textContent = `Edit: ${name}`;
    document.getElementById('formMode').value = 'edit';
    document.getElementById('formName').value = h.name; document.getElementById('formName').disabled = true;
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
        await apiFetch(`${API}/api/hosts`, { method:'POST', headers:authHeaders(), body:JSON.stringify({name, kuma_push_url:kuma}) });
        toast(`${name} added`);
    } else {
        await apiFetch(`${API}/api/hosts/${name}`, { method:'PUT', headers:authHeaders(), body:JSON.stringify({kuma_push_url:kuma, enabled}) });
        toast(`${name} updated`);
    }
    closeModal(); loadAll();
}

async function confirmDelete(name) {
    if (!confirm(`Delete "${name}" and all history?`)) return;
    await apiFetch(`${API}/api/hosts/${name}`, { method:'DELETE', headers:authHeaders() });
    toast(`${name} deleted`); closeDrawer(); loadAll();
}

function openModal() { document.getElementById('modalBg').classList.remove('opacity-0','pointer-events-none'); const m = document.getElementById('modal'); m.classList.remove('scale-95','opacity-0','pointer-events-none'); }
function closeModal() { document.getElementById('modalBg').classList.add('opacity-0','pointer-events-none'); const m = document.getElementById('modal'); m.classList.add('scale-95','opacity-0','pointer-events-none'); }

// ── Navigation ────────────────────────────────────────────
function showPage(page) {
    currentPage = page;
    ['dashboard','alerts','hosts','config'].forEach(p => {
        document.getElementById(`page-${p}`).classList.toggle('hidden', p !== page);
        // Nav highlights
        const nav = document.getElementById(`nav-${p}`);
        const side = document.getElementById(`side-${p}`);
        if (nav) { nav.className = p === page ? 'text-sm font-bold tracking-tight text-blue-400 px-3 py-1 rounded-lg font-headline' : 'text-sm font-medium tracking-tight text-slate-400 hover:bg-slate-800/50 px-3 py-1 rounded-lg transition-colors font-headline'; }
        if (side) { side.className = p === page ? 'flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-600/10 text-blue-400 border-r-2 border-blue-500 font-headline text-sm font-semibold' : 'flex items-center gap-3 px-4 py-3 rounded-xl text-slate-500 hover:text-slate-300 hover:bg-slate-900/80 transition-all font-headline text-sm font-semibold'; }
    });
}

// ── Toast ─────────────────────────────────────────────────
function toast(msg) {
    const t = document.createElement('div');
    t.className = 'glass px-5 py-3 rounded-xl text-sm font-medium text-white shadow-2xl flex items-center gap-2 animate-[slideIn_0.3s_ease-out]';
    t.innerHTML = `<span class="material-symbols-outlined text-secondary text-sm" style="font-variation-settings:'FILL' 1">check_circle</span> ${msg}`;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

// ── Helpers ───────────────────────────────────────────────
function fmtBytes(b) { if (!b) return '0 B'; const u = ['B','KB','MB','GB','TB']; const i = Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(i>0?1:0)+' '+u[i]; }
function fmtDuration(s) { if (!s) return '–'; if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'m'; return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; }
function timeAgo(iso) { const d=(Date.now()-new Date(iso).getTime())/1000; if(d<60) return 'just now'; if(d<3600) return Math.floor(d/60)+'m ago'; if(d<86400) return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }
function statusChipClass(s) { return { ok:'bg-secondary/10 text-secondary border border-secondary/20', error:'bg-error/10 text-error border border-error/20', stale:'bg-tertiary/10 text-tertiary border border-tertiary/20', disabled:'bg-outline/10 text-outline border border-outline/20' }[s] || ''; }
