// api/detonate.js
// VOCE CLUSTER v2 — Climax Detonation (Session-Aware)

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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const sessionId  = (body?.sessionId || 'GLOBAL').toString().trim().toUpperCase().slice(0, 12);
  const channel    = `voce-${sessionId}`;
  const triggeredAt = Date.now();

  try {
    const pushPromise = getPusher().trigger(channel, 'climax-trigger', {
      triggeredAt,
      message: 'COMPILATION COMPLETE — INITIATING DISTRIBUTED PAYLOAD DROP',
    });

    // Race against 140ms to guarantee fast host response
    await Promise.race([
      pushPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 140)),
    ]);

    return res.status(200).json({ ok: true, triggeredAt, channel });
  } catch (err) {
    if (err.message === 'timeout') {
      console.warn('[detonate] Optimistic 200 — push may still succeed');
      return res.status(200).json({ ok: true, triggeredAt, optimistic: true });
    }
    console.error('[detonate] Failed:', err.message);
    return res.status(502).json({ error: 'Broadcast failed' });
  }
};
