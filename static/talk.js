// Talk page chrome: menu drawer, reset, and the settings that change how the HUD looks.
(() => {
  const U = PixelUI, settings = window.PIXEL_SETTINGS || {}, $ = id => document.getElementById(id);
  $('px').classList.toggle('hide-delay', settings.show_delay === false);
  $('engineName').textContent = settings.transport === 'pipecat' ? 'Cascade · WebRTC' : 'Cascade';
  if (settings.name) { document.title = settings.name; $('textInput').placeholder = `Message ${settings.name}…`; }
  U.mountDrawer($('menu'), 'talk');
  $('reset').addEventListener('click', async () => {
    try { await U.postJson('/api/reset', {}); window.pixelResetUI?.(); U.toast('Conversation forgotten', 'ok'); }
    catch (error) { U.toast(error.message, 'error'); }
  });
})();
