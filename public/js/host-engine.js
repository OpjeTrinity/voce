// public/js/host-engine.js
// VOCE CLUSTER — Host Orchestrator Engine
// Manages compilation state machine, acoustic energy model, QR generation,
// node tracking, dashboard rendering, and failsafe keybinds.

'use strict';

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
// Injected from host.html: window.VOCE_CONFIG = { pusherKey, pusherCluster }
const CONFIG = window.VOCE_CONFIG || {};
const PUSHER_KEY      = CONFIG.pusherKey     || '';
const PUSHER_CLUSTER  = CONFIG.pusherCluster || 'ap2';
const CHANNEL_NAME    = 'voce-cluster';
const DETONATE_EP     = '/api/detonate';

// ─── ENGINE CONSTANTS ───────────────────────────────────────────────────────
const TICK_RATE_MS        = 33;    // ~30 FPS
const DECAY_FACTOR        = 0.65;  // Exponential decay per tick
const AMBIENT_THRESHOLD   = 35;    // Energy floor for progress calculation
const BOTTLENECK_START    = 75.0;  // Lock progress here
const BOTTLENECK_END      = 76.5;  // Release if energy >= BOTTLENECK_RELEASE
const BOTTLENECK_RELEASE  = 120;   // Required energy to break bottleneck
const PROGRESS_EXPONENT   = 2.2;   // Quadratic resistance curve exponent
const PROGRESS_MULTIPLIER = 2.8;   // Linear scaling after exponent

// ─── STATE VARIABLES ────────────────────────────────────────────────────────
let totalIncomingEnergy = 0;   // Accumulator: receives pulses
let currentEnergy       = 0;   // Display/calculation value (decaying)
let progress            = 0.0; // 0.0 → 100.0
let isBottlenecked      = false;
let nodeCount           = 0;
let isRunning           = false;
let isDetonated         = false;
let detonateCalledOnce  = false;
let tickHandle          = null;

// ─── DOM REFERENCES ─────────────────────────────────────────────────────────
const progressFill    = document.getElementById('progress-fill');
const progressPct     = document.getElementById('progress-pct');
const progressTicks   = document.querySelectorAll('#progress-ticks span');
const statusMessage   = document.getElementById('status-message');
const statusSub       = document.getElementById('status-sub');
const acousticFill    = document.getElementById('acoustic-fill');
const acousticValue   = document.getElementById('acoustic-value');
const metricNodes     = document.getElementById('metric-nodes');
const metricEnergy    = document.getElementById('metric-energy');
const metricSpeed     = document.getElementById('metric-speed');
const logEntries      = document.getElementById('log-entries');
const nodeCountNum    = document.getElementById('node-count-number');
const nodePipList     = document.getElementById('node-list');
const headerTime      = document.getElementById('header-time');
const videoOverlay    = document.getElementById('video-overlay');
const climaxVideo     = document.getElementById('climax-video');
const climaxIframe    = document.getElementById('climax-iframe');
const headerStatusDot = document.getElementById('header-status-dot');

// ─── QR CODE GENERATION ──────────────────────────────────────────────────────
function initQR() {
  const container = document.getElementById('qr-canvas-container');
  const urlEl     = document.getElementById('qr-url');
  const url       = window.location.origin;

  if (urlEl) urlEl.textContent = url;

  if (container && window.QRCode) {
    try {
      new QRCode(container, {
        text:          url,
        width:         160,
        height:        160,
        colorDark:     '#000000',
        colorLight:    '#ffffff',
        correctLevel:  QRCode.CorrectLevel.H,
      });
      addLog('ok', 'QR code generated → ' + url);
    } catch (e) {
      addLog('warn', 'QR generation failed: ' + e.message);
    }
  } else {
    addLog('warn', 'QRCode library not loaded');
  }
}

// ─── PUSHER INITIALIZATION ───────────────────────────────────────────────────
let pusher  = null;
let channel = null;

function initPusher() {
  if (!PUSHER_KEY) {
    addLog('warn', 'PUSHER_KEY not configured — operating in dry-run mode');
    return;
  }

  try {
    pusher = new Pusher(PUSHER_KEY, {
      cluster:  PUSHER_CLUSTER,
      forceTLS: true,
    });

    channel = pusher.subscribe(CHANNEL_NAME);

    // ── Acoustic pulse from audience nodes ──────────────────────────────
    channel.bind('acoustic-pulse', (data) => {
      const vol = parseFloat(data?.volume);
      if (!Number.isFinite(vol) || vol < 0) return;
      totalIncomingEnergy += vol;
    });

    // ── Node registration tracking ───────────────────────────────────────
    channel.bind('pusher:subscription_succeeded', () => {
      addLog('ok', 'Pusher channel subscribed: ' + CHANNEL_NAME);
    });

    // Track members if using presence channel (optional enhancement)
    // For standard channel, we infer node count from pulse frequency
    pusher.connection.bind('connected', () => {
      addLog('ok', 'Pusher WebSocket connected');
      if (headerStatusDot) {
        headerStatusDot.style.background = 'var(--green)';
      }
    });

    pusher.connection.bind('error', (err) => {
      addLog('err', 'Pusher error: ' + (err?.error?.data?.message || 'unknown'));
    });

    pusher.connection.bind('disconnected', () => {
      addLog('warn', 'Pusher disconnected — attempting reconnect');
    });

    addLog('info', 'Pusher initialized — cluster: ' + PUSHER_CLUSTER);

  } catch (err) {
    addLog('err', 'Pusher init failed: ' + err.message);
  }
}

// ─── NODE COUNTER MANAGEMENT ─────────────────────────────────────────────────
// We estimate node count by counting how many unique pulse bursts arrive
// per second (rough heuristic for standard channels without presence)
let pulseWindowCount  = 0;
let lastNodeEstimate  = 0;

// Called whenever a pulse arrives
function onPulseReceived(vol) {
  pulseWindowCount++;
  totalIncomingEnergy += vol;
}

// Re-estimate node count every 2 seconds
setInterval(() => {
  // A connected node pulses roughly every 150ms → ~6.67 pulses/sec
  const estimatedNodes = Math.round(pulseWindowCount / (2000 / 150));
  if (estimatedNodes !== lastNodeEstimate) {
    lastNodeEstimate = estimatedNodes;
    updateNodeCount(estimatedNodes);
  }
  pulseWindowCount = 0;
}, 2000);

function incrementNodeCount() {
  updateNodeCount(nodeCount + 1);
  addLog('ok', 'Node linked → ' + nodeCount + ' active nodes');
}

function updateNodeCount(n) {
  nodeCount = Math.max(0, n);
  if (metricNodes) metricNodes.textContent = nodeCount;
  if (nodeCountNum) {
    nodeCountNum.textContent = nodeCount;
    nodeCountNum.classList.add('bump');
    setTimeout(() => nodeCountNum.classList.remove('bump'), 200);
  }
  syncNodePips();
}

function syncNodePips() {
  if (!nodePipList) return;
  const current = nodePipList.querySelectorAll('.node-pip').length;
  if (nodeCount > current) {
    for (let i = current; i < nodeCount; i++) {
      const pip = document.createElement('span');
      pip.className = 'node-pip';
      nodePipList.appendChild(pip);
    }
  } else if (nodeCount < current) {
    const pips = nodePipList.querySelectorAll('.node-pip');
    for (let i = nodeCount; i < current; i++) {
      pips[i]?.remove();
    }
  }
}

// ─── COMPILATION PROGRESS ENGINE ─────────────────────────────────────────────
// Phase labels mapped to progress ranges
const PHASES = [
  { at:  0, label: 'INITIALIZING LLVM IR BACKEND',       sub: 'Loading bitcode modules into memory...',               state: 'normal' },
  { at: 10, label: 'PARSING TRANSLATION UNITS',           sub: 'Resolving 14,847 symbol references across 23 crates', state: 'normal' },
  { at: 22, label: 'RUNNING OPTIMIZATION PASSES (O3)',    sub: 'Applying loop unrolling, SIMD vectorization, DCE...',  state: 'normal' },
  { at: 38, label: 'CODEGEN: INSTRUCTION SELECTION',      sub: 'SelectionDAG → MachineInstr lowering in progress...', state: 'normal' },
  { at: 52, label: 'REGISTER ALLOCATION (GREEDY)',        sub: 'Spilling 3,211 virtual regs to stack frame...',       state: 'warning' },
  { at: 65, label: 'LINKING FINAL BINARY',                sub: 'LTO pass running — merging 892 modules...',           state: 'warning' },
  { at: 74, label: 'THERMAL THROTTLE DETECTED',           sub: 'Silicon junction temp: 98°C — BKD remediation required', state: 'warning' },
  { at: 75, label: 'CRITICAL BOTTLENECK: L3 THERMAL LOCKOUT', sub: 'INSUFFICIENT CLUSTER COMPUTE\nNEED COMBINED ACOUSTIC PRESSURE > 120 dB', state: 'bottleneck' },
  { at: 80, label: 'BOTTLENECK CLEARED — RESUMING',       sub: 'Acoustic pressure sufficient — unlocking pipeline...', state: 'warning' },
  { at: 88, label: 'FINALIZING BINARY SECTIONS',          sub: '.text .data .rodata sections patched...',             state: 'normal' },
  { at: 95, label: 'STRIPPING DEBUG SYMBOLS',             sub: 'Running strip --strip-debug on 4.2GB ELF binary...',  state: 'normal' },
  { at: 99, label: 'COMPILATION COMPLETE',                sub: 'Binary checksum verified. Deploying payload...',      state: 'complete' },
];

function getPhase(p) {
  let current = PHASES[0];
  for (const phase of PHASES) {
    if (p >= phase.at) current = phase;
    else break;
  }
  return current;
}

// ─── MAIN TICK FUNCTION ──────────────────────────────────────────────────────
let lastProgress = -1;
let speedHistory = [];

function tick() {
  if (isDetonated) return;

  const prevProgress = progress;

  // ── 1. Energy Decay ─────────────────────────────────────────────────
  currentEnergy       = totalIncomingEnergy;
  totalIncomingEnergy = totalIncomingEnergy * DECAY_FACTOR;

  // ── 2. Progress Calculation ──────────────────────────────────────────
  if (currentEnergy > AMBIENT_THRESHOLD) {
    const delta = Math.pow(
      (currentEnergy - AMBIENT_THRESHOLD) / 100,
      PROGRESS_EXPONENT
    ) * PROGRESS_MULTIPLIER;

    // ── 3. Bottleneck Gate ───────────────────────────────────────────
    if (progress >= BOTTLENECK_START && progress < BOTTLENECK_END) {
      isBottlenecked = true;
      if (currentEnergy >= BOTTLENECK_RELEASE) {
        // Burst through bottleneck
        isBottlenecked = false;
        progress = Math.min(progress + delta, 100);
        addLog('ok', '🔥 ACOUSTIC THRESHOLD MET — BOTTLENECK RELEASED');
        // Broadcast overclock alert to mobile nodes
        broadcastOverclockAlert();
      } else {
        // Hold at 75%
        progress = BOTTLENECK_START;
      }
    } else {
      isBottlenecked = false;
      progress = Math.min(progress + delta, 100);
    }
  }

  // Track compile speed
  const speedDelta = progress - prevProgress;
  speedHistory.push(speedDelta);
  if (speedHistory.length > 30) speedHistory.shift();
  const avgSpeed = speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

  // ── 4. Update UI ─────────────────────────────────────────────────────
  _updateProgressBar();
  _updateStatusBlock();
  _updateAcousticGauge();
  _updateMetrics(avgSpeed);

  // ── 5. Win Condition ──────────────────────────────────────────────────
  if (progress >= 100 && !detonateCalledOnce) {
    detonateCalledOnce = true;
    _onCompilationComplete();
  }
}

// Broadcast overclock-alert to mobile nodes via Pusher
let overclockBroadcastSent = false;
function broadcastOverclockAlert() {
  if (overclockBroadcastSent) return;
  overclockBroadcastSent = true;
  // Trigger via the API — we reuse the detonate endpoint's pattern
  // Since we don't have a separate endpoint for this, just trigger via Pusher server SDK
  // For now, we signal via a dedicated pulse with special flag
  fetch('/api/pulse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 255, __overclock: true }),
  }).catch(() => {});
  addLog('warn', 'OVERCLOCK ALERT broadcast to all nodes');
}

// ─── UI UPDATES ──────────────────────────────────────────────────────────────
function _updateProgressBar() {
  const pct = Math.round(progress * 10) / 10;

  if (progressFill) {
    progressFill.style.width = pct + '%';
    progressFill.className = 'progress-fill' + (isBottlenecked ? ' bottleneck' : progress >= 100 ? ' complete' : '');
    // Need to match the base id, not class
    progressFill.id = 'progress-fill'; // keep id
    progressFill.className = isBottlenecked ? 'bottleneck' : progress >= 100 ? 'complete' : '';
  }

  if (progressPct) {
    progressPct.textContent = pct.toFixed(1) + '%';
    progressPct.className = isBottlenecked ? 'bottleneck' : progress >= 95 ? 'complete' : progress >= 65 ? 'warning' : '';
  }

  // Tick marks (20 ticks)
  const litCount = Math.round((pct / 100) * progressTicks.length);
  progressTicks.forEach((tick, i) => {
    tick.classList.toggle('active', i < litCount);
  });
}

function _updateStatusBlock() {
  const phase = getPhase(progress);

  if (statusMessage) {
    statusMessage.textContent = phase.label;
    statusMessage.className   = phase.state === 'bottleneck' ? 'bottleneck'
                              : phase.state === 'warning'    ? 'warning'
                              : phase.state === 'complete'   ? 'complete'
                              : '';
  }
  if (statusSub) {
    statusSub.textContent = phase.sub;
  }
}

function _updateAcousticGauge() {
  const pct = Math.min((currentEnergy / 150) * 100, 100);

  if (acousticFill) {
    acousticFill.style.width = pct + '%';
    acousticFill.className =
      pct > 80 ? 'critical' :
      pct > 50 ? 'hot'      : '';
  }

  if (acousticValue) {
    acousticValue.textContent = Math.round(currentEnergy);
  }
}

function _updateMetrics(avgSpeed) {
  if (metricEnergy) {
    metricEnergy.textContent = Math.round(currentEnergy);
  }
  if (metricSpeed) {
    const speedStr = avgSpeed > 0 ? '+' + (avgSpeed * 100).toFixed(2) : '0.00';
    metricSpeed.textContent = speedStr;
  }
}

// ─── WIN CONDITION ────────────────────────────────────────────────────────────
async function _onCompilationComplete() {
  isDetonated = true;
  isRunning   = false;
  clearInterval(tickHandle);

  addLog('ok', '✅ COMPILATION COMPLETE — 100% — INITIATING PAYLOAD DROP');

  // Glitch the progress pct
  if (progressPct) {
    progressPct.textContent = '100.0%';
    progressPct.classList.add('complete', 'glitch-text');
  }

  _updateStatusBlock();

  // Trigger detonation API
  try {
    const res = await fetch(DETONATE_EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      addLog('ok', 'Detonation API → 200 OK — climax-trigger broadcast sent');
    } else {
      addLog('warn', 'Detonation API returned ' + res.status + ' — triggering locally');
    }
  } catch (err) {
    addLog('err', 'Detonation API failed: ' + err.message + ' — triggering locally');
  }

  // Always trigger local detonation after a short dramatic pause
  setTimeout(_triggerHostClimax, 800);
}

function _triggerHostClimax() {
  if (!videoOverlay) return;
  videoOverlay.classList.add('active');

  if (climaxVideo && climaxVideo.src && climaxVideo.src !== window.location.href) {
    climaxVideo.currentTime = 0;
    climaxVideo.volume      = 1.0;
    climaxVideo.play().catch(() => _activateHostIframe());
  } else {
    _activateHostIframe();
  }
}

function _activateHostIframe() {
  if (!climaxIframe) return;
  climaxIframe.src =
    'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=0&controls=1&loop=1&playlist=dQw4w9WgXcQ&rel=0';
  if (climaxVideo) climaxVideo.style.display = 'none';
}

// ─── LOG SYSTEM ───────────────────────────────────────────────────────────────
const MAX_LOG_ENTRIES = 8;

function addLog(level, message) {
  if (!logEntries) return;

  const now  = new Date();
  const time = now.toTimeString().slice(0, 8);

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const TAG_MAP = { info: '[INFO]', ok: '[ OK ]', warn: '[WARN]', err: '[ERR!]' };

  entry.innerHTML = `
    <span class="log-ts">${time}</span>
    <span class="log-tag ${level}">${TAG_MAP[level] || '[----]'}</span>
    <span class="log-msg">${message}</span>
  `;

  logEntries.appendChild(entry);

  // Keep only last MAX_LOG_ENTRIES
  while (logEntries.children.length > MAX_LOG_ENTRIES) {
    logEntries.removeChild(logEntries.firstChild);
  }

  // Auto-scroll
  logEntries.scrollTop = logEntries.scrollHeight;
}

// ─── FAILSAFE KEYBINDS ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't interfere if user is typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.code) {
    case 'Space':
    case 'ArrowRight':
      // +5% progress bypass — skips audio checks and bottleneck
      e.preventDefault();
      if (isDetonated) return;
      progress = Math.min(progress + 5.0, 100);
      isBottlenecked = false;
      addLog('warn', '⚡ FAILSAFE: +5% manual override injected');
      _updateProgressBar();
      _updateStatusBlock();
      break;

    case 'KeyR':
      // Instantly set to 100% and trigger detonation
      if (isDetonated) return;
      progress = 100.0;
      isBottlenecked = false;
      addLog('warn', '🚀 FAILSAFE: KeyR — forcing 100% and detonation');
      _updateProgressBar();
      if (!detonateCalledOnce) {
        detonateCalledOnce = true;
        _onCompilationComplete();
      }
      break;

    case 'Escape':
      // Emergency: close video overlay if open
      if (videoOverlay && videoOverlay.classList.contains('active')) {
        videoOverlay.classList.remove('active');
        if (climaxIframe) climaxIframe.src = '';
        if (climaxVideo) climaxVideo.pause();
        addLog('info', 'ESC: Video overlay closed');
      }
      break;
  }
});

// ─── CLOCK ────────────────────────────────────────────────────────────────────
function updateClock() {
  if (headerTime) {
    const now = new Date();
    headerTime.textContent = now.toLocaleTimeString('en-GB', {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
}
setInterval(updateClock, 1000);
updateClock();

// ─── ENGINE START ─────────────────────────────────────────────────────────────
function start() {
  if (isRunning) return;
  isRunning  = true;
  tickHandle = setInterval(tick, TICK_RATE_MS);
  addLog('ok', 'VOCE Engine started — tick rate: ' + TICK_RATE_MS + 'ms (30 FPS)');
}

// ─── PUSHER EVENT RE-BINDING FOR ENGINE ───────────────────────────────────────
// We need to override the Pusher binding after initPusher() runs
// Use a polling check to grab the channel reference
function bindEngineEvents() {
  if (!channel) {
    setTimeout(bindEngineEvents, 200);
    return;
  }

  // Re-bind acoustic-pulse to engine's accumulator
  channel.unbind('acoustic-pulse');
  channel.bind('acoustic-pulse', (data) => {
    const vol = parseFloat(data?.volume);
    if (!Number.isFinite(vol) || vol < 0) return;
    totalIncomingEnergy += vol;
    pulseWindowCount++;
  });
}

// ─── INITIALIZATION SEQUENCE ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  addLog('info', 'VOCE CLUSTER v2.0.26 — HOST ORCHESTRATOR ONLINE');
  addLog('info', 'Biological Kinetic Dissipation module loaded');

  initQR();
  initPusher();
  bindEngineEvents();
  start();

  addLog('ok', 'Waiting for audience nodes to link...');
  addLog('info', 'Failsafe keys: [SPACE/→] +5% | [R] Force 100% | [ESC] Close overlay');
});
