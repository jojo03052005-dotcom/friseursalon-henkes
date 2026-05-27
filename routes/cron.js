/**
 * Cron-Endpoints (per Shared-Secret geschuetzt).
 *
 *   GET /api/cron/daily-digest  -- Tagesueberblick an SALON_EMAIL,
 *                                  pingt nebenbei den Server warm.
 *
 * Schutz: ?secret=... oder Authorization: Bearer <SECRET>.
 * Wenn CRON_SECRET nicht gesetzt ist -> 503 (Endpoint deaktiviert),
 * damit nicht jemand ohne Konfiguration die Mail-Quota anzapfen kann.
 */

const express = require("express");

const { safeStringEqual } = require("../lib/auth");
const { readAll } = require("../lib/storage");
const { SALON_HOURS } = require("../lib/config");
const { asyncHandler } = require("../lib/async-handler");
const logger = require("../lib/logger").child("cron");

const {
  sendDailyDigestEmail,
  isEmailConfigured,
} = require("../services/emailService");

const router = express.Router();

router.get(
  "/daily-digest",
  asyncHandler(async (req, res) => {
    const expectedSecret = process.env.CRON_SECRET?.trim();
    if (!expectedSecret) {
      return res.status(503).json({
        success: false,
        message: "Cron ist nicht konfiguriert (CRON_SECRET fehlt).",
      });
    }

    const headerAuth = req.headers.authorization || "";
    const bearerMatch = headerAuth.match(/^Bearer\s+(.+)$/i);
    const provided = (bearerMatch ? bearerMatch[1] : req.query.secret || "")
      .toString()
      .trim();

    if (!provided || !safeStringEqual(provided, expectedSecret)) {
      logger.warn("cron_auth_failed", { ip: req.ip });
      return res.status(401).json({ success: false, message: "Ungueltiges Cron-Secret." });
    }

    const appointments = await readAll();

    // Berlin-lokales "heute" (YYYY-MM-DD) via Intl-API.
    const todayBerlin = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    // Salon-Ruhetag (So/Mo): keine Tagesuebersicht versenden, sonst
    // kriegt der Salon jeden Sonntag/Montag eine "0 Termine"-Mail.
    // Cron-Job-Ping bleibt trotzdem hilfreich (haelt Server warm),
    // wir antworten 200 mit skipped:true.
    // Berlin-Wochentag via Intl ableiten (sicher gegen Server-TZ).
    const berlinWeekday = new Date(`${todayBerlin}T12:00:00Z`).getUTCDay();
    const isOpenDay = Boolean(SALON_HOURS[berlinWeekday]);

    if (!isOpenDay) {
      logger.info("daily_digest_skipped_closed_day", {
        today: todayBerlin,
        weekday: berlinWeekday,
      });
      return res.json({
        success: true,
        skipped: true,
        reason: "salon closed today (Sun/Mon)",
        today: todayBerlin,
      });
    }

    const todays = appointments.filter(
      (item) =>
        item.date === todayBerlin &&
        item.confirmed &&
        !item.cancelled &&
        !item.declined
    );

    if (!isEmailConfigured()) {
      return res.status(503).json({
        success: false,
        message: "E-Mail ist nicht konfiguriert.",
        today: todayBerlin,
        count: todays.length,
      });
    }

    const result = await sendDailyDigestEmail(todays, todayBerlin);
    logger.info("daily_digest_sent", {
      today: todayBerlin,
      count: todays.length,
      ok: result.sent,
      error: result.error || null,
    });

    return res.json({
      success: result.sent,
      message: result.sent
        ? `Tagesübersicht gesendet (${todays.length} Termine).`
        : `Versand fehlgeschlagen: ${result.error || "unbekannt"}`,
      today: todayBerlin,
      count: todays.length,
      result,
    });
  })
);

module.exports = router;
