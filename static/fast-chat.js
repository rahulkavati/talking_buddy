// Return the assistant text immediately, then synthesize/play audio in the background.
// This makes the conversation feel responsive even when TTS takes another moment.
const nativeFetch = window.fetch.bind(window);
let playbackContext = null;
const unlockAudio = () => {
  if (!playbackContext) playbackContext = new (window.AudioContext || window.webkitAudioContext)();
  if (playbackContext.state === 'suspended') playbackContext.resume();
};
document.addEventListener('pointerdown', unlockAudio, true);

async function playBase64Audio(base64) {
  unlockAudio();
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const buffer = await playbackContext.decodeAudioData(bytes.buffer);
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);
  window.animateSpeaking?.(true);
  source.onended = () => window.animateSpeaking?.(false);
  source.start();
}

window.fetch = async (resource, options) => {
  const url = typeof resource === 'string' ? resource : resource.url;
  if (!url.endsWith('/api/chat')) return nativeFetch(resource, options);

  const response = await nativeFetch(resource, options);
  const data = await response.json();
  if (data.reply) {
    nativeFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.reply })
    }).then(async ttsResponse => {
      const tts = await ttsResponse.json();
      if (!tts.audio) return;
      await playBase64Audio(tts.audio);
    }).catch(error => console.warn('Voice playback failed:', error));
  }
  return new Response(JSON.stringify({ ...data, audio: '' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
