// api/session.js
// VOCE CLUSTER v2 — Session Factory
// Creates a unique session room; returns sessionId, Pusher channel, and join URL

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Generate a 6-char alphanumeric session ID
  const sessionId = Math.random().toString(36).slice(2, 8).toUpperCase();

  // Derive the public origin for the join URL
  // x-forwarded-host is set by Vercel for deployed functions
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const origin = `${proto}://${host}`;

  return res.status(200).json({
    sessionId,
    channel: `voce-${sessionId}`,
    joinUrl: `${origin}/join/${sessionId}`,
  });
};
