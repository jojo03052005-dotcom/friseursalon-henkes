/**
 * Oeffentliche, nicht-authentifizierte Endpoints.
 *   GET /api/health    -- Liveness-Probe, Pre-Warm-Target, Render-Healthcheck
 *   GET /api/services  -- Service-Liste fuer das Frontend-<select>
 */

const express = require("express");

const { ALLOWED_SERVICES } = require("../lib/config");
const { readAll } = require("../lib/storage");
const { isEmailConfigured } = require("../services/emailService");

const router = express.Router();

router.get("/health", async (_req, res) => {
  // Versuche die Termin-Anzahl mitzuliefern. Wenn das Storage gerade
  // einen Fehler hat, antworten wir trotzdem 200 -- der Health-Check
  // soll Render nicht in einen Redeploy zwingen, nur weil das File-System
  // kurz mal hakt.
  let appointmentCount = null;
  try {
    const appointments = await readAll();
    appointmentCount = appointments.length;
  } catch (_err) {
    // ignore
  }

  res.json({
    success: true,
    service: "friseursalon-henkes-backend",
    emailConfigured: isEmailConfigured(),
    appointmentCount,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

router.get("/services", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300"); // 5 Min cache
  res.json({ success: true, services: ALLOWED_SERVICES });
});

module.exports = router;
