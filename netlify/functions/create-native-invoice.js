// Netlify Function: create-native-invoice
// Aufgabe: Entgegennimmt mandantenfähige Rechnungsdaten, generiert eine fortlaufende
// Rechnungsnummer aus Redis und legt über die GoHighLevel API (LeadConnector) eine
// native Rechnung an. Erfolgs- und Fehlzustände werden in Upstash Redis geloggt.
//
// Abhängigkeiten: @upstash/redis, axios, zod
//
// Sicherheit:
// - Nur POST-Requests (x-api-key im Header muss mit process.env.MY_INVOICE_API_KEY übereinstimmen)
// - Greift für jede Agency (mandantenfähig) auf Hash "agency:[agencyId]" zu:
//   - HGETALL agency:[agencyId] (Konfiguration prüfen, u.a. invoice_format)
//   - HINCRBY agency:[agencyId] invoice_counter 1 (fortlaufende Nummer)
// Logging:
// - LPUSH invoice_logs (letzte 500 Einträge gehalten)
// - Fehlerzähler pro (agencyId + transactionId), nach 5 Fehlern -> "Poison Pill" (429)

const axios = require('axios');
const { z } = require('zod');
const { Redis } = require('@upstash/redis');

// --- Environment Variablen ---
const {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  MY_INVOICE_API_KEY, // Erwartet im Header: x-api-key
  GHL_API_KEY, // Bearer Token für GoHighLevel (LeadConnector) API
} = process.env;

// --- Redis Client (Upstash REST) ---
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// --- Zod Schemas für Validierung ---
const RecipientSchema = z
  .object({
    name: z.string().optional(),
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
  })
  .optional();

const ItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().int().nonnegative(), // in Cent
});

const PayloadSchema = z.object({
  agencyId: z.string().min(1),
  locationId: z.string().min(1), // Pflichtfeld für GHL
  contactId: z.string().min(1), // Pflichtfeld für GHL
  transactionId: z.string().min(1),
  isSmallBusiness: z.boolean().default(false),
  recipient: RecipientSchema, // nur für Logging
  items: z.array(ItemSchema).min(1),
});

// --- Hilfsfunktionen ---
const ok = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const error = (statusCode, message, extra) => ok(statusCode, { error: message, ...(extra || {}) });

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// Formatierung der Rechnungsnummer mit Platzhaltern:
// {YYYY}, {YY}, {MM}, {DD}, {counter} oder {counter:N} für Zero-Padding.
function formatInvoiceNumber(template, counter) {
  const now = new Date();
  const pad = (n, w = 1) => String(n).padStart(w, '0');
  const tokens = {
    '{YYYY}': String(now.getFullYear()),
    '{YY}': String(now.getFullYear()).slice(-2),
    '{MM}': pad(now.getMonth() + 1, 2),
    '{DD}': pad(now.getDate(), 2),
  };

  let result = template || 'INV-{YYYY}-{counter:5}';
  for (const [k, v] of Object.entries(tokens)) {
    result = result.split(k).join(v);
  }
  const counterRe = /\{counter(?::(\d+))?\}/g;
  result = result.replace(counterRe, (_m, w) => pad(counter, w ? parseInt(w, 10) : 1));

  // Falls Template keinen Counter enthält, hänge einen an (defensiv)
  if (!/{counter(?::\d+)?}/.test(template || '')) {
    result += `-${pad(counter, 1)}`;
  }
  return result;
}

// Ein Log-Event in Redis ablegen (fehlerresistent, begrenzt auf 500 Einträge)
async function logEvent(level, message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  try {
    await redis.lpush('invoice_logs', JSON.stringify(entry));
    await redis.ltrim('invoice_logs', 0, 499);
  } catch (_) {
    // Logging darf keine Hauptlogik stören
  }
}

// Agency-Konfiguration holen (existiert sie nicht, ist das Objekt leer)
async function getAgencyConfig(agencyId) {
  const key = `agency:${agencyId}`;
  const cfg = await redis.hgetall(key);
  return cfg || {};
}

// Nächste Rechnungsnummer atomar ermitteln und nach Template formatieren
async function nextInvoiceNumber(agencyId, config) {
  const key = `agency:${agencyId}`;
  const counter = await redis.hincrby(key, 'invoice_counter', 1);
  const template = config.invoice_format || 'INV-{YYYY}-{counter:5}';
  return { counter, number: formatInvoiceNumber(template, counter) };
}

// Fehlerzähler erhöhen, Ablaufzeit 24h. Rückgabe: aktueller Zählerstand.
async function incTxnError(agencyId, transactionId) {
  const key = `txn_error_count:${agencyId}:${transactionId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 24 * 60 * 60);
  }
  return count;
}

exports.handler = async (event) => {
  // Nur POST zulassen
  if (event.httpMethod !== 'POST') {
    return error(405, 'Method Not Allowed');
  }

  // API-Key prüfen
  const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'] || event.headers['x-api_Key'];
  if (!MY_INVOICE_API_KEY || apiKey !== MY_INVOICE_API_KEY) {
    return error(401, 'Unauthorized');
  }

  // JSON-Body parsen
  const parsed = safeJsonParse(event.body || '');
  if (!parsed) {
    return error(400, 'Invalid JSON body');
  }

  // Payload validieren
  const result = PayloadSchema.safeParse(parsed);
  if (!result.success) {
    return error(400, 'Validation failed', { issues: result.error.issues });
  }

  const payload = result.data;
  const { agencyId, locationId, contactId, transactionId, isSmallBusiness, items } = payload;

  try {
    // Schritt 1: Agency-Konfiguration prüfen
    const config = await getAgencyConfig(agencyId);
    const hasConfig = config && Object.keys(config).length > 0;
    if (!hasConfig) {
      await logEvent('warn', 'Agency config missing', { agencyId, transactionId });
      return error(403, 'Forbidden: agency not configured');
    }

    // Schritt 2: Fortlaufende Rechnungsnummer ermitteln
    const { number: invoiceNumber, counter } = await nextInvoiceNumber(agencyId, config);

    // Schritt 3/4: Line Items mappen, globale Steuer setzen
    const lineItems = items.map((it) => ({
      description: it.description,
      qty: it.quantity,
      // Cent -> Float (2 Nachkommastellen)
      unit_price: Math.round((it.unitPrice / 100) * 100) / 100,
    }));

    const tax = isSmallBusiness
      ? { name: 'Umsatzsteuer', rate: 0, type: 'PERCENT' }
      : { name: '19% MwSt.', rate: 19, type: 'PERCENT' };

    const ghlPayload = {
      locationId,
      contactId,
      status: 'draft', // immer als Entwurf
      invoiceData: {
        items: lineItems,
        invoiceNumber,
        terms: '',
        notes: '',
        taxType: 'inclusive',
        tax, // globales Steuerobjekt
      },
    };

    const agencyGhlKey = (config.ghl_api_key && String(config.ghl_api_key)) || null;
    const effectiveGhlKey = agencyGhlKey || GHL_API_KEY;
    if (!effectiveGhlKey) {
      await logEvent('error', 'No GHL key configured (agency or env)', { agencyId, transactionId, invoiceNumber, counter });
      return error(500, 'Server misconfiguration');
    }

    // Schritt 5: GoHighLevel API aufrufen
    const url = 'https://services.leadconnectorhq.com/invoices/';
    let ghlRes;
    try {
      ghlRes = await axios.post(url, ghlPayload, {
        headers: {
          Authorization: `Bearer ${effectiveGhlKey}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 20000,
      });
    } catch (e) {
      const status = e.response?.status;
      const data = e.response?.data;
      const count = await incTxnError(agencyId, transactionId);
      const poison = count >= 5;
      await logEvent('error', 'Native invoice creation failed', {
        agencyId,
        transactionId,
        invoiceNumber,
        counter,
        httpStatus: status,
        response: data,
        error: e.message,
        poison,
        errorCount: count,
      });
      if (poison) {
        return error(429, 'Poison pill: too many failures for this transaction', { transactionId, errorCount: count });
      }
      return error(status || 502, 'Failed to create native invoice', { details: data });
    }

    // Schritt 6: Erfolg loggen
    const responseData = ghlRes.data || {};
    const ghlInvoiceId = responseData.id || responseData.invoiceId || responseData.data?.id || null;

    await logEvent('info', 'Native invoice created', {
      agencyId,
      transactionId,
      invoiceNumber,
      ghlInvoiceId,
      httpStatus: ghlRes.status,
      recipient: payload.recipient || null,
      keySource: agencyGhlKey ? 'agency' : 'env',
    });

    // Schritt 7: Antwort
    return ok(200, {
      status: 'ok',
      message: 'Native invoice created',
      invoiceId: ghlInvoiceId,
      invoiceNumber,
    });
  } catch (e) {
    // Catch-all
    await logEvent('error', 'Unhandled error in create-native-invoice', {
      agencyId: payload.agencyId,
      transactionId: payload.transactionId,
      error: e.message,
    });
    return error(500, 'Internal Server Error');
  }
};
