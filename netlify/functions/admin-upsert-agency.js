// Admin Function: admin-upsert-agency
// Purpose: Create or update an agency configuration in Redis.
// Security: Requires header x-admin-key == process.env.ADMIN_API_KEY.
// Body example:
// {
//   "agencyId": "ACME",
//   "invoice_format": "INV-{YYYY}-{counter:5}",
//   "invoice_counter": 0,
//   "ghl_api_key": "<LOCATION_OR_OAUTH_TOKEN>"
// }

const { z } = require('zod');
const { Redis } = require('@upstash/redis');

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_API_KEY } = process.env;

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const Schema = z.object({
  agencyId: z.string().min(1),
  invoice_format: z.string().min(1).optional(),
  invoice_counter: z.number().int().min(0).optional(),
  ghl_api_key: z.string().min(10).optional(),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-admin-key', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!ADMIN_API_KEY) return json(500, { error: 'Server misconfiguration (ADMIN_API_KEY missing)' });

  const key = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (key !== ADMIN_API_KEY) return json(401, { error: 'Unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return json(400, { error: 'Validation failed', issues: parsed.error.issues });

  const { agencyId, invoice_format, invoice_counter, ghl_api_key } = parsed.data;
  const redisKey = `agency:${agencyId}`;
  const fields = {};
  if (invoice_format !== undefined) fields.invoice_format = invoice_format;
  if (invoice_counter !== undefined) fields.invoice_counter = String(invoice_counter);
  if (ghl_api_key !== undefined) fields.ghl_api_key = ghl_api_key;

  if (Object.keys(fields).length === 0) return json(400, { error: 'No fields provided to update' });

  try {
    // HSET multiple fields
    await redis.hset(redisKey, fields);
    // Read back config (redact secrets)
    const cfg = await redis.hgetall(redisKey);
    if (cfg && cfg.ghl_api_key) cfg.ghl_api_key = '••••••••';
    return json(200, { status: 'ok', agencyId, config: cfg });
  } catch (e) {
    return json(500, { error: 'Failed to upsert agency', details: e.message });
  }
};

