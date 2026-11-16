// Full-duplex voice mode: PCM frames -> rolling Whisper -> streamed Ollama/Kokoro.
(() => {
  const talk = document.getElementById('talk');
  const form = document.getElementById('textForm');
  const input = document.getElementById('textInput');
  const transcript = document.getElementById('transcript');
  const status = document.getElementById('status');
  const rightPanel = document.getElementById('rightPanel');
  if (!talk || !transcript) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let socket = null;
  let recognition = null;
  let listening = false;
  let browserSTT = false;
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
  let activeTransport = null;
  let noiseFloor = 0.006;
  let voicedMs = 0;
  let utteranceMs = 0;
  let bargeMs = 0;
  let playbackTailUntil = 0;
  const speechThreshold = 0.02;   // absolute gate; the adaptive floor sits above it
  // Conversation feel comes from the Conversation Engine screen (server.py _CLIENT_DEFAULTS).
  const prefs = window.PIXEL_SETTINGS || {};
  const pct = (value, fallback) => Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
  const endSilenceMs = 350 + 7 * pct(prefs.patience, 50);            // pause that ends your turn (default 700 ms)
  const bargeHoldMs = 320 - 2 * pct(prefs.interrupt, 72);            // how long you must talk over Pixel
  const bargeThreshold = 0.09 - 0.0005 * pct(prefs.interrupt, 72);   // must clearly beat Pixel's own speaker echo
  const bargeEnabled = prefs.barge_in !== false;

  function usesPipecat() {
    const requested = new URLSearchParams(location.search).get('voice');
    if (requested) return requested === 'pipecat';
    return window.PIXEL_VOICE_TRANSPORT === 'pipecat';
  }

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
    const label = value.includes('SPEAK') ? 'Speaking' : value.includes('THINK') || value.includes('PROCESS') || value.includes('TRANSCRIB') ? 'Thinking' : value.includes('HEARING') || value.includes('LISTEN') ? 'Listening' : 'Ready';
    status.textContent = label;
    status.dataset.raw = value;
    status.closest('.status-pill')?.classList.toggle('speaking', label === 'Speaking');
    status.closest('.status-pill')?.classList.toggle('busy', label === 'Thinking' || label === 'Listening');
    rightPanel.classList.toggle('listening', value.includes('LISTEN') || value.includes('HEARING'));
    window.dispatchEvent(new CustomEvent('pixel:voice-stage', { detail: { value } }));
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
        let buffer;
        try {
          buffer = await audioContext.decodeAudioData(bytes.buffer);
        } catch (error) {
          // One unreadable clip must not silence the rest of the reply.
          console.warn('Skipping undecodable audio clip:', error);
          continue;
        }
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
    playbackTailUntil = Date.now() + 180;   // let the speaker finish ringing
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
      echoCancellation: prefs.echo !== false, noiseSuppression: true, autoGainControl: true
    }});
    await audioContext.audioWorklet.addModule('/static/voice-capture-worklet.js');
    meterSource = audioContext.createMediaStreamSource(micStream);
    meterNode = new AudioWorkletNode(audioContext, 'voice-capture');
    meterSink = audioContext.createGain();
    meterSink.gain.value = 0;
    speechStarted = false;
    silenceMs = 0;
    voicedMs = 0;
    utteranceMs = 0;
    bargeMs = 0;
    pendingPcm = [];
    pendingSamples = 0;
    meterNode.port.onmessage = event => {
      const rms = event.data.rms || 0;
      const pcm = event.data.pcm;
      window.dispatchEvent(new CustomEvent('pixel:voice-level', { detail: { rms } }));
      const frameMs = (pcm?.length || 0) / audioContext.sampleRate * 1000;
      if (!listening || !pcm || !socket || socket.readyState !== WebSocket.OPEN) return;

      const speakingNow = playing || audioQueue.length > 0;
      // Learn the room's noise floor so a fan or a quiet room moves the gate,
      // instead of a fixed threshold that fires on breath and keyboard taps.
      // The worklet posts ~3 ms frames, so adapt by elapsed time, not per frame:
      // a per-frame average chased the voice itself within 100 ms and the gate
      // often never opened. Quiet frames move the floor quickly (1.5 s); loud
      // ones only slowly (12 s), so a new steady noise is still learned.
      const gate = Math.max(speechThreshold, noiseFloor * 2.5);
      if (!speechStarted && !speakingNow) {
        const seconds = rms < gate ? 1.5 : 12;
        noiseFloor += (rms - noiseFloor) * (1 - Math.exp(-frameMs / (seconds * 1000)));
      }

      // Barge-in has to clearly beat Pixel's own voice. Otherwise speaker echo
      // interrupts the reply and is then transcribed as a brand-new turn.
      if (speakingNow) {
        // A door slam is a blip, not an interruption: require sustained level.
        const loud = rms > Math.max(bargeThreshold, noiseFloor * 6);
        bargeMs = loud ? bargeMs + frameMs : 0;
        if (bargeEnabled && bargeMs >= bargeHoldMs && Date.now() - lastBargeIn > 700) {
          lastBargeIn = Date.now();
          bargeMs = 0;
          interruptAudio();
          playbackTailUntil = Date.now() + 300;
          voicedMs = 0;
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' }));
          setStatus('HEARING YOU // INTERRUPTED');
        }
        return;   // never stream our own audio back to Whisper
      }
      bargeMs = 0;
      if (Date.now() < playbackTailUntil) { voicedMs = 0; return; }

      if (rms > gate) {
        voicedMs += frameMs;
        if (!speechStarted && voicedMs >= 180) {
          speechStarted = true;
          silenceMs = 0;
          utteranceMs = voicedMs;
          socket.send(JSON.stringify({ type: 'audio_start', sample_rate: audioContext.sampleRate }));
          setStatus('HEARING YOU // STREAMING');
        }
        if (speechStarted) {
          silenceMs = 0;
          utteranceMs += frameMs;
          queuePcm(pcm);
        }
      } else if (!speechStarted) {
        voicedMs = Math.max(0, voicedMs - frameMs);   // scattered blips must not add up to "speech"
      } else {
        queuePcm(pcm);
        silenceMs += frameMs;
        voicedMs = 0;
        if (silenceMs >= endSilenceMs) {
          speechStarted = false;
          silenceMs = 0;
          flushPcm();
          // A cough or a door is not a turn; drop anything under ~0.4 s.
          if (utteranceMs >= 400) {
            socket.send(JSON.stringify({ type: 'audio_end' }));
            window.pixelTurnEnd?.(performance.now() - endSilenceMs, 'voice');   // you stopped talking this long ago
            setStatus('TRANSCRIBING // STREAMING WHISPER');
          } else if (socket?.readyState === WebSocket.OPEN) {
            // Drop the blip without cancelling a reply that is in progress.
            socket.send(JSON.stringify({ type: 'audio_discard' }));
          }
          utteranceMs = 0;
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
    voicedMs = 0;
    utteranceMs = 0;
    bargeMs = 0;
    pendingPcm = [];
    pendingSamples = 0;
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws/realtime`);
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Pixel’s voice service is not reachable.'));
      socket.onclose = () => {
        socket = null;
        // A dropped link must not leave the UI "listening" to nothing.
        if (listening && activeTransport === 'websocket') {
          stopRealtime();
          setStatus('LINK ERROR // The voice link closed. Tap the mic to reconnect.');
        }
      };
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        // A cancelled turn can still have one network packet in flight. Ignore
        // it so old speech never plays over the user's new utterance.
        if (message.turn && message.type !== 'user_text' && message.turn !== activeTurn) return;
        if (message.type === 'partial_transcript') {
          if (listening) {
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
    if (usesPipecat() && window.pixelPipecatVoice) {
      try {
        await window.pixelPipecatVoice.start({
          onState: setStatus,
          onConnectionLost: () => {
            if (!listening || activeTransport !== 'pipecat') return;
            window.pixelPipecatVoice.stop();
            activeTransport = null;
            setStatus('WEBRTC LINK LOST // USING FALLBACK');
            startWebSocketFallback().catch(error =>
              setStatus('LINK ERROR // ' + error.message)
            );
          },
        });
        listening = true;
        activeTransport = 'pipecat';
        talk.title = 'Stop conversation';
        return;
      } catch (error) {
        // Keep the tested WebSocket path available if WebRTC or a provider
        // cannot start. The user can continue talking without a dead button.
        window.pixelPipecatVoice.stop();
        setStatus('WEBRTC UNAVAILABLE // USING FALLBACK');
      }
    }
    await startWebSocketFallback();
  }

  async function startWebSocketFallback() {
    await connect();
    listening = true;
    // Always use the local PCM -> Whisper path. Browser SpeechRecognition can
    // use a remote platform service and otherwise races the local transcript.
    browserSTT = false;
    await startMicMeter();
    activeTransport = 'websocket';
    setStatus('LISTENING // REALTIME LINK OPEN');
    talk.title = 'Stop conversation';
  }

  function stopRealtime() {
    listening = false;
    browserSTT = false;
    if (activeTransport === 'pipecat' && window.pixelPipecatVoice) {
      window.pixelPipecatVoice.stop();
      activeTransport = null;
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
    activeTransport = null;
    setStatus('STANDBY // READY');
    talk.title = 'Start conversation';
  }

  // Typed prompts and prompt chips work in every mode. WebRTC cannot accept
  // text (there is no RTVI text frame in this build), so they use the HTTP path
  // and render the reply instead of doing nothing.
  async function httpChat(text) {
    text = (text || '').trim();
    if (!text) return;
    interruptAudio();
    setStatus('THINKING // STREAMING');
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    transcript.textContent = text;
    window.pixelUser?.(text);
    window.pixelReply?.(data.reply || '');
    setStatus('STANDBY // READY');
  }

  const explain = error => error?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your system settings.'
    : error?.name === 'NotFoundError' ? 'No microphone was found.' : (error?.message || 'The voice link could not start.');
  let starting = false;
  talk.onclick = async () => {
    if (starting) return;
    if (listening) { stopRealtime(); return; }
    starting = true;
    setStatus('PROCESSING // CONNECTING');
    try { await startRealtime(); }
    catch (error) { stopRealtime(); setStatus('LINK ERROR // ' + explain(error)); }
    starting = false;
  };
  if (form) form.onsubmit = event => {
    event.preventDefault();
    const text = input.value.trim();
    input.value = '';
    if (!text) return;
    window.pixelTurnEnd?.(performance.now(), 'text');
    if (socket?.readyState === WebSocket.OPEN) sendText(text);
    else httpChat(text).catch(error => setStatus('LINK ERROR // ' + error.message));
  };
  document.querySelectorAll('.chip').forEach(button => {
    button.onclick = () => {
      window.pixelTurnEnd?.(performance.now(), 'text');
      if (socket?.readyState === WebSocket.OPEN) sendText(button.dataset.prompt);
      else httpChat(button.dataset.prompt).catch(error => setStatus('LINK ERROR // ' + error.message));
    };
  });
})();
