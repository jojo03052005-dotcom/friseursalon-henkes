/**
 * Storage-Layer fuer Termine + Schliesstage.
 *
 * Zwei Engines:
 *   - Postgres (lib/db.js), aktiv wenn DATABASE_URL gesetzt ist
 *     (Production auf Render mit Neon)
 *   - File-basierter JSON (Default, fuer lokale Entwicklung + Tests)
 *
 * Die oeffentliche API ist identisch fuer beide Engines, sodass die
 * Routes nichts davon mitbekommen, womit sie sprechen.
 *
 * File-Engine:
 *   JSON in data/appointments.json mit atomarem Write (.tmp + rename).
 *   data/closed-days.json fuer Feiertage/Betriebsferien.
 *
 * Postgres-Engine:
 *   Termine in appointments-Tabelle (JSONB), closed-days in settings-
 *   Tabelle. Neon-Free reicht dicke.
 */

const fs = require("fs/promises");
const path = require("path");

const {
  DATA_DIR,
  APPOINTMENTS_FILE,
  CLOSED_DAYS_FILE,
} = require("./config");
const db = require("./db");

const logger = require("./logger").child("storage");

/**
 * Persistent-Mode-Indikator: entweder Postgres ueber DATABASE_URL ODER
 * HENKES_DATA_DIR auf einem Render-Disk-Mount. Wenn beides leer ist,
 * sind wir auf ephemerem FS -- Termine ueberleben keine Deploys.
 */
const IS_PERSISTENT = db.IS_ENABLED || Boolean(process.env.HENKES_DATA_DIR?.trim());

/**
 * Welche Engine ist aktiv? "postgres" wenn DATABASE_URL gesetzt,
 * sonst "json". Wird im Health-Endpoint + Boot-Log ausgegeben.
 */
const ENGINE = db.IS_ENABLED ? "postgres" : "json";

/* ---------------- File-Engine Implementierung ---------------- */

async function fileReadAll() {
  try {
    const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info("appointments_file_initialized", { path: APPOINTMENTS_FILE });
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(APPOINTMENTS_FILE, "[]", "utf8");
      return [];
    }
    throw error;
  }
}

async function fileWriteAll(appointments) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${APPOINTMENTS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(appointments, null, 2), "utf8");
  await fs.rename(tempFile, APPOINTMENTS_FILE);
}

async function fileReadClosedDays() {
  try {
    const raw = await fs.readFile(CLOSED_DAYS_FILE, "utf8");
    const data = JSON.parse(raw);
    return new Set(Array.isArray(data.days) ? data.days : []);
  } catch (_err) {
    return new Set();
  }
}

/* ---------------- High-Level API (Engine-agnostisch) ---------------- */

/**
 * Liest alle Termine. Postgres -> DB-Query, JSON -> File. Bei DB-Fehlern
 * wird die Exception weitergereicht (Routes mappen auf 500 + strukturierten Log).
 */
async function readAll() {
  if (db.IS_ENABLED) return db.readAllAppointments();
  return fileReadAll();
}

/**
 * Schreibt eine vollstaendige Liste. Bei Postgres unter der Haube eine
 * Transaktion (DELETE + Bulk-Insert). Bei File: atomar via .tmp + rename.
 *
 * Hinweis: das ist die "ersetze alles"-Operation. Im Postgres-Mode
 * gibt's eigentlich keinen Grund das ganze Set neu zu schreiben, aber
 * wir halten die API kompatibel mit dem File-Layer -- Routes machen
 * weiterhin readAll() -> mutate -> writeAll(). Bei <1000 Eintraegen
 * praktisch nicht messbar.
 */
async function writeAll(appointments) {
  if (db.IS_ENABLED) return db.writeAllAppointments(appointments);
  return fileWriteAll(appointments);
}

/**
 * Findet einen Termin anhand der ID. Liefert
 *   { appointments, appointment, index }
 * -- damit Aufrufer den Termin mutieren und mit writeAll() speichern
 * koennen, ohne zweimal zu lesen.
 *
 * Hinweis: im Postgres-Mode ist die "appointments-Liste + index"-Form
 * etwas kuenstlich (wir koennten direkt UPSERT machen), aber sie ist
 * API-kompatibel mit dem File-Layer und kostet uns nichts.
 */
async function findById(id) {
  const appointments = await readAll();
  const index = appointments.findIndex((item) => item.id === id);
  if (index === -1) return { appointments, appointment: null, index: -1 };
  return { appointments, appointment: appointments[index], index };
}

async function findByCancelToken(token) {
  if (db.IS_ENABLED) {
    const appointment = await db.findAppointmentByCancelToken(token);
    if (!appointment) {
      // appointments + index sind fuer den Caller egal wenn nicht gefunden,
      // aber API-kompatibel zurueckliefern.
      const appointments = await db.readAllAppointments();
      return { appointments, appointment: null, index: -1 };
    }
    // Liste + index fuer in-place-update vom Caller.
    const appointments = await db.readAllAppointments();
    const index = appointments.findIndex((a) => a.id === appointment.id);
    return { appointments, appointment, index };
  }
  const appointments = await fileReadAll();
  const index = appointments.findIndex((item) => item.cancelToken === token);
  if (index === -1) return { appointments, appointment: null, index: -1 };
  return { appointments, appointment: appointments[index], index };
}

async function remove(id) {
  if (db.IS_ENABLED) {
    return db.removeAppointment(id);
  }
  const appointments = await fileReadAll();
  const index = appointments.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const [removed] = appointments.splice(index, 1);
  await fileWriteAll(appointments);
  return removed;
}

async function readClosedDays() {
  if (db.IS_ENABLED) {
    const value = await db.getSetting("closed_days");
    return new Set(Array.isArray(value?.days) ? value.days : []);
  }
  return fileReadClosedDays();
}

/* ---------------- Health / Recovery ---------------- */

/**
 * Im DB-Mode: einmal SELECT 1 als Probe. Im File-Mode: Probe-Datei
 * schreiben + lesen + loeschen (wie bisher).
 */
async function checkWritable() {
  if (db.IS_ENABLED) {
    await db.ping();
    return { writable: true, path: "postgres", persistent: true, engine: "postgres" };
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const probeFile = path.join(DATA_DIR, ".write-probe");
  const stamp = `probe-${process.pid}-${Date.now()}`;
  await fs.writeFile(probeFile, stamp, "utf8");
  const readBack = await fs.readFile(probeFile, "utf8");
  if (readBack !== stamp) {
    throw new Error(
      `Write-probe mismatch in ${DATA_DIR} (read '${readBack.slice(0, 40)}' instead of '${stamp.slice(0, 40)}')`
    );
  }
  await fs.unlink(probeFile);
  return {
    writable: true,
    path: DATA_DIR,
    persistent: IS_PERSISTENT,
    engine: "json",
  };
}

/**
 * Im DB-Mode: SELECT COUNT(*) als Sanity-Check. Im File-Mode: JSON
 * lesen + parsen.
 */
async function checkAppointmentsFile() {
  if (db.IS_ENABLED) {
    try {
      const count = await db.countAppointments();
      return { healthy: true, exists: true, count, engine: "postgres" };
    } catch (error) {
      return {
        healthy: false,
        exists: true,
        error: error.message,
        code: error.code || "DB_ERROR",
        engine: "postgres",
      };
    }
  }
  try {
    const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      healthy: true,
      exists: true,
      count: Array.isArray(data) ? data.length : 0,
      isArray: Array.isArray(data),
      sizeBytes: raw.length,
      engine: "json",
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { healthy: true, exists: false, count: 0, engine: "json" };
    }
    return {
      healthy: false,
      exists: true,
      error: error.message,
      code: error.code || "PARSE_ERROR",
      engine: "json",
    };
  }
}

/**
 * Versucht eine korrupte appointments.json aus dem letzten validen
 * Backup wiederherzustellen. NUR im JSON-Mode relevant -- im Postgres-
 * Mode passiert das nie (Postgres hat eigene Crash-Recovery, Neon
 * bietet zusaetzlich Point-in-Time-Recovery).
 */
async function recoverFromBackup() {
  if (db.IS_ENABLED) {
    return { restored: false, from: null, reason: "not applicable in postgres mode" };
  }

  const backupsDir = path.join(DATA_DIR, "backups");
  let backupFiles = [];
  try {
    const all = await fs.readdir(backupsDir);
    backupFiles = all
      .filter((f) => f.startsWith("appointments-") && f.endsWith(".json"))
      .sort()
      .reverse();
  } catch (err) {
    if (err.code === "ENOENT") {
      return { restored: false, from: null, reason: "no backups directory" };
    }
    return { restored: false, from: null, reason: `readdir failed: ${err.message}` };
  }

  if (backupFiles.length === 0) {
    return { restored: false, from: null, reason: "backups directory empty" };
  }

  try {
    const corruptedTarget = `${APPOINTMENTS_FILE}.corrupted-${Date.now()}`;
    await fs.rename(APPOINTMENTS_FILE, corruptedTarget);
    logger.warn("corrupted_file_quarantined", { moved_to: corruptedTarget });
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.error("quarantine_failed", { error: err.message });
    }
  }

  for (const filename of backupFiles) {
    const candidate = path.join(backupsDir, filename);
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;

      const tmpDest = `${APPOINTMENTS_FILE}.tmp`;
      await fs.writeFile(tmpDest, raw, "utf8");
      await fs.rename(tmpDest, APPOINTMENTS_FILE);

      logger.warn("recovered_from_backup", {
        from: filename,
        appointments: data.length,
      });
      return { restored: true, from: filename, reason: "success" };
    } catch (err) {
      logger.warn("backup_skip_invalid", { filename, error: err.message });
      continue;
    }
  }

  return {
    restored: false,
    from: null,
    reason: `no valid backup found among ${backupFiles.length} files`,
  };
}

module.exports = {
  readAll,
  writeAll,
  findById,
  findByCancelToken,
  remove,
  readClosedDays,
  checkWritable,
  checkAppointmentsFile,
  recoverFromBackup,
  IS_PERSISTENT,
  ENGINE,
  DATA_DIR,
  APPOINTMENTS_FILE,
};
