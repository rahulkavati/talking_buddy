// Streaming voice mode: browser captions -> WebSocket -> streamed Ollama/Kokoro.
(() => {
  const talk = document.getElementById('talk');
  const form = document.getElementById('textForm');
  const input = document.getElementById('textInput');
  const transcript = document.getElementById('transcript');
  const status = document.getElementById('status');
  const rightPanel = document.getElementById('rightPanel');
  if (!talk || !transcript) return;

  const fallbackTalk = talk.onclick;
  const fallbackForm = form?.onsubmit;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let socket = null;
  let recognition = null;
  let listening = false;
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
    await audioContext.audioWorklet.addModule('/static/mic-meter-worklet.js');
    meterSource = audioContext.createMediaStreamSource(micStream);
    meterNode = new AudioWorkletNode(audioContext, 'mic-meter');
    meterSink = audioContext.createGain();
    meterSink.gain.value = 0;
    meterNode.port.onmessage = event => {
      const rms = event.data.rms || 0;
      if (rms > .012 && (playing || audioQueue.length) && Date.now() - lastBargeIn > 450) {
        lastBargeIn = Date.now();
        interruptAudio();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' }));
        setStatus('HEARING YOU // INTERRUPTED');
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
        if (message.type === 'user_text') {
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
      if (finalText.trim() && listening) sendText(finalText);
    };
    // Chrome's SpeechRecognition sends audio to Google. If it fails (offline), use local Whisper.
    recognition.onerror = e => {
      if (listening && ['network', 'service-not-allowed'].includes(e.error)) {
        stopRealtime();
        setStatus('ONLINE CAPTIONS UNAVAILABLE // USING LOCAL WHISPER');
        fallbackTalk?.();
      }
    };
    recognition.onend = () => {
      if (listening) try { recognition.start(); } catch (_) {}
    };
  }

  async function startRealtime() {
    if (!SR || new URLSearchParams(location.search).has('local')) {   // add ?local to the URL to force offline Whisper
      if (fallbackTalk) return fallbackTalk();
      setStatus('BROWSER SPEECH INPUT UNAVAILABLE');
      return;
    }
    await unlockAudio();
    await startMicMeter();
    await connect();
    setupRecognition();
    listening = true;
    try { recognition.start(); } catch (_) {}
    setStatus('LISTENING // REALTIME LINK OPEN');
    talk.title = 'Stop conversation';
  }

  function stopRealtime() {
    listening = false;
    if (recognition) recognition.stop();
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
