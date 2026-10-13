// -----------------------------------------------------------------------------
// From the raw plugins to the snapshot, on the real answers of Glances 4.5.8
// and 3.4.0.5 and the glances-api (Home Assistant) fixtures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainDisk, hottest, parseSnapshot, parseUptime } from '../src/glances/model.js';
import { loadFixtures, readFixture } from './helpers/fakeGlances.js';

const read = (directory, apiVersion, overrides = {}) => {
  const plugins = { ...loadFixtures(directory), ...overrides };
  return parseSnapshot({
    apiVersion,
    static: { system: plugins.system, version: plugins.version },
    data: plugins,
  });
};

test('Glances 4.5.8: every figure of the server', () => {
  const raw = loadFixtures('v4');
  const snapshot = read('v4', 4);
  assert.equal(snapshot.apiVersion, 4);
  assert.equal(snapshot.glancesVersion, '4.5.8');
  assert.equal(snapshot.hostname, 'nas');
  assert.equal(snapshot.cpu, raw.cpu.total);
  assert.equal(snapshot.cores, 4);
  assert.deepEqual(snapshot.load, {
    min1: raw.load.min1,
    min5: raw.load.min5,
    min15: raw.load.min15,
  });
  assert.equal(snapshot.memory, raw.mem.percent);
  assert.equal(snapshot.swap, raw.memswap.percent);
  assert.equal(raw.uptime, '4 days, 4:51:21');
  assert.equal(snapshot.uptime, 4 * 86400 + 4 * 3600 + 51 * 60 + 21);
});

test('disks: the Docker files and the pseudo file systems are left out', () => {
  const snapshot = read('v4', 4);
  assert.deepEqual(
    snapshot.disks.map((disk) => disk.mount),
    ['/srv/media', '/mnt/data', '/srv/backup'],
  );
  const data = snapshot.disks[1];
  assert.equal(data.size, 67108864);
  assert.equal(data.free, 67108864);
  assert.equal(data.percent, 0);
  assert.equal(mainDisk(snapshot).mount, '/srv/media', 'the largest without a root');
});

test('the root disk is the main one, or the host root seen from Docker', () => {
  const fs = loadFixtures('v4').fs;
  const withRoot = read('v4', 4, { fs: [...fs, { ...fs[0], mnt_point: '/', size: 1000 }] });
  assert.equal(mainDisk(withRoot).mount, '/');
  const rootfs = read('v4', 4, { fs: [...fs, { ...fs[0], mnt_point: '/rootfs', size: 1000 }] });
  assert.equal(mainDisk(rootfs).mount, '/rootfs');
  assert.equal(mainDisk(read('v4', 4, { fs: [] })), null);
});

test('network: v4 rates per second, v3 bytes over the time since the last refresh', () => {
  const v4 = read('v4', 4).interfaces;
  assert.deepEqual(
    v4.map((nic) => nic.name),
    ['eth0'],
    'lo is left out',
  );
  const raw4 = loadFixtures('v4').network.find((nic) => nic.interface_name === 'eth0');
  assert.equal(v4[0].rx, raw4.bytes_recv_rate_per_sec);
  assert.equal(v4[0].tx, raw4.bytes_sent_rate_per_sec);
  const v3 = read('v3', 3).interfaces;
  const raw3 = loadFixtures('v3').network.find((nic) => nic.interface_name === 'eth0');
  assert.equal(v3[0].rx, raw3.rx / raw3.time_since_update);
  assert.equal(v3[0].speed, 10485760000);
});

test('container and VM plumbing interfaces are hidden', () => {
  const nic = (name) => ({ interface_name: name, bytes_recv_rate_per_sec: 1 });
  const names = read('v4', 4, {
    network: ['lo', 'veth1a2b3c', 'br-0123456789ab', 'docker0', 'eth0', 'wlan0', 'enp3s0'].map(nic),
  }).interfaces.map((entry) => entry.name);
  assert.deepEqual(names, ['eth0', 'wlan0', 'enp3s0']);
});

test('temperature sensors only, Fahrenheit converted, glitches and fans dropped', () => {
  const sensors = read('v4', 4).sensors;
  assert.equal(sensors.length, 8);
  assert.equal(hottest(read('v4', 4)).label, 'Package id 0');
  const custom = read('v4', 4, {
    sensors: [
      { label: 'CPU', type: 'temperature_core', unit: 'F', value: 122 },
      { label: 'Fan 1', type: 'fan_speed', unit: 'R', value: 1200 },
      { label: 'err_temp', type: 'temperature_hdd', unit: 'C', value: 'unavailable' },
      { label: 'Bogus', type: 'temperature_core', unit: 'C', value: 65261 },
      { label: 'CPU', type: 'temperature_core', unit: 'C', value: 40 },
    ],
  }).sensors;
  assert.deepEqual(custom, [{ label: 'CPU', type: 'temperature_core', celsius: 50 }]);
});

test('containers of Glances 4: health status, stopped ones listed with all=True', () => {
  const containers = read('v4', 4).containers;
  assert.deepEqual(
    containers.map(({ name, status, running }) => [name, status, running]),
    [
      ['jellyfin', 'running', true],
      ['nextcloud', 'healthy', true],
      ['mariadb', 'running', true],
      ['backup-job', 'exited', false],
    ],
  );
  const jellyfin = containers[0];
  assert.equal(jellyfin.cpu, 12);
  assert.equal(jellyfin.memory, 1073741824 - 4194304, 'the inactive page cache left out');
  assert.equal(jellyfin.memoryLimit, 16537718784);
  assert.equal(containers[3].cpu, 0);
  assert.equal(containers[3].memory, 0);
});

test('containers of Glances 3: an object, Status with a capital S', () => {
  const containers = read('v3', 3).containers;
  assert.deepEqual(
    containers.map(({ name, running }) => [name, running]),
    [
      ['backup-job', false],
      ['jellyfin', true],
      ['mariadb', true],
      ['nextcloud', true],
    ],
  );
  const v3default = read('v3', 3, { containers: readFixture('v3-default/containers.json') });
  assert.equal(v3default.containers.length, 3, 'the default lists the running ones only');
});

test('no container plugin: null, not an empty list', () => {
  const plugins = loadFixtures('v4');
  delete plugins.containers;
  const snapshot = parseSnapshot({ apiVersion: 4, data: plugins });
  assert.equal(snapshot.containers, null);
  assert.deepEqual(read('v4', 4, { containers: [] }).containers, []);
});

test('Glances 3.3 and older name the plugin "docker"', () => {
  const containers = readFixture('v3/containers.json');
  const plugins = loadFixtures('v3');
  delete plugins.containers;
  const snapshot = parseSnapshot({ apiVersion: 3, data: { ...plugins, docker: containers } });
  assert.equal(snapshot.containers.length, 4);
});

test('the first read of a fresh Glances 4 measures no CPU', () => {
  const snapshot = read('v4', 4, { cpu: readFixture('v4-first-read-cpu.json') });
  assert.equal(snapshot.cpu, null);
});

test('the glances-api fixtures (Home Assistant), v3 and v4', () => {
  const { v3_all: v3, v4_all: v4 } = readFixture('glances-api.json');
  const old = parseSnapshot({ apiVersion: 3, static: { system: v3.system }, data: v3 });
  assert.equal(old.cpu, 10.6);
  assert.equal(old.memory, 27.6);
  assert.equal(old.swap, null, 'no memswap plugin');
  assert.equal(old.hostname, 'fedora-35');
  assert.deepEqual(
    old.disks.map((disk) => disk.mount),
    ['/ssl', '/media'],
  );
  assert.deepEqual(
    old.interfaces.map((nic) => nic.name),
    ['bond0', 'eth0'],
  );
  assert.deepEqual(
    old.sensors.map((sensor) => sensor.label),
    ['cpu_thermal 1'],
  );
  assert.deepEqual(
    old.containers.map((c) => [c.name, c.running, Math.round(c.cpu)]),
    [
      ['container1', true, 51],
      ['container2', true, 26],
    ],
  );
  assert.equal(old.containers[0].memory, 1120321536 - 580915200, 'v3: the cache left out');
  const recent = parseSnapshot({ apiVersion: 4, data: v4 });
  assert.equal(recent.interfaces[0].rx, 6377770);
  assert.deepEqual(
    recent.containers.map((c) => [c.name, c.running, c.memory]),
    [
      ['container1', true, null],
      ['container2', true, null],
    ],
  );
});

test('uptime: the formats of Python timedelta', () => {
  assert.equal(parseUptime('4 days, 4:33:27'), 4 * 86400 + 4 * 3600 + 33 * 60 + 27);
  assert.equal(parseUptime('1 day, 0:01:02'), 86400 + 62);
  assert.equal(parseUptime('4:33:27'), 4 * 3600 + 33 * 60 + 27);
  assert.equal(parseUptime('0:00:05.123456'), 5);
  assert.equal(parseUptime(3600), 3600);
  assert.equal(parseUptime('soon'), null);
  assert.equal(parseUptime(null), null);
});

test('an empty answer gives an empty snapshot, never a crash', () => {
  const snapshot = parseSnapshot({ apiVersion: 4 });
  assert.equal(snapshot.cpu, null);
  assert.equal(snapshot.load, null);
  assert.equal(snapshot.memory, null);
  assert.equal(snapshot.uptime, null);
  assert.deepEqual(snapshot.disks, []);
  assert.equal(snapshot.containers, null);
  const garbage = parseSnapshot({
    apiVersion: 3,
    data: { fs: 'x', network: {}, sensors: [null, 3], containers: { containers: 'x' } },
  });
  assert.deepEqual(garbage.disks, []);
  assert.deepEqual(garbage.containers, []);
});
