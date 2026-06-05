export async function detectSilence(
  fileOrBlob: File | Blob, 
  threshold: number = 0.02, 
  chunkSize: number = 2048
): Promise<{ start: number; end: number; duration: number }> {
  // We need to read the file into an ArrayBuffer and decode it using AudioContext
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  
  const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContext();
  
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Process the first channel (mono check is usually fine)
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = channelData.length;
    
    let startSample = 0;
    let endSample = totalSamples - 1;
    
    // Find start (first non-silent sample)
    for (let i = 0; i < totalSamples; i += 100) {
      if (Math.abs(channelData[i]) > threshold) {
        startSample = Math.max(0, i - 100);
        break;
      }
    }
    
    // Find end (last non-silent sample)
    for (let i = totalSamples - 1; i >= 0; i -= 100) {
      if (Math.abs(channelData[i]) > threshold) {
        endSample = Math.min(totalSamples - 1, i + 100);
        break;
      }
    }
    
    return {
      start: parseFloat((startSample / sampleRate).toFixed(1)),
      end: parseFloat((endSample / sampleRate).toFixed(1)),
      duration: parseFloat((totalSamples / sampleRate).toFixed(1))
    };
  } finally {
    // Clean up AudioContext if possible
    if (audioContext.state !== 'closed') {
      audioContext.close();
    }
  }
}

export async function trimAndCompressAudio(
  fileOrBlob: File | Blob,
  trimStart: number,
  trimEnd: number
): Promise<{ blob: Blob; mimeType: string }> {
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  
  const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContext();
  
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Calculate sample range
    const startOffset = Math.max(0, Math.floor(trimStart * audioBuffer.sampleRate));
    const endOffset = (trimEnd > trimStart) 
      ? Math.min(audioBuffer.length, Math.floor(trimEnd * audioBuffer.sampleRate))
      : audioBuffer.length;
    
    const sliceLength = endOffset - startOffset;
    if (sliceLength <= 0) {
      throw new Error("Invalid trim range resulted in empty audio slice");
    }

    const duration = sliceLength / audioBuffer.sampleRate;

    // Dynamically choose target sample rate to stay under 6MB
    // Formula: Size = duration * sampleRate * bytesPerSample
    // To fit within 6MB safely for any network upload reverse proxies
    const maxSampleRateFor6MB = Math.floor(6000000 / (duration * 2));
    
    let targetSampleRate = 16000;
    if (maxSampleRateFor6MB < 16000) {
      if (maxSampleRateFor6MB >= 12000) {
        targetSampleRate = 12000;
      } else if (maxSampleRateFor6MB >= 11025) {
        targetSampleRate = 11025;
      } else {
        targetSampleRate = 8000;
      }
    }

    // Never upsample, keep original sample rate if it's already lower than target
    targetSampleRate = Math.min(targetSampleRate, audioBuffer.sampleRate);
    
    // Choose bit depth: if duration is long (e.g. > 5 mins or size still > 6MB), use 8-bit PCM to cut size in half!
    let bitsPerSample = 16;
    if (duration > 300 || (duration * targetSampleRate * 2) > 6000000) {
      bitsPerSample = 8;
    }

    const bytesPerSample = bitsPerSample === 8 ? 1 : 2;
    
    // Downsampling ratio
    const ratio = audioBuffer.sampleRate / targetSampleRate;
    const newLength = Math.max(1, Math.floor(sliceLength / ratio));
    
    const resultBuffer = new Float32Array(newLength);
    // Get the first channel's data (mono)
    const channelData = audioBuffer.getChannelData(0);
    
    // Downsample using linear interpolation
    for (let i = 0; i < newLength; i++) {
      const origIndex = startOffset + i * ratio;
      const indexLow = Math.floor(origIndex);
      const indexHigh = Math.min(channelData.length - 1, indexLow + 1);
      const weight = origIndex - indexLow;
      
      const valLow = channelData[indexLow] || 0;
      const valHigh = channelData[indexHigh] || 0;
      
      resultBuffer[i] = valLow * (1 - weight) + valHigh * weight;
    }
    
    // Encode to PCM WAV format
    const headerSize = 44;
    const wavBuffer = new ArrayBuffer(headerSize + newLength * bytesPerSample);
    const view = new DataView(wavBuffer);
    
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    
    // Write RIFF identifier
    writeString(0, 'RIFF');
    // File length (excluding RIFF/WAVE tags - i.e. 36 + data size)
    view.setUint32(4, 36 + newLength * bytesPerSample, true);
    // RIFF type
    writeString(8, 'WAVE');
    // Format chunk
    writeString(12, 'fmt ');
    // Format chunk chunk length (16 for PCM)
    view.setUint32(16, 16, true);
    // Audio format (1 = uncompressed PCM)
    view.setUint16(20, 1, true);
    // Channel count (1 = mono)
    view.setUint16(22, 1, true);
    // Sample rate
    view.setUint32(24, targetSampleRate, true);
    // Byte rate (sampleRate * channel count * bytes per sample)
    view.setUint32(28, targetSampleRate * 1 * bytesPerSample, true);
    // Block align (channel count * bytes per sample)
    view.setUint16(32, 1 * bytesPerSample, true);
    // Bits per sample (8 or 16)
    view.setUint16(34, bitsPerSample, true);
    // Data chunk
    writeString(36, 'data');
    // Data chunk length
    view.setUint32(40, newLength * bytesPerSample, true);
    
    // Write audio samples
    let index = headerSize;
    if (bitsPerSample === 16) {
      // Int16 PCM (-32768 to 32767)
      for (let i = 0; i < newLength; i++) {
        const sample = Math.max(-1, Math.min(1, resultBuffer[i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(index, intSample, true);
        index += 2;
      }
    } else {
      // UInt8 PCM (0 to 255, silence at 128)
      for (let i = 0; i < newLength; i++) {
        const sample = Math.max(-1, Math.min(1, resultBuffer[i]));
        const uSample = Math.round((sample + 1.0) * 127.5);
        view.setUint8(index, Math.max(0, Math.min(255, uSample)));
        index += 1;
      }
    }
    
    const compressedBlob = new Blob([view], { type: 'audio/wav' });
    return { blob: compressedBlob, mimeType: 'audio/wav' };
  } finally {
    if (audioContext.state !== 'closed') {
      audioContext.close().catch(console.error);
    }
  }
}

