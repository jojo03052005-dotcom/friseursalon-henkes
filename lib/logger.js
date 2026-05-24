/**
 * Minimaler strukturierter Logger.
 *
 * Production (NODE_ENV=production): JSON-Lines auf stdout/stderr.
 * Render-Logs sind damit grep-bar nach Feldern, und ein externer
 * Log-Sammler (Logtail, Better Stack, Axiom) kann sie direkt parsen.
 *
 * Development: lesbar formatiert mit Zeitstempel und Komponente.
 *
 * Levels:
 *   debug -> nur sichtbar wenn LOG_LEVEL=debug
 *   info  -> alles ueber stdout
 *   warn  -> stdout, gelb in Dev
 *   error -> stderr, rot in Dev
 *
 * Verwendung:
 *   const log = require('./lib/logger').child('booking');
 *   log.info('appointment_created', { id, name, date });
 *   log.error('email_failed', { id, error: err.message });
 *
 * Kein neues npm-Paket -- wir haben console + JSON.stringify.
 */

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

// ANSI-Farben fuer Dev-Output. In Production weggelassen, weil
// JSON-Logs Farben nicht haben sollen (verwirrt Parser).
const COLORS = {
  debug: "\x1b[90m", // grau
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // gelb
  error: "\x1b[31m", // rot
  reset: "\x1b[0m",
};

function emit(level, component, event, fields) {
  if (LEVELS[level] < CURRENT_LEVEL) return;

  const payload = {
    time: new Date().toISOString(),
    level,
    component,
    event,
    ...fields,
  };

  const stream = level === "error" ? process.stderr : process.stdout;

  if (IS_PRODUCTION) {
    stream.write(JSON.stringify(payload) + "\n");
    return;
  }

  // Dev: kompakt + farbig
  const color = COLORS[level] || "";
  const reset = COLORS.reset;
  const time = payload.time.slice(11, 19); // HH:MM:SS
  const extra = Object.keys(fields || {}).length > 0
    ? " " + JSON.stringify(fields)
    : "";
  stream.write(`${color}${time} ${level.toUpperCase().padEnd(5)} [${component}] ${event}${reset}${extra}\n`);
}

function makeLogger(component) {
  return {
    debug: (event, fields) => emit("debug", component, event, fields),
    info: (event, fields) => emit("info", component, event, fields),
    warn: (event, fields) => emit("warn", component, event, fields),
    error: (event, fields) => emit("error", component, event, fields),
    child: (subComponent) => makeLogger(`${component}:${subComponent}`),
  };
}

/**
 * Default-Logger ohne Komponente. Fuer Modul-spezifische Logs lieber
 * .child('name') benutzen, damit man im Output sieht woher die Zeile kommt.
 */
const root = makeLogger("app");

module.exports = {
  ...root,
  child: (component) => makeLogger(component),
};
