(function () {
  const button = document.getElementById('settings') || createButton();
  if (!button) return;

  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.innerHTML = `
    <div class="settings-backdrop" data-close></div>
    <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <header class="settings-header"><div><div class="settings-kicker">LOCAL SYSTEM // CONTROL</div><h2 id="settingsTitle">SYSTEM SETUP</h2></div><button class="settings-close" data-close aria-label="Close">×</button></header>
      <p class="settings-intro">Pixel checks these local services before starting a conversation. Install or prepare anything that is missing.</p>
      <div id="systemItems" class="system-items"><div class="settings-loading">CHECKING LOCAL SERVICES…</div></div>
      <div id="systemMessage" class="system-message" aria-live="polite"></div>
    </section>`;
  document.body.appendChild(modal);

  const items = modal.querySelector('#systemItems');
  const message = modal.querySelector('#systemMessage');
  const close = () => modal.classList.remove('open');
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  button.addEventListener('click', () => { modal.classList.add('open'); refresh(); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function createButton() {
    const controls = document.querySelector('.controls');
    if (!controls) return null;
    const el = document.createElement('button');
    el.id = 'settings'; el.className = 'icon-btn glass'; el.title = 'System setup'; el.textContent = '⚙';
    controls.insertBefore(el, controls.querySelector('#talk'));
    return el;
  }

  async function refresh() {
    message.textContent = '';
    items.innerHTML = '<div class="settings-loading">CHECKING LOCAL SERVICES…</div>';
    try {
      const response = await fetch('/api/system/status');
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Status check failed');
      render(data.items || []);
    } catch (error) {
      items.innerHTML = '<div class="settings-error">Unable to reach the local service. Start the app service and try again.</div>';
      message.textContent = error.message;
    }
  }

  function render(list) {
    items.innerHTML = list.map(item => {
      const ready = item.ready ? 'ready' : (item.installed ? 'installed' : 'missing');
      const action = item.id === 'brain' || item.id === 'whisper' || item.id === 'kokoro';
      return `<article class="system-row"><div class="system-copy"><div class="system-name">${escapeHtml(item.name)} <span class="system-kind">${escapeHtml(item.kind || '')}</span></div><div class="system-detail">${escapeHtml(item.detail || '')}</div></div><div class="system-action"><span class="system-status ${ready}">${item.ready ? 'READY' : item.installed ? 'INSTALLED' : 'MISSING'}</span>${action && !item.ready ? `<button class="setup-button" data-action="${escapeHtml(item.id)}">SET UP</button>` : ''}</div></article>`;
    }).join('');
    items.querySelectorAll('.setup-button').forEach(btn => btn.addEventListener('click', () => setup(btn.dataset.action, btn)));
  }

  async function setup(action, buttonEl) {
    buttonEl.disabled = true; buttonEl.textContent = 'WORKING…'; message.textContent = 'Preparing ' + action + '. This can take a few minutes the first time.';
    try {
      const response = await fetch('/api/system/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Setup failed');
      message.textContent = data.message || 'Setup complete.'; render(data.items || []);
    } catch (error) { buttonEl.disabled = false; buttonEl.textContent = 'RETRY'; message.textContent = error.message; }
  }

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
})();

if (!document.querySelector('script[src="/static/desktop-drawer.js"]')) {
  const drawerScript = document.createElement('script');
  drawerScript.src = '/static/desktop-drawer.js';
  document.body.appendChild(drawerScript);
}
