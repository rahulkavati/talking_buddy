// Latency Lab: real reply delays recorded on the Talk page, plus an on-demand timed test.
(() => {
  const U = PixelUI, $ = id => document.getElementById(id);
  U.mountSidebar('latency');
  let lastAudio = '';
  const STAGES = [['first_token_ms', 'Model starts answering'], ['first_sentence_ms', 'First sentence written'], ['tts_ms', 'Voice for that sentence'], ['first_audio_ms', 'Until you would hear it']];

  function renderVoice() {
    const turns = U.turns.all().filter(turn => turn.kind !== 'probe'), stats = U.summarize(turns.map(turn => turn.ms));
    if (!stats.count) { $('voiceStats').innerHTML = '<div class="empty"><strong>No conversations measured yet</strong>Talk to Pixel, then come back. Each reply is timed automatically.</div>'; return; }
    const recent = turns.slice(-28), peak = Math.max(...recent.map(turn => turn.ms));
    $('voiceStats').innerHTML = `<div class="stat-row"><div class="stat hero"><b data-tone="${U.delayTone(stats.median)}">${U.fmtMs(stats.median)}</b><small>typical reply delay</small></div>
      <div class="stat"><b>${U.fmtMs(stats.best)}</b><small>fastest</small></div><div class="stat"><b>${U.fmtMs(stats.p90)}</b><small>9 in 10 are under</small></div><div class="stat"><b>${stats.count}</b><small>replies timed</small></div></div>
      <div class="spark" role="img" aria-label="Delay of the last ${recent.length} replies">${recent.map(turn => `<i data-tone="${U.delayTone(turn.ms)}" style="height:${Math.max(6, turn.ms / peak * 100)}%" title="${U.fmtMs(turn.ms)}"></i>`).join('')}</div>
      <p class="note">Last ${recent.length} replies, oldest on the left. Green is under 1 s, amber under 1.8 s.</p>`;
  }

  function renderProbe(entry) {
    if (!entry) { $('probeResult').innerHTML = '<p class="note">No test run yet.</p>'; return; }
    const total = entry.stages.first_audio_ms || 1;
    $('probeResult').innerHTML = STAGES.map(([key, label]) => `<div class="stage"><div><span>${label}</span><b>${U.fmtMs(entry.stages[key])}</b></div><div class="progress"><span style="width:${Math.min(100, entry.stages[key] / total * 100)}%"></span></div></div>`).join('')
      + `<p class="note">“${U.escapeHtml(entry.reply || '')}”${entry.model ? ` · ${U.escapeHtml(entry.model)}` : ''}</p>`
      + (lastAudio ? '<div class="inline"><button class="button secondary small" id="play">▶ Hear it</button></div>' : '');
    $('play')?.addEventListener('click', () => U.playWav(lastAudio).catch(error => U.toast(error.message, 'error')));
  }

  function renderRecent() {
    const list = U.turns.all().slice(-10).reverse();
    $('clear').disabled = !list.length;
    $('recent').innerHTML = list.length ? list.map(turn => `<div class="row"><div class="row-copy"><h3>${U.escapeHtml(turn.text || (turn.kind === 'text' ? 'Typed message' : 'Voice turn'))}</h3><p>${turn.kind === 'probe' ? 'Speed test' : turn.kind === 'text' ? 'Typed · thinking and speaking only' : 'Spoken · full turn'} · ${U.timeAgo(turn.ts)}</p></div><div class="row-actions"><span class="status ${turn.kind === 'probe' ? 'optional' : 'ready'}" data-tone="${U.delayTone(turn.ms)}">${U.fmtMs(turn.ms)}</span></div></div>`).join('') : '<div class="empty">Nothing measured yet.</div>';
  }
  const renderAll = () => { renderVoice(); renderRecent(); renderProbe(U.turns.all().filter(turn => turn.kind === 'probe').pop()); };

  $('probeForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('runTest'); button.disabled = true; button.textContent = 'Testing…';
    try {
      const result = await U.postJson('/api/latency/probe', { text: $('probeText').value });
      lastAudio = result.audio;
      U.turns.add({ kind: 'probe', ms: result.timings.first_audio_ms, stages: result.timings, text: result.prompt, reply: result.reply.slice(0, 160), model: result.model });
      renderAll();
    } catch (error) { U.toast(error.message, 'error'); }
    button.disabled = false; button.textContent = 'Run test';
  });
  $('clear').addEventListener('click', () => { if (confirm('Clear all saved reply timings?')) { U.turns.clear(); lastAudio = ''; renderAll(); } });
  renderAll();
})();
