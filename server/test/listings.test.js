import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import app from '../src/app.js';
import { Listing } from '../src/models/Listing.js';
import { User } from '../src/models/User.js';

test('listing routes: CRUD, validation, and soft-delete visibility', async (t) => {
  // Exercise the real HTTP routes and validation without touching the course database.
  const documents = new Map();
  const seller = new User({ name: 'Test Seller', email: 'seller@example.com', password: 'test-password' });
  t.mock.method(User.collection, 'find', (filter, options) => {
    assert.deepEqual(options.projection, { name: 1, email: 1 });
    const found = filter._id.$in.some(id => id.toString() === seller.id);
    return { toArray: async () => found ? [{ _id: seller._id, name: seller.name, email: seller.email }] : [] };
  });
  const populateSeller = (docs, path, select) => Listing.populate(docs, { path, select });
  const matches = (doc, filter) =>
    (!filter._id || doc._id === filter._id) &&
    (!filter.status || doc.status !== filter.status.$ne);

  t.mock.method(Listing, 'create', async (value) => {
    const model = new Listing(value);
    await model.validate();
    const doc = { ...model.toObject(), _id: model._id.toString() };
    documents.set(doc._id, doc);
    return doc;
  });
  t.mock.method(Listing, 'find', (filter) => ({
    populate: (path, select) => ({
      sort: () => ({ lean: async () => populateSeller(
        [...documents.values()].filter(doc => matches(doc, filter)).map(doc => ({ ...doc })), path, select
      ) })
    })
  }));
  t.mock.method(Listing, 'findOne', (filter) => ({
    populate: async (path, select) => {
      const doc = [...documents.values()].find(doc => matches(doc, filter));
      return doc ? populateSeller({ ...doc }, path, select) : null;
    }
  }));
  t.mock.method(Listing, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(options.new, true);
    assert.equal(options.runValidators, true);
    const doc = [...documents.values()].find(doc => matches(doc, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return doc;
  });
  t.mock.method(Listing, 'findByIdAndUpdate', async (id, update, options) => {
    assert.equal(options.new, true);
    assert.equal(options.runValidators, true);
    const doc = documents.get(id);
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return doc;
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/listings`;
  async function request(method, path = '', body) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  assert.deepEqual((await request('GET')).body, { listings: [] });
  for (const body of [undefined, {}, { title: 'Book', price: -1 },
    { title: 'Book', price: 5, category: 'invalid' },
    { title: 'Book', price: 5, seller: 'invalid' }]) {
    assert.equal((await request('POST', '', body)).status, 400);
  }
  assert.equal(documents.size, 0);

  const created = await request('POST', '', { title: 'Book', price: 0 });
  assert.equal(created.status, 201);
  assert.equal(created.body.listing.status, 'active');
  const id = created.body.listing.id;
  assert.equal(typeof id, 'string');
  assert.equal(created.body.listing._id, undefined);
  assert.equal(created.body.listing.__v, undefined);
  assert.equal((await request('GET', `/${id}`)).body.listing.title, 'Book');
  assert.equal((await request('GET')).body.listings.length, 1);

  // Exercise real Mongoose population with a simulated users collection.
  assert.equal((await request('GET', `/${id}`)).body.listing.seller, undefined);
  await request('PATCH', `/${id}`, { seller: seller.id });
  const expectedSeller = { _id: seller.id, name: seller.name, email: seller.email };
  assert.deepEqual((await request('GET', `/${id}`)).body.listing.seller, expectedSeller);
  assert.deepEqual((await request('GET')).body.listings[0].seller, expectedSeller);
  await request('PATCH', `/${id}`, { seller: '507f1f77bcf86cd799439012' });
  assert.equal((await request('GET', `/${id}`)).body.listing.seller, null);
  assert.equal((await request('GET')).body.listings[0].seller, null);

  for (const body of [undefined, {}, { price: -1 }, { status: 'invalid' }, { unexpected: true }]) {
    assert.equal((await request('PATCH', `/${id}`, body)).status, 400);
  }
  const updated = await request('PATCH', `/${id}`, { price: 25, unexpected: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.listing.price, 25);
  assert.equal(updated.body.listing.title, 'Book');
  assert.equal(documents.get(id).unexpected, undefined);

  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const body = method === 'PATCH' ? { price: 10 } : undefined;
    assert.equal((await request(method, '/invalid', body)).status, 400);
    assert.equal((await request(method, '/507f1f77bcf86cd799439011', body)).status, 404);
  }

  assert.equal((await request('PATCH', '/invalid/sold')).status, 400);
  assert.equal((await request('PATCH', '/507f1f77bcf86cd799439011/sold')).status, 404);
  const sold = await request('PATCH', `/${id}/sold`);
  assert.equal(sold.status, 200);
  assert.equal(sold.body.listing.status, 'sold');
  assert.equal(sold.body.listing.price, 25);
  assert.equal(sold.body.listing.category, 'other');
  const soldAgain = await request('PATCH', `/${id}/sold`, { price: 999, category: 'electronics' });
  assert.equal(soldAgain.status, 200);
  assert.equal(soldAgain.body.listing.price, 25);
  assert.equal(soldAgain.body.listing.category, 'other');
  assert.equal((await request('GET', `/${id}`)).body.listing.status, 'sold');
  assert.equal((await request('GET')).body.listings.length, 1);

  const deleted = await request('DELETE', `/${id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true });
  assert.equal(documents.get(id).status, 'removed');
  assert.equal(documents.size, 1);
  assert.equal((await request('PATCH', `/${id}/sold`)).status, 404);
  assert.equal(documents.get(id).status, 'removed');
  assert.equal((await request('GET')).body.listings.length, 0);
  assert.equal((await request('GET', '?includeRemoved=false')).body.listings.length, 0);
  assert.equal((await request('GET', '?includeRemoved=true')).body.listings.length, 1);
  assert.equal((await request('GET', `/${id}`)).status, 404);
  assert.equal((await request('GET', `/${id}?includeRemoved=true`)).status, 200);
  assert.equal((await request('DELETE', `/${id}`)).status, 200);
});
