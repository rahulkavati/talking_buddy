/* Pixel UI kit: shared navigation, API client, settings binding and pure helpers.
   Classic script (no build step). Pure helpers are exported for unit tests (tests/ui). */
(function (root) {
  'use strict';
  const doc = root.document;

  const NAV = [
    { id: 'talk', href: '/', label: 'Talk' },
    { id: 'models', href: '/models', label: 'Models & Tools' },
    { id: 'engine', href: '/engine', label: 'Conversation Engine' },
    { id: 'latency', href: '/latency', label: 'Latency Lab' },
    { id: 'look', href: '/look', label: 'Voice & Look' },
    { id: 'settings', href: '/settings', label: 'Settings' },
  ];
  const hrefFor = id => id === 'setup' ? '/setup' : NAV.find(n => n.id === id)?.href;

  /* ---------- pure helpers ---------- */
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  /** Summary statistics for a list of millisecond delays. */
  function summarize(values) {
    const v = values.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    return { count: v.length, median: percentile(v, .5), p90: percentile(v, .9), best: v[0] ?? null, worst: v[v.length - 1] ?? null };
  }
  const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  /** Traffic-light bucket for a reply delay. */
  const delayTone = ms => ms == null ? 'none' : ms <= 1000 ? 'good' : ms <= 1800 ? 'ok' : 'slow';
  const fmtBytes = n => !n ? '—' : n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.round(n / 1e6)} MB`;
  const timeAgo = (ts, now = Date.now()) => {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  const jobActive = job => !!job && (job.state === 'queued' || job.state === 'running');

  /** How one system item should be shown, given the running setup jobs. */
  function itemState(item, jobs = {}) {
    if (item.ready) return { tone: 'ready', label: 'Ready' };
    const job = item.action ? jobs[item.action] : null;
    if (jobActive(job)) {
      const label = job.state === 'queued' ? 'Waiting' : job.progress != null ? `Installing ${Math.round(job.progress * 100)}%` : 'Installing…';
      return { tone: 'busy', label, busy: true, progress: job.progress, message: job.message };
    }
    if (job?.state === 'error') return { tone: 'error', label: 'Failed', error: job.error };
    if (item.optional) return { tone: 'optional', label: 'Planned' };
    if (!item.required) return { tone: 'optional', label: 'Optional' };
    return { tone: 'missing', label: item.installed ? 'Not running' : 'Not installed' };
  }
  /** Unique setup actions that would fix the not-ready items. */
  function missingActions(items, requiredOnly = false) {
    return [...new Set(items.filter(i => !i.ready && i.action && (!requiredOnly || i.required)).map(i => i.action))];
  }
  const machineLine = m => !m ? '' : [m.memory_bytes && `${Math.round(m.memory_bytes / 2 ** 30)} GB memory`, m.disk_free_bytes && `${fmtBytes(m.disk_free_bytes)} free`].filter(Boolean).join(' · ');

  /* ---------- reply-delay history (per browser profile, never throws) ---------- */
  const TURNS_KEY = 'pixel.turns', MAX_TURNS = 200;
  const turns = {
    all() { try { const list = JSON.parse(root.localStorage.getItem(TURNS_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch (_) { return []; } },
    add(entry) { try { root.localStorage.setItem(TURNS_KEY, JSON.stringify([...turns.all(), { ts: Date.now(), kind: 'voice', ...entry }].slice(-MAX_TURNS))); } catch (_) { /* storage full or blocked */ } },
    clear() { try { root.localStorage.removeItem(TURNS_KEY); } catch (_) { /* ignore */ } },
  };

  /* ---------- API ---------- */
  async function api(path, options = {}) {
    let response;
    try { response = await root.fetch(path, { cache: 'no-store', ...options }); }
    catch (_) { throw new Error('Pixel’s local service is not reachable. Start it and try again.'); }
    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON body */ }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || data?.detail || `Request failed (${response.status})`);
    return data;
  }
  const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /** Polls system status only while an install is running. */
  function createSystemWatcher(onUpdate, onError) {
    let timer = null, last = null;
    async function refresh() {
      clearTimeout(timer);
      try { last = await api('/api/system/status'); } catch (error) { onError?.(error); return null; }
      onUpdate(last);
      if (Object.values(last.jobs || {}).some(jobActive)) timer = setTimeout(refresh, 900);
      return last;
    }
    async function install(actions) {
      try { for (const action of new Set(actions)) await postJson('/api/system/setup', { action }); }
      catch (error) { toast(error.message, 'error'); }
      return refresh();
    }
    return { refresh, install, get data() { return last; } };
  }

  /** Batches setting changes into one request; `flush()` sends immediately. */
  function createSaver(onSaved) {
    let pending = {}, timer = null;
    async function flush() {
      clearTimeout(timer); timer = null;
      if (!Object.keys(pending).length) return;
      const body = pending; pending = {};
      try { onSaved(await postJson('/api/settings', body)); toast('Saved', 'ok'); }
      catch (error) { toast(error.message, 'error'); onSaved(null, error); }
    }
    const save = patch => { Object.assign(pending, patch); clearTimeout(timer); timer = setTimeout(flush, 350); };
    save.flush = flush;
    return save;
  }

  /** Wires every [data-setting] control under `scope` to the settings object. */
  function bindSettings(scope, settings, save, formats = {}) {
    scope.querySelectorAll('[data-setting]').forEach(control => {
      const key = control.dataset.setting, scale = Number(control.dataset.scale || 1);
      const paint = value => {
        if (control.type === 'range') control.style.setProperty('--fill', `${(control.value - control.min) / (control.max - control.min) * 100}%`);
        const out = scope.querySelector(`[data-value-for="${key}"]`);
        if (out) out.textContent = formats[key] ? formats[key](value) : value;
      };
      const read = () => control.type === 'checkbox' ? control.checked : control.type === 'range' ? Number(control.value) / scale : control.type === 'radio' ? control.value : control.value.trim();
      const value = settings[key];
      if (control.type === 'checkbox') control.checked = !!value;
      else if (control.type === 'radio') control.checked = control.value === value;
      else if (control.type === 'range') control.value = Math.round(value * scale);
      else control.value = value ?? '';
      paint(value);
      if (control.dataset.bound) return;
      control.dataset.bound = '1';
      control.addEventListener(control.type === 'range' || control.type === 'text' ? 'input' : 'change', () => {
        if (control.type === 'radio' && !control.checked) return;
        const next = read();
        paint(next);
        if (control.type === 'text' && !next) return;
        save({ [key]: next });
      });
    });
  }

  /* ---------- audio ---------- */
  let audioCtx = null;
  async function playWav(base64) {
    if (!base64) throw new Error('No audio came back. Check that the voice is installed.');
    audioCtx = audioCtx || new (root.AudioContext || root.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const bytes = Uint8Array.from(root.atob(base64), c => c.charCodeAt(0));
    const source = audioCtx.createBufferSource();
    source.buffer = await audioCtx.decodeAudioData(bytes.buffer);
    source.connect(audioCtx.destination);
    source.start();
    return new Promise(resolve => { source.onended = resolve; });
  }

  /* ---------- navigation ---------- */
  const params = () => new URLSearchParams(root.location?.search || '');
  const embedded = () => params().has('embedded') && root.parent !== root;
  function navigate(id) {
    const href = hrefFor(id); if (!href) return;
    if (embedded()) root.parent.postMessage({ type: 'pixel:navigate', page: id }, root.location.origin);
    else root.location.href = href;
  }
  function navHtml(active) {
    return `<nav aria-label="Pixel">${NAV.map(n => `<a href="${n.href}" class="nav-item${n.id === active ? ' active' : ''}"${n.id === active ? ' aria-current="page"' : ''} data-nav="${n.id}"><i></i>${escapeHtml(n.label)}${n.id === 'models' ? '<b class="nav-badge" hidden></b>' : ''}</a>`).join('')}</nav>`;
  }
  function wireNav(scope, onNavigate) {
    scope.querySelectorAll('[data-nav]').forEach(link => link.addEventListener('click', event => {
      if (onNavigate) { event.preventDefault(); onNavigate(link.dataset.nav); }
      else if (embedded()) { event.preventDefault(); navigate(link.dataset.nav); }
    }));
  }
  function applyFrameFlags() {
    if (embedded()) doc.body.classList.add('embedded');
    if (params().has('inset')) doc.body.classList.add('inset');
  }
  /** Sidebar for a page (hidden by CSS when the page runs inside the desktop shell). */
  function mountSidebar(active, { onNavigate } = {}) {
    applyFrameFlags();
    const side = doc.getElementById('side'); if (!side) return;
    side.innerHTML = `<a class="brand" href="/setup" data-nav="setup" aria-label="Pixel setup"><span class="brand-mark">✿</span><span>PIXEL</span></a>${navHtml(active)}<div class="machine-foot" id="sideFoot">Runs on this computer<br>Nothing leaves it by default</div>`;
    wireNav(side, onNavigate);
  }
  function markActive(id) {
    doc.querySelectorAll('[data-nav]').forEach(link => { const on = link.dataset.nav === id; link.classList.toggle('active', on); on ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current'); });
  }
  function setNavBadge(count) { doc.querySelectorAll('.nav-badge').forEach(el => { el.hidden = !count; el.textContent = count; }); }
  function setSideFoot(machine) { const el = doc.getElementById('sideFoot'); if (el && machine) el.innerHTML = `${escapeHtml(machine.os)} · ${escapeHtml(machine.chip)}<br>${escapeHtml(machineLine(machine))}`; }

  /** Slide-in navigation for the full-screen Talk page. */
  function mountDrawer(button, active) {
    applyFrameFlags();
    const backdrop = doc.createElement('div'); backdrop.className = 'drawer-backdrop';
    const drawer = doc.createElement('aside'); drawer.className = 'drawer'; drawer.setAttribute('aria-label', 'Pixel navigation'); drawer.inert = true;
    drawer.innerHTML = `<div class="brand"><span class="brand-mark">✿</span><span>PIXEL</span><button class="drawer-close" aria-label="Close menu">×</button></div>${navHtml(active)}<div class="machine-foot">Runs on this computer<br>Nothing leaves it by default</div>`;
    doc.body.append(backdrop, drawer);
    const setOpen = open => { drawer.classList.toggle('open', open); backdrop.classList.toggle('open', open); drawer.inert = !open; button.setAttribute('aria-expanded', String(open)); if (open) drawer.querySelector('a').focus(); else button.focus(); };
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => setOpen(true));
    backdrop.addEventListener('click', () => setOpen(false));
    drawer.querySelector('.drawer-close').addEventListener('click', () => setOpen(false));
    doc.addEventListener('keydown', event => { if (event.key === 'Escape' && drawer.classList.contains('open')) setOpen(false); });
    wireNav(drawer, id => { if (id === active) setOpen(false); else navigate(id); });
  }

  let toastTimer;
  function toast(message, tone = 'info') {
    let el = doc.getElementById('toast');
    if (!el) { el = doc.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); doc.body.append(el); }
    el.className = `${tone} show`; el.textContent = message;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), tone === 'error' ? 6000 : 2600);
  }

  const PixelUI = { NAV, hrefFor, escapeHtml, summarize, fmtMs, fmtBytes, delayTone, timeAgo, jobActive, itemState, missingActions, machineLine, turns, api, postJson, createSystemWatcher, createSaver, bindSettings, playWav, embedded, navigate, mountSidebar, markActive, setNavBadge, setSideFoot, mountDrawer, toast };
  if (typeof module !== 'undefined' && module.exports) module.exports = PixelUI;
  else root.PixelUI = PixelUI;
})(typeof window !== 'undefined' ? window : globalThis);
