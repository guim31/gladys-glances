// -----------------------------------------------------------------------------
// Glances client: the REST API of the Glances web server (`glances -w`, port
// 61208), version 4 (Glances 4.x) or 3 (Glances 3.x, still widespread on
// NAS and distributions). The version is detected once, from
// `/api/<v>/pluginslist`: a Glances 4 answers 404 under /api/3 and the
// reverse. The plugins disabled on the server (`--disable-plugin`) are absent
// from that list and answer 400: they are simply not read.
//
// One GET per plugin read, never `/api/<v>/all`: `all` carries the process
// list, hundreds of kB on a busy host, read for nothing every 30 seconds.
//
// Authentication (`glances -w --password`): HTTP Basic, user name `glances`
// unless the server was started with `--username`. Glances hashes the
// password it checks (PBKDF2, 100,000 rounds): a request costs the server a
// few milliseconds, never a reason to read faster.
//
// Read only: the Glances API changes nothing on the server.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: off, wrong address, firewall, Glances stopped
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // user name or password refused
  PASSWORD_MISSING: 'password_missing', // Glances asks for a password and none is configured
  NOT_GLANCES: 'not_glances', // something answers, not the API of Glances 3 or 4
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  HTTP: 'http', // any other HTTP error
});

export class GlancesError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status, location }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GlancesError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// The plugins read at every refresh, when the server has them.
export const PLUGINS = Object.freeze([
  'cpu',
  'load',
  'mem',
  'memswap',
  'uptime',
  'fs',
  'network',
  'sensors',
  'containers',
  // Name of the containers plugin up to Glances 3.3.
  'docker',
]);

// Read when the server is (re)detected only: they do not move.
export const STATIC_PLUGINS = Object.freeze(['system', 'version']);

export const API_VERSIONS = Object.freeze([4, 3]);

// A server is detected again after this long: a Glances upgraded from 3 to 4
// in place, a host renamed.
export const REDETECT_AFTER_MS = 3600_000;

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class GlancesClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} [options.username]
   * @param {string} [options.password] '' for none
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   * @param {() => number} [options.now]
   */
  constructor({
    url,
    username = 'glances',
    password = '',
    insecure = false,
    request = httpRequest,
    timeoutMs = 15_000,
    now = () => Date.now(),
  }) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {3|4|null} API version, null until detected */
    this.apiVersion = null;
    /** @type {Set<string>} plugins the server serves */
    this.plugins = new Set();
    this.detectedAt = 0;
    /** The `system` and `version` plugins, read at detection. */
    this.static = {};
  }

  headers() {
    const headers = { accept: 'application/json' };
    if (this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    return headers;
  }

  /**
   * One GET. Resolves `{ status, data }` for 200 (`data` parsed), 400 and
   * 404 (`data` null): what they mean depends on the request. Throws a
   * GlancesError for everything else.
   */
  async get(path) {
    let response;
    try {
      response = await this.request(`${this.url}${path}`, {
        headers: this.headers(),
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (TLS_CODES.has(err.code)) {
        throw new GlancesError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      throw new GlancesError(ERROR_KINDS.UNREACHABLE, err.code ? `${err.code}` : err.message);
    }
    const { status } = response;
    if (status === 401 || status === 403) {
      throw this.password
        ? new GlancesError(ERROR_KINDS.AUTH, `Credentials refused (HTTP ${status})`, { status })
        : new GlancesError(ERROR_KINDS.PASSWORD_MISSING, `A password is needed (HTTP ${status})`, {
            status,
          });
    }
    if (status >= 300 && status < 400) {
      throw new GlancesError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, {
        status,
        location: response.headers?.location,
      });
    }
    if (status === 400 || status === 404) {
      return { status, data: null };
    }
    if (status !== 200) {
      throw new GlancesError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, { status });
    }
    try {
      return { status, data: JSON.parse(response.body) };
    } catch {
      // An HTML page: the web interface of another service, a login portal.
      throw new GlancesError(ERROR_KINDS.NOT_GLANCES, 'The answer is not JSON');
    }
  }

  /** Find the API version and the plugins of the server. */
  async detect() {
    for (const version of API_VERSIONS) {
      const { status, data } = await this.get(`/api/${version}/pluginslist`);
      if (status === 404) {
        continue;
      }
      if (status !== 200 || !Array.isArray(data)) {
        break;
      }
      this.plugins = new Set(data.filter((name) => typeof name === 'string'));
      this.apiVersion = version;
      this.static = {};
      for (const plugin of STATIC_PLUGINS.filter((name) => this.plugins.has(name))) {
        const answer = await this.get(`/api/${version}/${plugin}`);
        if (answer.status === 200) {
          this.static[plugin] = answer.data;
        }
      }
      this.detectedAt = this.now();
      return;
    }
    this.apiVersion = null;
    throw new GlancesError(ERROR_KINDS.NOT_GLANCES, 'No Glances API v3 or v4 at this address');
  }

  /**
   * Read every plugin of PLUGINS the server serves.
   * @returns {Promise<{ apiVersion: 3|4, plugins: Set<string>, static: object, data: object }>}
   *   `data`: the raw answer of each plugin read (a disabled one is absent)
   * @throws {GlancesError}
   */
  async read({ retried = false } = {}) {
    if (this.apiVersion === null || this.now() - this.detectedAt >= REDETECT_AFTER_MS) {
      await this.detect();
    }
    const version = this.apiVersion;
    const wanted = PLUGINS.filter((plugin) => this.plugins.has(plugin));
    const answers = await Promise.all(
      wanted.map((plugin) => this.get(`/api/${version}/${plugin}`)),
    );
    const data = {};
    let moved = false;
    answers.forEach(({ status, data: body }, index) => {
      if (status === 200) {
        data[wanted[index]] = body;
      } else if (status === 404) {
        moved = true;
      }
    });
    if (moved) {
      // The API moved under our feet (Glances upgraded in place): detect again, once.
      this.apiVersion = null;
      if (retried) {
        throw new GlancesError(ERROR_KINDS.NOT_GLANCES, 'The Glances API answers 404');
      }
      return this.read({ retried: true });
    }
    return { apiVersion: version, plugins: this.plugins, static: this.static, data };
  }
}
