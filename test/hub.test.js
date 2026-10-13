// -----------------------------------------------------------------------------
// The hub, end to end against the SDK's fake Gladys and fake Glances servers:
// discovery, states of the devices added (only the changes, the noisy values
// once a minute, the budget), scene events on transitions (disk steps,
// confirmed temperatures, stopped containers, unreachable server), what
// survives a restart, the connection status and the transport badges.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TYPES, FEATURE_KEYS } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  FakeGlances,
  PASSWORD,
  URL_1,
  URL_2,
  createClock,
  createDevices,
  createWorld,
  deviceId,
  featureId,
} from './helpers/world.js';

const { SERVER, DISK, NETWORK, SENSOR, CONTAINER } = DEVICE_TYPES;

const eventsOf = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const statesOf = (world, externalId) =>
  world.fake.states.filter((state) => state.device_feature_external_id === externalId);

async function nasWorld(options = {}) {
  const glances = options.glances ?? new FakeGlances();
  const world = await createWorld({ servers: { [URL_1]: glances }, ...options });
  return { ...world, glances };
}

test('discovers the server, its disks, interfaces, sensors and containers', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  const names = world.fake.discoveredDevices.map((device) => device.name);
  assert.deepEqual(names.slice(0, 5), [
    'NAS',
    'NAS /srv/media',
    'NAS /mnt/data',
    'NAS /srv/backup',
    'NAS eth0',
  ]);
  assert.ok(names.includes('NAS Package id 0'));
  assert.ok(names.includes('NAS nextcloud'));
  assert.ok(names.includes('NAS backup-job'), 'a stopped container listed with all=True');
  const server = world.fake.discoveredDevices[0];
  assert.equal(server.external_id, deviceId(world.gladys, SERVER));
  assert.equal(server.should_poll, false);
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.states.length, 0, 'nothing published before a device is added');
});

test('the server is named after Glances when no name is configured', async (t) => {
  const world = await nasWorld({ config: { server_1_url: '192.0.2.10' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices[0].name, 'nas');
});

test('a container id as host name (Glances in Docker): the address instead', async (t) => {
  const glances = new FakeGlances();
  glances.plugins.system.hostname = '49968bba0848';
  const world = await nasWorld({ glances, config: { server_1_url: '192.0.2.10' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices[0].name, '192.0.2.10');
});

test('a device added gets all its states at once, then only the changes', async (t) => {
  const clock = createClock();
  const world = await nasWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world);
  const cpu = featureId(world.gladys, SERVER, null, FEATURE_KEYS.CPU);
  const online = featureId(world.gladys, SERVER, null, FEATURE_KEYS.ONLINE);
  const free = featureId(world.gladys, DISK, '/mnt/data', FEATURE_KEYS.FREE);
  assert.equal(world.fake.lastState(cpu), 31.7);
  assert.equal(world.fake.lastState(online), 1);
  assert.equal(world.fake.lastState(free), 0.1, '64 MiB, in GB');
  assert.equal(
    world.fake.lastState(featureId(world.gladys, CONTAINER, 'jellyfin', FEATURE_KEYS.MEMORY)),
    1020,
  );
  assert.equal(
    world.fake.lastState(featureId(world.gladys, NETWORK, 'eth0', FEATURE_KEYS.RX)),
    Math.round(((world.glances.plugins.network[1].bytes_recv_rate_per_sec * 8) / 1e6) * 100) / 100,
  );

  const before = world.fake.states.length;
  clock.advance(30_000);
  await world.hub.pollAll();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');

  world.glances.setDisk('/mnt/data', 50);
  world.glances.plugins.cpu.total = 55.5;
  clock.advance(20_000);
  await world.hub.pollAll();
  assert.equal(
    world.fake.lastState(featureId(world.gladys, DISK, '/mnt/data', 'used_percent')),
    50,
  );
  assert.equal(statesOf(world, cpu).length, 1, 'the CPU moved, but less than a minute ago');
  clock.advance(10_000);
  await world.hub.pollAll();
  assert.equal(world.fake.lastState(cpu), 55.5, 'a minute later');
});

test('an unchanged value is sent again after 6 hours', async (t) => {
  const clock = createClock();
  const world = await nasWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world, (device) => device.name === 'NAS /mnt/data');
  const used = featureId(world.gladys, DISK, '/mnt/data', FEATURE_KEYS.USED_PERCENT);
  assert.equal(statesOf(world, used).length, 1);
  clock.advance(6 * 3600_000);
  await world.hub.pollAll();
  assert.equal(statesOf(world, used).length, 2);
});

test('the budget keeps the states per minute below the Gladys limit', async (t) => {
  const clock = createClock();
  const world = await nasWorld({ clock, timings: { statesPerMinute: 2 } });
  t.after(() => world.app.stop());
  await createDevices(world); // forced: a device just added is always sent
  const before = world.fake.states.length;
  world.glances.plugins.fs.forEach((disk) => {
    disk.percent = 42;
  });
  world.glances.plugins.cpu.total = 99;
  clock.advance(61_000);
  await world.hub.pollAll();
  const sent = world.fake.states.slice(before);
  assert.equal(sent.length, 2);
  assert.ok(
    sent.every((state) => state.device_feature_external_id.endsWith(':used_percent')),
    'the quiet values go first',
  );
  clock.advance(61_000);
  await world.hub.pollAll();
  assert.equal(world.fake.states.length - before, 4, 'the rest the next minute');
});

test('only the devices added receive states, and the server says offline when down', async (t) => {
  const clock = createClock();
  const world = await nasWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world, (device) => device.external_id === deviceId(world.gladys, SERVER));
  assert.ok(
    world.fake.states.every((state) => state.device_feature_external_id.includes(':server:')),
  );
  world.glances.failure = 'down';
  await world.hub.pollAll();
  const online = featureId(world.gladys, SERVER, null, FEATURE_KEYS.ONLINE);
  assert.equal(world.fake.lastState(online), 1, 'one failure is a blip');
  assert.equal(eventsOf(world, TRIGGERS.UNREACHABLE).length, 0);
  await world.hub.pollAll();
  assert.equal(world.fake.lastState(online), 0);
  const [event] = eventsOf(world, TRIGGERS.UNREACHABLE);
  assert.equal(event.data.server, deviceId(world.gladys, SERVER));
  assert.equal(event.data.server_name, 'NAS');
  assert.equal(event.data.error, 'does not answer (is "glances -w" running?)');
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.UNREACHABLE).length, 1, 'once per outage');
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(world.fake.connectionStatus.connected, false);

  world.glances.failure = null;
  await world.hub.pollAll();
  assert.equal(world.fake.lastState(online), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('a refused password is reported, not announced as unreachable', async (t) => {
  const glances = new FakeGlances({ password: PASSWORD });
  const world = await nasWorld({
    glances,
    config: { server_1_url: '192.0.2.10', server_1_password: 'wrong', language: 'fr' },
  });
  t.after(() => world.app.stop());
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.UNREACHABLE).length, 0);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(
    world.fake.connectionStatus.message.fr,
    "192.0.2.10 : nom d'utilisateur ou mot de passe refusé",
  );
  assert.ok(!JSON.stringify(world.fake.requests).includes('wrong'));
});

test('disk almost full: one event per step crossed, again after cleaning', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  world.glances.setDisk('/mnt/data', 86);
  await world.hub.pollAll();
  let events = eventsOf(world, TRIGGERS.DISK);
  assert.deepEqual(
    events.map((event) => event.data.threshold),
    [80, 85],
  );
  assert.deepEqual(events[1].data, {
    server: deviceId(world.gladys, SERVER),
    disk: deviceId(world.gladys, DISK, '/mnt/data'),
    threshold: 85,
    server_name: 'NAS',
    mount_point: '/mnt/data',
    used_percent: 86,
    free_gb: 0,
  });
  world.glances.setDisk('/mnt/data', 84);
  await world.hub.pollAll();
  world.glances.setDisk('/mnt/data', 86);
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.DISK).length, 2, 'within 2 points: no repeat');
  world.glances.setDisk('/mnt/data', 82);
  await world.hub.pollAll();
  world.glances.setDisk('/mnt/data', 85);
  await world.hub.pollAll();
  events = eventsOf(world, TRIGGERS.DISK);
  assert.deepEqual(
    events.map((event) => event.data.threshold),
    [80, 85, 85],
  );
});

test('a disk already full at the first read is recorded, not announced', async (t) => {
  const glances = new FakeGlances();
  glances.setDisk('/mnt/data', 96);
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  assert.equal(eventsOf(world, TRIGGERS.DISK).length, 0);
  glances.setDisk('/mnt/data', 99);
  await world.hub.pollAll();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.DISK).map((event) => event.data.threshold),
    [98],
  );
});

test('high temperature: two reads in a row, 5 °C to re-arm, 30 minutes apart', async (t) => {
  const clock = createClock();
  const world = await nasWorld({ clock });
  t.after(() => world.app.stop());
  const read = async (celsius) => {
    world.glances.setSensor('Composite', celsius);
    clock.advance(30_000);
    await world.hub.pollAll();
  };
  await read(71);
  assert.equal(eventsOf(world, TRIGGERS.TEMPERATURE).length, 0, 'a single read is a spike');
  await read(60);
  // 55 °C at the first read: 50 and 55 already taken, silently.
  assert.deepEqual(
    eventsOf(world, TRIGGERS.TEMPERATURE).map((event) => event.data.threshold),
    [60],
    '71 then 60: two reads at or above 60',
  );
  await read(71);
  await read(72);
  let events = eventsOf(world, TRIGGERS.TEMPERATURE);
  assert.deepEqual(
    events.map((event) => event.data.threshold),
    [60, 65, 70],
  );
  assert.deepEqual(events[2].data, {
    server: deviceId(world.gladys, SERVER),
    sensor: deviceId(world.gladys, SENSOR, 'Composite'),
    threshold: 70,
    server_name: 'NAS',
    sensor_name: 'Composite',
    temperature: 72,
  });
  await read(66); // below 70, not 5 °C below: still taken
  await read(71);
  await read(71);
  assert.equal(eventsOf(world, TRIGGERS.TEMPERATURE).length, 3);
  await read(64); // re-armed, but within 30 minutes
  await read(71);
  await read(71);
  assert.equal(eventsOf(world, TRIGGERS.TEMPERATURE).length, 3, 'cooldown');
  clock.advance(30 * 60_000);
  await read(60);
  await read(71);
  await read(71);
  events = eventsOf(world, TRIGGERS.TEMPERATURE);
  assert.deepEqual(
    events.slice(3).map((event) => event.data.threshold),
    [70],
  );
});

test('container stopped: two reads without it, then running 0', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({ glances, config: { server_1_url: '192.0.2.10', language: 'fr' } });
  t.after(() => world.app.stop());
  await createDevices(world, (device) => device.name === 'nas nextcloud');
  const running = featureId(world.gladys, CONTAINER, 'nextcloud', FEATURE_KEYS.RUNNING);
  assert.equal(world.fake.lastState(running), 1);

  glances.setContainer('nextcloud', null); // default Glances: a stopped container is gone
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.CONTAINER).length, 0, 'maybe being recreated');
  assert.equal(world.fake.lastState(running), 1);
  await world.hub.pollAll();
  const [event] = eventsOf(world, TRIGGERS.CONTAINER);
  assert.deepEqual(event.data, {
    server: deviceId(world.gladys, SERVER),
    container: deviceId(world.gladys, CONTAINER, 'nextcloud'),
    server_name: 'nas',
    container_name: 'nextcloud',
    status: 'Arrêté',
  });
  assert.equal(world.fake.lastState(running), 0);
  assert.equal(
    world.fake.lastState(featureId(world.gladys, CONTAINER, 'nextcloud', FEATURE_KEYS.CPU)),
    0,
  );
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.CONTAINER).length, 1);
});

test('a container recreated within one read is no stop', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  const saved = structuredClone(glances.containerList.find((c) => c.name === 'mariadb'));
  glances.setContainer('mariadb', null);
  await world.hub.pollAll();
  glances.containerList.push({ ...saved, id: 'f'.repeat(64) });
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.CONTAINER).length, 0);
});

test('paused, restarting and exited containers count as stopped; unhealthy still runs', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  glances.setContainer('jellyfin', 'paused');
  glances.setContainer('mariadb', 'restarting');
  glances.setContainer('nextcloud', 'unhealthy');
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.CONTAINER).map((event) => [
      event.data.container_name,
      event.data.status,
    ]),
    [
      ['jellyfin', 'Paused'],
      ['mariadb', 'Restarting'],
    ],
  );
});

test('a container that never ran (exited at the first read) is no stop', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.CONTAINER).length, 0, 'backup-job was always exited');
});

test('Glances 3 containers stop the same way', async (t) => {
  const glances = new FakeGlances({ version: 3 });
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  glances.setContainer('jellyfin', 'exited');
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.CONTAINER).map((event) => event.data.container_name),
    ['jellyfin'],
  );
});

test('the containers plugin disabled: no stop announced for every container', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  await createDevices(world, (device) => device.name === 'NAS jellyfin');
  const before = world.fake.states.length;
  glances.disable('containers');
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.CONTAINER).length, 0);
  assert.equal(world.fake.states.length, before);
});

test('what was announced survives a restart of the integration', async (t) => {
  const glances = new FakeGlances();
  const first = await nasWorld({ glances });
  glances.setDisk('/mnt/data', 91);
  glances.setContainer('mariadb', null);
  await first.hub.pollAll();
  await first.hub.pollAll();
  await first.app.stop();
  assert.equal(eventsOf(first, TRIGGERS.DISK).length, 3);
  assert.equal(eventsOf(first, TRIGGERS.CONTAINER).length, 1);

  const second = await nasWorld({ glances, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  await second.hub.pollAll();
  assert.equal(eventsOf(second, TRIGGERS.DISK).length, 0, 'not announced twice');
  assert.equal(eventsOf(second, TRIGGERS.CONTAINER).length, 0);
  glances.setDisk('/mnt/data', 96);
  await second.hub.pollAll();
  assert.deepEqual(
    eventsOf(second, TRIGGERS.DISK).map((event) => event.data.threshold),
    [95],
  );
  // A container that stopped while the integration was off is still seen.
  glances.setContainer('jellyfin', null);
  await second.hub.pollAll();
  await second.hub.pollAll();
  assert.deepEqual(
    eventsOf(second, TRIGGERS.CONTAINER).map((event) => event.data.container_name),
    ['jellyfin'],
  );
});

test('a server removed from the configuration forgets its states', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({ glances });
  t.after(() => world.app.stop());
  assert.ok(world.hub.watcher.hasContainers(1));
  await world.fake.configUpdated({ language: 'en' });
  assert.equal(world.hub.watcher.hasContainers(1), false);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.deepEqual(world.fake.discoveredDevices, []);
});

test('two servers: names, slots and a failing one', async (t) => {
  const world = await createWorld({
    servers: {
      [URL_1]: new FakeGlances(),
      [URL_2]: new FakeGlances({ version: 3, password: PASSWORD }),
    },
    config: {
      server_1_url: '192.0.2.10',
      server_1_name: 'NAS',
      server_2_url: URL_2,
      server_2_password: PASSWORD,
      language: 'en',
    },
  });
  t.after(() => world.app.stop());
  const servers = world.fake.discoveredDevices.filter((device) =>
    device.external_id.includes(':server:'),
  );
  assert.deepEqual(
    servers.map((device) => [device.name, device.external_id]),
    [
      ['NAS', deviceId(world.gladys, SERVER, null, 1)],
      ['homeserver', deviceId(world.gladys, SERVER, null, 2)],
    ],
  );
  world.network.servers[URL_2].failure = 'down';
  await world.hub.pollAll();
  assert.equal(world.fake.connectionStatus.connected, true, 'one of two still answers');
  assert.match(world.fake.connectionStatus.message.en, /homeserver: does not answer/);
});

test('a new address in the same slot keeps the devices; a new name renames nothing', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  const before = world.fake.discoveredDevices.map((device) => device.external_id);
  world.network.servers['http://nas.lan:61208'] = world.glances;
  await world.fake.configUpdated({ server_1_url: 'nas.lan', server_1_name: 'Big NAS' });
  const after = world.fake.discoveredDevices;
  assert.deepEqual(
    after.map((device) => device.external_id),
    before,
  );
  assert.equal(after[0].name, 'Big NAS');
});

test('the feature names follow the configured language', async (t) => {
  const world = await nasWorld({ config: { server_1_url: '192.0.2.10', language: 'de' } });
  t.after(() => world.app.stop());
  const server = world.fake.discoveredDevices[0];
  assert.deepEqual(server.features.map((feature) => feature.name).slice(0, 3), [
    'Online',
    'Prozessor',
    'Arbeitsspeicher',
  ]);
  await world.fake.configUpdated({ server_1_url: '192.0.2.10', language: 'es' });
  assert.equal(world.fake.discoveredDevices[0].features[1].name, 'Procesador');
});

test('a device created later gets its states and refreshes the widget', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  const widgetRefreshes = world.fake.widgetRefreshes.length;
  const device = world.fake.discoveredDevices.find((d) => d.name === 'NAS Composite');
  await world.fake.deviceCreated(device);
  assert.equal(
    world.fake.lastState(featureId(world.gladys, SENSOR, 'Composite', FEATURE_KEYS.TEMPERATURE)),
    55,
  );
  assert.equal(world.fake.widgetRefreshes.length, widgetRefreshes + 1);
  assert.deepEqual(world.fake.transports.at(-1), {
    device_external_id: device.external_id,
    transport: 'local',
  });
});

test('Gladys restarted: everything is sent again', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  await createDevices(world, (device) => device.name === 'NAS');
  const before = world.fake.states.length;
  await world.gladys.disconnect();
  await world.gladys.connect();
  assert.ok(world.fake.states.length > before);
});

test('"Search" in the Discovery tab publishes the list again', async (t) => {
  const world = await nasWorld();
  t.after(() => world.app.stop());
  const count = world.fake.requests.filter((r) => r.path === '/discovered_device').length;
  await world.fake.scanRequest();
  assert.equal(
    world.fake.requests.filter((r) => r.path === '/discovered_device').length,
    count + 1,
  );
});

test('"Test the connection" reports every server', async (t) => {
  const glances = new FakeGlances();
  const world = await nasWorld({
    glances,
    config: { server_1_url: '192.0.2.10', server_2_url: 'ftp://nope', language: 'fr' },
  });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(
    ack.data.message.fr,
    'nas : OK, Glances 4.5.8 (API v4), 3 disque(s), 1 interface(s), 8 capteur(s) de température, 3 conteneur(s) en marche\n' +
      'Adresse incomprise, ex. 192.168.1.20 ou http://nas.lan:61208',
  );
  glances.failure = 'down';
  const down = await world.fake.action('test_connection', {});
  assert.match(down.data.message.en, /^nas: does not answer/);
});

test('no server configured: the connection status says what to do', async (t) => {
  const world = await createWorld({ config: {} });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(
    world.fake.connectionStatus.message.en,
    'Enter the address of a Glances server in the configuration.',
  );
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.data.message.en, 'Enter the address of a Glances server in the configuration.');
});
