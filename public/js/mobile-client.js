// public/js/mobile-client.js
// VOCE CLUSTER — Audience Mobile Node Controller
// Manages state machine, Pusher subscription, mic loop, and climax detonation

'use strict';

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
// These are injected at runtime from the HTML template via window.VOCE_CONFIG
// Set in index.html before this script loads:
//   window.VOCE_CONFIG = { pusherKey: 'YOUR_KEY', pusherCluster: 'YOUR_CLUSTER' };
const CONFIG = window.VOCE_CONFIG || {};
const PUSHER_KEY     = CONFIG.pusherKey     || '';
const PUSHER_CLUSTER = CONFIG.pusherCluster || 'ap2';
const CHANNEL_NAME   = 'voce-cluster';
const PULSE_ENDPOINT = '/api/pulse';

// ─── NOISE GATE ─────────────────────────────────────────────────────────────
const NOISE_GATE_AMPLITUDE = 32; // Mirror of audio-node.js threshold

// ─── STATE MACHINE ──────────────────────────────────────────────────────────
const STATE = {
  STANDBY:    'STANDBY',
  CONNECTING: 'CONNECTING',
  ACTIVE:     'ACTIVE',
  OVERCLOCK:  'OVERCLOCK',
  DETONATED:  'DETONATED',
};
let currentState = STATE.STANDBY;

// ─── DOM REFERENCES ─────────────────────────────────────────────────────────
const body            = document.body;
const connectBtn      = document.getElementById('connect-btn');
const statusText      = document.getElementById('status-text');
const statusDot       = document.getElementById('status-dot');
const meterSection    = document.getElementById('meter-section');
const meterFill       = document.getElementById('meter-fill');
const meterDb         = document.getElementById('meter-db');
const vuTicks         = document.querySelectorAll('.vu-tick');
const nodeIdEl        = document.getElementById('node-id');
const screamPrompt    = document.getElementById('scream-prompt');
const videoOverlay    = document.getElementById('video-overlay');
const climaxVideo     = document.getElementById('climax-video');
const climaxIframe    = document.getElementById('climax-iframe');
const errorToast      = document.getElementById('error-toast');

// ─── UNIQUE NODE ID ─────────────────────────────────────────────────────────
const NODE_ID = 'NODE-' + Math.random().toString(36).slice(2, 7).toUpperCase();
if (nodeIdEl) nodeIdEl.textContent = NODE_ID;

// ─── PUSHER CHANNEL REFERENCE ────────────────────────────────────────────────
let pusher  = null;
let channel = null;

// ─── STATE TRANSITIONS ───────────────────────────────────────────────────────
const STATUS_LABELS = {
  [STATE.STANDBY]:    'STANDBY — TAP TO JOIN',
  [STATE.CONNECTING]: 'LINKING NODE...',
  [STATE.ACTIVE]:     'NODE ARMED — LISTENING',
  [STATE.OVERCLOCK]:  'OVERCLOCK ACTIVE — SCREAM NOW',
  [STATE.DETONATED]:  'DETONATION CONFIRMED',
};

function setState(newState) {
  currentState = newState;
  if (statusText) statusText.textContent = STATUS_LABELS[newState] || newState;

  // Body class drives CSS state transitions
  body.className = '';
  if (newState === STATE.ACTIVE)     body.classList.add('state-active');
  if (newState === STATE.OVERCLOCK)  body.classList.add('state-overclock');
  if (newState === STATE.CONNECTING) body.classList.add('state-connecting');

  // Show/hide connect button
  if (connectBtn) {
    connectBtn.classList.toggle('hidden', newState !== STATE.STANDBY);
  }

  // Show meter once active
  if (meterSection) {
    meterSection.classList.toggle('visible',
      newState === STATE.ACTIVE || newState === STATE.OVERCLOCK
    );
  }

  // Scream prompt during overclock bottleneck broadcast
  if (screamPrompt) {
    screamPrompt.classList.toggle('visible', newState === STATE.OVERCLOCK);
  }
}

// ─── CONNECT BUTTON HANDLER ──────────────────────────────────────────────────
if (connectBtn) {
  connectBtn.addEventListener('click', handleConnect, { once: true });
}

async function handleConnect() {
  setState(STATE.CONNECTING);

  // 1. Check Audio API support
  if (!window.AudioNode || !window.AudioNode.isSupported()) {
    showError('Web Audio API not supported on this device.');
    setState(STATE.STANDBY);
    if (connectBtn) connectBtn.addEventListener('click', handleConnect, { once: true });
    return;
  }

  // 2. Register AudioNode callbacks
  window.AudioNode.setCallbacks({
    onSample:   handleSample,
    onError:    (err) => showError('Mic error: ' + err.message),
    onActivate: () => console.log('[MobileClient] AudioNode active'),
  });

  // 3. Init AudioContext + request mic + pre-warm video
  //    MUST happen synchronously from click handler
  const mediaEl = climaxVideo || climaxIframe;
  const ok = await window.AudioNode.init(mediaEl);

  if (!ok) {
    showError('Could not access microphone. Please allow permission and retry.');
    setState(STATE.STANDBY);
    if (connectBtn) {
      connectBtn.classList.remove('hidden');
      connectBtn.addEventListener('click', handleConnect, { once: true });
    }
    return;
  }

  // 4. Initialize Pusher subscription
  initPusher();

  setState(STATE.ACTIVE);
}

// ─── AUDIO SAMPLE HANDLER ────────────────────────────────────────────────────
async function handleSample(avg) {
  // Update meter UI
  updateMeter(avg);

  // Only dispatch above noise gate
  if (avg <= NOISE_GATE_AMPLITUDE) return;
  if (currentState === STATE.DETONATED) return;

  // Fire-and-forget POST to /api/pulse
  try {
    fetch(PULSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: Math.round(avg * 100) / 100 }),
      // keepalive: true helps on mobile page unload
      keepalive: true,
    }).catch(() => {}); // Silently ignore network errors
  } catch (_) {}
}

// ─── METER UI UPDATE ─────────────────────────────────────────────────────────
function updateMeter(avg) {
  const pct = window.AudioNode.getMeterPercent(avg);

  if (meterFill) {
    meterFill.style.width = pct + '%';
  }

  if (meterDb) {
    // Convert avg amplitude to approximate dB for display
    const db = avg > 0
      ? Math.round(20 * Math.log10(avg / 128) * 10) / 10
      : -Infinity;
    meterDb.textContent = avg > 1 ? db + ' dB' : '-∞';
  }

  // VU tick bar (20 ticks)
  const litCount = Math.round((pct / 100) * vuTicks.length);
  vuTicks.forEach((tick, i) => {
    tick.className = 'vu-tick';
    if (i < litCount) {
      if (i >= vuTicks.length * 0.85) tick.classList.add('lit-red');
      else if (i >= vuTicks.length * 0.65) tick.classList.add('lit-yellow');
      else tick.classList.add('lit-green');
    }
  });
}

// ─── PUSHER INITIALIZATION ───────────────────────────────────────────────────
function initPusher() {
  if (!PUSHER_KEY) {
    console.warn('[MobileClient] No Pusher key configured — real-time features disabled');
    return;
  }

  try {
    pusher = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      forceTLS: true,
    });

    channel = pusher.subscribe(CHANNEL_NAME);

    // Listen for overclock broadcast (from host when bottleneck hits)
    channel.bind('overclock-alert', () => {
      if (currentState === STATE.ACTIVE) {
        setState(STATE.OVERCLOCK);
      }
    });

    // Listen for the climax trigger
    channel.bind('climax-trigger', handleClimaxTrigger);

    // Handle connection errors gracefully
    pusher.connection.bind('error', (err) => {
      console.warn('[MobileClient] Pusher connection error:', err);
    });

    console.log('[MobileClient] Pusher subscribed to', CHANNEL_NAME);
  } catch (err) {
    console.error('[MobileClient] Pusher init failed:', err);
    showError('Real-time connection failed. You can still contribute audio!');
  }
}

// ─── CLIMAX DETONATION HANDLER ───────────────────────────────────────────────
function handleClimaxTrigger(data) {
  if (currentState === STATE.DETONATED) return;
  setState(STATE.DETONATED);

  console.log('[MobileClient] CLIMAX TRIGGERED', data);

  // 1. Bring video overlay from display:none → display:flex
  if (videoOverlay) {
    videoOverlay.classList.add('active');
  }

  // 2. Play the climax video (pre-warmed in init — should autoplay without issues)
  if (climaxVideo && climaxVideo.src && climaxVideo.src !== window.location.href) {
    climaxVideo.currentTime = 0;
    climaxVideo.volume = 1.0;
    climaxVideo.play().catch(err => {
      console.warn('[MobileClient] Video play failed, trying iframe fallback:', err);
      _activateIframeFallback();
    });
  } else {
    // No local video — use YouTube iframe fallback
    _activateIframeFallback();
  }

  // 3. Haptic engine — standard navigator.vibrate pattern
  if (navigator.vibrate) {
    navigator.vibrate([300, 150, 300, 150, 1000]);
  }

  // 4. Stop mic sampling to save battery
  window.AudioNode.stop();
}

function _activateIframeFallback() {
  if (!climaxIframe) return;
  // Rick Astley — Never Gonna Give You Up (autoplay, mute=0, controls=0)
  climaxIframe.src =
    'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=0&controls=0&loop=1&playlist=dQw4w9WgXcQ&modestbranding=1&rel=0';
  climaxIframe.style.display = 'block';
  if (climaxVideo) climaxVideo.style.display = 'none';
}

// ─── ERROR TOAST ─────────────────────────────────────────────────────────────
function showError(msg) {
  if (!errorToast) return;
  errorToast.textContent = msg;
  errorToast.classList.add('show');
  setTimeout(() => errorToast.classList.remove('show'), 4000);
}

// ─── INIT ────────────────────────────────────────────────────────────────────
// Start in standby
setState(STATE.STANDBY);

console.log(`[VOCE] ${NODE_ID} initialized. Waiting for user gesture.`);
