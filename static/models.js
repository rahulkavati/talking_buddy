if (new URLSearchParams(location.search).has('embedded')) document.body.classList.add('embedded');
const groupMap = {
  hearing: { title:'HEARING', ids:['whisper','silero','smart_turn'] },
  thinking: { title:'THINKING & SPEAKING', ids:['brain','kokoro'] },
  plumbing: { title:'FULL-DUPLEX PLUMBING', ids:['webrtc','ollama','moshi'] }
};
const actionIds = new Set(['brain','whisper','kokoro','smart_turn','webrtc']);
let items = [];
const $ = id => document.getElementById(id);

async function load() {
  $('groups').innerHTML = '<div class="loading">CHECKING LOCAL SERVICES…</div>';
  const response = await fetch('/api/system/status');
  const data = await response.json();
  items = enrich(data.items || []);
  render();
}
function enrich(serverItems) {
  const byId = Object.fromEntries(serverItems.map(item => [item.id, item]));
  return [
    {id:'whisper',name:'Whisper Small',kind:'Fast streaming speech-to-text',detail:'Local transcription',ready:byId.whisper?.ready,installed:byId.whisper?.installed},
    {id:'silero',name:'Silero VAD',kind:'Detects when you start and stop talking',detail:'Voice activity detection',ready:true,installed:true},
    {id:'smart_turn',name:'Smart Turn v3.2',kind:'Knows if you’re done or just pausing',detail:'Semantic turn detection',ready:false,installed:false},
    {id:'brain',name:byId.brain?.name || 'Gemma 3 4B',kind:'Local language model via Ollama',detail:'Conversation model',ready:byId.brain?.ready,installed:byId.brain?.installed},
    {id:'kokoro',name:'Kokoro TTS',kind:'Natural streaming voice',detail:'Local speech synthesis',ready:byId.kokoro?.ready,installed:byId.kokoro?.installed},
    {id:'webrtc',name:'WebRTC Echo Cancellation',kind:'Lets you interrupt without Pixel hearing itself',detail:'Full-duplex audio plumbing',ready:false,installed:false},
    {id:'ollama',name:'Ollama runtime',kind:'Local model runtime',detail:byId.ollama?.detail || 'Local runtime',ready:byId.ollama?.ready,installed:byId.ollama?.installed},
    {id:'moshi',name:'Moshi (Kyutai) · 4-bit MLX',kind:'Experimental speech-to-speech',detail:'Optional future engine',ready:false,installed:false,optional:true}
  ];
}
function render() {
  const missing = items.filter(item => !item.ready && !item.optional && actionIds.has(item.id)).length;
  $('navMissing').textContent = missing;
  $('groups').innerHTML = Object.values(groupMap).map(group => `<section class="group"><p class="group-title">${group.title}</p>${group.ids.map(id => row(items.find(item => item.id === id))).join('')}</section>`).join('');
  $('groups').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => setup(button.dataset.action, button)));
}
function row(item) {
  if (!item) return '';
  const icon = item.id === 'kokoro' ? 'K' : item.id === 'moshi' ? 'Mo' : item.name.slice(0,1);
  const color = item.id === 'kokoro' ? 'teal' : item.id === 'moshi' ? 'purple' : ['smart_turn','webrtc'].includes(item.id) ? 'orange' : '';
  const state = item.ready ? 'ready' : item.optional ? 'optional' : 'missing';
  const label = item.ready ? 'Installed' : item.optional ? 'Optional' : 'Not installed';
  const button = !item.ready && !item.optional && actionIds.has(item.id) ? `<button class="small-button" data-action="${item.id}">Install</button>` : '';
  return `<article class="tool-row"><div class="tool-icon ${color}">${icon}</div><div class="tool-copy"><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.kind)} · ${escapeHtml(item.detail)}</p></div><div class="tool-actions"><span class="status ${state}">${label}</span>${button}</div></article>`;
}
async function setup(action, button) { button.disabled = true; button.textContent = 'Working…'; await fetch('/api/system/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}); await load(); }
async function installAll() { $('installAll').disabled = true; for (const item of items.filter(item => !item.ready && actionIds.has(item.id))) await fetch('/api/system/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:item.id})}); await load(); $('installAll').disabled = false; }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
$('refresh').addEventListener('click',load); $('installAll').addEventListener('click',installAll); load().catch(() => { $('groups').innerHTML = '<div class="loading">Unable to reach the local service.</div>'; });
