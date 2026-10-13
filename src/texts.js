// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, scene event
// variables, scene action outputs and errors. Four languages, the four of the
// Gladys interface; German says "du", Spanish "usted". test/i18n.test.js
// checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './glances/client.js';

export const LANGUAGE_FALLBACK = 'en';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the address of a Glances server in the configuration.',
    fr: "Saisissez l'adresse d'un serveur Glances dans la configuration.",
    de: 'Gib die Adresse eines Glances-Servers in der Konfiguration ein.',
    es: 'Introduzca la dirección de un servidor Glances en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.20 or http://nas.lan:61208',
    fr: 'Adresse incomprise, ex. 192.168.1.20 ou http://nas.lan:61208',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.20 oder http://nas.lan:61208',
    es: 'Dirección no válida, p. ej. 192.168.1.20 o http://nas.lan:61208',
  },
};

// One short explanation per error kind (src/glances/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer (is "glances -w" running?)',
    fr: 'ne répond pas (« glances -w » est-il lancé ?)',
    de: 'antwortet nicht (läuft „glances -w“?)',
    es: 'no responde (¿se está ejecutando «glances -w»?)',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user name or password refused',
    fr: "nom d'utilisateur ou mot de passe refusé",
    de: 'Benutzername oder Passwort abgelehnt',
    es: 'nombre de usuario o contraseña rechazados',
  },
  [ERROR_KINDS.PASSWORD_MISSING]: {
    en: 'Glances asks for a password: enter it in the configuration',
    fr: 'Glances demande un mot de passe : saisissez-le dans la configuration',
    de: 'Glances verlangt ein Passwort: Gib es in der Konfiguration ein',
    es: 'Glances pide una contraseña: introdúzcala en la configuración',
  },
  [ERROR_KINDS.NOT_GLANCES]: {
    en: 'no Glances web server (API 3 or 4) at this address',
    fr: 'aucun serveur web Glances (API 3 ou 4) à cette adresse',
    de: 'kein Glances-Webserver (API 3 oder 4) unter dieser Adresse',
    es: 'no hay ningún servidor web Glances (API 3 o 4) en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// A container that no longer runs, in words (scene event variable, widget rows).
export const CONTAINER_STATE_TEXT = {
  stopped: { en: 'Stopped', fr: 'Arrêté', de: 'Gestoppt', es: 'Detenido' },
  paused: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  restarting: {
    en: 'Restarting',
    fr: 'Redémarre',
    de: 'Startet neu',
    es: 'Reiniciándose',
  },
};

/** The state word of a container status that is not running. */
export function containerStateKey(status) {
  if (status === 'paused') {
    return 'paused';
  }
  if (status === 'restarting') {
    return 'restarting';
  }
  return 'stopped';
}

// The "Test the connection" report, one line per server.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    disks: (count) => `${count} disk(s)`,
    interfaces: (count) => `${count} interface(s)`,
    sensors: (count) => `${count} temperature sensor(s)`,
    containers: (count) => `${count} container(s) running`,
  },
  fr: {
    ok: 'OK',
    disks: (count) => `${count} disque(s)`,
    interfaces: (count) => `${count} interface(s)`,
    sensors: (count) => `${count} capteur(s) de température`,
    containers: (count) => `${count} conteneur(s) en marche`,
  },
  de: {
    ok: 'OK',
    disks: (count) => `${count} Datenträger`,
    interfaces: (count) => `${count} Schnittstelle(n)`,
    sensors: (count) => `${count} Temperatursensor(en)`,
    containers: (count) => `${count} Container laufen`,
  },
  es: {
    ok: 'OK',
    disks: (count) => `${count} disco(s)`,
    interfaces: (count) => `${count} interfaz/interfaces`,
    sensors: (count) => `${count} sensor(es) de temperatura`,
    containers: (count) => `${count} contenedor(es) en marcha`,
  },
};

// The `summary` output of "State of a server", ready for a message.
export const SUMMARY_TEXT = {
  en: {
    cpu: 'CPU',
    memory: 'memory',
    disk: 'disk',
    free: (size) => `${size} free`,
    running: (count) => `${count} container(s) running`,
    stopped: (names) => `stopped: ${names}`,
    unreachable: 'unreachable',
  },
  fr: {
    cpu: 'processeur',
    memory: 'mémoire',
    disk: 'disque',
    free: (size) => `${size} libres`,
    running: (count) => `${count} conteneur(s) en marche`,
    stopped: (names) => `arrêtés : ${names}`,
    unreachable: 'injoignable',
  },
  de: {
    cpu: 'Prozessor',
    memory: 'Arbeitsspeicher',
    disk: 'Datenträger',
    free: (size) => `${size} frei`,
    running: (count) => `${count} Container laufen`,
    stopped: (names) => `gestoppt: ${names}`,
    unreachable: 'nicht erreichbar',
  },
  es: {
    cpu: 'procesador',
    memory: 'memoria',
    disk: 'disco',
    free: (size) => `${size} libres`,
    running: (count) => `${count} contenedor(es) en marcha`,
    stopped: (names) => `detenidos: ${names}`,
    unreachable: 'inaccesible',
  },
};

// Units written in the texts (the French write "Go", the others "GB").
export const UNIT_TEXT = {
  gigabyte: { en: 'GB', fr: 'Go', de: 'GB', es: 'GB' },
};

// Errors of the scene actions (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No Glances server is configured.',
    fr: "Aucun serveur Glances n'est configuré.",
    de: 'Kein Glances-Server ist konfiguriert.',
    es: 'No hay ningún servidor Glances configurado.',
  },
  unknownServer: {
    en: 'This device does not belong to a configured Glances server.',
    fr: "Cet appareil n'appartient à aucun serveur Glances configuré.",
    de: 'Dieses Gerät gehört zu keinem konfigurierten Glances-Server.',
    es: 'Este dispositivo no pertenece a ningún servidor Glances configurado.',
  },
};

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** A number written the way the language writes it (decimal comma in fr, de, es). */
export const formatNumber = (value, language, digits = 1) =>
  new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);

/** "12 %" (fr, de, es) or "12%" (en). */
export const formatPercent = (value, language) =>
  `${formatNumber(value, language, 0)}${language === 'en' ? '%' : ' %'}`;

/** A size in GiB, "110 GB" / "110 Go". */
export const formatGigabytes = (bytes, language) =>
  `${formatNumber(bytes / 1024 ** 3, language, bytes >= 10 * 1024 ** 3 ? 0 : 1)} ${pick(
    UNIT_TEXT.gigabyte,
    language,
  )}`;

/** A temperature, "52 °C". */
export const formatCelsius = (value, language) => `${formatNumber(value, language, 0)} °C`;

/** An uptime, "4 d 3 h" / "4 j 3 h" / "4 T 3 Std." / "4 d 3 h". */
export function formatUptime(seconds, language) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const day = { en: 'd', fr: 'j', de: 'T', es: 'd' }[language] ?? 'd';
  const hour = language === 'de' ? 'Std.' : 'h';
  if (days > 0) {
    return `${days} ${day} ${hours} ${hour}`;
  }
  if (hours > 0) {
    return `${hours} ${hour} ${minutes} min`;
  }
  return `${minutes} min`;
}
