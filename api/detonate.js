// api/detonate.js
// VOCE CLUSTER — Climax Detonation Broadcast Endpoint
// Fires the global "climax-trigger" event across all connected nodes
// Must complete under 150ms to avoid blocking the host UI

const Pusher = require('pusher');

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

  // Optional secret gate: set DETONATE_SECRET env var to protect endpoint
  const secret = process.env.DETONATE_SECRET;
  if (secret) {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (body?.secret !== secret) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
  }

  const triggeredAt = Date.now();

  try {
    const pusher = getPusher();

    // Race a timeout against the Pusher call to guarantee <150ms response
    const pushPromise = pusher.trigger('voce-cluster', 'climax-trigger', {
      triggeredAt,
      targetMedia: 'rickroll', // Could be extended to select different media
      message: 'COMPILATION COMPLETE — INITIATING DISTRIBUTED PAYLOAD DROP',
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 140)
    );

    await Promise.race([pushPromise, timeoutPromise]);

    return res.status(200).json({
      ok: true,
      triggeredAt,
      message: 'Climax trigger broadcast successful',
    });
  } catch (err) {
    // Even on timeout, return 200 — the Pusher call likely went through
    // The race is only to guarantee fast UI response
    if (err.message === 'timeout') {
      console.warn('[detonate] Pusher call exceeded 140ms — returning 200 optimistically');
      return res.status(200).json({
        ok: true,
        triggeredAt,
        message: 'Broadcast dispatched (optimistic)',
      });
    }
    console.error('[detonate] Pusher trigger failed:', err.message);
    return res.status(502).json({ error: 'Upstream broadcast failed' });
  }
};
