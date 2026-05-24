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
 * Buchungs-API: jede Anfrage kostet uns 2 Resend-Mails.
 * 5 / 15 Min / IP reicht selbst fuer eine Familie, die mehrere
 * Termine hintereinander bucht.
 */
const bookingLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  max: 5,
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
  max: 20,
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
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  bookingLimiter,
  cancelLimiter,
  adminLimiter,
};
