// -----------------------------------------------------------------------------
// An in-memory Glances web server, serving the real answers recorded from
// Glances 4.5.8 and 3.4.0.5 (test/fixtures/glances), with the behaviours seen
// on the real servers: 404 under the other API version, 400 for a plugin not
// served, 401 without the right Basic credentials. The tests change its
// plugins (a disk filling up, a container stopping) between two reads.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';

export const PASSWORD = 'test-glances-password';

const FIXTURES = new URL('../fixtures/glances/', import.meta.url);

/** The recorded answers of one Glances, plugin by plugin. */
export function loadFixtures(directory) {
  const base = new URL(`${directory}/`, FIXTURES);
  const plugins = {};
  for (const file of readdirSync(base)) {
    if (file.endsWith('.json')) {
      plugins[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(new URL(file, base), 'utf8'));
    }
  }
  return plugins;
}

export const readFixture = (path) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8'));

export class FakeGlances {
  /**
   * @param {object} [options]
   * @param {3|4} [options.version]
   * @param {string|null} [options.password] null: no authentication
   * @param {string} [options.username]
   * @param {object} [options.plugins] plugin answers (the recorded ones by default)
   */
  constructor({ version = 4, password = null, username = 'glances', plugins } = {}) {
    this.version = version;
    this.password = password;
    this.username = username;
    this.plugins = structuredClone(plugins ?? loadFixtures(`v${version}`));
    /** 'down' (no answer), 'html' (another service), 'redirect', or an HTTP status */
    this.failure = null;
    this.requests = [];
  }

  /** Plugins served: the pluginslist follows what the tests set. */
  get pluginslist() {
    return Object.keys(this.plugins).filter((name) => name !== 'pluginslist');
  }

  disable(...names) {
    for (const name of names) {
      delete this.plugins[name];
    }
  }

  /** Set the use of a disk (mount point), keeping size and free coherent. */
  setDisk(mount, percent) {
    const disk = this.plugins.fs.find((entry) => entry.mnt_point === mount);
    disk.percent = percent;
    disk.used = Math.round((disk.size * percent) / 100);
    disk.free = disk.size - disk.used;
  }

  setSensor(label, value) {
    this.plugins.sensors.find((entry) => entry.label === label).value = value;
  }

  get containerList() {
    const raw = this.plugins.containers;
    return Array.isArray(raw) ? raw : raw.containers;
  }

  /** Change the status of a container, or remove it from the list (null). */
  setContainer(name, status) {
    const list = this.containerList;
    const index = list.findIndex((entry) => entry.name === name);
    if (status === null) {
      list.splice(index, 1);
    } else if (this.version >= 4) {
      list[index].status = status;
    } else {
      list[index].Status = status;
    }
  }

  async handle(path, { headers = {} } = {}) {
    this.requests.push(path);
    if (this.failure === 'down') {
      const error = new Error('connect ECONNREFUSED');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    if (this.failure === 'html') {
      return { status: 200, headers: {}, body: '<!doctype html><title>Router</title>' };
    }
    if (this.failure === 'redirect') {
      return { status: 301, headers: { location: 'https://example.invalid/' }, body: '' };
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, headers: {}, body: 'error' };
    }
    if (this.password !== null) {
      const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString(
        'base64',
      )}`;
      if (headers.authorization !== expected) {
        return { status: 401, headers: {}, body: '{"detail":"Unauthorized"}' };
      }
    }
    const match = path.match(/^\/api\/(\d+)\/([a-z]+)$/);
    if (!match || Number(match[1]) !== this.version) {
      return { status: 404, headers: {}, body: '{"detail":"Not Found"}' };
    }
    const plugin = match[2];
    if (plugin === 'pluginslist') {
      return { status: 200, headers: {}, body: JSON.stringify(this.pluginslist) };
    }
    if (plugin === 'all') {
      const all = Object.fromEntries(
        Object.entries(this.plugins).filter(([name]) => name !== 'pluginslist'),
      );
      // The process list Glances adds, which per-plugin reads avoid.
      all.processlist = [];
      return { status: 200, headers: {}, body: JSON.stringify(all) };
    }
    if (!(plugin in this.plugins)) {
      return { status: 400, headers: {}, body: '{"detail":"Unknown plugin"}' };
    }
    return { status: 200, headers: {}, body: JSON.stringify(this.plugins[plugin]) };
  }
}

/**
 * A network of fake Glances servers, by base URL: the `request` function the
 * client takes. An unknown address does not answer.
 */
export function createNetwork(servers) {
  const network = {
    servers,
    async request(url, options) {
      for (const [base, server] of Object.entries(network.servers)) {
        if (url.startsWith(`${base}/`)) {
          return server.handle(url.slice(base.length), options);
        }
      }
      const error = new Error('connect EHOSTUNREACH');
      error.code = 'EHOSTUNREACH';
      throw error;
    },
  };
  return network;
}
