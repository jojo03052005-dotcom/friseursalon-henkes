/**
 * Express-Rate-Limiter fuer die schuetzenswerten Endpoints.
 *
 * Aufteilung pro Endpoint-Kategorie, weil die Profile unterschiedlich
 * sind: Buchungen kosten Mails, Storno geht ueber Random-Token (brute-force
 * praktisch unmoeglich), Admin sitzt hinter Basic-Auth.
 *
 * Render terminiert TLS und schickt die Original-IP via x-forwarded-for.
 * Express muss dafuer "trust proxy" auf 1 stehen haben (wird in server.js
 * gesetzt), sonst sehen alle Limiter dieselbe Proxy-IP.
 */

const rateLimit = require("express-rate-limit");

const WINDOW_15_MIN = 15 * 60 * 1000;

/**
 * Liest einen positiven Integer aus einer Env-Var, faellt sonst auf den
 * Default zurueck. Genutzt von Tests, um die Limits hoch zu drehen,
 * damit Integrationstests nicht in den Rate-Limit-Wall rennen.
 * In Production NICHT setzen.
 */
function intFromEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * Buchungs-API: jede Anfrage kostet uns 2 Resend-Mails.
 * 5 / 15 Min / IP reicht selbst fuer eine Familie, die mehrere
 * Termine hintereinander bucht.
 */
const bookingLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  max: intFromEnv("HENKES_BOOKING_RATE_MAX", 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Zu viele Anfragen von dieser Adresse. Bitte versuchen Sie es in ein paar Minuten erneut oder rufen Sie uns kurz an.",
  },
});

/**
 * Storno-Endpoint: Token ist 128 Bit Zufall, brute-force ist praktisch
 * unmoeglich. Trotzdem etwas Limit, damit niemand Resend-Cancel-Calls
 * en masse ausloesen kann.
 */
const cancelLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  max: intFromEnv("HENKES_CANCEL_RATE_MAX", 20),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Admin-Endpoints: bereits durch Basic-Auth geschuetzt. Hoher Limit,
 * damit der echte Admin sich nicht selbst aussperrt; Brute-Force-
 * Schutz bleibt.
 */
const adminLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  max: intFromEnv("HENKES_ADMIN_RATE_MAX", 200),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Cron-Endpoint: bereits per CRON_SECRET geschuetzt, aber falls das
 * Secret leakt (Logs, ENV-Dump, etc.), waere die Mail-Quota angreifbar.
 * 30/15min pro IP ist ueppig fuer den echten Cron (1x pro Tag) und
 * killt jeden Spam-Versuch sofort.
 */
const cronLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  max: intFromEnv("HENKES_CRON_RATE_MAX", 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Cron rate limit exceeded.",
  },
});

module.exports = {
  bookingLimiter,
  cancelLimiter,
  adminLimiter,
  cronLimiter,
};
