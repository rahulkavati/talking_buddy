// Settings: privacy switches, a real microphone check, and data housekeeping.
(async () => {
  const U = PixelUI, $ = id => document.getElementById(id);
  U.mountSidebar('settings');
  let payload;
  try { payload = await U.api('/api/settings'); }
  catch (error) { $('controls').innerHTML = `<div class="card empty"><strong>Can’t load settings</strong>${U.escapeHtml(error.message)}</div>`; return; }
  const save = U.createSaver(next => { if (next) payload = next; render(); });

  async function render() {
    const { settings, options } = payload;
    $('webNote').textContent = options.web_triggers.length ? `Only when you say “${options.web_triggers[0]}”. Otherwise Pixel stays offline.` : 'Only when you ask for it out loud';
    U.bindSettings(document, settings, save);
    let version = '';
    try { version = (await U.api('/api/config')).version || ''; } catch (_) { /* shown as unknown */ }
    const facts = [['Version', version || 'Unknown'], ['Language model', settings.model], ['Speech-to-text', `Whisper · ${options.stt}`], ['Voice', `${options.tts_engine} · ${settings.voice}`], ['Audio link', settings.transport === 'pipecat' ? 'WebRTC (Pipecat)' : 'Classic (WebSocket)']];
    $('about').innerHTML = facts.map(([label, value]) => `<div class="kv"><span>${label}</span><span>${U.escapeHtml(value)}</span></div>`).join('');
  }
  render();

  /* microphone check: permission, then a live level meter */
  let mic = null;
  function stopMic() {
    if (!mic) return;
    cancelAnimationFrame(mic.frame); mic.stream.getTracks().forEach(track => track.stop()); mic.context.close(); mic = null;
    $('micLevel').style.width = '0'; $('micTest').textContent = 'Test microphone';
  }
  $('micTest').addEventListener('click', async () => {
    if (mic) { stopMic(); $('micState').textContent = 'Test stopped.'; return; }
    if (!navigator.mediaDevices?.getUserMedia) { $('micState').textContent = 'This window can’t use a microphone.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: payload.settings.echo, noiseSuppression: true } });
      const context = new (window.AudioContext || window.webkitAudioContext)(), analyser = context.createAnalyser(), data = new Float32Array(1024);
      analyser.fftSize = 1024; context.createMediaStreamSource(stream).connect(analyser);
      mic = { stream, context, frame: 0 }; let heard = false;
      $('micTest').textContent = 'Stop test'; $('micState').textContent = `Listening on “${stream.getAudioTracks()[0]?.label || 'default microphone'}”. Say something.`;
      const tick = () => {
        if (!mic) return;
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
        $('micLevel').style.width = `${Math.min(100, rms * 900)}%`;
        if (!heard && rms > .02) { heard = true; $('micState').textContent = 'Pixel can hear you. The microphone works.'; }
        mic.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      $('micState').textContent = error.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your system or browser settings, then try again.' : `No microphone available (${error.message}).`;
    }
  });
  addEventListener('pagehide', stopMic);

  $('resetChat').addEventListener('click', async () => { try { await U.postJson('/api/reset', {}); U.toast('Conversation forgotten', 'ok'); } catch (error) { U.toast(error.message, 'error'); } });
  $('clearTurns').addEventListener('click', () => { if (confirm('Clear all saved reply timings?')) { U.turns.clear(); U.toast('Speed history cleared', 'ok'); } });
  $('resetAll').addEventListener('click', async () => {
    if (!confirm('Reset every setting to its default? Your models stay installed.')) return;
    try { payload = await U.api('/api/settings', { method: 'DELETE' }); render(); U.toast('Settings reset', 'ok'); } catch (error) { U.toast(error.message, 'error'); }
  });
  $('openSetup').addEventListener('click', () => U.navigate('setup'));
})();
