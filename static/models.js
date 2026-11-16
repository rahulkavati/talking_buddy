// Models & Tools: live install status, per-item actions and download progress.
(() => {
  const U = PixelUI, $ = id => document.getElementById(id);
  U.mountSidebar('models');
  const GROUPS = [['hearing', 'Hearing'], ['thinking', 'Thinking & speaking'], ['plumbing', 'Full-duplex upgrade']];
  // One install covers several rows; only this row shows the button.
  const ACTION_OWNER = { voice_stack: 'pipecat' };

  const watcher = U.createSystemWatcher(render, error => {
    $('groups').innerHTML = `<div class="card empty"><strong>Can’t reach Pixel’s local service</strong>${U.escapeHtml(error.message)}</div>`;
    $('installAll').disabled = true;
  });

  function row(item, jobs) {
    const state = U.itemState(item, jobs), job = item.action ? jobs[item.action] : null;
    const owns = item.action && (ACTION_OWNER[item.action] || item.id) === item.id;
    const detail = [item.kind, state.busy ? state.message : item.detail, !item.ready && item.size_bytes ? `about ${U.fmtBytes(item.size_bytes)}` : ''].filter(Boolean).join(' · ');
    const note = state.error || (!state.busy && item.hint) || (!owns && item.action && !state.busy ? 'Installs with Pipecat.' : '');
    let action = '';
    if (!state.busy && owns) action = `<button class="button primary small" data-action="${item.action}">${job?.state === 'error' ? 'Retry' : item.action === 'ollama' ? 'Start' : 'Install'}</button>`;
    else if (item.url && !item.ready) action = `<a class="button secondary small" href="${U.escapeHtml(item.url)}" target="_blank" rel="noopener">Get it</a>`;
    const bar = state.busy ? `<div class="progress${state.progress == null ? ' indeterminate' : ''}"><span style="width:${Math.round((state.progress || 0) * 100)}%"></span></div>` : '';
    return `<article class="row"><div class="tool-icon ${state.tone}">${U.escapeHtml(item.name.replace(/[^A-Za-z]/g, '').slice(0, item.id === 'moshi' ? 2 : 1).replace(/^./, c => c.toUpperCase()))}</div>
      <div class="row-copy"><h3>${U.escapeHtml(item.name)}</h3><p>${U.escapeHtml(detail)}</p>${note ? `<p class="${state.error ? 'err' : ''}">${U.escapeHtml(note)}</p>` : ''}${bar}</div>
      <div class="row-actions"><span class="status ${state.tone}">${U.escapeHtml(state.label)}</span>${action}</div></article>`;
  }

  function render(data) {
    const { items, jobs } = data, busy = Object.values(jobs).some(U.jobActive);
    const actions = U.missingActions(items, true);
    U.setNavBadge(items.filter(item => item.required && !item.ready).length);
    U.setSideFoot(data.machine);
    $('installAll').disabled = busy || !actions.length;
    $('installAll').textContent = busy ? 'Installing…' : actions.length ? 'Install all missing' : 'Everything required is ready';
    $('installAll').onclick = () => watcher.install(actions);
    $('groups').innerHTML = GROUPS.map(([id, title]) => `<section class="group" style="margin-bottom:14px"><p class="group-title">${title}</p>${items.filter(item => item.group === id).map(item => row(item, jobs)).join('')}</section>`).join('');
    $('groups').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { button.disabled = true; watcher.install([button.dataset.action]); }));
  }

  $('refresh').addEventListener('click', async () => { $('refresh').disabled = true; await watcher.refresh(); $('refresh').disabled = false; });
  watcher.refresh();
})();
