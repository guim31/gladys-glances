// -----------------------------------------------------------------------------
// From the raw answers of the Glances plugins (API v3 or v4) to one snapshot
// of the server, the same whatever the version. Every value may be missing
// (a plugin disabled on the server, a field Glances could not measure): the
// snapshot then says null, and nothing is published for it.
//
// Differences between the versions, seen on real Glances 3.4.0.5 and 4.5.8
// (test/fixtures/glances) and in the glances-api fixtures:
//   - network: v4 gives `bytes_recv_rate_per_sec`; v3 gives the bytes since
//     the previous refresh (`rx`) and `time_since_update`; v4 has no `is_up`.
//   - containers: v4 answers a list, `status` (the health status when the
//     image has a health check: "healthy", "unhealthy", "starting"); v3 a
//     `{ version, containers }` object, `Status`; Glances 3.3 and older name
//     the plugin `docker`. By default Glances lists the running containers
//     only: a stopped container disappears from the answer.
//   - cpu: the first read of a freshly started Glances 4 answers zeros
//     everywhere, `idle` included: not a measure.
//   - version: Glances 4 has a `version` plugin, Glances 3 none.
// -----------------------------------------------------------------------------

// Container states that mean "it runs". A health status replaces "running"
// in Glances 4: an unhealthy container still runs.
export const RUNNING_STATES = new Set(['running', 'healthy', 'unhealthy', 'starting']);

// Mount points that are no disks: the files Docker binds into a Glances
// container, and the kernel pseudo file systems Docker masks with tmpfs
// (listed when Glances is told to show tmpfs, `[fs] allow=tmpfs`).
const DOCKER_FILES = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf']);
const PSEUDO_MOUNTS = /^\/(proc|sys|dev)(\/|$)|\/docker\.sock$/;

// Interfaces that carry nothing a user follows: loopback, container and VM
// plumbing, tunnels.
const HIDDEN_INTERFACES =
  /^(lo|veth.*|br-[0-9a-f]{12}|docker\d+|virbr\d+-nic|tunl\d+|sit\d+|ip6tnl\d+|ip_vti\d+|gre\d+|gretap\d+|erspan\d+|dummy\d+|cali.*|flannel.*|cni\d+|vxlan.*|kube-.*)$/;

// A sensor reading outside this range is a glitch (an unread register).
const TEMPERATURE_RANGE = [-50, 150];

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * Glances formats the uptime with Python's timedelta: "4 days, 4:33:27",
 * "1 day, 0:01:02", "4:33:27" (microseconds sometimes kept).
 * @returns {number|null} seconds
 */
export function parseUptime(value) {
  if (typeof value === 'number') {
    return num(value);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(/^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!match) {
    return null;
  }
  const [, days = '0', hours, minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function parseCpu(cpu) {
  const total = num(cpu?.total);
  if (total === null) {
    return null;
  }
  // A freshly started Glances 4 answers zeros everywhere: nothing measured yet.
  if (total === 0 && num(cpu.idle) === 0) {
    return null;
  }
  return Math.min(100, Math.max(0, total));
}

function parseDisks(fs) {
  const disks = [];
  const seen = new Set();
  for (const entry of list(fs)) {
    const mount = typeof entry?.mnt_point === 'string' ? entry.mnt_point : null;
    const size = num(entry?.size);
    const percent = num(entry?.percent);
    if (
      !mount ||
      DOCKER_FILES.has(mount) ||
      PSEUDO_MOUNTS.test(mount) ||
      seen.has(mount) ||
      !size ||
      percent === null
    ) {
      continue;
    }
    seen.add(mount);
    const used = num(entry.used);
    const free = num(entry.free) ?? (used === null ? null : Math.max(0, size - used));
    disks.push({
      mount,
      device: typeof entry.device_name === 'string' ? entry.device_name : null,
      fsType: typeof entry.fs_type === 'string' ? entry.fs_type : null,
      percent: Math.min(100, Math.max(0, percent)),
      size,
      free,
    });
  }
  return disks;
}

function parseInterfaces(network, apiVersion) {
  const interfaces = [];
  const seen = new Set();
  for (const entry of list(network)) {
    const name = typeof entry?.interface_name === 'string' ? entry.interface_name : null;
    if (!name || HIDDEN_INTERFACES.test(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    let rx = null;
    let tx = null;
    if (apiVersion >= 4) {
      rx = num(entry.bytes_recv_rate_per_sec);
      tx = num(entry.bytes_sent_rate_per_sec);
    } else {
      const elapsed = num(entry.time_since_update);
      if (elapsed && elapsed > 0) {
        rx = num(entry.rx) === null ? null : entry.rx / elapsed;
        tx = num(entry.tx) === null ? null : entry.tx / elapsed;
      }
    }
    interfaces.push({
      name,
      rx: rx === null ? null : Math.max(0, rx),
      tx: tx === null ? null : Math.max(0, tx),
      speed: num(entry.speed),
    });
  }
  return interfaces;
}

function parseSensors(sensors) {
  const parsed = [];
  const seen = new Set();
  for (const entry of list(sensors)) {
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    const type = typeof entry?.type === 'string' ? entry.type : '';
    let value = num(entry?.value);
    if (!label || !type.startsWith('temperature') || value === null) {
      continue;
    }
    // Glances started with --fahrenheit converts its readings.
    if (entry.unit === 'F') {
      value = ((value - 32) * 5) / 9;
    }
    if (value < TEMPERATURE_RANGE[0] || value > TEMPERATURE_RANGE[1]) {
      continue;
    }
    // Two chips may share a label (two NVMe drives, both "Composite"): the
    // next ones are numbered, in the order Glances lists them.
    let unique = label;
    for (let n = 2; seen.has(unique); n += 1) {
      unique = `${label} (${n})`;
    }
    seen.add(unique);
    parsed.push({ label: unique, type, celsius: value });
  }
  return parsed;
}

function parseContainer(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.replace(/^\//, '') : '';
  if (!name) {
    return null;
  }
  const rawStatus = entry.status ?? entry.Status;
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : 'unknown';
  const running = RUNNING_STATES.has(status);
  const memory = object(entry.memory);
  const usage = num(memory.usage) ?? num(entry.memory_usage);
  // What `docker stats` and the Glances interface show: the page cache left out.
  const cache = num(memory.inactive_file) ?? num(memory.cache) ?? 0;
  return {
    name,
    status,
    running,
    cpu: running ? (num(entry.cpu?.total) ?? num(entry.cpu_percent)) : 0,
    memory: running ? (usage === null ? null : Math.max(0, usage - cache)) : 0,
    memoryLimit: num(memory.limit) ?? num(entry.memory_limit),
    engine: typeof entry.engine === 'string' ? entry.engine : null,
  };
}

function parseContainers(data) {
  const raw = data.containers ?? data.docker;
  if (raw === undefined) {
    return null; // plugin disabled, or no container engine support
  }
  const entries = Array.isArray(raw) ? raw : list(object(raw).containers);
  const containers = [];
  const seen = new Set();
  for (const entry of entries) {
    const container = parseContainer(entry);
    if (container && !seen.has(container.name)) {
      seen.add(container.name);
      containers.push(container);
    }
  }
  return containers;
}

/**
 * @param {{ apiVersion: number, static?: object, data?: object }} read see GlancesClient#read
 */
export function parseSnapshot({ apiVersion, static: fixed = {}, data = {} }) {
  const system = object(fixed.system);
  const load = object(data.load);
  const mem = object(data.mem);
  const swap = object(data.memswap);
  const cores = num(load.cpucore) ?? num(data.cpu?.cpucore);
  const swapTotal = num(swap.total);
  return {
    apiVersion,
    glancesVersion: typeof fixed.version === 'string' ? fixed.version : null,
    hostname: typeof system.hostname === 'string' ? system.hostname : null,
    os: typeof system.hr_name === 'string' ? system.hr_name : null,
    cpu: parseCpu(data.cpu),
    cores: cores && cores > 0 ? Math.round(cores) : null,
    load:
      num(load.min1) === null
        ? null
        : { min1: load.min1, min5: num(load.min5), min15: num(load.min15) },
    memory: num(mem.percent),
    swap: swapTotal && num(swap.percent) !== null ? swap.percent : null,
    uptime: parseUptime(data.uptime),
    disks: parseDisks(data.fs),
    interfaces: parseInterfaces(data.network, apiVersion),
    sensors: parseSensors(data.sensors),
    containers: parseContainers(data),
  };
}

/** The hottest temperature sensor, null without any. */
export function hottest(snapshot) {
  let best = null;
  for (const sensor of snapshot?.sensors ?? []) {
    if (!best || sensor.celsius > best.celsius) {
      best = sensor;
    }
  }
  return best;
}

// Where Glances run in Docker sees the host root: `-v /:/rootfs:ro`.
const MAIN_MOUNTS = ['/', '/rootfs', '/host', '/hostfs'];

/** The disk to show by default: the root, else the largest. */
export function mainDisk(snapshot) {
  const disks = snapshot?.disks ?? [];
  for (const mount of MAIN_MOUNTS) {
    const disk = disks.find((entry) => entry.mount === mount);
    if (disk) {
      return disk;
    }
  }
  return disks.reduce((best, disk) => (!best || disk.size > best.size ? disk : best), null);
}
