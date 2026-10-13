// -----------------------------------------------------------------------------
// "State of a server": every figure as an output, the summary for a message,
// an unreachable server answered rather than failed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TYPES } from '../src/devices.js';
import { summarize } from '../src/scenes.js';
import { FakeGlances, URL_1, createClock, createWorld, deviceId } from './helpers/world.js';

const { SERVER, DISK, CONTAINER } = DEVICE_TYPES;

async function world(options = {}) {
  const glances = options.glances ?? new FakeGlances();
  const created = await createWorld({ servers: { [URL_1]: glances }, ...options });
  return { ...created, glances };
}

test('every figure of the server, from the server device', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const ack = await w.fake.sceneAction('get_server_status', { server: deviceId(w.gladys, SERVER) });
  assert.equal(ack.success, true, ack.error);
  const { outputs } = ack.data;
  assert.equal(outputs.name, 'NAS');
  assert.equal(outputs.online, true);
  assert.equal(outputs.cpu, 31.7);
  assert.equal(outputs.swap, 100);
  assert.equal(outputs.load_1, 2.05);
  assert.equal(outputs.uptime_days, 4.2);
  assert.equal(outputs.disk_percent, 80.8);
  assert.equal(outputs.disk_free_gb, 85.2);
  assert.equal(outputs.temperature, 86);
  assert.equal(outputs.containers_running, 3);
  assert.equal(outputs.containers_stopped, 0);
  assert.equal(
    outputs.summary,
    'NAS: CPU 32%, memory 73%, disk /srv/media 81% (85 GB free), 86 °C, 3 container(s) running',
  );
});

test('any device of the server will do, a disk or a container', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  for (const id of [
    deviceId(w.gladys, DISK, '/mnt/data'),
    deviceId(w.gladys, CONTAINER, 'mariadb'),
  ]) {
    const ack = await w.fake.sceneAction('get_server_status', { server: id });
    assert.equal(ack.data.outputs.name, 'NAS');
  }
});

test('the summary in French, with the stopped containers', async (t) => {
  const glances = new FakeGlances();
  const w = await world({ glances, config: { server_1_url: '192.0.2.10', language: 'fr' } });
  t.after(() => w.app.stop());
  glances.setContainer('jellyfin', null);
  await w.hub.pollAll();
  await w.hub.pollAll();
  const ack = await w.fake.sceneAction('get_server_status', { server: deviceId(w.gladys, SERVER) });
  assert.equal(
    ack.data.outputs.summary,
    'nas : processeur 32 %, mémoire 73 %, disque /srv/media 81 % (85 Go libres), 86 °C, 2 conteneur(s) en marche, arrêtés : jellyfin',
  );
  assert.equal(ack.data.outputs.containers_stopped, 1);
});

test('an unreachable server is an answer: online false, the reason in the summary', async (t) => {
  const glances = new FakeGlances();
  const clock = createClock();
  const w = await world({ glances, clock, config: { server_1_url: '192.0.2.10', language: 'de' } });
  t.after(() => w.app.stop());
  glances.failure = 'down';
  clock.advance(15_000);
  const ack = await w.fake.sceneAction('get_server_status', { server: deviceId(w.gladys, SERVER) });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, {
    name: 'nas',
    online: false,
    summary: 'nas: antwortet nicht (läuft „glances -w“?)',
  });
});

test('reads Glances again when the last read is older than 15 seconds', async (t) => {
  const clock = createClock();
  const glances = new FakeGlances();
  const w = await world({ glances, clock });
  t.after(() => w.app.stop());
  const server = deviceId(w.gladys, SERVER);
  const count = glances.requests.length;
  await w.fake.sceneAction('get_server_status', { server });
  assert.equal(glances.requests.length, count, 'fresh enough');
  clock.advance(15_000);
  glances.plugins.cpu.total = 77;
  const ack = await w.fake.sceneAction('get_server_status', { server });
  assert.equal(ack.data.outputs.cpu, 77);
});

test('a device of another integration, or no server at all, fails clearly', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const ack = await w.fake.sceneAction('get_server_status', { server: 'ext:other:thing:1' });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'This device does not belong to a configured Glances server.');
  const empty = await createWorld({ config: { language: 'es' } });
  t.after(() => empty.app.stop());
  const none = await empty.fake.sceneAction('get_server_status', { server: 'x' });
  assert.equal(none.error, 'No hay ningún servidor Glances configurado.');
});

test('the summary leaves out what Glances does not measure', () => {
  const view = {
    name: 'PC',
    online: true,
    error: null,
    disk: null,
    stopped: [],
    snapshot: { cpu: 5, memory: null, sensors: [], containers: null },
  };
  assert.equal(summarize(view, 'es'), 'PC: procesador 5 %');
});
