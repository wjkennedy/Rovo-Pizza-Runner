import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory mocks
const responses = new Map();
const memStore = new Map();

globalThis.__setMockResponse = (url, data) => responses.set(url, data);

const mockApi = {
  fetch: async (url, opts) => {
    if (!responses.has(url)) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'not mocked', url }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responses.get(url)),
    };
  },
};

const mockStorage = {
  get: async (k) => memStore.get(k),
  set: async (k, v) => memStore.set(k, v),
  delete: async (k) => memStore.delete(k),
};

// ESM module load hook for @forge/api
await import('node:module').then(({ createRequire }) => {
  const require = createRequire(import.meta.url);
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@forge/api') {
      return {
        default: mockApi,
        storage: mockStorage,
      };
    }
    return originalLoad.apply(this, arguments);
  };
});

const { getDominosMenu, quotePizzaOrder, placePizzaOrder } = await import('../src/index.js');

test('placePizzaOrder blocks without confirm=true', async () => {
  const res = await placePizzaOrder({ orderToken: 'x', confirm: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'CONFIRMATION_REQUIRED');
});

test('getDominosMenu returns filtered codes', async () => {
  const base = 'https://order.dominos.com';
  __setMockResponse(`${base}/power/store/123/menu?lang=en&structured=true`, {
    Products: [
      { Code: '14SCREEN', Name: 'Large Hand Tossed Pizza' },
      { Code: '12SCREEN', Name: 'Medium Hand Tossed Pizza' }
    ]
  });

  const res = await getDominosMenu({ storeId: '123', search: 'large' });
  assert.equal(res.ok, true);
  assert.equal(res.products.length, 1);
  assert.equal(res.products[0].code, '14SCREEN');
});

test('quotePizzaOrder stores token and placePizzaOrder uses it', async () => {
  const base = 'https://order.dominos.com';

  // Store locator
  const locatorUrl =
    `${base}/power/store-locator?` +
    `s=${encodeURIComponent('1 Main St')}&` +
    `c=${encodeURIComponent('New York, NY 10001')}&` +
    `type=${encodeURIComponent('Delivery')}`;

  __setMockResponse(locatorUrl, { Stores: [{ StoreID: '123', Name: 'Test Store' }] });

  // Menu (must include the code we order)
  __setMockResponse(`${base}/power/store/123/menu?lang=en&structured=true`, {
    Products: [{ Code: '14SCREEN', Name: 'Large Hand Tossed Pizza' }]
  });

  // Validate + price + place
  __setMockResponse(`${base}/power/validate-order`, { Order: { Errors: [] } });
  __setMockResponse(`${base}/power/price-order`, { Order: { Amounts: { Customer: 19.99, Currency: 'USD' } } });
  __setMockResponse(`${base}/power/place-order`, { OrderID: 'ABC123' });

  const quote = await quotePizzaOrder({
    addressLine1: '1 Main St',
    addressLine2: '',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    phone: '2125551212',
    email: 'test@example.com',
    itemsJson: JSON.stringify([{ Code: '14SCREEN', Qty: 1 }]),
    serviceMethod: 'DELIVERY'
  });

  assert.equal(quote.ok, true);
  assert.ok(quote.orderToken);
  assert.equal(quote.estimatedTotal, 19.99);

  const placed = await placePizzaOrder({ orderToken: quote.orderToken, confirm: true });
  assert.equal(placed.ok, true);
  assert.equal(placed.confirmation.orderId, 'ABC123');
});

