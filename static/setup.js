const $ = id => document.getElementById(id);
let systemItems = [];

async function refreshStatus() {
  try {
    const response = await fetch('/api/system/status');
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Status unavailable');
    systemItems = data.items || [];
    renderStatus();
  } catch (error) {
    $('readinessList').innerHTML = '<div class="loading">Local service unavailable. Start the app service and try again.</div>';
    $('readySummary').textContent = 'Unavailable';
  }
}

function renderStatus() {
  const ready = systemItems.filter(item => item.ready).length;
  const total = systemItems.length || 1;
  const missing = systemItems.filter(item => !item.ready && item.id !== 'ollama').length;
  $('readySummary').textContent = `${ready} of ${total} ready`;
  $('readyProgress').style.width = `${Math.round(ready / total * 100)}%`;
  $('missingCount').textContent = `(${missing})`;
  $('downloadSize').textContent = missing ? 'a few GB' : '0 GB';
  $('machineMeta').textContent = 'Local services checked · private by default';
  $('readinessList').innerHTML = systemItems.map(item => {
    const kind = item.kind || 'System component';
    const state = item.ready ? 'ready' : item.id === 'ollama' ? 'optional' : 'missing';
    const label = item.ready ? 'Ready' : item.id === 'ollama' ? 'Installed' : 'Missing';
    return `<div class="status-row"><span class="status-pill ${state}">${label}</span><span>${escapeHtml(item.name)} · ${escapeHtml(kind)}</span></div>`;
  }).join('');
}

async function installMissing() {
  const missing = systemItems.filter(item => !item.ready && ['brain', 'whisper', 'kokoro'].includes(item.id));
  $('installMissing').disabled = true;
  $('installMissing').textContent = 'Setting up…';
  for (const item of missing) {
    $('readySummary').textContent = `Setting up ${item.name}…`;
    await fetch('/api/system/setup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action:item.id}) });
  }
  await refreshStatus();
  $('installMissing').disabled = false;
  $('installMissing').innerHTML = 'Install missing items <span id="missingCount">(0)</span>';
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
$('installMissing').addEventListener('click', installMissing);
$('reviewList').addEventListener('click', () => document.querySelector('.readiness-card').scrollIntoView({behavior:'smooth'}));
refreshStatus();
