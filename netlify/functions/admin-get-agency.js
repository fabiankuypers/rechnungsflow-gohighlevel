// Admin Function: admin-get-agency
// Purpose: Fetch an agency configuration from Redis.
// Security: Requires header x-admin-key == process.env.ADMIN_API_KEY.
// Query: ?agencyId=ACME[&includeSecrets=true]

const { Redis } = require('@upstash/redis');

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_API_KEY } = process.env;

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-admin-key', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!ADMIN_API_KEY) return json(500, { error: 'Server misconfiguration (ADMIN_API_KEY missing)' });

  const key = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (key !== ADMIN_API_KEY) return json(401, { error: 'Unauthorized' });

  const qs = event.queryStringParameters || {};
  const agencyId = qs.agencyId || '';
  const includeSecrets = String(qs.includeSecrets || 'false').toLowerCase() === 'true';
  if (!agencyId) return json(400, { error: 'agencyId required' });

  try {
    const cfg = await redis.hgetall(`agency:${agencyId}`);
    if (!cfg || Object.keys(cfg).length === 0) return json(404, { error: 'Not found' });
    const out = { ...cfg };
    if (!includeSecrets && out.ghl_api_key) out.ghl_api_key = '••••••••';
    out.has_ghl_key = !!cfg.ghl_api_key;
    return json(200, { agencyId, config: out });
  } catch (e) {
    return json(500, { error: 'Failed to fetch agency', details: e.message });
  }
};

