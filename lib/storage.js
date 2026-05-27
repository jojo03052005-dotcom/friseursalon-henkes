/**
 * Storage-Layer fuer Termine + Schliesstage.
 *
 * Aktuell File-basiert: JSON in data/appointments.json mit atomarem
 * Write (tempfile + rename). Wenn wir spaeter auf SQLite / Postgres
 * wechseln, aendert sich nur DIESES Modul -- alle Routen rufen die
 * gleichen High-Level-Funktionen.
 *
 * Wichtig: alle Funktionen werfen bei harten Fehlern (z.B. korrupte
 * JSON, Disk voll). Aufrufer fangen das im Route-Handler und mappen
 * auf eine HTTP-500-Antwort. ENOENT beim ersten Lesen wird sanft
 * behandelt -- wir legen die Datei mit "[]" an, damit das erste
 * Booking funktioniert.
 */

const fs = require("fs/promises");
const path = require("path");

const {
  DATA_DIR,
  APPOINTMENTS_FILE,
  CLOSED_DAYS_FILE,
} = require("./config");

const logger = require("./logger").child("storage");

/**
 * Persistent-Mode-Indikator: HENKES_DATA_DIR wurde explizit auf einen
 * Pfad gesetzt (typischer Render-Disk-Mount: /var/data/henkes). Wenn
 * nicht gesetzt, sind wir auf ephemerem Filesystem -- Termine ueberleben
 * keine Deploys.
 */
const IS_PERSISTENT = Boolean(process.env.HENKES_DATA_DIR?.trim());

/* ---------------- Termine ---------------- */

/**
 * Liest alle Termine. Wenn die Datei noch nicht existiert, wird sie
 * mit leerem Array angelegt. Defekte JSON -> Exception (kein silent
 * data loss).
 */
async function readAll() {
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

/**
 * Schreibt alle Termine atomar: erst in .tmp schreiben, dann rename.
 * rename ist auf POSIX/Windows atomar -- entweder ist die neue Datei
 * komplett da, oder die alte ist unveraendert. Verhindert halb-
 * geschriebene Files bei Strom-/Container-Crash mitten im Write.
 */
async function writeAll(appointments) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${APPOINTMENTS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(appointments, null, 2), "utf8");
  await fs.rename(tempFile, APPOINTMENTS_FILE);
}

/**
 * Findet einen Termin anhand der ID. Liefert { appointments, appointment, index }
 * -- so kann der Aufrufer den Termin mutieren und mit writeAll() speichern,
 * ohne zweimal zu lesen.
 */
async function findById(id) {
  const appointments = await readAll();
  const index = appointments.findIndex((item) => item.id === id);
  if (index === -1) {
    return { appointments, appointment: null, index: -1 };
  }
  return { appointments, appointment: appointments[index], index };
}

/**
 * Findet einen Termin anhand seines cancelToken (Storno-Flow).
 */
async function findByCancelToken(token) {
  const appointments = await readAll();
  const index = appointments.findIndex((item) => item.cancelToken === token);
  if (index === -1) {
    return { appointments, appointment: null, index: -1 };
  }
  return { appointments, appointment: appointments[index], index };
}

/**
 * Loescht einen Termin permanent. Liefert den entfernten Eintrag
 * zurueck (oder null wenn nicht gefunden).
 */
async function remove(id) {
  const appointments = await readAll();
  const index = appointments.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const [removed] = appointments.splice(index, 1);
  await writeAll(appointments);
  return removed;
}

/* ---------------- Schliesstage ---------------- */

/**
 * Liest die Schliesstage-Liste (Feiertage, Betriebsferien) aus
 * data/closed-days.json. Datei fehlt oder ungueltig -> leeres Set.
 * Wird einmal pro Validierung gelesen -- klein genug fuer JSON.
 */
async function readClosedDays() {
  try {
    const raw = await fs.readFile(CLOSED_DAYS_FILE, "utf8");
    const data = JSON.parse(raw);
    return new Set(Array.isArray(data.days) ? data.days : []);
  } catch (_err) {
    return new Set();
  }
}

/* ---------------- Health / Recovery ---------------- */

/**
 * Probiert das Datenverzeichnis schreibend an: legt eine winzige
 * Probe-Datei an und loescht sie wieder. Liefert true wenn alles OK,
 * sonst wirft eine Exception mit Klartext-Grund.
 *
 * Wird beim Server-Start aufgerufen und vom /api/health-Endpoint
 * angefragt. Damit faellt ein kaputter Disk-Mount frueh und
 * unmissverstaendlich auf.
 */
async function checkWritable() {
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
  };
}

/**
 * Prueft, ob appointments.json valides JSON ist (ohne den Inhalt zu
 * verwenden). Fehlt die Datei -> healthy:true mit count:0. Kann nicht
 * gelesen werden -> healthy:false + reason.
 */
async function checkAppointmentsFile() {
  try {
    const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      healthy: true,
      exists: true,
      count: Array.isArray(data) ? data.length : 0,
      isArray: Array.isArray(data),
      sizeBytes: raw.length,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { healthy: true, exists: false, count: 0 };
    }
    return {
      healthy: false,
      exists: true,
      error: error.message,
      code: error.code || "PARSE_ERROR",
    };
  }
}

/**
 * Versucht, eine korrupte appointments.json aus dem zuletzt gueltigen
 * Backup wiederherzustellen.
 *
 * Vorgehen:
 *   1. Sichere die kaputte Datei nach appointments.json.corrupted-<ts>
 *      (NIE einfach loeschen -- der Operator soll forensisch nachschauen
 *      koennen).
 *   2. Suche im backups/-Verzeichnis nach Snapshots, nimm den neuesten,
 *      der valide JSON enthaelt.
 *   3. Kopiere ihn nach appointments.json.
 *   4. Log ausfuehrlich, damit man im Render-Log sieht was passierte.
 *
 * Liefert { restored: bool, from: filename | null, reason: string }.
 * Wirft NIE -- schlimmstenfalls restored:false und der Server startet
 * mit leerer Liste (was sauberer ist als crashloop).
 */
async function recoverFromBackup() {
  const backupsDir = path.join(DATA_DIR, "backups");
  let backupFiles = [];
  try {
    const all = await fs.readdir(backupsDir);
    backupFiles = all
      .filter((f) => f.startsWith("appointments-") && f.endsWith(".json"))
      .sort()
      .reverse(); // neueste zuerst
  } catch (err) {
    if (err.code === "ENOENT") {
      return { restored: false, from: null, reason: "no backups directory" };
    }
    return { restored: false, from: null, reason: `readdir failed: ${err.message}` };
  }

  if (backupFiles.length === 0) {
    return { restored: false, from: null, reason: "backups directory empty" };
  }

  // Defekte Datei zur Seite legen (forensisch behalten).
  try {
    const corruptedTarget = `${APPOINTMENTS_FILE}.corrupted-${Date.now()}`;
    await fs.rename(APPOINTMENTS_FILE, corruptedTarget);
    logger.warn("corrupted_file_quarantined", { moved_to: corruptedTarget });
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.error("quarantine_failed", { error: err.message });
    }
  }

  // Den neuesten validen Backup-Snapshot finden + kopieren.
  for (const filename of backupFiles) {
    const candidate = path.join(backupsDir, filename);
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;

      // Atomar rueberkopieren (tmp + rename), damit ein Crash mitten im
      // Restore nichts halbes hinterlaesst.
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
  DATA_DIR,
  APPOINTMENTS_FILE,
};
