/*
 * Xorp's Silence Remover — silence detection engine.
 *
 * Runs entirely locally (no cloud). Reads the temporary WAV mixdown that
 * host.jsx exports from the active sequence, computes short-window RMS
 * loudness in dBFS, and returns a list of speech/silence segments.
 *
 * This file has no dependency on Premiere's API — it's pure audio math —
 * so it's easy to unit test outside of CEP too (e.g. with plain Node).
 */

const SilenceDetect = (function () {

  // --- Minimal PCM WAV parser (16-bit / 24-bit / 32-bit float, mono or stereo) ---
  function parseWav(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, false) !== 0x52494646 /* "RIFF" */) {
      throw new Error("Not a RIFF/WAV file");
    }
    let pos = 12;
    let fmt = null;
    let dataOffset = -1, dataLength = 0;

    while (pos < dv.byteLength - 8) {
      const chunkId = String.fromCharCode(
        dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3)
      );
      const chunkSize = dv.getUint32(pos + 4, true);
      if (chunkId === "fmt ") {
        fmt = {
          audioFormat: dv.getUint16(pos + 8, true),
          numChannels: dv.getUint16(pos + 10, true),
          sampleRate: dv.getUint32(pos + 12, true),
          bitsPerSample: dv.getUint16(pos + 22, true)
        };
      } else if (chunkId === "data") {
        dataOffset = pos + 8;
        dataLength = chunkSize;
      }
      pos += 8 + chunkSize + (chunkSize % 2);
    }
    if (!fmt || dataOffset < 0) throw new Error("Malformed WAV: missing fmt/data chunk");

    const bytesPerSample = fmt.bitsPerSample / 8;
    const totalSamples = Math.floor(dataLength / bytesPerSample / fmt.numChannels);
    const samples = new Float32Array(totalSamples);

    for (let i = 0; i < totalSamples; i++) {
      let acc = 0;
      for (let ch = 0; ch < fmt.numChannels; ch++) {
        const offset = dataOffset + (i * fmt.numChannels + ch) * bytesPerSample;
        let v;
        if (fmt.bitsPerSample === 16) {
          v = dv.getInt16(offset, true) / 32768;
        } else if (fmt.bitsPerSample === 24) {
          const b0 = dv.getUint8(offset), b1 = dv.getUint8(offset + 1), b2 = dv.getUint8(offset + 2);
          let raw = (b2 << 16) | (b1 << 8) | b0;
          if (raw & 0x800000) raw -= 0x1000000;
          v = raw / 8388608;
        } else if (fmt.bitsPerSample === 32 && fmt.audioFormat === 3) {
          v = dv.getFloat32(offset, true);
        } else {
          v = dv.getInt32(offset, true) / 2147483648;
        }
        acc += v;
      }
      samples[i] = acc / fmt.numChannels; // downmix to mono for analysis
    }

    return { sampleRate: fmt.sampleRate, samples };
  }

  // --- RMS -> dBFS over sliding windows ---
  function computeLoudnessCurve(samples, sampleRate, windowMs) {
    const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
    const numWindows = Math.ceil(samples.length / windowSize);
    const dbCurve = new Float32Array(numWindows);

    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSize;
      const end = Math.min(samples.length, start + windowSize);
      let sumSq = 0;
      for (let i = start; i < end; i++) sumSq += samples[i] * samples[i];
      const rms = Math.sqrt(sumSq / Math.max(1, end - start));
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      dbCurve[w] = db;
    }
    return { dbCurve, windowMs };
  }

  // --- Turn the loudness curve into silence/speech segments ---
  // thresholdDb: e.g. -40
  // minSilenceMs: minimum length of a gap to be considered "cuttable" silence
  // paddingMs: how much speech-side buffer to leave around each cut
  function detectSegments(dbCurve, windowMs, thresholdDb, minSilenceMs, paddingMs, totalDurationMs) {
    const isSilent = i => dbCurve[i] < thresholdDb;
    const silenceRanges = [];
    let i = 0;
    while (i < dbCurve.length) {
      if (isSilent(i)) {
        const startIdx = i;
        while (i < dbCurve.length && isSilent(i)) i++;
        const endIdx = i;
        const durationMs = (endIdx - startIdx) * windowMs;
        if (durationMs >= minSilenceMs) {
          silenceRanges.push({
            startMs: startIdx * windowMs,
            endMs: endIdx * windowMs
          });
        }
      } else {
        i++;
      }
    }

    // Apply padding: shrink each silence range by `paddingMs` on both sides
    // so we don't clip the breath/attack of speech.
    const paddedSilence = silenceRanges
      .map(r => ({
        startMs: r.startMs + paddingMs,
        endMs: r.endMs - paddingMs
      }))
      .filter(r => r.endMs > r.startMs);

    // Build speech (kept) segments as the inverse of silence ranges
    const speechSegments = [];
    let cursor = 0;
    for (const s of paddedSilence) {
      if (s.startMs > cursor) {
        speechSegments.push({ startMs: cursor, endMs: s.startMs, type: "speech" });
      }
      cursor = Math.max(cursor, s.endMs);
    }
    if (cursor < totalDurationMs) {
      speechSegments.push({ startMs: cursor, endMs: totalDurationMs, type: "speech" });
    }

    const silenceSegments = paddedSilence.map(s => ({ ...s, type: "silence" }));

    return { speechSegments, silenceSegments, rawSilenceRanges: silenceRanges };
  }

  function analyzeWavBuffer(buffer, opts) {
    const { sampleRate, samples } = parseWav(buffer);
    const windowMs = 10; // 10ms analysis window ~= good resolution vs speed tradeoff
    const { dbCurve } = computeLoudnessCurve(samples, sampleRate, windowMs);
    const totalDurationMs = (samples.length / sampleRate) * 1000;
    const result = detectSegments(
      dbCurve, windowMs, opts.thresholdDb, opts.minSilenceMs, opts.paddingMs, totalDurationMs
    );
    result.totalDurationMs = totalDurationMs;
    result.dbCurve = dbCurve;
    result.windowMs = windowMs;
    return result;
  }

  return { parseWav, computeLoudnessCurve, detectSegments, analyzeWavBuffer };
})();
