// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake Glances servers on a
// fake network, a temporary /data and a manual clock, with the integration
// wired on top through registerHandlers. No timer runs: the tests read the
// servers with `world.hub.pollAll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { deviceIds, itemKey } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { FakeGlances, PASSWORD, createNetwork } from './fakeGlances.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const URL_1 = 'http://192.0.2.10:61208';
export const URL_2 = 'https://198.51.100.20';

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.UTC(2026, 9, 13, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {Record<string, FakeGlances>} [options.servers] by base URL
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 */
export async function createWorld({
  clock = createClock(),
  servers,
  config = { server_1_url: '192.0.2.10', server_1_name: 'NAS', language: 'en' },
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-glances-')),
  timings = {},
} = {}) {
  const network = createNetwork(servers ?? { [URL_1]: new FakeGlances() });
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: network.request,
    timers: false,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, network, app, hub: app.hub, clock, dataDir };
}

/** External id of a device: the server (`name` omitted) or one of its items. */
export const deviceId = (gladys, type, name = null, slot = 1) =>
  deviceIds(gladys, type, slot, name === null ? null : itemKey(name)).device;

export const featureId = (gladys, type, name, feature, slot = 1) =>
  deviceIds(gladys, type, slot, name === null ? null : itemKey(name)).feature(feature);

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

export { FakeGlances, PASSWORD };
