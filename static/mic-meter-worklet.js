class MicMeterProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
      this.port.postMessage({ rms: Math.sqrt(sum / channel.length) });
    }
    return true;
  }
}
registerProcessor('mic-meter', MicMeterProcessor);
