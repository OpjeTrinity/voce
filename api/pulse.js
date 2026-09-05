// api/pulse.js
// VOCE CLUSTER v2 — Acoustic Pulse Ingestion (Session-Aware)

const Pusher = require('pusher');

let pusherClient = null;
function getPusher() {
  if (!pusherClient) {
    pusherClient = new Pusher({
      appId:   process.env.PUSHER_APP_ID,
      key:     process.env.PUSHER_KEY,
      secret:  process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS:  true,
    });
  }
  return pusherClient;
}

// Simple per-IP rate limiter (100ms window)
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const last = rateLimitMap.get(ip) || 0;
  if (now - last < 100) return true;
  rateLimitMap.set(ip, now);
  if (rateLimitMap.size > 2000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v > 5000) rateLimitMap.delete(k);
    }
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Rate limited' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const volume    = parseFloat(body?.volume);
  const sessionId = (body?.sessionId || 'GLOBAL').toString().trim().toUpperCase().slice(0, 12);

  if (!Number.isFinite(volume) || volume < 0 || volume > 255) {
    return res.status(400).json({ error: 'Invalid volume. Must be float in [0, 255].' });
  }

  // Route to the session-specific channel
  const channel = `voce-${sessionId}`;

  try {
    await getPusher().trigger(channel, 'acoustic-pulse', {
      volume: Math.round(volume * 100) / 100,
      ts:     Date.now(),
    });
    return res.status(200).json({ ok: true, channel });
  } catch (err) {
    console.error('[pulse] Pusher trigger failed:', err.message);
    return res.status(502).json({ error: 'Upstream push failed' });
  }
};
