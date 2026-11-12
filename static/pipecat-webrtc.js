// SmallWebRTC browser client for the parallel Pipecat voice path.
// Opt in with ?voice=pipecat while the compatibility WebSocket path remains default.
(() => {
  let peer = null;
  let stream = null;
  let audio = null;
  let pcId = null;

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

  async function start({ onState } = {}) {
    if (peer) return;
    onState?.('CONNECTING // WEBRTC');
    stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    }}), 10000, 'Microphone permission timed out');
    peer = new RTCPeerConnection();
    stream.getTracks().forEach(track => peer.addTrack(track, stream));
    peer.addTransceiver('audio', { direction: 'recvonly' });
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
    };
    peer.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
        onState?.('WEBRTC LINK LOST');
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
    onState?.('LISTENING // PIPECAT WEBRTC');
  }

  function stop() {
    peer?.close();
    peer = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    audio?.remove();
    audio = null;
    pcId = null;
  }

  window.pixelPipecatVoice = { start, stop };
})();
