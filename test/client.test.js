// -----------------------------------------------------------------------------
// The client: API version detection (4, else 3), HTTP Basic credentials, the
// plugins disabled on the server left out, and every error sorted by kind,
// the way the connection status and the scene events need it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, GlancesClient, REDETECT_AFTER_MS } from '../src/glances/client.js';
import { FakeGlances, PASSWORD, createNetwork } from './helpers/fakeGlances.js';

const URL = 'http://192.0.2.10:61208';

function client(glances, options = {}) {
  const network = createNetwork({ [URL]: glances });
  const calls = [];
  const request = (url, init) => {
    calls.push({ url, init });
    return network.request(url, init);
  };
  return Object.assign(new GlancesClient({ url: URL, request, ...options }), { calls });
}

const rejectsWith = (promise, kind) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.kind, kind);
    assert.ok(!err.message.includes(PASSWORD), 'the password never reaches a message');
    return true;
  });

test('detects a Glances 4 and reads its plugins, never /all', async () => {
  const glances = new FakeGlances();
  const read = await client(glances).read();
  assert.equal(read.apiVersion, 4);
  assert.equal(read.static.version, '4.5.8');
  assert.equal(read.static.system.hostname, 'nas');
  assert.deepEqual(Object.keys(read.data).sort(), [
    'containers',
    'cpu',
    'fs',
    'load',
    'mem',
    'memswap',
    'network',
    'sensors',
    'uptime',
  ]);
  assert.ok(!glances.requests.some((path) => path.endsWith('/all')));
  assert.ok(!glances.requests.some((path) => path.endsWith('/processlist')));
});

test('falls back to the API v3 of a Glances 3', async () => {
  const glances = new FakeGlances({ version: 3 });
  const read = await client(glances).read();
  assert.equal(read.apiVersion, 3);
  assert.equal(read.static.version, undefined, 'Glances 3 has no version plugin');
  assert.deepEqual(glances.requests.slice(0, 2), ['/api/4/pluginslist', '/api/3/pluginslist']);
});

test('detects once, then reads the plugins only, until the hour is over', async () => {
  const glances = new FakeGlances();
  let now = 0;
  const glancesClient = client(glances, { now: () => now });
  await glancesClient.read();
  const first = glances.requests.length;
  await glancesClient.read();
  assert.equal(glances.requests.length - first, 9, 'one request per plugin');
  now += REDETECT_AFTER_MS;
  await glancesClient.read();
  assert.ok(glances.requests.slice(first + 9).includes('/api/4/pluginslist'));
});

test('a plugin disabled on the server is not read', async () => {
  const glances = new FakeGlances();
  glances.disable('sensors', 'containers');
  const read = await client(glances).read();
  assert.equal(read.data.sensors, undefined);
  assert.equal(read.data.containers, undefined);
  assert.ok(!glances.requests.includes('/api/4/sensors'));
});

test('Glances upgraded from 3 to 4 in place: detected again within the same read', async () => {
  const glances = new FakeGlances({ version: 3 });
  const glancesClient = client(glances);
  await glancesClient.read();
  Object.assign(glances, new FakeGlances({ version: 4 }), { requests: glances.requests });
  const read = await glancesClient.read();
  assert.equal(read.apiVersion, 4);
});

test('sends the user name and the password in HTTP Basic', async () => {
  const glances = new FakeGlances({ password: PASSWORD });
  const glancesClient = client(glances, { password: PASSWORD });
  await glancesClient.read();
  const header = glancesClient.calls[0].init.headers.authorization;
  assert.equal(
    Buffer.from(header.replace('Basic ', ''), 'base64').toString(),
    `glances:${PASSWORD}`,
  );
});

test('another user name, set with --username', async () => {
  const glances = new FakeGlances({ password: PASSWORD, username: 'admin' });
  await client(glances, { username: 'admin', password: PASSWORD }).read();
  await rejectsWith(client(glances, { password: PASSWORD }).read(), ERROR_KINDS.AUTH);
});

test('no Authorization header without a password', async () => {
  const glancesClient = client(new FakeGlances());
  await glancesClient.read();
  assert.equal(glancesClient.calls[0].init.headers.authorization, undefined);
});

test('a wrong password, and a missing one, are told apart', async () => {
  const glances = new FakeGlances({ password: PASSWORD });
  await rejectsWith(client(glances, { password: 'wrong' }).read(), ERROR_KINDS.AUTH);
  await rejectsWith(client(glances).read(), ERROR_KINDS.PASSWORD_MISSING);
});

test('every failure has its kind', async () => {
  const glances = new FakeGlances();
  glances.failure = 'down';
  await rejectsWith(client(glances).read(), ERROR_KINDS.UNREACHABLE);
  glances.failure = 'html';
  await rejectsWith(client(glances).read(), ERROR_KINDS.NOT_GLANCES);
  glances.failure = 'redirect';
  await rejectsWith(client(glances).read(), ERROR_KINDS.REDIRECT);
  glances.failure = 500;
  await rejectsWith(client(glances).read(), ERROR_KINDS.HTTP);
  glances.failure = 404;
  await rejectsWith(client(glances).read(), ERROR_KINDS.NOT_GLANCES);
});

test('a refused certificate is a TLS error, a timeout is silence', async () => {
  const fail = (code) => async () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  await rejectsWith(
    new GlancesClient({ url: URL, request: fail('DEPTH_ZERO_SELF_SIGNED_CERT') }).read(),
    ERROR_KINDS.TLS,
  );
  await rejectsWith(
    new GlancesClient({ url: URL, request: fail('ETIMEDOUT') }).read(),
    ERROR_KINDS.UNREACHABLE,
  );
});

test('passes the self-signed option and a timeout to the transport', async () => {
  const glancesClient = client(new FakeGlances(), { insecure: true, timeoutMs: 1234 });
  await glancesClient.read();
  assert.equal(glancesClient.calls[0].init.insecure, true);
  assert.equal(glancesClient.calls[0].init.timeoutMs, 1234);
});
