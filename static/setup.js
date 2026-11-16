// First-run screen: real machine facts, real readiness, one button to install what is missing.
(() => {
  const U = PixelUI, $ = id => document.getElementById(id);
  if (new URLSearchParams(location.search).has('inset')) document.body.classList.add('inset');
  let primaryAction = () => watcher.refresh();

  const watcher = U.createSystemWatcher(render, error => {
    $('readinessList').innerHTML = `<div class="empty"><strong>Can’t reach Pixel’s local service</strong>${U.escapeHtml(error.message)}</div>`;
    $('readySummary').textContent = 'Unavailable';
    setPrimary('Try again', () => watcher.refresh());
  });

  function setPrimary(label, action, disabled = false) {
    $('primary').textContent = label; $('primary').disabled = disabled; primaryAction = action;
  }

  function render(data) {
    const { machine, items, jobs, summary } = data;
    $('machineIcon').textContent = (machine.os || '?').slice(0, 1).toUpperCase();
    $('machineName').textContent = `${machine.os} ${machine.os_version} · ${machine.chip}`;
    $('machineMeta').textContent = U.machineLine(machine);
    $('readySummary').textContent = `${summary.ready} of ${summary.required} ready`;
    $('readyProgress').style.width = `${summary.required ? summary.ready / summary.required * 100 : 0}%`;

    const required = items.filter(item => item.required), todo = required.filter(item => !item.ready);
    const actions = U.missingActions(items, true), busy = Object.values(jobs).some(U.jobActive);
    const bytes = todo.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
    $('privacy').textContent = todo.length && bytes ? `Nothing leaves this computer · about ${U.fmtBytes(bytes)} to download` : 'Nothing leaves this computer';

    if (!todo.length) {
      $('headline').innerHTML = 'You’re all set.'; $('lede').textContent = 'Everything Pixel needs is installed and running on this computer.';
      setPrimary('Start talking', () => U.navigate('talk'));
    } else if (busy) setPrimary('Setting up…', () => {}, true);
    else if (actions.length) setPrimary(`Install missing items (${todo.filter(item => item.action).length})`, () => watcher.install(actions));
    else setPrimary('Re-check', () => watcher.refresh());

    const order = [...required, ...items.filter(item => !item.required)];
    $('readinessList').innerHTML = order.map(item => {
      const state = U.itemState(item, jobs);
      const note = state.error || (state.busy ? state.message : item.hint) || '';
      return `<div class="row"><span class="status ${state.tone}">${U.escapeHtml(state.label)}</span><div class="row-copy"><h3>${U.escapeHtml(item.name)} · ${U.escapeHtml(item.kind)}</h3>${note ? `<p class="${state.error ? 'err' : ''}">${U.escapeHtml(note)}</p>` : ''}</div></div>`;
    }).join('');
  }

  $('primary').addEventListener('click', () => primaryAction());
  $('review').addEventListener('click', () => U.navigate('models'));
  watcher.refresh();
})();
