// -----------------------------------------------------------------------------
// The `server` widget: gauges, tiles and rows of a server, within the budget
// of the core (checked by the SDK's validateWidgetContent), the chosen disk,
// a server that does not answer, and the Refresh button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../src/devices.js';
import { WIDGET_KEY } from '../src/hub.js';
import { ACTIONS } from '../src/widgets.js';
import { FakeGlances, URL_1, createWorld, deviceId } from './helpers/world.js';

const { SERVER, DISK, CONTAINER } = DEVICE_TYPES;

async function world(options = {}) {
  const glances = options.glances ?? new FakeGlances();
  const created = await createWorld({ servers: { [URL_1]: glances }, ...options });
  return { ...created, glances };
}

async function content(w, settings, language = 'en') {
  const ack = await w.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'rendered exactly as sent');
  return ack.data.content;
}

const byType = (components, type) => components.filter((c) => c.type === type);

test('gauges, tiles and rows of a server', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const { components, ttl_seconds: ttl } = await content(w, { server: deviceId(w.gladys, SERVER) });
  assert.equal(ttl, 30);
  assert.equal(components[0].text, 'NAS');
  assert.deepEqual(
    byType(components, 'gauge').map((g) => [g.label, g.value, g.color]),
    [
      ['CPU', 32, 'success'],
      ['Memory', 73, 'success'],
      ['Disk /srv/media', 81, 'warning'],
    ],
  );
  assert.deepEqual(
    byType(components, 'value').map((v) => [v.label, v.value]),
    [
      ['Temperature', 86],
      ['Containers', 3],
    ],
  );
  const [status] = byType(components, 'status');
  assert.deepEqual(
    status.items.map((item) => item.label),
    ['Disk /srv/media', 'Swap', 'Load', 'Uptime'],
  );
  assert.equal(status.items[3].value, '4 d 4 h');
  assert.equal(byType(components, 'button')[0].action.key, ACTIONS.REFRESH);
});

test('the chosen disk, and any device of the server as the server', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const { components } = await content(w, {
    server: deviceId(w.gladys, CONTAINER, 'nextcloud'),
    disk: deviceId(w.gladys, DISK, '/mnt/data'),
  });
  assert.equal(byType(components, 'gauge')[2].label, 'Disk /mnt/data');
});

test('stopped containers first, in red', async (t) => {
  const glances = new FakeGlances();
  const w = await world({ glances, config: { server_1_url: '192.0.2.10', language: 'fr' } });
  t.after(() => w.app.stop());
  glances.setContainer('mariadb', null);
  await w.hub.pollAll();
  await w.hub.pollAll();
  const { components } = await content(w, { server: deviceId(w.gladys, SERVER) }, 'fr');
  const [status] = byType(components, 'status');
  assert.deepEqual(status.items[0], {
    label: 'mariadb',
    value: 'Arrêté',
    icon: 'x-circle',
    color: 'danger',
  });
  assert.equal(byType(components, 'value')[1].color, 'danger');
});

test('a server that does not answer says so', async (t) => {
  const glances = new FakeGlances();
  const w = await world({ glances });
  t.after(() => w.app.stop());
  glances.failure = 'down';
  await w.hub.pollAll();
  const { components } = await content(w, { server: deviceId(w.gladys, SERVER) });
  assert.deepEqual(
    components.map((c) => c.type),
    ['text', 'text', 'button'],
  );
  assert.equal(components[1].text, 'NAS: does not answer (is "glances -w" running?)');
});

test('without a server chosen, or one removed: a hint', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const pick = await content(w, {}, 'de');
  assert.match(pick.components[0].text, /^Wähle den Server/);
  const gone = await content(w, { server: deviceId(w.gladys, SERVER, null, 3) });
  assert.match(gone.components[0].text, /no longer in the configuration/);
});

test('many stopped containers stay within eight rows', async (t) => {
  const glances = new FakeGlances();
  const w = await world({ glances });
  t.after(() => w.app.stop());
  for (let i = 0; i < 10; i += 1) {
    glances.containerList.push({ ...glances.containerList[0], name: `job-${i}` });
  }
  await w.hub.pollAll();
  glances.plugins.containers = glances.containerList.filter((c) => !c.name.startsWith('job-'));
  await w.hub.pollAll();
  await w.hub.pollAll();
  const { components } = await content(w, { server: deviceId(w.gladys, SERVER) });
  const [status] = byType(components, 'status');
  assert.equal(status.items.length, 8);
  assert.equal(status.items.at(-1).label, 'Others');
});

test('Refresh reads the server again', async (t) => {
  const glances = new FakeGlances();
  const w = await world({ glances });
  t.after(() => w.app.stop());
  const count = glances.requests.length;
  const ack = await w.fake.widgetAction(
    WIDGET_KEY,
    ACTIONS.REFRESH,
    {},
    {
      settings: { server: deviceId(w.gladys, SERVER) },
    },
  );
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data, {
    message: {
      en: 'Glances read again.',
      fr: 'Glances relu.',
      de: 'Glances neu gelesen.',
      es: 'Glances leído de nuevo.',
    },
  });
  assert.ok(glances.requests.length > count);
  const unknown = await w.fake.widgetAction(WIDGET_KEY, 'other', {}, { settings: {} });
  assert.equal(unknown.success, false);
});
