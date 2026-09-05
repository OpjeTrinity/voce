// api/pulse.js
// VOCE CLUSTER — Acoustic Pulse Ingestion Endpoint
// Receives volume payloads from audience nodes and broadcasts via Pusher

const Pusher = require('pusher');

// Lazy-initialize Pusher client to avoid cold-start overhead
let pusherClient = null;

function getPusher() {
  if (!pusherClient) {
    pusherClient = new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS: true,
    });
  }
  return pusherClient;
}

// Simple in-memory rate limiter (per cold instance)
// Limits to max 1 push per IP per 100ms window
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 100;

function isRateLimited(ip) {
  const now = Date.now();
  const last = rateLimitMap.get(ip) || 0;
  if (now - last < RATE_WINDOW_MS) return true;
  rateLimitMap.set(ip, now);
  // Clean old entries periodically to prevent memory leak
  if (rateLimitMap.size > 2000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v > 5000) rateLimitMap.delete(k);
    }
  }
  return false;
}

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Rate limiting
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Parse and validate payload
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const volume = parseFloat(body?.volume);

  // Validate: must be a finite number in range [0, 255]
  if (!Number.isFinite(volume) || volume < 0 || volume > 255) {
    return res.status(400).json({ error: 'Invalid volume payload. Must be float in [0, 255].' });
  }

  try {
    const pusher = getPusher();
    await pusher.trigger('voce-cluster', 'acoustic-pulse', {
      volume: Math.round(volume * 100) / 100, // Round to 2dp
      ts: Date.now(),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[pulse] Pusher trigger failed:', err.message);
    return res.status(502).json({ error: 'Upstream push failed' });
  }
};
