// -----------------------------------------------------------------------------
// The Glances hub: one record per configured server, read on a timer of the
// container (the interval chosen in the configuration); the states of the
// devices the user added published to Gladys when they change, the scene
// events fired on transitions (src/alerts.js), and the views the widget and
// the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the configurable
// interval goes up to 5 minutes, beyond the fixed list of the core
// scheduler, and the scene events must fire for every disk, sensor and
// container, added to Gladys or not.
//
// The 300 states per minute of Gladys: only the devices added are published,
// only what changed (rounded), the values that move at every read at most
// once a minute, and a budget of 240 states per minute on top. Every value
// is sent again after 6 hours unchanged, before the core marks it outdated
// (48 hours).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Watcher } from './alerts.js';
import {
  DEVICE_TYPES,
  buildDevice,
  deviceIds,
  featureValues,
  itemKey,
  parseDeviceId,
} from './devices.js';
import { ERROR_KINDS, GlancesClient } from './glances/client.js';
import { mainDisk, parseSnapshot } from './glances/model.js';
import { hostOf } from './config.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  CONTAINER_STATE_TEXT,
  ERROR_TEXT,
  REPORT_TEXT,
  containerStateKey,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'glances-hub' });

export const WIDGET_KEY = 'server';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  DISK: 'disk_almost_full',
  TEMPERATURE: 'temperature_high',
  CONTAINER: 'container_stopped',
  UNREACHABLE: 'server_unreachable',
});

export const HUB_TIMINGS = {
  // A server that fails once is read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Failures in a row before a server counts as unreachable (scene event).
  downAfterFailures: 2,
  // The values that move at every read (CPU, load, rates…): at most this often.
  noisyEveryMs: 60_000,
  // An unchanged value is sent again after this long.
  heartbeatMs: 6 * 3600_000,
  // A scene action reads Glances again when the last read is older.
  freshMs: 15_000,
  // A disk, sensor or container not seen for a week is forgotten.
  forgetAfterMs: 7 * 24 * 3600_000,
  // States sent per minute at most, below the 300 of Gladys.
  statesPerMinute: 240,
};

const MAX_STATES_PER_REQUEST = 100;
const MAX_TRANSPORTS_PER_REQUEST = 100;

const signature = (server, config) =>
  JSON.stringify([server.url, server.username, server.password, config.allowSelfSigned]);

// Glances run in Docker reports the container id as its host name.
const meaningfulHostname = (name) =>
  typeof name === 'string' && name && !/^[0-9a-f]{12}$/.test(name) ? name : null;

export class GlancesHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/glances/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    /** @type {Map<number, object>} server records, by slot */
    this.records = new Map();
    this.watcher = new Watcher();
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    /** When the states of the last minute were sent (budget). */
    this.sentTimes = [];
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.pollTimer = null;
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.watcher = new Watcher(await this.store.load());
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config?.language !== config.language;
    this.config = config;
    const wanted = new Map(config.servers.map((server) => [server.slot, server]));
    let forgotten = false;
    for (const [slot, record] of this.records) {
      const server = wanted.get(slot);
      if (!server || record.signature !== signature(server, config)) {
        this.dropRecord(record);
        this.records.delete(slot);
        // Another address may be another machine: what was announced for the
        // old one must not fire for the new one (recorded again, silently).
        if (server && server.url !== record.server.url) {
          forgotten = this.watcher.forgetSlot(slot) || forgotten;
        }
      }
    }
    // A slot whose address is being corrected keeps its history.
    const kept = new Set([...wanted.keys(), ...config.invalidSlots]);
    if (this.watcher.forgetSlots(kept) || forgotten) {
      this.store.save(this.watcher.saved);
    }
    for (const server of config.servers) {
      const record = this.records.get(server.slot);
      if (record) {
        record.server = server; // a new name only
      } else {
        this.records.set(server.slot, this.newRecord(server, config));
      }
    }
    if (languageChanged) {
      this.discovered = null;
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  newRecord(server, config) {
    return {
      server,
      signature: signature(server, config),
      client: new GlancesClient({
        url: server.url,
        username: server.username,
        password: server.password,
        insecure: config.allowSelfSigned,
        request: this.request,
        now: this.now,
      }),
      /** @type {object|null} the last snapshot read (src/glances/model.js) */
      snapshot: null,
      /** Items of the snapshot by device type and item key. */
      index: null,
      readAt: 0,
      error: null,
      failures: 0,
      down: false,
      polling: null,
      retryTimer: null,
      dropped: false,
    };
  }

  dropRecord(record) {
    record.dropped = true;
    clearTimeout(record.retryTimer);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const record of this.records.values()) {
      clearTimeout(record.retryTimer);
    }
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || this.records.size === 0) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
      } catch (err) {
        logger.error('Poll failed', err);
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Names and identities ------------------------------------------------------

  /** The server name: the one configured, the host name Glances gives, or the address. */
  serverName(record) {
    return (
      record.server.name ??
      meaningfulHostname(record.snapshot?.hostname) ??
      hostOf(record.server.url)
    );
  }

  /** A server in a list: with its slot when two would read the same. */
  label(record) {
    return `Server ${record.server.slot} (${this.serverName(record)})`;
  }

  serverId(slot) {
    return deviceIds(this.gladys, DEVICE_TYPES.SERVER, slot).device;
  }

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** The devices of a slot the user added, with their parsed identity. */
  createdDevices(slot) {
    const devices = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device.external_id);
      if (parsed?.slot === slot) {
        devices.push({ device, ...parsed });
      }
    }
    return devices;
  }

  context(record) {
    return {
      online: !record.down && record.error === null && record.snapshot !== null,
      hasContainers:
        Boolean(record.snapshot?.containers?.length) ||
        this.watcher.hasContainers(record.server.slot),
      cores: record.snapshot?.cores ?? null,
    };
  }

  /** Every device a snapshot proposes: the server, then its disks, interfaces, sensors, containers. */
  items(record) {
    const { snapshot } = record;
    if (!snapshot) {
      return [];
    }
    const server = this.serverName(record);
    const child = (type, name, item) => ({
      type,
      key: itemKey(name),
      name: `${server} ${name}`,
      item,
    });
    return [
      { type: DEVICE_TYPES.SERVER, key: null, name: server, item: snapshot },
      ...snapshot.disks.map((disk) => child(DEVICE_TYPES.DISK, disk.mount, disk)),
      ...snapshot.interfaces.map((nic) => child(DEVICE_TYPES.NETWORK, nic.name, nic)),
      ...snapshot.sensors.map((sensor) => child(DEVICE_TYPES.SENSOR, sensor.label, sensor)),
      ...(snapshot.containers ?? []).map((container) =>
        child(DEVICE_TYPES.CONTAINER, container.name, container),
      ),
    ];
  }

  indexOf(record) {
    const index = new Map();
    for (const entry of this.items(record)) {
      index.set(`${entry.type}|${entry.key ?? ''}`, entry.item);
    }
    return index;
  }

  /** The item a device stands for in the last snapshot, null when absent. */
  itemFor(record, type, key) {
    return record.index?.get(`${type}|${key ?? ''}`) ?? null;
  }

  // --- Devices -----------------------------------------------------------------

  discoveredDevices() {
    const devices = [];
    for (const record of [...this.records.values()].sort((a, b) => a.server.slot - b.server.slot)) {
      const context = this.context(record);
      for (const entry of this.items(record)) {
        devices.push(
          buildDevice(this.gladys, {
            ...entry,
            slot: record.server.slot,
            context,
            language: this.config.language,
          }),
        );
      }
    }
    return devices;
  }

  /** Publish the Discovery list when it changed (a disk mounted, a container created…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
    } catch (err) {
      logger.warn(`Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read the servers, publish the list again. */
  async rediscover() {
    await this.pollAll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const found = this.find(device.external_id);
    if (!found) {
      return;
    }
    // A device deleted then added again is a new row in Gladys: no badge yet.
    this.transports.delete(device.external_id);
    await this.publishRecordStates(found.record, { force: true, only: device.external_id });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** The user deleted a device: forget what was sent for it. */
  onDeviceDeleted(device) {
    const id = device?.external_id;
    if (typeof id !== 'string') {
      return;
    }
    this.transports.delete(id);
    for (const map of [this.published, this.publishedAt]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${id}:`)) {
          map.delete(key);
        }
      }
    }
  }

  // --- Reading the servers ---------------------------------------------------------

  async pollAll({ publish = false } = {}) {
    const records = [...this.records.values()];
    const changes = await Promise.all(records.map((record) => this.poll(record)));
    await this.afterChanges(changes.some(Boolean), { publish });
  }

  /** Gladys asks for a refresh (onPoll): read that server now. */
  async pollDevice(device) {
    const found = this.find(device.external_id);
    if (found) {
      await this.afterChanges(await this.poll(found.record));
    }
  }

  /** Read again the servers whose last read is older than `freshMs` (scene actions). */
  async refreshIfStale(records = [...this.records.values()]) {
    const stale = records.filter((record) => this.now() - record.readAt >= this.timings.freshMs);
    if (stale.length > 0) {
      const changes = await Promise.all(stale.map((record) => this.poll(record)));
      await this.afterChanges(changes.some(Boolean));
    }
  }

  /**
   * Read one server and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget should be refreshed now
   */
  poll(record) {
    record.polling ??= this.read(record).finally(() => {
      record.polling = null;
    });
    return record.polling;
  }

  async read(record) {
    try {
      return await this.applySuccess(record, await record.client.read());
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      return this.applyFailure(record, err);
    }
  }

  async applySuccess(record, read) {
    if (record.dropped) {
      return false;
    }
    const { slot } = record.server;
    const now = this.now();
    const snapshot = parseSnapshot(read);
    let widgetChanged = record.error !== null || record.readAt === 0;
    if (record.error) {
      logger.info(`${this.label(record)} answers again`);
    }
    if (!record.snapshot || record.snapshot.apiVersion !== snapshot.apiVersion) {
      logger.info(
        `${this.label(record)}: Glances ${snapshot.glancesVersion ?? snapshot.apiVersion} (API v${
          snapshot.apiVersion
        })`,
      );
    }
    record.snapshot = snapshot;
    record.index = this.indexOf(record);
    record.failures = 0;
    record.down = false;
    record.error = null;
    record.readAt = now;

    const server = this.serverName(record);
    const serverDevice = this.serverId(slot);
    const childId = (type, name) => deviceIds(this.gladys, type, slot, itemKey(name)).device;

    for (const { disk, threshold } of this.watcher.disks(slot, snapshot.disks, now)) {
      logger.info(`${server} ${disk.mount}: ${disk.percent} % used (step ${threshold} %)`);
      widgetChanged = true;
      await this.fireEvent(TRIGGERS.DISK, {
        server: serverDevice,
        disk: childId(DEVICE_TYPES.DISK, disk.mount),
        threshold,
        server_name: server,
        mount_point: disk.mount,
        used_percent: Math.round(disk.percent * 10) / 10,
        free_gb: disk.free === null ? null : Math.round((disk.free / 1024 ** 3) * 10) / 10,
      });
    }
    for (const { sensor, threshold } of this.watcher.sensors(slot, snapshot.sensors, now)) {
      logger.info(`${server} ${sensor.label}: ${sensor.celsius} °C (step ${threshold} °C)`);
      await this.fireEvent(TRIGGERS.TEMPERATURE, {
        server: serverDevice,
        sensor: childId(DEVICE_TYPES.SENSOR, sensor.label),
        threshold,
        server_name: server,
        sensor_name: sensor.label,
        temperature: Math.round(sensor.celsius * 10) / 10,
      });
    }
    if (snapshot.containers) {
      for (const { name, status } of this.watcher.containers(slot, snapshot.containers, now)) {
        logger.info(`${server}: container ${name} stopped (${status})`);
        widgetChanged = true;
        await this.fireEvent(TRIGGERS.CONTAINER, {
          server: serverDevice,
          container: childId(DEVICE_TYPES.CONTAINER, name),
          server_name: server,
          container_name: name,
          status: pick(CONTAINER_STATE_TEXT[containerStateKey(status)], this.config.language),
        });
      }
    }
    this.watcher.forgetStale(slot, now, this.timings.forgetAfterMs);
    this.store.save(this.watcher.saved);

    await this.publishRecordStates(record);
    return widgetChanged;
  }

  async applyFailure(record, err) {
    if (record.dropped) {
      return false;
    }
    const wasError = record.error?.kind;
    record.error = { kind: err.kind, message: err.message };
    record.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`${this.label(record)}: ${err.message}`);
    }
    // Only silence counts as unreachable: a refused password is a
    // configuration problem, reported by the connection status.
    if (err.kind !== ERROR_KINDS.UNREACHABLE) {
      record.failures = 0;
      return wasError !== err.kind;
    }
    record.failures += 1;
    if (record.failures === 1) {
      this.scheduleRetry(record);
    }
    if (!record.down && record.failures >= this.timings.downAfterFailures) {
      record.down = true;
      await this.fireEvent(TRIGGERS.UNREACHABLE, {
        server: this.serverId(record.server.slot),
        server_name: this.serverName(record),
        error: pick(ERROR_TEXT[err.kind], this.config.language),
      });
      await this.publishRecordStates(record);
      return true;
    }
    if (record.down) {
      // Offline again after a resync or past the heartbeat (deduplicated).
      await this.publishRecordStates(record);
    }
    return wasError !== err.kind;
  }

  scheduleRetry(record) {
    clearTimeout(record.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    record.retryTimer = setTimeout(() => {
      this.poll(record)
        .then((changed) => this.afterChanges(changed))
        .catch((err) => logger.error('Retry failed', err));
    }, this.timings.retryMs);
    record.retryTimer.unref?.();
  }

  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /**
   * The states of the devices of a server the user added.
   * @param {object} record
   * @param {object} [options]
   * @param {boolean} [options.force] send even unchanged values (a device just added)
   * @param {string} [options.only] the external id of the one device to send
   */
  async publishRecordStates(record, { force = false, only = null } = {}) {
    const { slot } = record.server;
    const context = this.context(record);
    const stopped = new Set(
      record.snapshot?.containers
        ? this.watcher.stoppedContainers(slot).map((container) => itemKey(container.name))
        : [],
    );
    const values = [];
    for (const { device, type, key } of this.createdDevices(slot)) {
      if (only && device.external_id !== only) {
        continue;
      }
      if (record.error) {
        // Nothing read: only say the server is offline once it is.
        if (type === DEVICE_TYPES.SERVER && record.down) {
          values.push(
            ...featureValues(this.gladys, { type, slot, key, item: null, context }).filter(
              (entry) => entry.value !== null,
            ),
          );
        }
        continue;
      }
      if (!record.snapshot) {
        continue;
      }
      const item = this.itemFor(record, type, key);
      if (type === DEVICE_TYPES.CONTAINER && !item && !stopped.has(key)) {
        // Missing from this read only (being recreated?), or no container
        // plugin: nothing known yet. Stopped once the watcher confirmed it.
        continue;
      }
      values.push(...featureValues(this.gladys, { type, slot, key, item, context }));
    }
    await this.sendStates(values, { force });
  }

  /** Keep what must be sent now: changed, not too soon, within the budget. */
  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const due = [];
    for (const { externalId, value, noisy } of values) {
      if (value === null) {
        continue;
      }
      const last = this.published.get(externalId);
      const at = this.publishedAt.get(externalId);
      if (!force) {
        if (last === value && at !== undefined && now - at < this.timings.heartbeatMs) {
          continue;
        }
        if (last !== value && noisy && at !== undefined && now - at < this.timings.noisyEveryMs) {
          continue;
        }
      }
      due.push({ externalId, value, noisy });
    }
    this.sentTimes = this.sentTimes.filter((time) => now - time < 60_000);
    let states = due;
    if (!force) {
      const allowed = Math.max(0, this.timings.statesPerMinute - this.sentTimes.length);
      if (due.length > allowed) {
        // The quiet values first (a disk, a container state); the rest waits.
        states = [...due.filter((s) => !s.noisy), ...due.filter((s) => s.noisy)].slice(0, allowed);
      }
    }
    // Reserved before any request: several servers publish at the same time.
    for (let i = 0; i < states.length; i += 1) {
      this.sentTimes.push(now);
    }
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      const batch = states.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(
          batch.map(({ externalId, value }) => ({
            device_feature_external_id: externalId,
            state: value,
          })),
        );
        for (const { externalId, value } of batch) {
          this.published.set(externalId, value);
          this.publishedAt.set(externalId, now);
        }
      } catch (err) {
        logger.warn(`States refused: ${err.message}`);
        for (let i = 0; i < batch.length; i += 1) {
          const index = this.sentTimes.lastIndexOf(now);
          if (index >= 0) {
            this.sentTimes.splice(index, 1);
          }
        }
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: "local", or "unreachable" with their server. */
  async publishTransports() {
    const entries = [];
    for (const record of this.records.values()) {
      if (record.readAt === 0) {
        continue;
      }
      const transport =
        record.error === null ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      for (const { device } of this.createdDevices(record.server.slot)) {
        if (this.transports.get(device.external_id) !== transport) {
          entries.push({ external_id: device.external_id, transport });
        }
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        logger.warn(`Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name: connected when every server answers. */
  connectionStatus() {
    if (!this.config) {
      return { connected: false, message: CONNECTION_TEXT.noServer };
    }
    const { servers, invalidSlots } = this.config;
    if (servers.length === 0) {
      return {
        connected: false,
        message: invalidSlots.length ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noServer,
      };
    }
    const failing = [...this.records.values()].filter((record) => record.error);
    if (failing.length === 0 && invalidSlots.length === 0) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noServer)) {
      const parts = failing.map((record) =>
        labelled(this.serverName(record), pick(ERROR_TEXT[record.error.kind], language), language),
      );
      if (invalidSlots.length) {
        parts.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = parts.join(' · ').slice(0, 200);
    }
    // Connected while one server of several still answers.
    return { connected: failing.length < this.records.size, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
    } catch (err) {
      logger.warn(`Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions, report) --------------------------------------------

  /**
   * The server of any of its devices (the server itself, a disk, a container…).
   * @returns {{ record: object, type: string, key: string|null }|null}
   */
  find(externalId) {
    const parsed = parseDeviceId(this.gladys, externalId);
    const record = parsed ? this.records.get(parsed.slot) : null;
    return record ? { record, type: parsed.type, key: parsed.key } : null;
  }

  /** What the widget and the scene actions show of a server. */
  view(record, { disk = null } = {}) {
    const { snapshot } = record;
    const chosenDisk =
      disk && snapshot
        ? (snapshot.disks.find((entry) => itemKey(entry.mount) === disk) ?? null)
        : null;
    return {
      name: this.serverName(record),
      online: record.error === null && snapshot !== null,
      error: record.error,
      snapshot,
      disk: chosenDisk ?? (snapshot ? mainDisk(snapshot) : null),
      stopped: this.watcher.stoppedContainers(record.server.slot),
    };
  }

  /** "Test the connection": read every server now, one line each. */
  async testConnection() {
    await this.pollAll({ publish: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (this.records.size === 0) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const lines = [...this.records.values()].map((record) => {
        const name = this.serverName(record);
        if (record.error) {
          return labelled(name, pick(ERROR_TEXT[record.error.kind], language), language);
        }
        const { snapshot } = record;
        const parts = [
          text.ok,
          `Glances ${snapshot.glancesVersion ?? snapshot.apiVersion} (API v${snapshot.apiVersion})`,
          text.disks(snapshot.disks.length),
          text.interfaces(snapshot.interfaces.length),
          text.sensors(snapshot.sensors.length),
        ];
        if (snapshot.containers) {
          parts.push(text.containers(snapshot.containers.filter((c) => c.running).length));
        }
        return labelled(name, parts.join(', '), language);
      });
      if (this.config?.invalidSlots.length) {
        lines.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = lines.join('\n');
    }
    return message;
  }

  /** Throws the reason no server can answer a scene action, if any. */
  assertReadable() {
    if (this.records.size === 0) {
      throw new Error(pick(ACTION_TEXT.noServer, this.config?.language));
    }
  }
}
