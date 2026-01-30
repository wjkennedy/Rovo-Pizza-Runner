// tests/index.test.js
jest.mock('@forge/api', () => {
  const store = new Map();
  return {
    fetch: jest.fn(),
    storage: {
      set: jest.fn(async (k, v) => store.set(k, v)),
      get: jest.fn(async (k) => store.get(k)),
      delete: jest.fn(async (k) => store.delete(k)),
    },
  };
});

const { fetch, storage } = require('@forge/api');
const handlers = require('../src/index');

function mkRes({ ok, status = 200, statusText = 'OK', json }) {
  return {
    ok,
    status,
    statusText,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(json),
  };
}

test('quotePizzaOrder: store-locator -> validate -> price -> stores token', async () => {
  fetch
    .mockResolvedValueOnce(mkRes({
      ok: true,
      json: { Stores: [{ StoreID: '3679', IsOnlineNow: true, IsOpen: true }] }
    }))
    .mockResolvedValueOnce(mkRes({
      ok: true,
      json: { Status: 0, Order: { StoreID: '3679', Products: [{ Code: '12SCREEN', Qty: 1 }] } }
    }))
    .mockResolvedValueOnce(mkRes({
      ok: true,
      json: { Order: { StoreID: '3679', ServiceMethod: 'Delivery', Products: [{ Code: '12SCREEN', Qty: 1 }], Amounts: { Customer: 12.34 } } }
    }));

  const out = await handlers.quotePizzaOrder({
    addressLine1: '93 Monitor St',
    city: 'Brooklyn',
    region: 'NY',
    postalCode: '11222',
    phone: '5551112222',
    email: 'test@example.com',
    itemsJson: JSON.stringify([{ Code: '12SCREEN', Qty: 1 }]),
    serviceMethod: 'DELIVERY'
  }, { accountId: 'abc' });

  expect(out.ok).toBe(true);
  expect(out.orderToken).toBeTruthy();
  expect(storage.set).toHaveBeenCalled();
});

test('placePizzaOrder: refuses without confirm', async () => {
  await expect(handlers.placePizzaOrder({ orderToken: 'x', confirm: false }))
    .rejects
    .toThrow(/confirm must be true/i);
});

