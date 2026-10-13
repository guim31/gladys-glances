// -----------------------------------------------------------------------------
// The logs the Gladys supervisor keeps: at the info level, only the life
// cycle. A normal reading cycle (reads, states, scene events) writes nothing;
// a failure that repeats at every read writes one line, then one when it heals.
// The SDK logger writes debug/info with console.log, warn/error with
// console.error, at the level of LOG_LEVEL read on every line.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { FakeGlances, URL_1, createClock, createDevices, createWorld } from './helpers/world.js';

/** The lines written at `LOG_LEVEL=info` from now on, by level. */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function nasWorld(t) {
  const clock = createClock();
  const glances = new FakeGlances();
  const world = await createWorld({ clock, servers: { [URL_1]: glances } });
  t.after(() => world.app.stop());
  return { ...world, glances };
}

test('a normal cycle writes nothing: reads, states, scene events', async (t) => {
  const world = await nasWorld(t);
  const lines = captureLogs(t);
  await createDevices(world);
  for (let read = 0; read < 6; read += 1) {
    world.clock.advance(61_000);
    world.glances.setDisk('/mnt/data', 80 + read * 3); // every step up to 95 %
    world.glances.setSensor('Package id 0', 70 + read * 5); // confirmed over two reads
    if (read === 2) {
      world.glances.setContainer('nextcloud', null); // stopped two reads later
    }
    await world.hub.pollAll();
  }
  await world.hub.rediscover();
  assert.ok(world.fake.states.length > 50, 'states published');
  assert.ok(world.fake.sceneEvents.length >= 3, 'scene events fired');
  assert.deepEqual(lines, []);
});

test('Glances down for several reads: one line, then one when it answers again', async (t) => {
  const world = await nasWorld(t);
  await createDevices(world);
  const lines = captureLogs(t);
  world.glances.failure = 'down';
  for (let read = 0; read < 5; read += 1) {
    world.clock.advance(61_000);
    await world.hub.pollAll();
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*Server 1 \(NAS\)/);
  world.glances.failure = null;
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*Server 1 \(NAS\) answers again/);
});

test('Gladys refusing the states for several reads: one line, then one', async (t) => {
  const world = await nasWorld(t);
  await createDevices(world);
  const lines = captureLogs(t);
  const publishStates = world.gladys.publishStates.bind(world.gladys);
  let refuse = true;
  t.mock.method(world.gladys, 'publishStates', async (states) => {
    if (refuse) {
      throw new Error('Gladys is away');
    }
    return publishStates(states);
  });
  for (let read = 0; read < 5; read += 1) {
    world.clock.advance(61_000);
    world.glances.setDisk('/srv/media', 40 + read); // a value to send at every read
    await world.hub.pollAll();
  }
  assert.ok(world.gladys.publishStates.mock.callCount() >= 5);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*States refused: Gladys is away/);
  refuse = false;
  world.clock.advance(61_000);
  await world.hub.pollAll();
  world.clock.advance(61_000);
  await world.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*States accepted again/);
});

test('a /data that refuses every write: one line, then one when it works again', async (t) => {
  const lines = captureLogs(t);
  const parent = mkdtempSync(join(tmpdir(), 'gladys-glances-'));
  const directory = join(parent, 'data');
  writeFileSync(directory, 'a file where the directory should be');
  const store = new Store(directory);
  for (let write = 0; write < 4; write += 1) {
    await store.save({ write });
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*Cannot write/);
  unlinkSync(directory);
  await store.save({ write: 4 });
  await store.save({ write: 5 });
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*written again/);
});
