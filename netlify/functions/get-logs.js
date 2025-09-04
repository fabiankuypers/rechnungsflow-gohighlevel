// Netlify Function: get-logs
// Aufgabe: Liefert aktuelle Logs aus Upstash Redis für das Admin-Cockpit.
// Optionaler Schutz per ADMIN_API_KEY (x-admin-key Header), wenn ENV gesetzt ist.

const { Redis } = require('@upstash/redis');

const {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  ADMIN_API_KEY, // optional: nur prüfen, wenn gesetzt
} = process.env;

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  // CORS Preflight (optional)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-api-key',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
      },
    };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Optionales Admin-Auth (nur wenn ADMIN_API_KEY gesetzt)
  const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (ADMIN_API_KEY && headerKey !== ADMIN_API_KEY) {
    return json(401, { error: 'Unauthorized' });
  }

  const params = event.queryStringParameters || {};
  const limit = Math.max(1, Math.min(parseInt(params.limit || '100', 10) || 100, 500));
  const filterAgencyId = params.agencyId || null;
  const filterTxnId = params.transactionId || null;

  try {
    // Wir lesen die letzten 500 Einträge (für Filtern) und schneiden dann auf 'limit' zu
    const raw = await redis.lrange('invoice_logs', 0, 499);
    const entries = (raw || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    const filtered = entries.filter((e) => {
      if (filterAgencyId && e.agencyId !== filterAgencyId) return false;
      if (filterTxnId && e.transactionId !== filterTxnId) return false;
      return true;
    });

    return json(200, { logs: filtered.slice(0, limit) });
  } catch (e) {
    return json(500, { error: 'Failed to fetch logs', details: e.message });
  }
};

