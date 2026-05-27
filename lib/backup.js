/**
 * Backup-System fuer appointments.json.
 *
 * Verhalten:
 *   - Zeitgesteuerte Snapshots alle BACKUP_INTERVAL_HOURS (default 6h)
 *   - Behaelt die letzten BACKUP_RETENTION Snapshots (default 14 = 3.5 Tage
 *     bei 6h-Takt). Aeltere werden rotiert geloescht.
 *   - Integritaets-Check VOR jedem Backup (kaputte JSON-Quelle -> kein
 *     Backup, Fehler im Log)
 *   - Atomares Schreiben (tmp + rename) damit ein Crash mitten im Backup
 *     keinen halben Snapshot hinterlaesst
 *   - Persistiert nach <DATA_DIR>/backups/appointments-<ISO-Timestamp>.json
 *
 * Trigger:
 *   - Beim Start: erstes Backup nach 60s (gibt dem Server Zeit zum Warm
 *     werden, faengt aber noch fruehe Faelle ab)
 *   - Danach: setInterval mit BACKUP_INTERVAL_HOURS
 *   - Stop: clearInterval bei SIGTERM (server.js)
 *
 * Bewusst kein cron-Modul -- setInterval ist nativ, kein Mehraufwand.
 *
 * Env-Vars (alle optional):
 *   HENKES_BACKUP_INTERVAL_HOURS   default 6
 *   HENKES_BACKUP_RETENTION        default 14
 *   HENKES_BACKUP_DISABLED         "1" deaktiviert komplett (z.B. fuer Tests)
 */

const fs = require("fs/promises");
const path = require("path");

const { DATA_DIR, APPOINTMENTS_FILE } = require("./config");
const logger = require("./logger").child("backup");

const HOUR_MS = 60 * 60 * 1000;

const INTERVAL_HOURS = parseFloat(process.env.HENKES_BACKUP_INTERVAL_HOURS) || 6;
const RETENTION = parseInt(process.env.HENKES_BACKUP_RETENTION, 10) || 14;
// Im Postgres-Mode macht das File-Backup keinen Sinn (Daten liegen in
// der DB, Neon hat eigene PITR). Operator kann via env explizit aus.
const POSTGRES_MODE = Boolean(process.env.DATABASE_URL?.trim());
const DISABLED = process.env.HENKES_BACKUP_DISABLED === "1" || POSTGRES_MODE;

const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const FILENAME_PREFIX = "appointments-";
const FILENAME_SUFFIX = ".json";

let intervalHandle = null;
let lastBackupAt = null;
let lastError = null;

/**
 * Wandelt einen Zeitstempel in einen Dateinamen-sicheren ISO-String:
 * "2026-05-25T12-34-56-789Z" (Doppelpunkte und Punkte raus).
 */
function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Schreibt einen Snapshot der appointments.json ins Backup-Verzeichnis.
 * Wirft bei Source-Korruption, kann aber von Aufrufern abgefangen werden.
 *
 * Liefert: { path, size, count }
 */
async function makeBackup() {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });

  let source;
  try {
    source = await fs.readFile(APPOINTMENTS_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // Noch keine appointments.json -- nichts zu backupen, kein Fehler.
      logger.debug("backup_skipped_no_source", {});
      return { skipped: true, reason: "no appointments file yet" };
    }
    throw err;
  }

  // Integrity-Check: Quelle muss valide JSON sein, sonst kein Backup
  // (verhindert dass wir versehentlich kaputte Daten als "Backup"
  // verewigen und ueber alte gute Snapshots rotieren).
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const msg = `Source JSON corrupted, refusing to back up: ${err.message}`;
    logger.error("backup_source_corrupted", { error: err.message });
    throw new Error(msg);
  }

  const filename = `${FILENAME_PREFIX}${timestampForFilename()}${FILENAME_SUFFIX}`;
  const dest = path.join(BACKUPS_DIR, filename);
  const tmp = `${dest}.tmp`;

  await fs.writeFile(tmp, source, "utf8");
  await fs.rename(tmp, dest);

  lastBackupAt = new Date();
  lastError = null;

  const count = Array.isArray(parsed) ? parsed.length : 0;
  logger.info("backup_created", { filename, count, sizeBytes: source.length });

  return { path: dest, filename, size: source.length, count };
}

/**
 * Loescht alle Backups jenseits der Retention. Aelteste zuerst.
 * Liefert { kept, deleted }.
 */
async function rotate(retention = RETENTION) {
  let files;
  try {
    const all = await fs.readdir(BACKUPS_DIR);
    files = all
      .filter((f) => f.startsWith(FILENAME_PREFIX) && f.endsWith(FILENAME_SUFFIX))
      .sort(); // ISO timestamps sortieren chronologisch
  } catch (err) {
    if (err.code === "ENOENT") return { kept: 0, deleted: 0 };
    throw err;
  }

  if (files.length <= retention) {
    return { kept: files.length, deleted: 0 };
  }

  const toDelete = files.slice(0, files.length - retention);
  let deleted = 0;
  for (const f of toDelete) {
    try {
      await fs.unlink(path.join(BACKUPS_DIR, f));
      deleted++;
    } catch (err) {
      logger.warn("backup_rotation_unlink_failed", { file: f, error: err.message });
    }
  }

  if (deleted > 0) {
    logger.info("backup_rotated", { kept: retention, deleted });
  }
  return { kept: retention, deleted };
}

/**
 * Listet vorhandene Backups, sortiert neueste zuerst.
 * Liefert { count, lastBackupAt: ISO-Datum-oder-null, files: [{name, sizeBytes, mtime}] }
 *
 * Wird vom /api/health-Endpoint genutzt -- daher schluckt sie auch
 * eventuelle Fehler und meldet sie strukturiert.
 */
async function listBackups() {
  try {
    const all = await fs.readdir(BACKUPS_DIR);
    const filtered = all
      .filter((f) => f.startsWith(FILENAME_PREFIX) && f.endsWith(FILENAME_SUFFIX))
      .sort()
      .reverse(); // neueste zuerst

    if (filtered.length === 0) {
      return { count: 0, lastBackupAt: null, files: [] };
    }

    const files = [];
    for (const name of filtered.slice(0, 10)) {
      try {
        const stat = await fs.stat(path.join(BACKUPS_DIR, name));
        files.push({
          name,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch (_err) {
        files.push({ name, error: "stat failed" });
      }
    }

    return {
      count: filtered.length,
      lastBackupAt: files[0]?.mtime || null,
      files,
    };
  } catch (err) {
    if (err.code === "ENOENT") return { count: 0, lastBackupAt: null, files: [] };
    return { count: 0, lastBackupAt: null, files: [], error: err.message };
  }
}

/**
 * Einmalige Backup + Rotation. Faengt Fehler ab, loggt sie und
 * persistiert sie als `lastError` (sichtbar im /api/health).
 */
async function backupAndRotate() {
  try {
    const result = await makeBackup();
    await rotate();
    return result;
  } catch (err) {
    lastError = {
      message: err.message,
      at: new Date().toISOString(),
    };
    logger.error("backup_cycle_failed", { error: err.message });
    return { error: err.message };
  }
}

/**
 * Startet den Backup-Scheduler. Macht das erste Backup nach 60s, dann
 * alle INTERVAL_HOURS Stunden. Mehrfach-Aufruf ist sicher (alter
 * Interval-Handle wird sauber gestoppt).
 *
 * Wenn HENKES_BACKUP_DISABLED=1, macht diese Funktion nichts (Tests).
 */
function start() {
  if (DISABLED) {
    logger.info("backup_disabled", {
      reason: POSTGRES_MODE ? "postgres mode (DB has own backups)" : "via env",
    });
    return;
  }
  stop();

  // Erstes Backup nach kurzer Wartezeit. Vermeidet Race wenn appointments.json
  // bei Boot noch nicht existiert; gibt auch dem Logger Zeit fuer den
  // Startup-Banner.
  const firstDelayMs = 60 * 1000;
  setTimeout(() => {
    backupAndRotate();
  }, firstDelayMs).unref(); // unref: blockiert kein Prozess-Exit

  intervalHandle = setInterval(() => {
    backupAndRotate();
  }, INTERVAL_HOURS * HOUR_MS);
  intervalHandle.unref();

  logger.info("backup_scheduler_started", {
    intervalHours: INTERVAL_HOURS,
    retention: RETENTION,
    backupsDir: BACKUPS_DIR,
  });
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("backup_scheduler_stopped", {});
  }
}

/**
 * Status-Info fuer den Health-Endpoint.
 */
function status() {
  return {
    enabled: !DISABLED,
    intervalHours: INTERVAL_HOURS,
    retention: RETENTION,
    backupsDir: BACKUPS_DIR,
    lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
    lastError,
  };
}

module.exports = {
  makeBackup,
  rotate,
  backupAndRotate,
  listBackups,
  start,
  stop,
  status,
  BACKUPS_DIR,
};
