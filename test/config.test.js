// -----------------------------------------------------------------------------
// Configuration: the address typed by the user, the three server slots, the
// defaults.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, hostOf, normalizeConfig, parseServerUrl } from '../src/config.js';

test('an address becomes a base URL, port 61208 by default', () => {
  assert.equal(parseServerUrl('192.0.2.10'), 'http://192.0.2.10:61208');
  assert.equal(parseServerUrl(' nas.lan '), 'http://nas.lan:61208');
  assert.equal(parseServerUrl('192.0.2.10:8080'), 'http://192.0.2.10:8080');
  assert.equal(parseServerUrl('http://192.0.2.10:61208/'), 'http://192.0.2.10:61208');
  assert.equal(parseServerUrl('http://nas.lan:61208/api/4/cpu'), 'http://nas.lan:61208');
  assert.equal(parseServerUrl('http://nas.lan:61208/#/'), 'http://nas.lan:61208');
  assert.equal(parseServerUrl('https://glances.example.com'), 'https://glances.example.com');
  assert.equal(
    parseServerUrl('https://example.com/glances/api/3'),
    'https://example.com/glances',
    'a reverse proxy sub-path is kept',
  );
});

test('an unusable address is refused, credentials in it too', () => {
  for (const raw of ['', '   ', 'ftp://nas', 'http://', 'http://user:pw@nas.lan', 42, null]) {
    assert.equal(parseServerUrl(raw), null, String(raw));
  }
});

test('the host shown to the user drops the scheme and the default port', () => {
  assert.equal(hostOf('http://192.0.2.10:61208'), '192.0.2.10');
  assert.equal(hostOf('http://192.0.2.10:8080'), '192.0.2.10:8080');
  assert.equal(hostOf('https://example.com/glances'), 'example.com/glances');
});

test('the defaults: no server, 30 seconds, French names', () => {
  const config = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(config.servers, []);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowSelfSigned, false);
  assert.deepEqual(normalizeConfig(undefined).servers, []);
});

test('three slots, the empty ones skipped, the invalid ones reported', () => {
  const config = normalizeConfig({
    server_1_url: '192.0.2.10',
    server_1_password: 'secret\n',
    server_1_name: '  NAS  ',
    server_2_url: 'ftp://nope',
    server_3_url: 'https://198.51.100.20',
    server_3_username: 'admin',
    poll_interval: '120',
    allow_self_signed: true,
    language: 'de',
  });
  assert.deepEqual(config.servers, [
    {
      slot: 1,
      url: 'http://192.0.2.10:61208',
      username: 'glances',
      password: 'secret',
      name: 'NAS',
    },
    {
      slot: 3,
      url: 'https://198.51.100.20',
      username: 'admin',
      password: '',
      name: null,
    },
  ]);
  assert.deepEqual(config.invalidSlots, [2]);
  assert.equal(config.pollIntervalMs, 120_000);
  assert.equal(config.allowSelfSigned, true);
  assert.equal(config.language, 'de');
});

test('a value outside the lists falls back to the default', () => {
  const config = normalizeConfig({ poll_interval: '7', language: 'it' });
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.language, 'fr');
});

test('a long name is cut, spaces inside a password are kept', () => {
  const config = normalizeConfig({
    server_1_url: 'nas',
    server_1_name: 'x'.repeat(80),
    server_1_password: ' a b ',
  });
  assert.equal(config.servers[0].name.length, 40);
  assert.equal(config.servers[0].password, ' a b ');
});
