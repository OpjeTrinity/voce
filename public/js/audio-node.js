// public/js/audio-node.js
// VOCE CLUSTER — Web Audio API Lifecycle Manager
// Handles AudioContext, AnalyserNode, RMS extraction, and autoplay pre-warming

'use strict';

const AudioNode = (() => {
  // ─── Internal State ──────────────────────────────────────────────────
  let audioCtx       = null;
  let analyser       = null;
  let dataArray      = null;
  let micStream      = null;
  let samplerInterval = null;
  let isActive       = false;

  // ─── Config ──────────────────────────────────────────────────────────
  const FFT_SIZE       = 128;         // 64 frequency bins, lightweight for mobile
  const SAMPLE_RATE_MS = 150;         // Throttled sample interval
  const NOISE_GATE     = 32;          // Minimum amplitude to dispatch
  const MAX_AMPLITUDE  = 120;         // Used for meter normalization

  // ─── Event Callbacks ─────────────────────────────────────────────────
  let onSample   = null;   // (avg: float) => void
  let onError    = null;   // (err: Error) => void
  let onActivate = null;   // () => void

  /**
   * setCallbacks — Register lifecycle callbacks before calling init()
   */
  function setCallbacks({ onSample: s, onError: e, onActivate: a }) {
    if (s) onSample   = s;
    if (e) onError    = e;
    if (a) onActivate = a;
  }

  /**
   * init — Must be called inside a user gesture handler.
   *         Requests microphone, builds AudioContext, pre-warms a media element.
   *
   * @param {HTMLMediaElement} mediaEl  — The hidden climax video/audio element to pre-warm
   * @returns {Promise<boolean>}         — Resolves true on success, false on failure
   */
  async function init(mediaEl) {
    if (isActive) return true;

    try {
      // 1. Request microphone access — MUST be in user gesture context
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
        video: false,
      });

      // 2. Build AudioContext — use webkit prefix for Safari compatibility
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Web Audio API not supported on this device');
      }
      audioCtx = new AudioContextClass();

      // 3. Explicitly resume — required on iOS Safari which starts suspended
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // 4. Build signal chain: Mic → Source → Analyser
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.3; // Light smoothing, don't over-average
      source.connect(analyser);

      // 5. Allocate data buffer (Uint8Array: values 0–255)
      dataArray = new Uint8Array(analyser.frequencyBinCount);

      // 6. Pre-warm the climax media element
      //    This is the key trick: play() + immediate pause() marks the element
      //    as "user-activated" in the browser's autoplay policy. A subsequent
      //    programmatic play() from a WebSocket event will then succeed.
      if (mediaEl) {
        try {
          const warmPromise = mediaEl.play();
          if (warmPromise !== undefined) {
            await warmPromise.catch(() => {}); // Ignore errors (may have no src yet)
          }
          mediaEl.pause();
          mediaEl.currentTime = 0;
        } catch (_) {
          // Pre-warm failure is non-fatal — best effort
          console.warn('[AudioNode] Media pre-warm failed (non-fatal)');
        }
      }

      // 7. Start sampling loop
      _startSampler();
      isActive = true;

      if (onActivate) onActivate();
      return true;

    } catch (err) {
      console.error('[AudioNode] init failed:', err);
      if (onError) onError(err);
      _cleanup();
      return false;
    }
  }

  /**
   * _startSampler — Internal sampling tick via setInterval
   *                 Reads time-domain data, computes average amplitude,
   *                 applies noise gate, fires callback.
   */
  function _startSampler() {
    if (samplerInterval) clearInterval(samplerInterval);

    samplerInterval = setInterval(() => {
      if (!analyser || !dataArray) return;

      // Read time-domain (waveform) data into Uint8Array
      analyser.getByteTimeDomainData(dataArray);

      // Compute average amplitude:
      //   dataArray values are 0–255 centered around 128 (silence = 128)
      //   Convert to 0–127 absolute deviation first
      let sum = 0;
      const N = dataArray.length;
      for (let i = 0; i < N; i++) {
        sum += Math.abs(dataArray[i] - 128);
      }
      const avg = sum / N; // Range: 0 (silence) to 127 (max clip)

      // Apply noise gate and dispatch
      if (avg > NOISE_GATE) {
        if (onSample) onSample(avg);
      } else {
        // Still fire with 0 so the meter can reflect silence
        if (onSample) onSample(avg);
      }
    }, SAMPLE_RATE_MS);
  }

  /**
   * stop — Gracefully tears down all audio resources
   */
  function stop() {
    _cleanup();
  }

  function _cleanup() {
    if (samplerInterval) {
      clearInterval(samplerInterval);
      samplerInterval = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    analyser  = null;
    dataArray = null;
    isActive  = false;
  }

  /**
   * getMeterPercent — Convert raw amplitude to a CSS meter percentage
   * Formula: min((avg / 120) * 100, 100)%
   * @param {number} avg
   * @returns {number} 0–100
   */
  function getMeterPercent(avg) {
    return Math.min((avg / MAX_AMPLITUDE) * 100, 100);
  }

  /**
   * isSupported — Quick capability check before init
   */
  function isSupported() {
    return !!(
      navigator.mediaDevices?.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext)
    );
  }

  // Public API
  return { init, stop, setCallbacks, getMeterPercent, isSupported };
})();

// Make available globally
window.AudioNode = AudioNode;
