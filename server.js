/**
 * Friseursalon Henkes - Terminbuchungs-Backend.
 *
 * Diese Datei macht NUR App-Komposition:
 *   - Middleware konfigurieren (helmet, body-parser, CORS)
 *   - Statische Dateien ausliefern (Admin hinter Basic-Auth)
 *   - Router mounten (lib/routes/*)
 *   - Catch-all-404
 *   - Zentrale Error-Middleware
 *   - Server starten + Graceful Shutdown
 *
 * Geschaeftslogik lebt in den Modulen unter lib/ und routes/.
 */

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");

const {
  ROOT_DIR,
  DEFAULT_ALLOWED_ORIGINS,
  NETLIFY_PREVIEW_REGEX,
} = require("./lib/config");

const { requireAdminAuth } = require("./lib/auth");
const stornoViews = require("./lib/views/storno");
const logger = require("./lib/logger");
const { runStartupCheck } = require("./lib/startup-check");
const storage = require("./lib/storage");
const backup = require("./lib/backup");
const db = require("./lib/db");
const migrate = require("./lib/migrate");
const { isEmailConfigured } = require("./services/emailService");

const publicRouter = require("./routes/public");
const appointmentsRouter = require("./routes/appointments");
const adminRouter = require("./routes/admin");
const cronRouter = require("./routes/cron");
const stornoRouter = require("./routes/storno");

const log = logger.child("server");
const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- Reverse-Proxy ---------------- */

// Render terminiert TLS und schickt uns die Original-IP via x-forwarded-*.
// Ohne "trust proxy" sieht Express alle Requests als von der Proxy-IP -- das
// bricht (a) Stornier-Link-Bau aus dem Request, (b) jeden IP-basierten
// Rate-Limiter. Auf "1" weil es vor uns genau einen Render-Hop gibt.
app.set("trust proxy", 1);

/* ---------------- Security-Header ---------------- */

// CSP ist hier deaktiviert, weil die Storno-HTML-Seiten und das admin-
// Panel inline <style>-Bloecke benutzen -- spaeter koennen wir eine
// Nonce-basierte CSP nachruesten. Cross-Origin-Embedder-Policy ist auch
// aus, damit Bilder/Fonts aus fremden Origins (Google Fonts) im Browser
// nicht blockiert werden.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

/* ---------------- Body-Parser ---------------- */

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "4kb" }));

/* ---------------- CORS ---------------- */

function isAllowedOrigin(origin, exactSet) {
  if (!origin) return false;
  if (exactSet.has(origin)) return true;
  if (NETLIFY_PREVIEW_REGEX.test(origin)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ]);

  if (isAllowedOrigin(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Idempotency-Key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

/* ---------------- Admin-HTML hinter Auth ---------------- */

// admin.html und admin.js werden vor express.static abgefangen und
// gegen Basic-Auth verifiziert. admin.css ist bewusst frei, enthaelt
// keine PII.
app.use((req, res, next) => {
  if (req.path === "/admin.html" || req.path === "/admin.js") {
    return requireAdminAuth(req, res, next);
  }
  return next();
});

/* ---------------- Static Files ---------------- */

app.use(express.static(ROOT_DIR));

/* ---------------- API-Router ---------------- */

app.use("/api", publicRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/cron", cronRouter);
app.use("/storno", stornoRouter);

/* ---------------- 404 / Fallback ---------------- */

// Catch-all: alles ohne Match landet hier. Fuer /api/* JSON, sonst
// die schoene 404-HTML-Seite.
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      message: `Endpoint nicht gefunden: ${req.method} ${req.path}`,
    });
  }
  res.status(404).sendFile(path.join(ROOT_DIR, "404.html"));
});

/* ---------------- Zentrale Error-Middleware ---------------- */

// Faengt alles ab, was Router via next(err) weitergeben. Logged
// strukturiert und antwortet generisch (nie Stack-Trace nach aussen).
// Storno-Router hat seinen eigenen Error-Handler, der vorher feuert
// (HTML-Antwort statt JSON).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log.error("unhandled_error", {
    path: req.path,
    method: req.method,
    error: String(err?.message || err),
    stack: err?.stack,
  });

  // Schon Antwort begonnen? Dann nicht doppelt schicken.
  if (res.headersSent) {
    return;
  }

  if (req.path.startsWith("/api/")) {
    return res.status(500).json({
      success: false,
      message: "Ein interner Fehler ist aufgetreten. Bitte versuchen Sie es erneut.",
    });
  }
  res.status(500).type("html").send(stornoViews.renderError());
});

/* ---------------- Server starten ---------------- */

const server = app.listen(PORT, () => {
  log.info("server_started", {
    port: PORT,
    env: process.env.NODE_ENV || "development",
    emailConfigured: isEmailConfigured(),
    pid: process.pid,
  });
  // Startup-Check NACH dem Listener-Log: Warnungen sind sichtbar, der
  // Server laeuft aber auch bei unvollstaendiger Config (fail-soft,
  // damit der Operator das im Browser sieht statt vor schwarzem Bildschirm).
  runStartupCheck();
  // Boot-Diagnostik fuer Storage + Backup (async, blockiert nicht).
  runBootDiagnostics().catch((err) => {
    log.error("boot_diagnostics_failed", { error: err.message });
  });
  // Backup-Scheduler starten (no-op wenn HENKES_BACKUP_DISABLED=1).
  backup.start();
});

/* ---------------- Boot-Diagnostics ---------------- */

/**
 * Beim Start: pruefen ob DATA_DIR beschreibbar ist und ob die
 * appointments.json valide JSON enthaelt. Bei Korruption -> Auto-
 * Recovery aus dem letzten validen Backup. Sehr ausfuehrliches Logging,
 * damit der Operator in den Render-Logs sieht was passierte.
 */
async function runBootDiagnostics() {
  // 0. Engine-Mode log
  log.info("storage_engine", { engine: storage.ENGINE });

  // 1. Storage-Writability (Postgres-Ping oder File-Probe)
  try {
    const result = await storage.checkWritable();
    log.info("storage_writable", result);
    if (!result.persistent && process.env.NODE_ENV === "production") {
      log.warn("storage_ephemeral_in_production", {
        message:
          "Neither DATABASE_URL nor HENKES_DATA_DIR set -- using ephemeral filesystem. Bookings WILL be lost on every deploy/restart. Set DATABASE_URL (Neon Postgres) or attach a Render Disk.",
      });
    }
  } catch (err) {
    log.error("storage_not_writable", {
      engine: storage.ENGINE,
      error: err.message,
      hint:
        storage.ENGINE === "postgres"
          ? "DB unreachable. Check DATABASE_URL and Neon project status."
          : "Check disk mount + permissions.",
    });
  }

  // 2. JSON->DB Migration (no-op in JSON mode oder wenn DB schon Daten hat)
  if (db.IS_ENABLED) {
    const importResult = await migrate.maybeImportFromJson();
    log.info("appointments_import", importResult);
    const closedResult = await migrate.maybeImportClosedDays();
    log.info("closed_days_import", closedResult);
  }

  // 3. Integritaets-Check + Auto-Recovery (Auto-Recovery nur im JSON-Mode)
  const fileCheck = await storage.checkAppointmentsFile();
  if (fileCheck.healthy) {
    log.info("appointments_file_ok", {
      engine: storage.ENGINE,
      exists: fileCheck.exists,
      count: fileCheck.count,
    });
  } else {
    log.error("appointments_file_corrupted", {
      engine: storage.ENGINE,
      error: fileCheck.error,
      code: fileCheck.code,
      action:
        storage.ENGINE === "json"
          ? "attempting auto-recovery from latest valid backup"
          : "investigate DB connectivity",
    });
    if (storage.ENGINE === "json") {
      const recovery = await storage.recoverFromBackup();
      if (recovery.restored) {
        log.warn("auto_recovery_success", { from: recovery.from });
      } else {
        log.error("auto_recovery_failed", { reason: recovery.reason });
      }
    }
  }
}

/* ---------------- Graceful Shutdown ---------------- */

/**
 * Render schickt SIGTERM bei Deploys. Ohne sauberen Shutdown koennen
 * laufende Requests abgehackt werden und atomare File-Writes ggf. im
 * .tmp-Zustand stecken bleiben. Mit server.close() warten wir die
 * offenen Requests ab, dann beenden wir.
 *
 * 10s Hard-Timeout: wenn Requests haengen, trotzdem rausgehen.
 * Render gibt 30s zwischen SIGTERM und SIGKILL.
 */
function gracefulShutdown(signal) {
  log.info("shutdown_requested", { signal });

  // Backup-Scheduler stoppen, damit kein neuer Interval-Tick mehr feuert.
  backup.stop();

  const forceTimer = setTimeout(() => {
    log.error("shutdown_forced", { reason: "timeout after 10s" });
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  server.close(async (err) => {
    if (err) {
      log.error("shutdown_error", { error: String(err.message || err) });
      process.exit(1);
    }
    // DB-Pool sauber schliessen damit laufende Queries noch zu Ende koennen.
    if (db.IS_ENABLED) {
      try {
        await db.close();
      } catch (dbErr) {
        log.warn("db_close_error", { error: String(dbErr.message || dbErr) });
      }
    }
    log.info("shutdown_complete", {});
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Unhandled-Rejection-Logger: aufgefangen statt prozess-killend.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", {
    reason: String(reason?.message || reason),
    stack: reason?.stack,
  });
});

process.on("uncaughtException", (error) => {
  log.error("uncaught_exception", {
    error: String(error?.message || error),
    stack: error?.stack,
  });
  // Bei uncaught exception ist der Prozess-State undefiniert -- raus.
  // Render restartet den Container automatisch.
  process.exit(1);
});

module.exports = app;
