// SmallWebRTC browser client for the parallel Pipecat voice path.
// Pipecat is the configured primary transport. The compatibility WebSocket
// path remains available when signaling or the peer connection cannot start.
(() => {
  let peer = null;
  let stream = null;
  let audio = null;
  let pcId = null;
  let rtvi = null;
  let meterContext = null;
  let meterSource = null;
  let meterAnalyser = null;
  let meterFrame = null;

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function waitForIceGathering(connection) {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const check = () => {
        if (connection.iceGatheringState === 'complete') {
          connection.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      connection.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 2500);
    });
  }

  async function start({ onState, onConnectionLost } = {}) {
    if (peer) return;
    onState?.('CONNECTING // WEBRTC');
    stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: (window.PIXEL_SETTINGS || {}).echo !== false, noiseSuppression: true, autoGainControl: true
    }}), 10000, 'Microphone permission timed out');
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('Microphone track is not live');
    track.onmute = () => onState?.('MICROPHONE MUTED');
    track.onunmute = () => onState?.('LISTENING // PIPECAT WEBRTC');
    meterContext = new (window.AudioContext || window.webkitAudioContext)();
    await meterContext.resume();
    meterSource = meterContext.createMediaStreamSource(stream);
    meterAnalyser = meterContext.createAnalyser();
    meterAnalyser.fftSize = 256;
    meterSource.connect(meterAnalyser);
    const meterData = new Uint8Array(meterAnalyser.fftSize);
    const sampleMeter = () => {
      if (!meterAnalyser) return;
      meterAnalyser.getByteTimeDomainData(meterData);
      let sum = 0;
      for (const value of meterData) { const centered = (value - 128) / 128; sum += centered * centered; }
      window.dispatchEvent(new CustomEvent('pixel:voice-level', { detail: { rms: Math.sqrt(sum / meterData.length) } }));
      meterFrame = requestAnimationFrame(sampleMeter);
    };
    sampleMeter();
    peer = new RTCPeerConnection();
    stream.getTracks().forEach(track => peer.addTrack(track, stream));
    // addTrack creates the single send/receive audio transceiver expected by
    // SmallWebRTC; adding a second audio transceiver breaks media delivery.
    rtvi = peer.createDataChannel('rtvi');
    rtvi.onopen = () => {
      // Pipecat gates input audio until the RTVI client-ready handshake. Without
      // this message the peer can be connected while the server receives no mic.
      rtvi.send(JSON.stringify({
        label: 'rtvi-ai',
        type: 'client-ready',
        id: crypto.randomUUID(),
        data: {
          version: '2.3.0',
          about: { library: 'pixel-manual-webrtc', library_version: '1.0.0', platform: 'electron' },
        },
      }));
    };
    // RTVI messages drive the HUD. Each type is handled explicitly: matching on
    // substrings used to put Pixel's own words into the "You" transcript.
    rtvi.onmessage = event => {
      let envelope;
      try { envelope = JSON.parse(event.data); } catch (_) { return; }   // telemetry is optional; audio must continue
      const type = envelope?.type, data = envelope?.data || {};
      const text = typeof data.text === 'string' ? data.text : '';
      switch (type) {
        case 'user-started-speaking':
          onState?.('HEARING YOU // PIPECAT');
          break;
        case 'user-stopped-speaking':
          window.pixelTurnEnd?.(performance.now(), 'voice');
          onState?.('THINKING // PIPECAT');
          break;
        case 'user-transcription': {
          if (!text.trim()) break;
          const transcript = document.getElementById('transcript');
          if (transcript) transcript.textContent = text.trim();
          if (data.final !== false) window.pixelUser?.(text.trim());
          break;
        }
        case 'bot-llm-text':
          window.pixelToken?.(text);
          break;
        case 'bot-started-speaking':
          onState?.('SPEAKING // PIPECAT AUDIO');
          window.animateSpeaking?.(true);
          break;
        case 'bot-stopped-speaking':
          window.animateSpeaking?.(false);
          onState?.('LISTENING // PIPECAT WEBRTC');
          break;
        case 'bot-interrupted':
          window.animateSpeaking?.(false);
          break;
        case 'error':
          onState?.('PIPECAT ERROR // ' + (data.message || data.error || 'The voice pipeline reported a problem.'));
          break;
        default:
          break;
      }
    };
    peer.ontrack = event => {
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audio.style.display = 'none';
        document.body.append(audio);
      }
      audio.srcObject = event.streams[0];
      audio.play().catch(() => onState?.('CLICK TO UNMUTE // WEBRTC'));
      // Feed Pixel's voice to the lip-sync analyser; audio still plays through the element above.
      try { window.pixelTap?.(meterContext.createMediaStreamSource(event.streams[0]), meterContext); } catch (_) { /* lip-sync is optional */ }
    };
    peer.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
        onState?.('WEBRTC LINK LOST');
        onConnectionLost?.();
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const response = await withTimeout(fetch('/api/voice/webrtc/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: peer.localDescription.sdp, type: peer.localDescription.type })
    }), 15000, 'WebRTC signaling timed out');
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error || 'Pipecat WebRTC offer failed');
    pcId = answer.pc_id;
    await peer.setRemoteDescription(answer);
    // Candidates found after the offer was sent are not in the SDP, so forward
    // them as trickle ICE instead of dropping them.
    peer.onicecandidate = event => {
      if (!event.candidate || !pcId) return;
      const candidate = event.candidate.toJSON();
      fetch('/api/voice/webrtc/ice', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pc_id: pcId,
          candidates: [{
            candidate: candidate.candidate,
            sdp_mid: candidate.sdpMid,
            sdp_mline_index: candidate.sdpMLineIndex,
          }],
        }),
      }).catch(() => {});
    };
    window.pixelPipecatActive = true;
    onState?.('LISTENING // PIPECAT WEBRTC');
  }

  function stop() {
    window.pixelPipecatActive = false;
    window.animateSpeaking?.(false);
    peer?.close();
    peer = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    audio?.remove();
    audio = null;
    if (meterFrame) cancelAnimationFrame(meterFrame);
    meterFrame = null;
    meterSource?.disconnect();
    meterAnalyser?.disconnect();
    meterContext?.close();
    meterSource = meterAnalyser = meterContext = null;
    rtvi?.close();
    rtvi = null;
    pcId = null;
  }

  window.pixelPipecatVoice = { start, stop };
})();
