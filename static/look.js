// Voice & Look: theme, voice and buddy options, saved to /api/settings.
(async () => {
  const U = PixelUI, $ = id => document.getElementById(id);
  U.mountSidebar('look');
  const THEME_INFO = {
    golden: ['Golden Meadow', 'Red buddy, sunset gold'], blossom: ['Cherry Blossom Dawn', 'Blue buddy, pink trees'],
    autumn: ['Autumn Ember', 'Teal buddy, wheat fields'], moonlit: ['Moonlit Meadow', 'Orange buddy, night sky'], neon: ['Neon Dusk', 'Silver buddy, violet glow'],
  };
  let payload;
  try { payload = await U.api('/api/settings'); }
  catch (error) { $('controls').innerHTML = `<div class="card empty"><strong>Can’t load settings</strong>${U.escapeHtml(error.message)}</div>`; return; }
  const save = U.createSaver(next => { if (next) payload = next; render(); });

  function render() {
    const { settings, options } = payload;
    if (!$('themes').children.length) $('themes').innerHTML = options.themes.map(id => `<label class="theme"><input type="radio" name="theme" value="${id}" data-setting="theme"><img src="/static/img/themes/${id}.jpg" alt="" loading="lazy"><span>${U.escapeHtml(THEME_INFO[id]?.[0] || id)}<small>${U.escapeHtml(THEME_INFO[id]?.[1] || '')}</small></span></label>`).join('');
    if (!$('voiceSelect').children.length) $('voiceSelect').innerHTML = options.voices.map(v => `<option value="${v.id}">${U.escapeHtml(v.label)}</option>`).join('');
    $('previewNote').textContent = options.tts_engine === 'kokoro' ? '' : `Voice engine: ${options.tts_engine}`;
    U.bindSettings(document, settings, save, { speed: v => `${Number(v).toFixed(2)}×` });
  }
  render();

  $('preview').addEventListener('click', async () => {
    const button = $('preview'); button.disabled = true; button.textContent = 'Preparing…';
    try {
      await save.flush();
      const { audio } = await U.postJson('/api/tts', { text: `Hi, I’m ${payload.settings.name}. This is how I sound.` });
      button.textContent = 'Playing…';
      await U.playWav(audio);
    } catch (error) { U.toast(error.message, 'error'); }
    button.disabled = false; button.textContent = '▶ Preview voice';
  });
})();
