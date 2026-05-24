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

module.exports = {
  readAll,
  writeAll,
  findById,
  findByCancelToken,
  remove,
  readClosedDays,
};
