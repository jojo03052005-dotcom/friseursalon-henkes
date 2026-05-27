/**
 * Zentrale Domain-Konfiguration.
 *
 * Hier leben alle Konstanten, die das Geschaeft beschreiben:
 * Salon-Daten, Leistungen, Oeffnungszeiten, Buchungs-Regeln.
 * Aenderungen am Salon-Betrieb -> nur hier anpassen, nicht im
 * Routen-Code oder im Mail-Service.
 *
 * Reine Daten, keine Logik. Frei importierbar von ueberall.
 */

const path = require("path");
const fs = require("fs");

/* ---------------- Salon-Daten aus JSON ---------------- */

/**
 * Salon-spezifische Daten kommen aus salon.config.json im Repo-Root.
 * Eine Datei pro Deployment -- so kann derselbe Codebase fuer mehrere
 * Saloons betrieben werden, ohne Code-Aenderungen.
 *
 * Bewusst sync-read beim Modul-Load: einmal beim Boot, fertig. Kein
 * async-Geraffel im Hot-Path. Bei kaputter/fehlender JSON -> sinnvolle
 * Defaults (Salon Henkes), damit alte Deployments ohne config-Datei
 * weiter funktionieren.
 */
function loadSalonConfig() {
  const configPath = path.resolve(__dirname, "..", "salon.config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (_err) {
    return null; // Defaults werden unten verwendet
  }
}

const SALON_CONFIG = loadSalonConfig();

const SALON = Object.freeze(
  SALON_CONFIG?.salon || {
    name: "Friseursalon Henkes",
    phone: "0209 41793",
    phoneTel: "020941793",
    phoneInternational: "4920941793",
    address: "Fürstinnenstraße 40",
    city: "45883 Gelsenkirchen",
    country: "DE",
  }
);

/* ---------------- Leistungen ---------------- */

/**
 * Die buchbaren Leistungen mit Default-Dauer in Minuten.
 * Dauer wird fuer den ICS-Kalender-Eintrag in den Bestaetigungs-Mails
 * verwendet. Werte sind grosszuegig geschaetzt; pro Termin kann der
 * Salon das spaeter anpassen (TODO im Admin-UI).
 */
const SERVICES = Object.freeze(
  (SALON_CONFIG?.services || [
    { name: "Haarschnitt", durationMinutes: 45 },
    { name: "Färbung",     durationMinutes: 90 },
    { name: "Strähnen",    durationMinutes: 120 },
    { name: "Styling",     durationMinutes: 60 },
    { name: "Haarpflege",  durationMinutes: 45 },
  ]).map((s) => Object.freeze({ ...s }))
);

const ALLOWED_SERVICES = Object.freeze(SERVICES.map((s) => s.name));

const SERVICE_DURATIONS_MINUTES = Object.freeze(
  Object.fromEntries(SERVICES.map((s) => [s.name, s.durationMinutes]))
);

const DEFAULT_SERVICE_DURATION_MINUTES = 60;

/* ---------------- Oeffnungszeiten ---------------- */

/**
 * Salon-Oeffnungszeiten pro Wochentag (0=So .. 6=Sa).
 * Fehlt der Wochentag -> Salon zu. Werte sind Minuten seit Mitternacht.
 * Eine gewuenschte Uhrzeit muss im [open, close)-Fenster liegen.
 */
/**
 * Wandelt "HH:MM" in Minuten seit Mitternacht.
 */
function parseTimeToMinutes(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const SALON_HOURS = (() => {
  if (SALON_CONFIG?.hours) {
    const out = {};
    for (const [day, hours] of Object.entries(SALON_CONFIG.hours)) {
      const open = parseTimeToMinutes(hours.open);
      const close = parseTimeToMinutes(hours.close);
      if (open !== null && close !== null && close > open) {
        out[Number(day)] = Object.freeze({ open, close });
      }
    }
    return Object.freeze(out);
  }
  // Defaults: Mo+So zu, Di-Fr 9-18, Sa 8-14
  return Object.freeze({
    2: Object.freeze({ open: 9 * 60, close: 18 * 60 }),
    3: Object.freeze({ open: 9 * 60, close: 18 * 60 }),
    4: Object.freeze({ open: 9 * 60, close: 18 * 60 }),
    5: Object.freeze({ open: 9 * 60, close: 18 * 60 }),
    6: Object.freeze({ open: 8 * 60, close: 14 * 60 }),
  });
})();

/* ---------------- Buchungs-Regeln ---------------- */

/**
 * Wie weit in die Zukunft Buchungen erlaubt sind. 90 Tage decken
 * realistische Vorausplanung ab, blockieren aber "Buche mich am
 * 31.12.2030"-Spass.
 */
const MAX_BOOKING_HORIZON_DAYS =
  SALON_CONFIG?.booking?.maxBookingHorizonDays || 90;

/**
 * Wir akzeptieren nur Slots im 15-Minuten-Raster. Krumme Zeiten
 * wie 14:37 deuten auf Tipper oder Bot.
 */
const ALLOWED_MINUTES = Object.freeze(new Set(["00", "15", "30", "45"]));

/**
 * Mindest-Vorlauf fuer Termine am gleichen Tag (in Millisekunden).
 * 60 Minuten -- damit der Salon noch reagieren kann.
 */
const SAME_DAY_LEAD_TIME_MS =
  (SALON_CONFIG?.booking?.sameDayLeadTimeMinutes || 60) * 60 * 1000;

/**
 * Doppel-Submit-Dedupe-Fenster (Millisekunden). Identische Buchungen
 * (gleiche email + date + time + service) innerhalb dieses Fensters
 * werden als Duplikat behandelt.
 */
const DEDUPE_WINDOW_MS =
  (SALON_CONFIG?.booking?.dedupeWindowSeconds || 60) * 1000;

/**
 * Maximale Notiz-Laenge im Buchungsformular. Verhindert, dass jemand
 * den Server mit einem Roman vollschreibt; 500 Zeichen sind genug
 * fuer alle realistischen Sonderwuensche.
 */
const MAX_NOTES_LENGTH = SALON_CONFIG?.booking?.maxNotesLength || 500;

/* ---------------- Validierungs-Patterns ---------------- */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

/**
 * Telefonnummern: nur sinnvolle Zeichen. Buchstaben verraten Spam-Bots,
 * die wirres Zeug einfuellen. Mindestens 6 Ziffern -- weniger ist
 * realistisch keine echte Nummer.
 */
const PHONE_ALLOWED_CHARS = /^[\d\s+\-/()]+$/;
const PHONE_MIN_DIGITS = 6;

/* ---------------- Pfade ---------------- */

const ROOT_DIR = path.resolve(__dirname, "..");

// Pfade lassen sich per Env-Var ueberschreiben -- aktuell nur fuer
// isolierte Tests genutzt (jeder Test bekommt eigenes tmp-Verzeichnis).
// In Production sind die Defaults richtig; bitte NICHT in Render setzen.
const DATA_DIR = process.env.HENKES_DATA_DIR
  ? path.resolve(process.env.HENKES_DATA_DIR)
  : path.join(ROOT_DIR, "data");

const APPOINTMENTS_FILE = process.env.HENKES_APPOINTMENTS_FILE
  ? path.resolve(process.env.HENKES_APPOINTMENTS_FILE)
  : path.join(DATA_DIR, "appointments.json");

const CLOSED_DAYS_FILE = process.env.HENKES_CLOSED_DAYS_FILE
  ? path.resolve(process.env.HENKES_CLOSED_DAYS_FILE)
  : path.join(DATA_DIR, "closed-days.json");

/* ---------------- CORS / Hosting ---------------- */

const NETLIFY_SITE = "friseursalon-henkes-website";

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  `https://${NETLIFY_SITE}.netlify.app`,
]);

/**
 * Pattern fuer Netlify-Deploy-Previews und Branch-Deploys, z.B.
 *   https://deploy-preview-8--friseursalon-henkes-website.netlify.app
 *   https://branchname--friseursalon-henkes-website.netlify.app
 * Der $-Anchor verhindert Spoofing wie "...netlify.app.attacker.com".
 * Site-Name hat keine Regex-Sonderzeichen, daher keine Escape-Logik noetig.
 */
const NETLIFY_PREVIEW_REGEX = new RegExp(
  `^https://[a-z0-9-]+--${NETLIFY_SITE}\\.netlify\\.app$`
);

module.exports = {
  SALON,
  SERVICES,
  ALLOWED_SERVICES,
  SERVICE_DURATIONS_MINUTES,
  DEFAULT_SERVICE_DURATION_MINUTES,
  SALON_HOURS,
  MAX_BOOKING_HORIZON_DAYS,
  ALLOWED_MINUTES,
  SAME_DAY_LEAD_TIME_MS,
  DEDUPE_WINDOW_MS,
  MAX_NOTES_LENGTH,
  EMAIL_REGEX,
  PHONE_ALLOWED_CHARS,
  PHONE_MIN_DIGITS,
  ROOT_DIR,
  DATA_DIR,
  APPOINTMENTS_FILE,
  CLOSED_DAYS_FILE,
  NETLIFY_SITE,
  DEFAULT_ALLOWED_ORIGINS,
  NETLIFY_PREVIEW_REGEX,
};
