class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const pcm = new Float32Array(channel);
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      this.port.postMessage({ rms: Math.sqrt(sum / pcm.length), pcm }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
