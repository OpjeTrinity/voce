// public/js/host-engine.js
// VOCE CLUSTER v2 — Host Orchestrator Engine
// Session-aware: creates a session room, generates QR, drives compile terminal.
// Compile speed is controlled by live acoustic energy from audience nodes.

'use strict';

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const CONFIG         = window.VOCE_CONFIG || {};
const PUSHER_KEY     = CONFIG.pusherKey     || '';
const PUSHER_CLUSTER = CONFIG.pusherCluster || 'ap2';

// ─── COMPILE ENGINE CONSTANTS ───────────────────────────────────────────────
const TICK_RATE_MS        = 33;     // 30 FPS update loop
const DECAY_FACTOR        = 0.70;   // Energy decay per tick
const BASE_LINE_DELAY_MS  = 3000;   // Delay between lines at zero energy
const MIN_LINE_DELAY_MS   = 120;    // Fastest possible line emission
const ENERGY_SPEED_FACTOR = 22;     // How much each energy unit reduces delay
const BOTTLENECK_RELEASE  = 120;    // Energy required to break the 75% stall

const LOG   = window.VOCE_COMPILE_LOG    || [];
const BK_START = window.VOCE_BOTTLENECK_START || 110;
const BK_END   = window.VOCE_BOTTLENECK_END   || 117;

// ─── ENGINE STATE ───────────────────────────────────────────────────────────
let sessionId           = null;
let pusher              = null;
let channel             = null;

let totalIncomingEnergy = 0;
let currentEnergy       = 0;
let nodeCount           = 0;
let pulseWindowCount    = 0;

// Compile state
let isCompiling         = false;
let isBottlenecked      = false;
let isDetonated         = false;
let currentLineIndex    = 0;       // Next log line to emit
let lastLineTime        = 0;       // Timestamp of last emitted line
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
const metricDelay     = document.getElementById('metric-delay');
const nodeCountNum    = document.getElementById('node-count-number');
const nodePipList     = document.getElementById('node-list');
const headerTime      = document.getElementById('header-time');
const headerStatusDot = document.getElementById('header-status-dot');
const startBtn        = document.getElementById('start-compile-btn');
const terminalBody    = document.getElementById('terminal-body');
const terminalCursor  = document.getElementById('terminal-cursor');
const videoOverlay    = document.getElementById('video-overlay');
const climaxVideo     = document.getElementById('climax-video');
const climaxIframe    = document.getElementById('climax-iframe');

// ─── SESSION INIT ─────────────────────────────────────────────────────────
async function initSession() {
  addLog('info', 'Requesting new session from /api/session...');
  try {
    const res  = await fetch('/api/session');
    const data = await res.json();
    sessionId  = data.sessionId;

    addLog('ok',  `Session created: ${sessionId} — channel: voce-${sessionId}`);
    addLog('info', `Join URL: ${data.joinUrl}`);

    // Update QR
    initQR(data.joinUrl);

    // Update footer channel display
    const footerChannel = document.getElementById('footer-channel');
    if (footerChannel) footerChannel.textContent = `voce-${sessionId}`;

    // Now connect Pusher for this session
    initPusher(sessionId);

  } catch (err) {
    addLog('err', 'Session init failed: ' + err.message);
  }
}

// ─── QR CODE ─────────────────────────────────────────────────────────────
function initQR(joinUrl) {
  const container = document.getElementById('qr-canvas-container');
  const urlEl     = document.getElementById('qr-url');

  if (urlEl) urlEl.textContent = joinUrl;
  if (!container) return;

  container.innerHTML = ''; // Clear any previous QR

  if (window.QRCode) {
    try {
      new QRCode(container, {
        text:         joinUrl,
        width:        160,
        height:       160,
        colorDark:    '#000000',
        colorLight:   '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
      addLog('ok', 'QR code generated');
    } catch (e) {
      addLog('warn', 'QR generation failed: ' + e.message);
    }
  } else {
    // Fallback: show the URL as text clearly
    container.style.cssText = 'font-size:11px;word-break:break-all;padding:8px;color:#000;background:#fff;border-radius:4px;max-width:160px;';
    container.textContent   = joinUrl;
  }
}

// ─── PUSHER ──────────────────────────────────────────────────────────────
function initPusher(sid) {
  if (!PUSHER_KEY) {
    addLog('warn', 'No PUSHER_KEY — real-time disabled');
    return;
  }

  pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER, forceTLS: true });
  const ch = `voce-${sid}`;
  channel  = pusher.subscribe(ch);

  channel.bind('acoustic-pulse', (data) => {
    const vol = parseFloat(data?.volume);
    if (!Number.isFinite(vol) || vol < 0) return;
    totalIncomingEnergy += vol;
    pulseWindowCount++;
  });

  pusher.connection.bind('connected', () => {
    addLog('ok', 'Pusher connected — listening on ' + ch);
    if (headerStatusDot) headerStatusDot.style.cssText =
      'background:var(--green);box-shadow:0 0 8px var(--green);';
  });

  pusher.connection.bind('error', (e) => {
    addLog('err', 'Pusher error: ' + (e?.error?.data?.message || 'unknown'));
  });
}

// ─── NODE COUNT ESTIMATE ─────────────────────────────────────────────────
setInterval(() => {
  // A connected node fires ~6.67 pulses/sec (every 150ms)
  const estimated = Math.max(0, Math.round(pulseWindowCount / (2000 / 150)));
  if (estimated !== nodeCount) updateNodeCount(estimated);
  pulseWindowCount = 0;
}, 2000);

function updateNodeCount(n) {
  nodeCount = n;
  if (metricNodes)   metricNodes.textContent = n;
  if (nodeCountNum) {
    nodeCountNum.textContent = n;
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
    for (let i = nodeCount; i < current; i++) pips[i]?.remove();
  }
}

// ─── START BUTTON ────────────────────────────────────────────────────────
if (startBtn) {
  startBtn.addEventListener('click', startCompile);
}

function startCompile() {
  if (isCompiling || isDetonated) return;
  isCompiling    = true;
  currentLineIndex = 0;
  lastLineTime   = Date.now();

  if (startBtn) {
    startBtn.disabled   = true;
    startBtn.textContent = '⚙ COMPILING...';
  }

  addLog('ok', 'Compilation initiated — acoustic energy drives compile speed');
  updateStatus('COMPILING', 'LLVM IR BACKEND LOADING', 'Acoustic energy controls compile velocity...', 'normal');

  // Clear terminal
  if (terminalBody) terminalBody.innerHTML = '';
  emitTerminalLine('$ python3 -m voce_engine compile --target=cuda --opt=O3 voce_engine/', 'cmd');
  emitTerminalLine('', 'blank');
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────
function tick() {
  if (isDetonated) return;

  // Energy decay
  currentEnergy       = totalIncomingEnergy;
  totalIncomingEnergy = totalIncomingEnergy * DECAY_FACTOR;

  // Update UI metrics
  _updateAcousticGauge();
  _updateMetrics();
  updateClock();

  if (!isCompiling) return;

  // Compute current line delay based on energy
  const delay = Math.max(
    MIN_LINE_DELAY_MS,
    BASE_LINE_DELAY_MS - (currentEnergy * ENERGY_SPEED_FACTOR)
  );

  const now     = Date.now();
  const elapsed = now - lastLineTime;

  // Bottleneck gate
  if (currentLineIndex >= BK_START && currentLineIndex <= BK_END) {
    isBottlenecked = true;
    if (currentEnergy < BOTTLENECK_RELEASE) {
      // Locked — flash status, do not advance
      _updateBottleneckStatus();
      _updateProgressBar();
      return;
    } else {
      // Enough energy — break through
      isBottlenecked = false;
      addLog('ok', '🔥 ACOUSTIC THRESHOLD EXCEEDED — BOTTLENECK RELEASED');
      updateStatus(
        'COMPILING',
        'THERMAL HEADROOM RESTORED',
        'Biological Kinetic Dissipation successful — resuming compilation...',
        'warning'
      );
    }
  } else {
    isBottlenecked = false;
  }

  // Advance line if enough time has passed
  if (elapsed >= delay) {
    lastLineTime = now;
    _emitNextLine();
  }

  _updateProgressBar();
}

function _emitNextLine() {
  if (currentLineIndex >= LOG.length) {
    _onCompileComplete();
    return;
  }

  const line = LOG[currentLineIndex];
  currentLineIndex++;

  // Classify line style
  let cls = 'normal';
  if (line.startsWith('[llvm]'))       cls = 'llvm';
  else if (line.startsWith('[opt]'))   cls = 'opt';
  else if (line.startsWith('[nvcc]'))  cls = 'nvcc';
  else if (line.startsWith('[linker]'))cls = 'linker';
  else if (line.startsWith('[codegen]'))cls = 'codegen';
  else if (line.includes('WARNING'))   cls = 'warn';
  else if (line.includes('STALL'))     cls = 'stall';
  else if (line.includes('ERROR'))     cls = 'error';
  else if (line.startsWith('>>>'))     cls = 'cmd';
  else if (line.startsWith('════'))    cls = 'banner';
  else if (line.includes('SUCCESSFUL')) cls = 'success';
  else if (line === '')                cls = 'blank';

  emitTerminalLine(line, cls);

  // Update phase label from line content
  if (line.startsWith('[parser]') && line.includes('AST')) {
    updateStatus('COMPILING', 'PARSING TRANSLATION UNITS', line.replace('[parser] ', ''), 'normal');
  } else if (line.startsWith('[llvm]') && line.includes('Emitting LLVM')) {
    updateStatus('COMPILING', 'GENERATING LLVM IR', 'Lowering Python bytecode...', 'normal');
  } else if (line.startsWith('[opt]') && line.includes('Pass 1')) {
    updateStatus('COMPILING', 'RUNNING OPTIMIZATION PASSES (O3)', 'Applying loop unrolling, SIMD vectorization, DCE...', 'normal');
  } else if (line.startsWith('[nvcc]') && line.includes('Compiling')) {
    updateStatus('COMPILING', 'COMPILING CUDA KERNELS', 'sm_89 target — RTX 4090', 'warning');
  } else if (line.startsWith('[codegen]') && line.includes('Instruction')) {
    updateStatus('COMPILING', 'CODE GENERATION (x86_64)', 'SelectionDAG → MachineInstr lowering...', 'warning');
  } else if (line.startsWith('[linker]') && line.includes('Linking')) {
    updateStatus('COMPILING', 'LINKING FINAL BINARY', 'LTO pass running — merging 892 modules...', 'warning');
  } else if (line.startsWith('[strip]')) {
    updateStatus('COMPILING', 'STRIPPING DEBUG SYMBOLS', 'Finalizing binary...', 'normal');
  }
}

function _updateBottleneckStatus() {
  const needed = Math.max(0, Math.round(BOTTLENECK_RELEASE - currentEnergy));
  updateStatus(
    'BOTTLENECK',
    'CRITICAL BOTTLENECK: L3 THERMAL LOCKOUT',
    `INSUFFICIENT CLUSTER COMPUTE — NEED ${needed} MORE ACOUSTIC UNITS (SCREAM LOUDER)`,
    'bottleneck'
  );
}

// ─── TERMINAL RENDERING ──────────────────────────────────────────────────
function emitTerminalLine(text, cls = 'normal') {
  if (!terminalBody) return;

  const line = document.createElement('div');
  line.className = 'term-line term-' + cls;

  if (cls === 'blank') {
    line.innerHTML = '&nbsp;';
  } else {
    line.textContent = text;
  }

  terminalBody.appendChild(line);
  terminalBody.scrollTop = terminalBody.scrollHeight;

  // Update line counter in terminal header
  const counter = document.getElementById('terminal-lines-count');
  if (counter) counter.textContent = terminalBody.children.length + ' lines';
}


// ─── PROGRESS BAR ────────────────────────────────────────────────────────
function _updateProgressBar() {
  const pct = LOG.length > 0
    ? Math.min((currentLineIndex / LOG.length) * 100, 100)
    : 0;

  if (progressFill) {
    progressFill.style.width = pct + '%';
    // Class-based color
    const cls = isBottlenecked ? 'bottleneck' : pct >= 100 ? 'complete' : '';
    progressFill.className = cls; // CSS uses #progress-fill selector + class
  }
  if (progressPct) {
    progressPct.textContent = pct.toFixed(1) + '%';
    progressPct.className   = isBottlenecked ? 'bottleneck'
                            : pct >= 95      ? 'complete'
                            : pct >= 65      ? 'warning'
                            : '';
  }

  // Tick marks
  const litCount = Math.round((pct / 100) * progressTicks.length);
  progressTicks.forEach((tick, i) => tick.classList.toggle('active', i < litCount));
}

// ─── STATUS BLOCK ─────────────────────────────────────────────────────────
function updateStatus(phase, message, sub, state) {
  const phaseEl = document.getElementById('status-phase');
  if (phaseEl)       phaseEl.textContent      = phase;
  if (statusMessage) {
    statusMessage.textContent = message;
    statusMessage.className   = state === 'bottleneck' ? 'bottleneck'
                              : state === 'warning'    ? 'warning'
                              : state === 'complete'   ? 'complete'
                              : '';
  }
  if (statusSub) statusSub.textContent = sub;
}

// ─── ACOUSTIC GAUGE ──────────────────────────────────────────────────────
function _updateAcousticGauge() {
  const pct = Math.min((currentEnergy / 150) * 100, 100);
  if (acousticFill) {
    acousticFill.style.width = pct + '%';
    acousticFill.className   = pct > 80 ? 'critical' : pct > 50 ? 'hot' : '';
  }
  if (acousticValue) acousticValue.textContent = Math.round(currentEnergy);
}

// ─── METRICS ─────────────────────────────────────────────────────────────
function _updateMetrics() {
  if (metricEnergy) metricEnergy.textContent = Math.round(currentEnergy);
  if (metricDelay) {
    const delay = isCompiling
      ? Math.max(MIN_LINE_DELAY_MS, BASE_LINE_DELAY_MS - currentEnergy * ENERGY_SPEED_FACTOR)
      : BASE_LINE_DELAY_MS;
    metricDelay.textContent = (delay / 1000).toFixed(2) + 's';
  }
}

// ─── WIN CONDITION ────────────────────────────────────────────────────────
async function _onCompileComplete() {
  if (isDetonated) return;
  isDetonated  = true;
  isCompiling  = false;
  clearInterval(tickHandle);

  emitTerminalLine('', 'blank');
  emitTerminalLine('>>> Binary deployed to production. Initiating reward protocol...', 'cmd');

  updateStatus('COMPLETE', 'COMPILATION SUCCESSFUL', 'Deploying payload to all nodes...', 'complete');
  addLog('ok', '✅ COMPILATION COMPLETE — broadcasting climax-trigger');

  if (progressPct) {
    progressPct.textContent = '100.0%';
    progressPct.className   = 'complete glitch-text';
  }

  try {
    await fetch('/api/detonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    addLog('ok', 'Detonate API → 200 OK');
  } catch (err) {
    addLog('warn', 'Detonate API failed — triggering locally: ' + err.message);
  }

  setTimeout(_triggerHostClimax, 600);
}

function _triggerHostClimax() {
  if (!videoOverlay) return;
  videoOverlay.classList.add('active');
  if (climaxVideo && climaxVideo.getAttribute('src')) {
    climaxVideo.currentTime = 0;
    climaxVideo.volume      = 1.0;
    climaxVideo.play().catch(() => _activateIframe());
  } else {
    _activateIframe();
  }
}

function _activateIframe() {
  if (!climaxIframe) return;
  climaxIframe.src = 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=0&controls=1&loop=1&playlist=dQw4w9WgXcQ&rel=0';
  if (climaxVideo) climaxVideo.style.display = 'none';
}

// ─── FAILSAFE KEYBINDS ────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.code) {
    case 'Space':
    case 'ArrowRight':
      e.preventDefault();
      if (!isCompiling || isDetonated) return;
      // Skip forward 8 lines
      for (let i = 0; i < 8 && currentLineIndex < LOG.length; i++) {
        _emitNextLine();
      }
      isBottlenecked = false;
      addLog('warn', '⚡ FAILSAFE: skipped 8 lines');
      _updateProgressBar();
      break;

    case 'KeyR':
      if (isDetonated) return;
      if (!isCompiling) startCompile();
      addLog('warn', '🚀 FAILSAFE: KeyR — forcing completion');
      // Emit all remaining lines instantly
      while (currentLineIndex < LOG.length) _emitNextLine();
      isBottlenecked = false;
      _updateProgressBar();
      if (!isDetonated) _onCompileComplete();
      break;

    case 'Escape':
      if (videoOverlay?.classList.contains('active')) {
        videoOverlay.classList.remove('active');
        if (climaxIframe) climaxIframe.src = '';
        if (climaxVideo) climaxVideo.pause();
        addLog('info', 'ESC: overlay closed');
      }
      break;
  }
});

// ─── LOG SYSTEM ────────────────────────────────────────────────────────
const MAX_LOG = 8;
function addLog(level, message) {
  const logEntries = document.getElementById('log-entries');
  if (!logEntries) return;
  const time   = new Date().toTimeString().slice(0, 8);
  const tags   = { info: '[INFO]', ok: '[ OK ]', warn: '[WARN]', err: '[ERR!]' };
  const el     = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = `<span class="log-ts">${time}</span><span class="log-tag ${level}">${tags[level] || '[----]'}</span><span class="log-msg">${message}</span>`;
  logEntries.appendChild(el);
  while (logEntries.children.length > MAX_LOG) logEntries.removeChild(logEntries.firstChild);
  logEntries.scrollTop = logEntries.scrollHeight;
}

// ─── CLOCK ─────────────────────────────────────────────────────────────
function updateClock() {
  if (headerTime) {
    headerTime.textContent = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  updateClock();
  addLog('info', 'VOCE CLUSTER v2.0.26 — HOST ORCHESTRATOR ONLINE');
  addLog('info', 'Biological Kinetic Dissipation module loaded');
  addLog('info', `Compile log: ${LOG.length} lines buffered`);

  await initSession();

  tickHandle = setInterval(tick, TICK_RATE_MS);
  addLog('ok', 'Engine tick started — 30 FPS');
  addLog('info', 'Awaiting audience nodes...');
  addLog('info', 'Press [START COMPILE] when room is ready');
});
