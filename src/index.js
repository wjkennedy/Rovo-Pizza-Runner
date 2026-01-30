// src/index.js
const { fetch, storage } = require('@forge/api');
const crypto = require('crypto');

const DOMINOS_BASE = 'https://order.dominos.com';

const MAX_MENU_RESULTS = 250; // keep responses small (Rovo action output limit)
const QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'UserError';
    this.details = details;
  }
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UserError(`${name} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function assertOptionalString(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

function normalizeServiceMethod(serviceMethod) {
  const raw = (serviceMethod || 'DELIVERY').toString().trim().toUpperCase();
  if (raw === 'DELIVERY') return 'Delivery';
  if (raw === 'CARRYOUT') return 'Carryout';
  // Domino sample uses "Delivery"/"Carryout"
  throw new UserError(`serviceMethod must be DELIVERY or CARRYOUT (got ${raw}).`);
}

function safeJsonParse(str, name) {
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new UserError(`${name} must be valid JSON.`, { error: String(e) });
  }
}

function buildStreetName(line1) {
  // Heuristic: remove leading house number and common unit markers.
  // Not perfect, but improves compatibility with Domino payloads.
  const s = line1.trim();
  const withoutNumber = s.replace(/^\s*\d+\s+/, '');
  const withoutUnit = withoutNumber.replace(/\s+(APT|APARTMENT|UNIT|STE|SUITE|#)\s*.*$/i, '').trim();
  return withoutUnit || s;
}

function buildAddress({ addressLine1, addressLine2, city, region, postalCode }) {
  const line1 = assertString(addressLine1, 'addressLine1');
  const line2 = assertOptionalString(addressLine2);

  const street = line2 ? `${line1} ${line2}` : line1;

  return {
    Street: street,
    StreetName: buildStreetName(line1),
    City: assertString(city, 'city').toUpperCase(),
    Region: assertString(region, 'region').toUpperCase(),
    PostalCode: assertString(postalCode, 'postalCode'),
    Type: line2 ? 'Apartment' : 'House',
  };
}

async function dominosFetchJson(path, { method = 'GET', query, body } = {}) {
  const url = new URL(DOMINOS_BASE + path);

  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers = { 'Accept': 'application/json' };
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // Simple retry/backoff for rate limits / transient errors
  const maxAttempts = 4;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url.toString(), { method, headers, body: payload });

    const text = await res.text();
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson && text ? safeJsonParse(text, 'Domino response') : (text || null);

    if (res.ok) return data;

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    lastErr = new Error(`Domino request failed: ${res.status} ${res.statusText}`);
    lastErr.status = res.status;
    lastErr.data = data;

    if (!retryable || attempt === maxAttempts) break;

    // exponential backoff with jitter
    const base = 250 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    await new Promise(r => setTimeout(r, base + jitter));
  }

  throw lastErr;
}

async function findBestStore({ addressLine1, city, region, postalCode, serviceMethod }) {
  const type = serviceMethod === 'Delivery' ? 'Delivery' : 'Carryout';
  const c = `${city}, ${region} ${postalCode}`;

  // /power/store-locator?s=<street>&c=<city state zip>&type=Delivery|Carryout :contentReference[oaicite:3]{index=3}
  const data = await dominosFetchJson('/power/store-locator', {
    method: 'GET',
    query: { s: addressLine1, c, type }
  });

  const stores = Array.isArray(data?.Stores) ? data.Stores : [];
  if (!stores.length) {
    throw new UserError('No Domino’s stores found for that address.');
  }

  // Prefer online/open stores when those flags exist
  const best =
    stores.find(s => s?.IsOnlineNow && (s?.IsOpen || s?.ServiceIsOpen)) ||
    stores.find(s => s?.IsOnlineNow) ||
    stores[0];

  const storeId = String(best?.StoreID || best?.StoreId || '').trim();
  if (!storeId) throw new UserError('Could not determine a StoreID from store-locator response.');
  return { storeId, store: best };
}

function buildProducts(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new UserError('itemsJson must be a non-empty JSON array of product objects.');
  }

  const products = items.map((p, idx) => {
    if (!p || typeof p !== 'object') {
      throw new UserError(`itemsJson[${idx}] must be an object.`);
    }
    if (typeof p.Code !== 'string' || !p.Code.trim()) {
      throw new UserError(`itemsJson[${idx}].Code is required.`);
    }
    const qty = Number(p.Qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new UserError(`itemsJson[${idx}].Qty must be a positive number.`);
    }

    // Keep any advanced fields Domino supports (Options, etc.), but enforce ID/isNew
    return {
      ...p,
      Code: p.Code.trim(),
      Qty: Math.floor(qty),
      ID: p.ID ?? (idx + 1),
      isNew: p.isNew ?? false,
    };
  });

  return products;
}

function summarizeQuote(priced) {
  const order = priced?.Order || {};
  const products = Array.isArray(order.Products) ? order.Products : [];
  const amounts = order.Amounts || {};

  // Not every response includes a consistent amounts schema, so be defensive
  const total =
    amounts?.Customer ||
    amounts?.Payment ||
    amounts?.Order ||
    amounts?.Total ||
    amounts?.Amount ||
    priced?.Order?.Amounts?.Customer;

  return {
    storeId: order.StoreID,
    serviceMethod: order.ServiceMethod,
    items: products.map(p => ({ code: p.Code, qty: p.Qty })),
    totals: amounts,
    total: total ?? null,
  };
}

/**
 * Rovo action: get-dominos-menu
 */
module.exports.getDominosMenu = async function getDominosMenu(payload) {
  const storeId = assertString(payload?.storeId, 'storeId');
  const search = assertOptionalString(payload?.search);

  // /power/store/${storeId}/menu?lang=en&structured=true :contentReference[oaicite:4]{index=4}
  const menu = await dominosFetchJson(`/power/store/${encodeURIComponent(storeId)}/menu`, {
    method: 'GET',
    query: { lang: 'en', structured: 'true' }
  });

  // Menu payload can be huge; keep it small for Rovo output (5MB cap). :contentReference[oaicite:5]{index=5}
  // If no search, return just category names + a small sample.
  const allProducts = menu?.Products || menu?.products || {};
  const entries = Object.entries(allProducts);

  const needle = search ? search.toLowerCase() : null;

  const filtered = [];
  for (const [code, p] of entries) {
    const name = (p?.Name || p?.name || '').toString();
    const desc = (p?.Description || p?.description || '').toString();
    const hay = `${code} ${name} ${desc}`.toLowerCase();

    if (!needle || hay.includes(needle)) {
      filtered.push({
        code,
        name,
        description: desc || undefined,
        // Some menus include sizes/prices in different shapes; keep it generic:
        tags: p?.Tags || p?.tags || undefined,
      });
    }

    if (filtered.length >= MAX_MENU_RESULTS) break;
  }

  if (!search) {
    // Provide lightweight guidance to prompt a follow-up search
    const categoryKeys = Object.keys(menu?.Categories || menu?.categories || {}).slice(0, 50);
    return {
      storeId,
      note: 'Menu can be large. Provide a `search` term for better results.',
      categories: categoryKeys,
      sampleProducts: filtered.slice(0, 50),
    };
  }

  return {
    storeId,
    search,
    count: filtered.length,
    results: filtered,
    truncated: filtered.length >= MAX_MENU_RESULTS,
  };
};

/**
 * Rovo action: quote-pizza-order
 * Must: store-locator → validate-order → price-order :contentReference[oaicite:6]{index=6}
 */
module.exports.quotePizzaOrder = async function quotePizzaOrder(payload, context) {
  // Context has accountId (don’t trust LLM-provided IDs for auth decisions). :contentReference[oaicite:7]{index=7}
  void context;

  const serviceMethod = normalizeServiceMethod(payload?.serviceMethod);

  const address = buildAddress({
    addressLine1: payload?.addressLine1,
    addressLine2: payload?.addressLine2,
    city: payload?.city,
    region: payload?.region,
    postalCode: payload?.postalCode,
  });

  const phone = assertString(payload?.phone, 'phone');
  const email = assertString(payload?.email, 'email');

  const itemsJson = assertString(payload?.itemsJson, 'itemsJson');
  const items = safeJsonParse(itemsJson, 'itemsJson');
  const products = buildProducts(items);

  const { storeId, store } = await findBestStore({
    addressLine1: payload.addressLine1,
    city: payload.city,
    region: payload.region,
    postalCode: payload.postalCode,
    serviceMethod,
  });

  const orderPayload = {
    Order: {
      Address: address,
      Coupons: [],
      CustomerID: '',
      Email: email,
      Extension: '',
      FirstName: '',  // strongly consider adding inputs later
      LastName: '',   // strongly consider adding inputs later
      LanguageCode: 'en',
      OrderChannel: 'OLO',
      OrderID: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
      OrderMethod: 'Web',
      OrderTaker: null,
      Payments: [],
      Phone: phone,
      PhonePrefix: '',
      Products: products,
      ServiceMethod: serviceMethod,
      SourceOrganizationURI: 'order.dominos.com',
      StoreID: String(storeId),
      Tags: {},
      Version: '1.0',
      NoCombine: true,
      Partners: {},
      OrderInfoCollection: [],
    },
  };

  const validated = await dominosFetchJson('/power/validate-order', {
    method: 'POST',
    body: orderPayload,
  });

  // If validation provides error structure, surface it nicely
  if (validated?.Status && validated.Status !== 0 && validated.Status !== '0') {
    return {
      ok: false,
      step: 'validate-order',
      status: validated.Status,
      message: validated?.Message || 'Order validation failed.',
      details: validated,
    };
  }

  const priced = await dominosFetchJson('/power/price-order', {
    method: 'POST',
    body: validated, // usually safest to pass the validated object forward
  });

  const orderToken = crypto.randomUUID();

  // Store priced draft for the explicit-confirmation step
  await storage.set(`pizza:quote:${orderToken}`, {
    createdAt: Date.now(),
    storeId,
    serviceMethod,
    storeHint: { StoreID: store?.StoreID, Name: store?.Name, AddressDescription: store?.AddressDescription },
    pricedDraft: priced,
  });

  return {
    ok: true,
    orderToken,
    quote: summarizeQuote(priced),
    message:
      'Quote created. Present this summary to the user and only call place-pizza-order with confirm=true after explicit confirmation.',
  };
};

/**
 * Rovo action: place-pizza-order
 * Uses saved quote draft; refuses unless confirm === true
 */
module.exports.placePizzaOrder = async function placePizzaOrder(payload) {
  const orderToken = assertString(payload?.orderToken, 'orderToken');
  const confirm = payload?.confirm === true;

  if (!confirm) {
    throw new UserError('Refusing to place order: confirm must be true (explicit user confirmation required).');
  }

  const saved = await storage.get(`pizza:quote:${orderToken}`);
  if (!saved) throw new UserError('Unknown or expired orderToken. Please re-quote the order.');

  if (Date.now() - saved.createdAt > QUOTE_TTL_MS) {
    await storage.delete(`pizza:quote:${orderToken}`);
    throw new UserError('That quote has expired. Please re-quote the order.');
  }

  // Attempt to place the order
  const placed = await dominosFetchJson('/power/place-order', {
    method: 'POST',
    body: saved.pricedDraft, // Domino expects the full order payload :contentReference[oaicite:8]{index=8}
  });

  // Cleanup draft after attempt (success or not)
  await storage.delete(`pizza:quote:${orderToken}`);

  return {
    ok: true,
    result: placed,
    note:
      'If Domino’s rejects due to payment requirements, extend the schema to collect a supported payment method or switch to a handoff flow.',
  };
};

