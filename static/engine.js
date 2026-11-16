// Conversation Engine: every enabled control is saved to /api/settings and used by the next conversation.
(async () => {
  const U = PixelUI, $ = id => document.getElementById(id);
  U.mountSidebar('engine');
  const band = (value, low, mid, high) => value < 34 ? low : value < 67 ? mid : high;
  const formats = {
    patience: v => `${band(v, 'Quick', 'Balanced', 'Patient')} · ${((350 + 7 * v) / 1000).toFixed(2)} s pause`,
    interrupt: v => band(v, 'Relaxed', 'Balanced', 'Quick'),
    speed: v => `${Number(v).toFixed(2)}×`,
  };
  let payload;
  try { payload = await U.api('/api/settings'); }
  catch (error) { $('controls').innerHTML = `<div class="card empty"><strong>Can’t load settings</strong>${U.escapeHtml(error.message)}</div>`; return; }

  const save = U.createSaver(next => { if (next) payload = next; render(); });
  function render() {
    const { settings, options } = payload;
    $('modelSelect').innerHTML = options.models.map(name => `<option value="${U.escapeHtml(name)}">${U.escapeHtml(name)}</option>`).join('');
    $('voiceSelect').innerHTML = options.voices.map(v => `<option value="${v.id}">${U.escapeHtml(v.label)}</option>`).join('');
    $('modelNote').textContent = options.models_live ? 'Models already downloaded in Ollama. Add more on the Models & Tools page.' : 'Ollama isn’t running, so only the configured model is listed.';
    $('sttName').textContent = `Whisper · ${options.stt}`;
    $('pipecatOption').disabled = !options.pipecat_ready;
    $('transportNote').textContent = options.pipecat_ready ? 'Classic is the tested link. WebRTC adds stronger echo cancellation and smarter turn-taking.' : 'WebRTC needs the full-duplex upgrade from Models & Tools. Classic is the tested link.';
    $('cascadeLink').textContent = settings.transport === 'pipecat' ? 'WebRTC (Pipecat)' : 'Classic (WebSocket)';
    U.bindSettings(document, settings, save, formats);
  }
  render();

  const voiceTurns = U.turns.all().filter(turn => turn.kind !== 'probe').map(turn => turn.ms);
  const stats = U.summarize(voiceTurns);
  if (stats.count) $('cascadeDelay').textContent = `${U.fmtMs(stats.median)} median over ${stats.count}`;
})();
