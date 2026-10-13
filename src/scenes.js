// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is the CPU above 80 %?" is already a scene condition on the device
// features. "State of a server" is what a condition cannot do: put the state
// of a server in a message ("NAS: CPU 12 %, memory 45 %, disk / 78 %…"),
// with every figure as an output too, for the devices the user did not add.
// It reads Glances again when the last read is older than 15 seconds. An
// unreachable server is an answer, not a failure: `online` false, and the
// summary says so — the scene can still send it.
// -----------------------------------------------------------------------------

import { hottest } from './glances/model.js';
import {
  ACTION_TEXT,
  ERROR_TEXT,
  SUMMARY_TEXT,
  formatCelsius,
  formatGigabytes,
  formatPercent,
  labelled,
  pick,
} from './texts.js';

// Container names listed in the summary, at most (the rest is counted).
export const MAX_LISTED_NAMES = 10;

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The one-line state of a server, in the configured language. */
export function summarize(view, language) {
  const text = SUMMARY_TEXT[language] ?? SUMMARY_TEXT.en;
  if (!view.online) {
    const reason = view.error ? pick(ERROR_TEXT[view.error.kind], language) : text.unreachable;
    return labelled(view.name, reason, language);
  }
  const { snapshot, disk } = view;
  const parts = [];
  if (snapshot.cpu !== null) {
    parts.push(`${text.cpu} ${formatPercent(snapshot.cpu, language)}`);
  }
  if (snapshot.memory !== null) {
    parts.push(`${text.memory} ${formatPercent(snapshot.memory, language)}`);
  }
  if (disk) {
    const free = disk.free === null ? '' : ` (${text.free(formatGigabytes(disk.free, language))})`;
    parts.push(`${text.disk} ${disk.mount} ${formatPercent(disk.percent, language)}${free}`);
  }
  const hot = hottest(snapshot);
  if (hot) {
    parts.push(formatCelsius(hot.celsius, language));
  }
  if (snapshot.containers) {
    parts.push(text.running(snapshot.containers.filter((c) => c.running).length));
  }
  if (view.stopped.length > 0) {
    const names = view.stopped.map((container) => container.name);
    const listed = names.slice(0, MAX_LISTED_NAMES);
    const more = names.length > listed.length ? `, +${names.length - listed.length}` : '';
    parts.push(text.stopped(`${listed.join(', ')}${more}`));
  }
  return labelled(view.name, parts.join(', '), language);
}

export const SCENE_ACTIONS = {
  async get_server_status(hub, { fields = {} }) {
    hub.assertReadable();
    const language = hub.config.language;
    const found = hub.find(fields.server);
    if (!found) {
      throw new Error(pick(ACTION_TEXT.unknownServer, language));
    }
    await hub.refreshIfStale([found.record]);
    // Read again: the server may have been reconfigured meanwhile.
    const record = hub.find(fields.server)?.record ?? found.record;
    const view = hub.view(record);
    const outputs = { name: view.name, online: view.online, summary: summarize(view, language) };
    if (!view.online) {
      return outputs;
    }
    const { snapshot, disk } = view;
    const set = (key, value, digits = 1) => {
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        outputs[key] = round(value, digits);
      }
    };
    set('cpu', snapshot.cpu);
    set('memory', snapshot.memory);
    set('swap', snapshot.swap);
    set('load_1', snapshot.load?.min1, 2);
    set('load_5', snapshot.load?.min5, 2);
    set('load_15', snapshot.load?.min15, 2);
    set('uptime_days', snapshot.uptime === null ? null : snapshot.uptime / 86400, 2);
    if (disk) {
      set('disk_percent', disk.percent);
      set('disk_free_gb', disk.free === null ? null : disk.free / 1024 ** 3);
    }
    set('temperature', hottest(snapshot)?.celsius);
    if (snapshot.containers) {
      outputs.containers_running = snapshot.containers.filter((c) => c.running).length;
      outputs.containers_stopped = view.stopped.length;
    }
    return outputs;
  },
};
