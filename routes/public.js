/**
 * Oeffentliche, nicht-authentifizierte Endpoints.
 *   GET /api/health    -- Liveness-Probe + Operational-Status
 *   GET /api/services  -- Service-Liste fuer das Frontend-<select>
 *
 * Wichtig: /api/health antwortet IMMER 200, auch wenn Subsysteme
 * Fehler haben. Sonst zwingt Render uns in einen Redeploy bei kleinen
 * Hickups (z.B. wenn das Filesystem gerade mal hakt). Probleme werden
 * stattdessen STRUKTURIERT im JSON-Body sichtbar -- ein Uptime-Pinger
 * kann gezielt auf z.B. `storage.writable === false` reagieren.
 */

const express = require("express");

const { ALLOWED_SERVICES } = require("../lib/config");
const storage = require("../lib/storage");
const backup = require("../lib/backup");
const { isEmailConfigured } = require("../services/emailService");

const router = express.Router();

// Lese package.json einmal beim Modul-Load fuer die Version (kein I/O
// pro Request). Wenn das Lesen scheitert -> "unknown".
let serviceVersion = "unknown";
try {
  serviceVersion = require("../package.json").version || "unknown";
} catch (_err) {
  // ignore
}

// HEAD-Liveness: viele Uptime-Monitore (UptimeRobot, Better-Stack, Pingdom)
// senden HEAD-Requests statt GET, um Bandbreite zu sparen. Express
// liefert HEAD nicht automatisch fuer GET-Routes -- wir antworten
// explizit mit 200 ohne Body. Schnell, kein Storage-Call.
router.head("/health", (_req, res) => {
  res.status(200).end();
});

router.get("/health", async (_req, res) => {
  const t0 = Date.now();
  const report = {
    success: true,
    service: "friseursalon-henkes-backend",
    version: serviceVersion,
    env: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    emailConfigured: isEmailConfigured(),
    storage: {
      writable: false,
      path: storage.DATA_DIR,
      persistent: storage.IS_PERSISTENT,
      engine: storage.ENGINE,
    },
    appointmentsFile: { healthy: false, exists: false, count: 0 },
    backup: backup.status(),
    memory: null,
    warnings: [],
  };

  // 1. Storage-Writability-Probe (kleine Datei in DATA_DIR rein/raus).
  //    Faengt ein gemounteter aber read-only Disk oder ein Permissions-
  //    Problem direkt ab.
  try {
    Object.assign(report.storage, await storage.checkWritable());
  } catch (err) {
    report.storage.writable = false;
    report.storage.error = err.message;
    report.warnings.push({
      level: "error",
      area: "storage",
      message: `DATA_DIR not writable: ${err.message}`,
    });
  }

  // 2. Termin-Datei: existiert sie + valide JSON?
  try {
    Object.assign(report.appointmentsFile, await storage.checkAppointmentsFile());
    if (!report.appointmentsFile.healthy) {
      report.warnings.push({
        level: "error",
        area: "appointments_file",
        message: `Corrupted JSON: ${report.appointmentsFile.error}`,
      });
    }
  } catch (err) {
    report.appointmentsFile.error = err.message;
    report.warnings.push({
      level: "error",
      area: "appointments_file",
      message: err.message,
    });
  }

  // 3. Memory (cheap)
  const mem = process.memoryUsage();
  report.memory = {
    rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
  };

  // 4. Configuration-Warnings
  if (!report.storage.persistent && (process.env.NODE_ENV === "production")) {
    report.warnings.push({
      level: "warn",
      area: "storage",
      message:
        "Neither DATABASE_URL nor HENKES_DATA_DIR set -- using ephemeral storage. Bookings will be lost on every Render deploy/restart. Set DATABASE_URL (Neon Postgres free) or attach a Render Disk.",
    });
  }
  if (!report.emailConfigured) {
    report.warnings.push({
      level: "warn",
      area: "email",
      message: "RESEND_API_KEY or SALON_EMAIL missing -- no mails will be sent.",
    });
  }
  if (
    report.backup.enabled &&
    report.backup.lastBackupAt === null &&
    report.uptimeSeconds > 120
  ) {
    report.warnings.push({
      level: "warn",
      area: "backup",
      message: "No backup created yet despite >2min uptime. Check backup scheduler.",
    });
  }
  if (report.backup.lastError) {
    report.warnings.push({
      level: "error",
      area: "backup",
      message: `Last backup failed: ${report.backup.lastError.message}`,
    });
  }

  report.checkDurationMs = Date.now() - t0;
  res.json(report);
});

router.get("/services", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300"); // 5 Min cache
  res.json({ success: true, services: ALLOWED_SERVICES });
});

module.exports = router;
