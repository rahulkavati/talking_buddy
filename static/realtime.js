// Full-duplex voice mode: PCM frames -> rolling Whisper -> streamed Ollama/Kokoro.
(() => {
  const talk = document.getElementById('talk');
  const form = document.getElementById('textForm');
  const input = document.getElementById('textInput');
  const transcript = document.getElementById('transcript');
  const status = document.getElementById('status');
  const rightPanel = document.getElementById('rightPanel');
  if (!talk || !transcript) return;

  const fallbackForm = form?.onsubmit;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let socket = null;
  let recognition = null;
  let listening = false;
  let browserSTT = false;
  let currentReply = null;
  let audioQueue = [];
  let playing = false;
  let activeSource = null;
  let audioContext = null;
  let micStream = null;
  let meterSource = null;
  let meterNode = null;
  let meterSink = null;
  let lastBargeIn = 0;
  let activeTurn = 0;
  let speechStarted = false;
  let silenceMs = 0;
  let pendingPcm = [];
  let pendingSamples = 0;
  const speechThreshold = 0.012;

  function flushPcm() {
    if (!pendingSamples || !socket || socket.readyState !== WebSocket.OPEN) return;
    const packet = new Float32Array(pendingSamples);
    let offset = 0;
    for (const chunk of pendingPcm) { packet.set(chunk, offset); offset += chunk.length; }
    pendingPcm = [];
    pendingSamples = 0;
    socket.send(packet.buffer);
  }

  function queuePcm(pcm) {
    const chunk = new Float32Array(pcm);
    pendingPcm.push(chunk);
    pendingSamples += chunk.length;
    // One 20 ms packet is enough resolution for VAD while avoiding hundreds
    // of tiny WebSocket messages per second from the AudioWorklet.
    if (pendingSamples >= Math.round((audioContext?.sampleRate || 48000) * .02)) flushPcm();
  }

  const setStatus = value => {
    status.textContent = value;
    rightPanel.classList.toggle('listening', value.includes('LISTEN') || value.includes('HEARING'));
  };

  const unlockAudio = () => {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') return audioContext.resume();
    return Promise.resolve();
  };

  async function playAudioQueue() {
    if (playing) return;
    playing = true;
    try {
      await unlockAudio();
      while (audioQueue.length) {
        const encoded = audioQueue.shift();
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const buffer = await audioContext.decodeAudioData(bytes.buffer);
        await new Promise(resolve => {
          const source = audioContext.createBufferSource();
          activeSource = source;
          source.buffer = buffer;
          source.connect(audioContext.destination);
          window.pixelTap?.(source, audioContext);
          source.onended = resolve;
          window.animateSpeaking?.(true);
          source.start();
        });
      }
    } catch (error) {
      console.error('Streaming audio playback failed:', error);
      setStatus('AUDIO ERROR // CLICK TALK TO UNMUTE');
    }
    activeSource = null;
    playing = false;
    window.animateSpeaking?.(false);
  }

  function interruptAudio() {
    audioQueue = [];
    if (activeSource) {
      try { activeSource.stop(); } catch (_) {}
      activeSource = null;
    }
    playing = false;
    window.animateSpeaking?.(false);
  }

  async function startMicMeter() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    }});
    await audioContext.audioWorklet.addModule('/static/voice-capture-worklet.js');
    meterSource = audioContext.createMediaStreamSource(micStream);
    meterNode = new AudioWorkletNode(audioContext, 'voice-capture');
    meterSink = audioContext.createGain();
    meterSink.gain.value = 0;
    speechStarted = false;
    silenceMs = 0;
    pendingPcm = [];
    pendingSamples = 0;
    meterNode.port.onmessage = event => {
      const rms = event.data.rms || 0;
      const pcm = event.data.pcm;
      const frameMs = (pcm?.length || 0) / audioContext.sampleRate * 1000;
      if (rms > speechThreshold && (playing || audioQueue.length) && Date.now() - lastBargeIn > 450) {
        lastBargeIn = Date.now();
        interruptAudio();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' }));
        setStatus('HEARING YOU // INTERRUPTED');
      }
      if (!listening || !pcm || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (rms > speechThreshold) {
        if (!speechStarted) {
          speechStarted = true;
          silenceMs = 0;
          socket.send(JSON.stringify({ type: 'audio_start', sample_rate: audioContext.sampleRate }));
          setStatus('HEARING YOU // STREAMING');
        }
        silenceMs = 0;
        queuePcm(pcm);
      } else if (speechStarted) {
        queuePcm(pcm);
        silenceMs += frameMs;
        if (silenceMs >= 700) {
          speechStarted = false;
          silenceMs = 0;
          flushPcm();
          socket.send(JSON.stringify({ type: 'audio_end' }));
          setStatus('TRANSCRIBING // STREAMING WHISPER');
        }
      }
    };
    meterSource.connect(meterNode);
    meterNode.connect(meterSink);
    meterSink.connect(audioContext.destination);
  }

  function stopMicMeter() {
    try { meterSource?.disconnect(); } catch (_) {}
    try { meterNode?.disconnect(); } catch (_) {}
    try { meterSink?.disconnect(); } catch (_) {}
    micStream?.getTracks().forEach(track => track.stop());
    meterSource = meterNode = meterSink = micStream = null;
    speechStarted = false;
    silenceMs = 0;
    pendingPcm = [];
    pendingSamples = 0;
  }

  function ensureReplyBox() {
    if (!currentReply) {
      document.getElementById('reply')?.remove();
      currentReply = document.createElement('div');
      currentReply.id = 'reply';
      currentReply.style.cssText = 'margin-top:.55rem;color:#e9fff8;font:.88rem ui-monospace,monospace;text-align:right;line-height:1.55';
      transcript.parentElement.append(currentReply);
    }
    return currentReply;
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws/realtime`);
      socket.onopen = resolve;
      socket.onerror = reject;
      socket.onclose = () => { socket = null; };
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        // A cancelled turn can still have one network packet in flight. Ignore
        // it so old speech never plays over the user's new utterance.
        if (message.turn && message.type !== 'user_text' && message.turn !== activeTurn) return;
        if (message.type === 'partial_transcript') {
          if (listening && !speechStarted) {
            transcript.textContent = message.text;
            setStatus('TRANSCRIBING // LIVE WHISPER');
          }
        } else if (message.type === 'transcript') {
          if (listening && message.text) {
            transcript.textContent = message.text;
            sendText(message.text);
          }
        } else if (message.type === 'user_text') {
          activeTurn = message.turn || (activeTurn + 1);
          transcript.textContent = message.text;
          window.pixelUser?.(message.text);
          document.getElementById('reply')?.remove();
          currentReply = null;
          interruptAudio();
        } else if (message.type === 'state') {
          setStatus(message.value === 'THINKING' ? 'THINKING // STREAMING' : 'SPEAKING // AUDIO LINK');
        } else if (message.type === 'token') {
          // Voice-first mode: keep Pixel's response hidden until it is spoken.
          // The user's most recent transcript remains visible above.
          window.pixelToken?.(message.text);
        } else if (message.type === 'audio') {
          audioQueue.push(message.audio);
          playAudioQueue().catch(error => console.warn('Streaming audio failed:', error));
        } else if (message.type === 'done') {
          if (listening) setStatus('LISTENING // VOICE LINK OPEN');
        } else if (message.type === 'cancelled') {
          interruptAudio();
          if (listening) setStatus('LISTENING // VOICE LINK OPEN');
        } else if (message.type === 'error') {
          setStatus('LINK ERROR // ' + message.message);
        }
      };
    });
  }

  function sendText(text) {
    text = text.trim();
    if (!text) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Stop the current audio before sending the next turn. This also makes
    // typed messages behave like a natural voice interruption.
    interruptAudio();
    activeTurn += 1;
    socket.send(JSON.stringify({ type: 'user_text', text }));
  }

  function setupRecognition() {
    if (!SR || recognition) return;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = 'en-US';
    recognition.onresult = event => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }
      if (interim.trim() && listening) {
        transcript.textContent = interim.trim();
        setStatus('HEARING YOU // LIVE CAPTION');
      }
      if (finalText.trim() && listening && browserSTT) sendText(finalText);
    };
    recognition.onerror = event => {
      if (listening && ['network', 'service-not-allowed'].includes(event.error)) {
        browserSTT = false;
        setStatus('LOCAL WHISPER // FALLBACK');
      }
    };
    recognition.onend = () => {
      if (listening && browserSTT) try { recognition.start(); } catch (_) {}
    };
  }

  async function startRealtime() {
    await unlockAudio();
    if (new URLSearchParams(location.search).get('voice') === 'pipecat' && window.pixelPipecatVoice) {
      try {
        await window.pixelPipecatVoice.start({ onState: setStatus });
        listening = true;
        talk.title = 'Stop conversation';
        return;
      } catch (error) {
        // Keep the tested WebSocket path available if WebRTC or a provider
        // cannot start. The user can continue talking without a dead button.
        window.pixelPipecatVoice.stop();
        setStatus('WEBRTC UNAVAILABLE // USING FALLBACK');
      }
    }
    await connect();
    listening = true;
    // Always use the local PCM -> Whisper path. Browser SpeechRecognition can
    // use a remote platform service and otherwise races the local transcript.
    browserSTT = false;
    await startMicMeter();
    setStatus('LISTENING // REALTIME LINK OPEN');
    talk.title = 'Stop conversation';
  }

  function stopRealtime() {
    listening = false;
    browserSTT = false;
    if (new URLSearchParams(location.search).get('voice') === 'pipecat' && window.pixelPipecatVoice) {
      window.pixelPipecatVoice.stop();
      setStatus('STANDBY // READY');
      talk.title = 'Start conversation';
      return;
    }
    if (recognition) recognition.stop();
    if (socket?.readyState === WebSocket.OPEN && speechStarted) {
      flushPcm();
      socket.send(JSON.stringify({ type: 'audio_end' }));
    }
    stopMicMeter();
    interruptAudio();
    if (socket) socket.close();
    socket = null;
    setStatus('STANDBY // READY');
    talk.title = 'Start conversation';
  }

  talk.onclick = () => listening ? stopRealtime() : startRealtime().catch(error => setStatus('LINK ERROR // ' + error.message));
  if (form) form.onsubmit = event => {
    event.preventDefault();
    const text = input.value.trim();
    input.value = '';
    if (socket?.readyState === WebSocket.OPEN) sendText(text);
    else if (fallbackForm) fallbackForm(event);
  };
  document.querySelectorAll('.chip').forEach(button => {
    button.onclick = () => {
      if (socket?.readyState === WebSocket.OPEN) sendText(button.dataset.prompt);
      else window.fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: button.dataset.prompt }) });
    };
  });
})();

const desktopSettingsScript = document.createElement('script');
desktopSettingsScript.src = '/static/desktop-settings.js';
document.body.appendChild(desktopSettingsScript);
const desktopDrawerScript = document.createElement('script');
desktopDrawerScript.src = '/static/desktop-drawer.js';
document.body.appendChild(desktopDrawerScript);
