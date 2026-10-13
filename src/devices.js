// -----------------------------------------------------------------------------
// The Gladys devices of a Glances server, proposed in the Discovery tab: the
// user adds the ones to follow, nothing is created on their behalf.
//
//   - the server itself (one per configured slot): online, CPU, memory,
//     swap, load averages, uptime, running containers, hottest sensor;
//   - one device per disk (mount point), network interface, temperature
//     sensor and container: a NAS easily has thirty of them, the user picks.
//
// Identity: the configuration slot of the server, and for the other devices
// the name Glances gives them (mount point, interface, sensor label,
// container name), as is when it is a plain identifier, hashed otherwise.
// A container keeps its device when it is recreated (a new id, the same
// name), the way `docker compose` updates do.
//
// Category/type couples come from the core table (see
// test/gladys-rules.test.js). The core has no generic "percent" category:
// usage percentages (CPU, memory, disk) are `level-sensor/liquid-level-percent`
// (a fill level, the couple OctoPrint and Brother already use), which also
// gives the jauge a 0-100 range. Load averages have no category at all:
// `unknown/unknown`, the three of them on the server, so their names show.
//
// Published with should_poll: false: the integration reads Glances on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { hottest } from './glances/model.js';

export const DEVICE_TYPES = Object.freeze({
  SERVER: 'server',
  DISK: 'disk',
  NETWORK: 'network',
  SENSOR: 'sensor',
  CONTAINER: 'container',
});

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  ONLINE: 'online',
  CPU: 'cpu',
  MEMORY: 'memory',
  SWAP: 'swap',
  LOAD_1: 'load_1',
  LOAD_5: 'load_5',
  LOAD_15: 'load_15',
  UPTIME: 'uptime',
  CONTAINERS_RUNNING: 'containers_running',
  TEMPERATURE_MAX: 'temperature_max',
  USED_PERCENT: 'used_percent',
  FREE: 'free',
  RX: 'rx',
  TX: 'tx',
  TEMPERATURE: 'temperature',
  RUNNING: 'running',
});

const K = FEATURE_KEYS;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [K.ONLINE]: 'Online',
    [K.CPU]: 'CPU',
    [K.MEMORY]: 'Memory',
    [K.SWAP]: 'Swap',
    [K.LOAD_1]: 'Load (1 min)',
    [K.LOAD_5]: 'Load (5 min)',
    [K.LOAD_15]: 'Load (15 min)',
    [K.UPTIME]: 'Uptime',
    [K.CONTAINERS_RUNNING]: 'Running containers',
    [K.TEMPERATURE_MAX]: 'Highest temperature',
    [K.USED_PERCENT]: 'Space used',
    [K.FREE]: 'Free space',
    [K.RX]: 'Download',
    [K.TX]: 'Upload',
    [K.TEMPERATURE]: 'Temperature',
    [K.RUNNING]: 'Running',
  },
  fr: {
    [K.ONLINE]: 'En ligne',
    [K.CPU]: 'Processeur',
    [K.MEMORY]: 'Mémoire',
    [K.SWAP]: 'Swap',
    [K.LOAD_1]: 'Charge (1 min)',
    [K.LOAD_5]: 'Charge (5 min)',
    [K.LOAD_15]: 'Charge (15 min)',
    [K.UPTIME]: 'Durée de fonctionnement',
    [K.CONTAINERS_RUNNING]: 'Conteneurs en marche',
    [K.TEMPERATURE_MAX]: 'Température la plus haute',
    [K.USED_PERCENT]: 'Espace utilisé',
    [K.FREE]: 'Espace libre',
    [K.RX]: 'Réception',
    [K.TX]: 'Émission',
    [K.TEMPERATURE]: 'Température',
    [K.RUNNING]: 'En marche',
  },
  de: {
    [K.ONLINE]: 'Online',
    [K.CPU]: 'Prozessor',
    [K.MEMORY]: 'Arbeitsspeicher',
    [K.SWAP]: 'Auslagerung',
    [K.LOAD_1]: 'Last (1 Min.)',
    [K.LOAD_5]: 'Last (5 Min.)',
    [K.LOAD_15]: 'Last (15 Min.)',
    [K.UPTIME]: 'Laufzeit',
    [K.CONTAINERS_RUNNING]: 'Laufende Container',
    [K.TEMPERATURE_MAX]: 'Höchste Temperatur',
    [K.USED_PERCENT]: 'Belegter Speicher',
    [K.FREE]: 'Freier Speicher',
    [K.RX]: 'Empfang',
    [K.TX]: 'Senden',
    [K.TEMPERATURE]: 'Temperatur',
    [K.RUNNING]: 'Läuft',
  },
  es: {
    [K.ONLINE]: 'En línea',
    [K.CPU]: 'Procesador',
    [K.MEMORY]: 'Memoria',
    [K.SWAP]: 'Swap',
    [K.LOAD_1]: 'Carga (1 min)',
    [K.LOAD_5]: 'Carga (5 min)',
    [K.LOAD_15]: 'Carga (15 min)',
    [K.UPTIME]: 'Tiempo en marcha',
    [K.CONTAINERS_RUNNING]: 'Contenedores en marcha',
    [K.TEMPERATURE_MAX]: 'Temperatura más alta',
    [K.USED_PERCENT]: 'Espacio usado',
    [K.FREE]: 'Espacio libre',
    [K.RX]: 'Recepción',
    [K.TX]: 'Envío',
    [K.TEMPERATURE]: 'Temperatura',
    [K.RUNNING]: 'En marcha',
  },
};

export const MODEL = 'Glances';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// Display bounds (the core never applies them on write).
export const BOUNDS = Object.freeze({
  LOAD_MAX: 1000,
  UPTIME_MAX_DAYS: 36500,
  CONTAINERS_MAX: 1000,
  TEMPERATURE: [-50, 150],
  // A fixed range: the link speed Glances reports moves (Wi-Fi), and a
  // bound that moves changes the device structure.
  RATE_MAX_MBPS: 10000,
  MEMORY_MAX_MB: 1048576,
});

/** A platform id part from a name Glances gives: as is when safe, hashed otherwise. */
export function itemKey(name) {
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && !/^h[0-9a-f]{12}$/.test(name)) {
    return name;
  }
  return `h${createHash('sha1').update(name).digest('hex').slice(0, 12)}`;
}

/** External ids of a device of a server slot (`key` null for the server). */
export function deviceIds(gladys, type, slot, key = null) {
  return gladys.externalIds(type, key === null ? `${slot}` : `${slot}-${key}`);
}

/**
 * The type, slot and item key of a device external id, null when not ours.
 * @returns {{ type: string, slot: number, key: string|null }|null}
 */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string') {
    return null;
  }
  for (const type of Object.values(DEVICE_TYPES)) {
    const prefix = gladys.externalIds(type, '').device;
    if (!externalId.startsWith(prefix)) {
      continue;
    }
    const rest = externalId.slice(prefix.length);
    const match =
      type === DEVICE_TYPES.SERVER
        ? rest.match(/^(\d+)$/)
        : rest.match(/^(\d+)-([A-Za-z0-9_.-]{1,64})$/);
    return match ? { type, slot: Number(match[1]), key: match[2] ?? null } : null;
  }
  return null;
}

const round = (value, digits) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// Feature shapes. `noisy` (or a function of the item): moves at every read,
// published at most once a minute (src/hub.js) to stay far below the 300
// states per minute of Gladys.
const percent = (digits = 1) => ({
  definition: {
    category: CATEGORY.LEVEL_SENSOR,
    type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
  },
  digits,
});
const binary = () => ({
  definition: { category: CATEGORY.INPUT, type: TYPE.SENSOR.BINARY, min: 0, max: 1 },
  digits: 0,
});
const temperature = () => ({
  definition: {
    category: CATEGORY.DEVICE_TEMPERATURE_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: BOUNDS.TEMPERATURE[0],
    max: BOUNDS.TEMPERATURE[1],
  },
  digits: 1,
});
const load = () => ({
  definition: {
    category: CATEGORY.UNKNOWN,
    type: TYPE.UNKNOWN.UNKNOWN,
    min: 0,
    max: BOUNDS.LOAD_MAX,
  },
  digits: 2,
});
const rate = () => ({
  definition: {
    category: CATEGORY.DATARATE,
    type: TYPE.DATARATE.RATE,
    unit: UNIT.MEGABITS_PER_SECOND,
    min: 0,
    max: BOUNDS.RATE_MAX_MBPS,
  },
  digits: 2,
});

const toMbps = (bytesPerSecond) =>
  bytesPerSecond === null || bytesPerSecond === undefined ? null : (bytesPerSecond * 8) / 1e6;

/**
 * The features of each device type: which exist for an item, their shape,
 * and their value. `item` is what the device stands for (the snapshot for the
 * server, a disk, an interface, a sensor, a container); `context` carries
 * what the server knows beyond it.
 */
const BLUEPRINTS = {
  [DEVICE_TYPES.SERVER]: [
    { key: K.ONLINE, ...binary(), value: (_, ctx) => (ctx.online ? 1 : 0) },
    { key: K.CPU, ...percent(), noisy: true, value: (s) => s?.cpu },
    { key: K.MEMORY, ...percent(), noisy: true, value: (s) => s?.memory },
    {
      key: K.SWAP,
      ...percent(),
      noisy: true,
      when: (s) => s.swap !== null,
      value: (s) => s?.swap,
    },
    { key: K.LOAD_1, ...load(), noisy: true, value: (s) => s?.load?.min1 },
    { key: K.LOAD_5, ...load(), noisy: true, value: (s) => s?.load?.min5 },
    { key: K.LOAD_15, ...load(), noisy: true, value: (s) => s?.load?.min15 },
    {
      key: K.UPTIME,
      definition: {
        category: CATEGORY.DURATION,
        type: TYPE.DURATION.DECIMAL,
        unit: UNIT.DAYS,
        min: 0,
        max: BOUNDS.UPTIME_MAX_DAYS,
      },
      digits: 2,
      value: (s) => (s?.uptime === null || s?.uptime === undefined ? null : s.uptime / 86400),
    },
    {
      key: K.CONTAINERS_RUNNING,
      definition: {
        category: CATEGORY.COUNTER_SENSOR,
        type: TYPE.SENSOR.INTEGER,
        min: 0,
        max: BOUNDS.CONTAINERS_MAX,
      },
      digits: 0,
      when: (_, ctx) => ctx.hasContainers,
      value: (s) =>
        s?.containers ? s.containers.filter((container) => container.running).length : null,
    },
    {
      key: K.TEMPERATURE_MAX,
      ...temperature(),
      noisy: true,
      when: (s) => s.sensors.length > 0,
      value: (s) => hottest(s)?.celsius ?? null,
    },
  ],
  [DEVICE_TYPES.DISK]: [
    { key: K.USED_PERCENT, ...percent(), value: (disk) => disk?.percent },
    {
      key: K.FREE,
      definition: {
        category: CATEGORY.DATA,
        type: TYPE.DATA.SIZE,
        unit: UNIT.GIGABYTE,
        min: 0,
      },
      max: (disk) => Math.max(1, Math.ceil(disk.size / GIB)),
      digits: 1,
      value: (disk) => (disk?.free === null || disk?.free === undefined ? null : disk.free / GIB),
    },
  ],
  [DEVICE_TYPES.NETWORK]: [
    { key: K.RX, ...rate(), noisy: true, value: (nic) => toMbps(nic?.rx) },
    { key: K.TX, ...rate(), noisy: true, value: (nic) => toMbps(nic?.tx) },
  ],
  [DEVICE_TYPES.SENSOR]: [
    { key: K.TEMPERATURE, ...temperature(), noisy: true, value: (sensor) => sensor?.celsius },
  ],
  [DEVICE_TYPES.CONTAINER]: [
    { key: K.RUNNING, ...binary(), value: (c) => (c ? (c.running ? 1 : 0) : 0) },
    {
      key: K.CPU,
      ...percent(),
      // Glances counts one core as 100 %, like `docker stats`.
      max: (_, ctx) => 100 * (ctx.cores ?? 1),
      // A container that stops drops to 0 at once.
      noisy: (c) => Boolean(c?.running),
      value: (c) => (c ? c.cpu : 0),
    },
    {
      key: K.MEMORY,
      definition: {
        category: CATEGORY.DATA,
        type: TYPE.DATA.SIZE,
        unit: UNIT.MEGABYTE,
        min: 0,
      },
      max: (c) =>
        c?.memoryLimit ? Math.max(1, Math.ceil(c.memoryLimit / MIB)) : BOUNDS.MEMORY_MAX_MB,
      digits: 0,
      noisy: (c) => Boolean(c?.running),
      value: (c) => (c ? (c.memory === null ? null : c.memory / MIB) : 0),
    },
  ],
};

/** Whether a feature of the blueprint exists for this item. */
const present = (feature, item, ctx) => !feature.when || feature.when(item, ctx);

/** The feature keys a device of this type has for this item. */
export const featureKeys = (type, item, ctx = {}) =>
  BLUEPRINTS[type].filter((feature) => present(feature, item, ctx)).map((f) => f.key);

/**
 * The discovery payload of a device.
 * @param {object} gladys SDK client
 * @param {object} options
 * @param {string} options.type one of DEVICE_TYPES
 * @param {number} options.slot server slot
 * @param {string|null} options.key item key (null for the server)
 * @param {string} options.name device name
 * @param {object} options.item what the device stands for
 * @param {object} [options.context] { online, hasContainers, cores }
 * @param {string} [options.language] feature names language
 * @param {Array<{name: string, value: string}>} [options.params]
 */
export function buildDevice(
  gladys,
  { type, slot, key = null, name, item, context = {}, language = 'en', params = [] },
) {
  const ids = deviceIds(gladys, type, slot, key);
  const names = NAMES[language] ?? NAMES.en;
  const features = BLUEPRINTS[type]
    .filter((feature) => present(feature, item, context))
    .map((feature) => ({
      name: names[feature.key],
      external_id: ids.feature(feature.key),
      ...feature.definition,
      ...(feature.max ? { max: feature.max(item, context) } : {}),
      read_only: true,
      has_feedback: false,
      keep_history: true,
    }));
  return {
    name: name.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: params.map((param) => ({ name: param.name, value: String(param.value).slice(0, 255) })),
    features,
  };
}

/**
 * The value of every feature of a device (null: nothing to publish).
 * @returns {Array<{ key: string, externalId: string, value: number|null, noisy: boolean }>}
 */
export function featureValues(gladys, { type, slot, key = null, item, context = {} }) {
  const ids = deviceIds(gladys, type, slot, key);
  return BLUEPRINTS[type]
    .filter((feature) => item === null || present(feature, item, context))
    .map((feature) => ({
      key: feature.key,
      externalId: ids.feature(feature.key),
      value: round(feature.value(item, context), feature.digits),
      noisy: typeof feature.noisy === 'function' ? feature.noisy(item) : Boolean(feature.noisy),
    }));
}
