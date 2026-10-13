// -----------------------------------------------------------------------------
// What the scene triggers compare with, read after read: the transitions of
// disks, temperature sensors and containers. Pure bookkeeping, no I/O: the
// hub (src/hub.js) feeds it every successful read and fires the events it
// returns. The tables live in /data (src/store.js) so a restart neither
// repeats an announcement nor misses one.
//
// The scene filters of Gladys only compare for equality: a threshold cannot
// be a filter on a value. So each trigger carries a `threshold` filter among
// fixed steps, and one event is fired per step crossed: a scene "disk almost
// full, 90 %" matches the event of the 90 % step and nothing else.
//
//   - disks: fired at the first read at or above a step, announced again
//     only once the disk went back 2 points below it (a cleaned disk);
//   - temperatures: two reads in a row at or above a step (a CPU spikes for
//     a second at every compilation), again only once 5 °C below it, and not
//     twice within 30 minutes for the same sensor and step;
//   - containers: a container seen running and missing, or not running, on
//     two reads in a row (a `docker compose` update recreates it within
//     seconds). With its default settings Glances lists the running
//     containers only: a stopped container is a missing one.
//
// The first time an item is seen, its state is recorded without any event:
// nothing has changed, and no scene could exist yet at the very first read.
// -----------------------------------------------------------------------------

export const DISK_THRESHOLDS = Object.freeze([80, 85, 90, 95, 98]);
export const DISK_REARM_POINTS = 2;

export const TEMPERATURE_THRESHOLDS = Object.freeze([50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
export const TEMPERATURE_REARM_DEGREES = 5;
export const TEMPERATURE_CONFIRM_READS = 2;
export const TEMPERATURE_COOLDOWN_MS = 30 * 60_000;

export const CONTAINER_CONFIRM_READS = 2;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const numbers = (value) => (Array.isArray(value) ? value.filter(Number.isFinite) : []);
const slotOf = (id) => Number(id.split(':')[0]);

export class Watcher {
  constructor(saved = {}) {
    const tables = object(saved);
    this.saved = {
      containers: object(tables.containers),
      disks: object(tables.disks),
      sensors: object(tables.sensors),
    };
    /** Reads in a row a container was seen not running, by id. */
    this.misses = new Map();
    /** Reads in a row a sensor was at or above a step, by `id|step`. */
    this.highs = new Map();
  }

  /**
   * @param {number} slot
   * @param {Array<{ mount: string, percent: number }>} disks
   * @returns {Array<{ disk: object, threshold: number }>} the steps crossed
   */
  disks(slot, disks, now) {
    const crossed = [];
    for (const disk of disks) {
      const id = `${slot}:${disk.mount}`;
      const entry = this.saved.disks[id];
      if (!entry) {
        this.saved.disks[id] = {
          above: DISK_THRESHOLDS.filter((step) => disk.percent >= step),
          seenAt: now,
        };
        continue;
      }
      const above = new Set(numbers(entry.above));
      for (const step of DISK_THRESHOLDS) {
        if (disk.percent >= step && !above.has(step)) {
          above.add(step);
          crossed.push({ disk, threshold: step });
        } else if (disk.percent < step - DISK_REARM_POINTS) {
          above.delete(step);
        }
      }
      this.saved.disks[id] = { above: [...above].sort((a, b) => a - b), seenAt: now };
    }
    return crossed;
  }

  /**
   * @param {number} slot
   * @param {Array<{ label: string, celsius: number }>} sensors
   * @returns {Array<{ sensor: object, threshold: number }>} the steps crossed
   */
  sensors(slot, sensors, now) {
    const crossed = [];
    for (const sensor of sensors) {
      const id = `${slot}:${sensor.label}`;
      const entry = this.saved.sensors[id];
      if (!entry) {
        this.saved.sensors[id] = {
          above: TEMPERATURE_THRESHOLDS.filter((step) => sensor.celsius >= step),
          firedAt: {},
          seenAt: now,
        };
        continue;
      }
      const above = new Set(numbers(entry.above));
      const firedAt = object(entry.firedAt);
      for (const step of TEMPERATURE_THRESHOLDS) {
        const highKey = `${id}|${step}`;
        if (sensor.celsius >= step) {
          if (above.has(step)) {
            continue;
          }
          const reads = (this.highs.get(highKey) ?? 0) + 1;
          if (reads < TEMPERATURE_CONFIRM_READS) {
            this.highs.set(highKey, reads);
            continue;
          }
          this.highs.delete(highKey);
          above.add(step);
          // Within the cooldown, the step is taken silently: re-armed only
          // once the sensor cooled down, like after an announcement.
          if (!(now - (firedAt[step] ?? -Infinity) < TEMPERATURE_COOLDOWN_MS)) {
            firedAt[step] = now;
            crossed.push({ sensor, threshold: step });
          }
        } else {
          this.highs.delete(highKey);
          if (sensor.celsius < step - TEMPERATURE_REARM_DEGREES) {
            above.delete(step);
          }
        }
      }
      this.saved.sensors[id] = {
        above: [...above].sort((a, b) => a - b),
        firedAt,
        seenAt: now,
      };
    }
    return crossed;
  }

  /**
   * @param {number} slot
   * @param {Array<{ name: string, status: string, running: boolean }>} containers
   *   the containers Glances listed
   * @returns {Array<{ name: string, status: string }>} the containers that stopped
   */
  containers(slot, containers, now) {
    const stopped = [];
    const listed = new Set();
    const notRunning = (id, name, status) => {
      const entry = this.saved.containers[id];
      if (!entry?.running) {
        return;
      }
      const misses = (this.misses.get(id) ?? 0) + 1;
      if (misses < CONTAINER_CONFIRM_READS) {
        this.misses.set(id, misses);
        return;
      }
      this.misses.delete(id);
      this.saved.containers[id] = { ...entry, running: false, status, since: now };
      stopped.push({ name, status });
    };

    for (const container of containers) {
      const id = `${slot}:${container.name}`;
      listed.add(id);
      const entry = this.saved.containers[id];
      if (container.running) {
        this.misses.delete(id);
        this.saved.containers[id] = {
          running: true,
          everRan: true,
          status: container.status,
          since: entry?.running ? entry.since : now,
          seenAt: now,
        };
      } else if (!entry) {
        this.saved.containers[id] = {
          running: false,
          everRan: false,
          status: container.status,
          since: now,
          seenAt: now,
        };
      } else {
        this.saved.containers[id] = { ...this.saved.containers[id], seenAt: now };
        notRunning(id, container.name, container.status);
      }
    }
    for (const id of Object.keys(this.saved.containers)) {
      if (slotOf(id) === slot && !listed.has(id)) {
        notRunning(id, id.slice(id.indexOf(':') + 1), 'absent');
      }
    }
    return stopped;
  }

  /** Whether containers were ever seen on this server. */
  hasContainers(slot) {
    return Object.keys(this.saved.containers).some((id) => slotOf(id) === slot);
  }

  /** The containers seen running before and stopped since, by name. */
  stoppedContainers(slot) {
    return Object.entries(this.saved.containers)
      .filter(([id, entry]) => slotOf(id) === slot && entry && !entry.running && entry.everRan)
      .map(([id, entry]) => ({ name: id.slice(id.indexOf(':') + 1), ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Forget the servers removed from the configuration. */
  forgetSlots(kept) {
    let changed = false;
    for (const table of Object.values(this.saved)) {
      for (const id of Object.keys(table)) {
        if (!kept.has(slotOf(id))) {
          delete table[id];
          changed = true;
        }
      }
    }
    for (const map of [this.misses, this.highs]) {
      for (const id of map.keys()) {
        if (!kept.has(slotOf(id))) {
          map.delete(id);
        }
      }
    }
    return changed;
  }

  /** Forget what was not seen for `maxAgeMs` (a container removed, a disk unplugged). */
  forgetStale(now, maxAgeMs) {
    for (const table of Object.values(this.saved)) {
      for (const [id, entry] of Object.entries(table)) {
        if (!(entry?.seenAt >= now - maxAgeMs)) {
          delete table[id];
          this.misses.delete(id);
        }
      }
    }
  }
}
