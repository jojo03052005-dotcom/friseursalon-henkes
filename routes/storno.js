/**
 * Storno-Flow per Token-Link aus der Bestaetigungs-Mail.
 *
 *   GET  /storno/:token  -- Bestaetigungsseite ("Wirklich absagen?")
 *   POST /storno/:token  -- fuehrt die Stornierung aus
 *
 * Idempotent: schon stornierte Termine zeigen die "war schon storniert"-
 * Seite, statt einen Fehler zu werfen.
 */

const express = require("express");

const { findByCancelToken, writeAll } = require("../lib/storage");
const { cancelLimiter } = require("../lib/rate-limit");
const stornoViews = require("../lib/views/storno");
const { asyncHandler } = require("../lib/async-handler");
const logger = require("../lib/logger").child("storno");

const {
  sendCancellationEmail,
  isEmailConfigured,
} = require("../services/emailService");

const router = express.Router();

router.use(cancelLimiter);

/**
 * Wir vergeben Storno-Tokens via crypto.randomUUID() -- d.h. genau
 * 36 Zeichen, Format 8-4-4-4-12 Hex mit Bindestrichen. Alles andere
 * ist Spam / Scanner und kann ohne DB-Roundtrip mit 404 abgewiesen
 * werden. Spart bei Scannern, die /storno/<random> hammern, jeden
 * Treffer eine teure Datei- oder DB-Operation.
 *
 * Bewusst lax: case-insensitive (manche Mail-Clients lowercasen URLs).
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLikelyValidToken(value) {
  if (typeof value !== "string") return false;
  if (value.length !== 36) return false;
  return UUID_V4_REGEX.test(value);
}

router.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || "");
    if (!isLikelyValidToken(token)) {
      return res.status(404).type("html").send(stornoViews.renderNotFound());
    }

    const { appointment } = await findByCancelToken(token);
    if (!appointment) {
      return res.status(404).type("html").send(stornoViews.renderNotFound());
    }

    if (appointment.cancelled) {
      return res.type("html").send(stornoViews.renderDone(appointment, false));
    }

    res.type("html").send(stornoViews.renderConfirm(appointment));
  })
);

router.post(
  "/:token",
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || "");
    if (!isLikelyValidToken(token)) {
      return res.status(404).type("html").send(stornoViews.renderNotFound());
    }

    const { appointments, appointment, index } = await findByCancelToken(token);
    if (!appointment) {
      return res.status(404).type("html").send(stornoViews.renderNotFound());
    }

    // Idempotent: schon storniert -> normal anzeigen, keine Doppel-Mail.
    if (appointment.cancelled) {
      return res.type("html").send(stornoViews.renderDone(appointment, false));
    }

    appointment.cancelled = true;
    appointment.cancelledAt = new Date().toISOString();

    if (isEmailConfigured()) {
      try {
        appointment.cancellationStatus = await sendCancellationEmail(appointment);
      } catch (mailError) {
        logger.error("storno_mail_failed", {
          id: appointment.id,
          error: String(mailError?.message || mailError),
        });
        appointment.cancellationStatus = {
          salon: { sent: false, error: String(mailError?.message || mailError) },
          reminderCancelled: false,
        };
      }
    } else {
      appointment.cancellationStatus = {
        salon: { sent: false, error: "E-Mail nicht konfiguriert." },
        reminderCancelled: false,
      };
    }

    appointments[index] = appointment;
    await writeAll(appointments);

    logger.info("appointment_cancelled_by_customer", {
      id: appointment.id,
      name: appointment.name,
      date: appointment.date,
      time: appointment.time,
      reminderCancelled: appointment.cancellationStatus?.reminderCancelled,
    });

    res.type("html").send(stornoViews.renderDone(appointment, true));
  })
);

// Error-Handler nur fuer diesen Router: bei unerwartetem Fehler
// zeigen wir die Salon-Telefonnummer als Fallback, statt einen 500 zu werfen.
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  logger.error("storno_unhandled_error", {
    error: String(err?.message || err),
    stack: err?.stack,
  });
  res.status(500).type("html").send(stornoViews.renderError());
});

module.exports = router;
