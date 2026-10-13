// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, LANGUAGES, POLL_INTERVALS, SLOTS } from '../src/config.js';
import { DISK_THRESHOLDS, TEMPERATURE_THRESHOLDS } from '../src/alerts.js';
import { DEVICE_TYPES } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { SCENE_ACTIONS } from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';
import { FakeGlances, URL_1, createClock, createWorld, deviceId } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: name, image, cover, local transport, network category', () => {
  assert.equal(manifest.name, 'Glances');
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-glances:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-glances/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['network']);
  assert.equal(manifest.network_discovery, undefined);
});

test('every manifest action has a handler', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const action of manifest.actions) {
    const ack = await world.fake.action(action.key, {});
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
  }
  assert.deepEqual(keysOf(manifest.actions), ['test_connection']);
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION));
});

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.deepEqual(declared, CAPABILITY_FIELDS);
  assert.ok(isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION));
});

test('every scene_actions key has a handler, and returns the declared outputs', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_actions).sort(), Object.keys(SCENE_ACTIONS).sort());
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const action of manifest.scene_actions) {
    const ack = await world.fake.sceneAction(action.key, {
      server: deviceId(world.gladys, DEVICE_TYPES.SERVER),
    });
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
    assert.deepEqual(
      Object.keys(ack.data.outputs).sort(),
      keysOf(action.outputs).sort(),
      `${action.key} outputs`,
    );
    for (const output of action.outputs) {
      assert.equal(typeof ack.data.outputs[output.key], output.type, `${action.key}.${output.key}`);
    }
  }
});

test('the scene triggers are the ones the hub fires, with their filters and variables', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGERS).sort());
  const clock = createClock();
  const glances = new FakeGlances();
  const world = await createWorld({ clock, servers: { [URL_1]: glances } });
  t.after(() => world.app.stop());
  // Every trigger once: a disk filling up, a hot sensor, a container gone,
  // the server silent.
  glances.setDisk('/mnt/data', 91);
  glances.setSensor('Composite', 81);
  glances.setContainer('mariadb', null);
  await world.hub.pollAll();
  await world.hub.pollAll();
  glances.failure = 'down';
  await world.hub.pollAll();
  await world.hub.pollAll();
  const fired = new Map(world.fake.sceneEvents.map((event) => [event.key, event.data]));
  for (const trigger of manifest.scene_triggers) {
    const data = fired.get(trigger.key);
    assert.ok(data, `${trigger.key} was fired`);
    // Filters match keys of `data`, variables read keys of `data`.
    for (const key of [...keysOf(trigger.fields), ...keysOf(trigger.variables)]) {
      assert.ok(key in data, `${trigger.key}: "${key}" is in the event data`);
    }
    for (const [key, value] of Object.entries(data)) {
      const variable = trigger.variables.find((v) => v.key === key);
      assert.ok(variable || keysOf(trigger.fields).includes(key), `${trigger.key}: "${key}"`);
      if (variable) {
        assert.equal(typeof value, variable.type, `${trigger.key}.${key}`);
      }
    }
  }
});

test('the threshold filters offer exactly the steps the hub fires', () => {
  const steps = (key) =>
    manifest.scene_triggers
      .find((trigger) => trigger.key === key)
      .fields.find((field) => field.key === 'threshold');
  const disk = steps(TRIGGERS.DISK);
  const temperature = steps(TRIGGERS.TEMPERATURE);
  assert.deepEqual(
    disk.options.map((o) => o.value),
    DISK_THRESHOLDS.map(String),
  );
  assert.deepEqual(
    temperature.options.map((o) => o.value),
    TEMPERATURE_THRESHOLDS.map(String),
  );
  for (const field of [disk, temperature]) {
    assert.equal(field.required, true, 'a threshold is never a wildcard');
    assert.ok(field.options.some((o) => o.value === field.default));
  }
});

test('every widgets key has a handler', async (t) => {
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  assert.deepEqual(Object.keys(WIDGETS), [WIDGET_KEY]);
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.widgetGet(WIDGET_KEY, {
    settings: { server: deviceId(world.gladys, DEVICE_TYPES.SERVER) },
  });
  assert.equal(ack.success, true, ack.error);
});

test('config_schema defaults and options stay consistent with the code', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
  const options = (key) =>
    manifest.config_schema.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(options('language'), LANGUAGES);
  assert.deepEqual(options('poll_interval'), POLL_INTERVALS);
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).sort(),
    manifest.config_schema
      .filter((f) => f.type !== 'section')
      .map((f) => f.key)
      .sort(),
  );
  for (const slot of SLOTS) {
    const key = manifest.config_schema.find((f) => f.key === `server_${slot}_password`);
    assert.equal(key.type, 'secret', 'passwords are secret fields');
    assert.equal(key.default, undefined, 'a secret field takes no default');
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source, no static options and no default', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0);
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices');
    assert.equal(field.options, undefined);
    assert.equal(field.default, undefined, 'a default is refused with a source');
  }
});

test('trigger filters are never boolean (no "any" state)', () => {
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields ?? []) {
      assert.notEqual(field.type, 'boolean');
    }
  }
});

test('number fields have integer bounds and defaults (the form has no step)', () => {
  for (const field of allFields.filter((f) => f.type === 'number')) {
    for (const key of ['min', 'max', 'default']) {
      if (field[key] !== undefined) {
        assert.ok(Number.isInteger(field[key]), `field "${field.key}".${key} must be an integer`);
      }
    }
  }
});

test('actions declare no secret field, no required field (no default is applied)', () => {
  // Gladys#3154/#3155: a secret in an action form cannot be filled, and an
  // action applies no default while enforcing `required`.
  for (const action of manifest.actions ?? []) {
    for (const field of action.fields ?? []) {
      assert.notEqual(field.type, 'secret');
      assert.notEqual(field.required, true);
    }
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});
