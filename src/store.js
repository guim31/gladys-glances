// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container):
// what the scene triggers compare with — the containers seen running, the
// disk and temperature thresholds already announced — so that a restart of
// the integration or of Gladys neither misses a transition nor announces one
// twice. Losing the file is harmless: the first read after it only records
// the states, without scene events.
// (Adapted from guim31/gladys-uptime-kuma.)
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createIssueLog } from './logs.js';

const logger = createLogger({ name: 'glances-store' });
const FILE_NAME = 'glances-state.json';

export class Store {
  constructor(directory = process.env.GLANCES_DATA_DIR || '/data') {
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    this.writing = null;
    // A /data that refuses writes refuses them at every read: logged once.
    this.issues = createIssueLog(logger);
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  // Writes are coalesced and atomic (temporary file + rename): a crash never
  // leaves half a JSON file behind.
  save(data) {
    this.latest = data;
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot));
          await rename(temporary, this.path);
          this.issues.ok('write', `${this.path} written again`);
        } catch (err) {
          this.issues.fail('write', 'warn', `Cannot write ${this.path}: ${err.message}`);
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
