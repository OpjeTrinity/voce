// public/js/mobile-client.js
// VOCE CLUSTER v2 — Audience Mobile Node Controller (Session-Aware)
// Reads sessionId from URL path /join/:sessionId

'use strict';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const CONFIG         = window.VOCE_CONFIG || {};
const PUSHER_KEY     = CONFIG.pusherKey     || '';
const PUSHER_CLUSTER = CONFIG.pusherCluster || 'ap2';
const PULSE_ENDPOINT = '/api/pulse';

// ─── SESSION ID FROM URL ─────────────────────────────────────────────────────
// URL format: /join/ABC123
const pathParts = window.location.pathname.split('/').filter(Boolean);
// pathParts[0] = 'join', pathParts[1] = sessionId
const SESSION_ID    = (pathParts[1] || 'GLOBAL').toUpperCase();
const CHANNEL_NAME  = `voce-${SESSION_ID}`;

// ─── NOISE GATE ──────────────────────────────────────────────────────────────
const NOISE_GATE = 32;

// ─── STATE MACHINE ───────────────────────────────────────────────────────────
const STATE = {
  STANDBY:    'STANDBY',
  CONNECTING: 'CONNECTING',
  ACTIVE:     'ACTIVE',
  OVERCLOCK:  'OVERCLOCK',
  DETONATED:  'DETONATED',
};
let currentState = STATE.STANDBY;

// ─── DOM REFERENCES ──────────────────────────────────────────────────────────
const body         = document.body;
const connectBtn   = document.getElementById('connect-btn');
const statusText   = document.getElementById('status-text');
const meterSection = document.getElementById('meter-section');
const meterFill    = document.getElementById('meter-fill');
const meterDb      = document.getElementById('meter-db');
const vuTicks      = document.querySelectorAll('.vu-tick');
const nodeIdEl     = document.getElementById('node-id');
const screamPrompt = document.getElementById('scream-prompt');
const videoOverlay = document.getElementById('video-overlay');
const climaxVideo  = document.getElementById('climax-video');
const climaxIframe = document.getElementById('climax-iframe');
const errorToast   = document.getElementById('error-toast');
const sessionLabel = document.getElementById('session-label');

// ─── SETUP ───────────────────────────────────────────────────────────────────
const NODE_ID = 'NODE-' + Math.random().toString(36).slice(2, 7).toUpperCase();
if (nodeIdEl)     nodeIdEl.textContent   = NODE_ID;
if (sessionLabel) sessionLabel.textContent = `SESSION: ${SESSION_ID}`;

// ─── STATE TRANSITIONS ────────────────────────────────────────────────────────
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

  body.className = '';
  if (newState === STATE.ACTIVE)     body.classList.add('state-active');
  if (newState === STATE.OVERCLOCK)  body.classList.add('state-overclock');

  if (connectBtn) {
    connectBtn.classList.toggle('hidden', newState !== STATE.STANDBY);
  }
  if (meterSection) {
    meterSection.classList.toggle('visible',
      newState === STATE.ACTIVE || newState === STATE.OVERCLOCK
    );
  }
  if (screamPrompt) {
    screamPrompt.classList.toggle('visible', newState === STATE.OVERCLOCK);
  }
}

// ─── CONNECT HANDLER ─────────────────────────────────────────────────────────
if (connectBtn) {
  connectBtn.addEventListener('click', handleConnect, { once: true });
}

async function handleConnect() {
  setState(STATE.CONNECTING);

  if (!window.AudioNode?.isSupported()) {
    showError('Web Audio API not supported on this device.');
    setState(STATE.STANDBY);
    connectBtn?.addEventListener('click', handleConnect, { once: true });
    return;
  }

  window.AudioNode.setCallbacks({
    onSample:   handleSample,
    onError:    (err) => showError('Mic error: ' + err.message),
    onActivate: () => console.log('[MobileClient] Audio active — session:', SESSION_ID),
  });

  const mediaEl = climaxVideo || climaxIframe;
  const ok = await window.AudioNode.init(mediaEl);

  if (!ok) {
    showError('Could not access microphone. Allow permission and retry.');
    setState(STATE.STANDBY);
    if (connectBtn) {
      connectBtn.classList.remove('hidden');
      connectBtn.addEventListener('click', handleConnect, { once: true });
    }
    return;
  }

  initPusher();
  setState(STATE.ACTIVE);
}

// ─── AUDIO SAMPLE HANDLER ────────────────────────────────────────────────────
function handleSample(avg) {
  updateMeter(avg);
  if (avg <= NOISE_GATE || currentState === STATE.DETONATED) return;

  fetch(PULSE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      volume:    Math.round(avg * 100) / 100,
    }),
    keepalive: true,
  }).catch(() => {});
}

// ─── METER UI ────────────────────────────────────────────────────────────────
function updateMeter(avg) {
  const pct = window.AudioNode.getMeterPercent(avg);
  if (meterFill) meterFill.style.width = pct + '%';
  if (meterDb) {
    const db = avg > 0 ? Math.round(20 * Math.log10(avg / 128) * 10) / 10 : -Infinity;
    meterDb.textContent = avg > 1 ? db + ' dB' : '-∞';
  }
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

// ─── PUSHER ──────────────────────────────────────────────────────────────────
let pusher  = null;
let channel = null;

function initPusher() {
  if (!PUSHER_KEY) {
    console.warn('[MobileClient] No Pusher key — real-time disabled');
    return;
  }
  try {
    pusher  = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER, forceTLS: true });
    channel = pusher.subscribe(CHANNEL_NAME);

    // Host broadcasts overclock alert when bottleneck is hit
    channel.bind('overclock-alert', () => {
      if (currentState === STATE.ACTIVE) setState(STATE.OVERCLOCK);
    });

    channel.bind('climax-trigger', handleClimax);
    pusher.connection.bind('error', (e) => console.warn('[Pusher]', e));

    console.log('[MobileClient] Subscribed to', CHANNEL_NAME, '— session:', SESSION_ID);
  } catch (err) {
    console.error('[MobileClient] Pusher init failed:', err);
    showError('Real-time connection failed. You can still contribute audio!');
  }
}

// ─── CLIMAX HANDLER ──────────────────────────────────────────────────────────
function handleClimax(data) {
  if (currentState === STATE.DETONATED) return;
  setState(STATE.DETONATED);
  console.log('[MobileClient] CLIMAX', data);

  if (videoOverlay) videoOverlay.classList.add('active');

  if (climaxVideo && climaxVideo.src && climaxVideo.src !== window.location.href) {
    climaxVideo.currentTime = 0;
    climaxVideo.volume      = 1.0;
    climaxVideo.play().catch(() => _iframeFallback());
  } else {
    _iframeFallback();
  }

  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 1000]);
  window.AudioNode?.stop();
}

function _iframeFallback() {
  if (!climaxIframe) return;
  climaxIframe.src = 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=0&controls=0&loop=1&playlist=dQw4w9WgXcQ&modestbranding=1&rel=0';
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
setState(STATE.STANDBY);
console.log(`[VOCE] ${NODE_ID} | session: ${SESSION_ID} | channel: ${CHANNEL_NAME}`);
