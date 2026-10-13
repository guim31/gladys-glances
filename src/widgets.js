// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `server`.
//
// The use case: a glance at the wall tablet tells whether the NAS or the
// home server is fine. Three gauges (CPU, memory, main disk), the hottest
// sensor and the running containers as tiles, then a few rows: uptime, load,
// swap, and the containers that stopped — the problems first. A server that
// does not answer says so in words.
//
// The server is chosen in the widget settings: any device of that server
// (the server itself, one of its disks…), the only kind of choice a widget
// setting offers. The disk is the root one unless another disk device is
// chosen. The figures are sent as values, not bound to device features: the
// widget works before any device is added.
//
// Budget (8 components, 6 tiles, 2 texts, 1 status, 4 buttons): five tiles,
// one text when the server does not answer, one status list of eight rows
// at most, and a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES, parseDeviceId } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { hottest } from './glances/model.js';
import {
  CONTAINER_STATE_TEXT,
  ERROR_TEXT,
  containerStateKey,
  formatGigabytes,
  formatNumber,
  formatPercent,
  formatUptime,
  labelled,
  pick,
} from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 8;

export const TEXT = {
  pick: {
    en: 'Choose the server in the settings of this widget (any device of the server).',
    fr: "Choisissez le serveur dans les réglages de ce widget (n'importe quel appareil du serveur).",
    de: 'Wähle den Server in den Einstellungen dieses Widgets (ein beliebiges Gerät des Servers).',
    es: 'Elija el servidor en los ajustes de este widget (cualquier dispositivo del servidor).',
  },
  gone: {
    en: 'This server is no longer in the configuration of the integration.',
    fr: "Ce serveur n'est plus dans la configuration de l'intégration.",
    de: 'Dieser Server ist nicht mehr in der Konfiguration der Integration.',
    es: 'Este servidor ya no está en la configuración de la integración.',
  },
  waiting: {
    en: 'Waiting for the first answer of Glances…',
    fr: 'En attente de la première réponse de Glances…',
    de: 'Warte auf die erste Antwort von Glances …',
    es: 'Esperando la primera respuesta de Glances…',
  },
  cpu: { en: 'CPU', fr: 'Processeur', de: 'Prozessor', es: 'Procesador' },
  memory: { en: 'Memory', fr: 'Mémoire', de: 'Speicher', es: 'Memoria' },
  disk: { en: 'Disk', fr: 'Disque', de: 'Datenträger', es: 'Disco' },
  temperature: { en: 'Temperature', fr: 'Température', de: 'Temperatur', es: 'Temperatura' },
  containers: { en: 'Containers', fr: 'Conteneurs', de: 'Container', es: 'Contenedores' },
  uptime: { en: 'Uptime', fr: 'En marche depuis', de: 'Läuft seit', es: 'En marcha desde' },
  load: { en: 'Load', fr: 'Charge', de: 'Last', es: 'Carga' },
  swap: { en: 'Swap', fr: 'Swap', de: 'Auslagerung', es: 'Swap' },
  free: { en: 'free', fr: 'libres', de: 'frei', es: 'libres' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Glances read again.',
    fr: 'Glances relu.',
    de: 'Glances neu gelesen.',
    es: 'Glances leído de nuevo.',
  },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Danger from 90, warning from 75: what a monitoring tool shows in red and orange. */
const usageColor = (value) =>
  value >= 90 ? WIDGET_COLORS.DANGER : value >= 75 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
const temperatureColor = (celsius) =>
  celsius >= 85
    ? WIDGET_COLORS.DANGER
    : celsius >= 70
      ? WIDGET_COLORS.WARNING
      : WIDGET_COLORS.NEUTRAL;

function message(text, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

const refreshButton = (language) => ({
  type: 'button',
  label: t(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

const gauge = (label, value, language) => ({
  type: 'gauge',
  value: Math.round(value),
  min: 0,
  max: 100,
  unit: '%',
  label: t(label, language),
  color: usageColor(value),
});

/** The tiles, the rows and the text of a server that answers. */
function serverComponents(view, language) {
  const { snapshot, disk } = view;
  const components = [];
  if (snapshot.cpu !== null) {
    components.push(gauge(TEXT.cpu, snapshot.cpu, language));
  }
  if (snapshot.memory !== null) {
    components.push(gauge(TEXT.memory, snapshot.memory, language));
  }
  if (disk) {
    components.push({
      ...gauge(TEXT.disk, disk.percent, language),
      label: fit(`${t(TEXT.disk, language)} ${disk.mount}`, 24),
    });
  }
  const hot = hottest(snapshot);
  if (hot) {
    components.push({
      type: 'value',
      value: Math.round(hot.celsius),
      unit: '°C',
      label: t(TEXT.temperature, language),
      icon: 'thermometer',
      color: temperatureColor(hot.celsius),
    });
  }
  if (snapshot.containers) {
    components.push({
      type: 'value',
      value: snapshot.containers.filter((container) => container.running).length,
      label: t(TEXT.containers, language),
      icon: 'box',
      color: view.stopped.length > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    });
  }

  const rows = [];
  for (const container of view.stopped) {
    rows.push({
      label: fit(container.name, 40),
      value: t(CONTAINER_STATE_TEXT[containerStateKey(container.status)], language),
      icon: 'x-circle',
      color: WIDGET_COLORS.DANGER,
    });
  }
  if (disk?.free !== null && disk?.free !== undefined) {
    rows.push({
      label: fit(`${t(TEXT.disk, language)} ${disk.mount}`, 40),
      value: `${formatGigabytes(disk.free, language)} ${t(TEXT.free, language)}`,
      icon: 'hard-drive',
      color: usageColor(disk.percent),
    });
  }
  if (snapshot.swap !== null) {
    rows.push({
      label: t(TEXT.swap, language),
      value: formatPercent(snapshot.swap, language),
      icon: 'layers',
      color: usageColor(snapshot.swap),
    });
  }
  if (snapshot.load) {
    const loads = [snapshot.load.min1, snapshot.load.min5, snapshot.load.min15]
      .filter((value) => value !== null)
      .map((value) => formatNumber(value, language, 2));
    rows.push({
      label: t(TEXT.load, language),
      value: loads.join(' · '),
      icon: 'activity',
      color:
        snapshot.cores && snapshot.load.min5 > snapshot.cores
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (snapshot.uptime !== null) {
    rows.push({
      label: t(TEXT.uptime, language),
      value: formatUptime(snapshot.uptime, language),
      icon: 'clock',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (rows.length > 0) {
    const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1) : rows;
    if (rows.length > shown.length) {
      shown.push({
        label: t(TEXT.more, language),
        value: `+${rows.length - shown.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    components.push({ type: 'status', items: shown });
  }
  return components;
}

async function get(hub, { settings, language = 'en' }) {
  const chosen = typeof settings?.server === 'string' ? settings.server : '';
  if (!chosen) {
    return message(TEXT.pick, language);
  }
  const found = hub.find(chosen);
  if (!found) {
    return message(TEXT.gone, language);
  }
  const diskId =
    typeof settings?.disk === 'string' ? parseDeviceId(hub.gladys, settings.disk) : null;
  const disk =
    diskId?.type === DEVICE_TYPES.DISK && diskId.slot === found.record.server.slot
      ? diskId.key
      : null;
  const view = hub.view(found.record, { disk });

  if (!view.online) {
    if (!view.error) {
      return message(TEXT.waiting, language, 30);
    }
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: fit(view.name, 40) },
        {
          type: 'text',
          variant: 'body',
          text: labelled(view.name, t(ERROR_TEXT[view.error.kind], language), language),
        },
        refreshButton(language),
      ],
    };
  }
  return {
    ttl_seconds: 30,
    components: [
      { type: 'text', variant: 'heading', text: fit(view.name, 40) },
      ...serverComponents(view, language),
      refreshButton(language),
    ],
  };
}

async function action(hub, { actionKey, settings }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  const found = typeof settings?.server === 'string' ? hub.find(settings.server) : null;
  if (found) {
    await hub.afterChanges(await hub.poll(found.record));
  } else {
    await hub.pollAll();
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
