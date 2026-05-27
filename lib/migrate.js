/**
 * Einmal-Migration: appointments.json -> Postgres.
 *
 * Wird beim Server-Start aufgerufen wenn:
 *   - DATABASE_URL gesetzt ist (Postgres-Mode aktiv)
 *   - Die DB-Tabelle leer ist
 *   - Eine appointments.json existiert (z.B. zuletzt manuell hochgeladen
 *     oder vom alten File-Mode uebernommen)
 *
 * Idempotent: ein zweiter Aufruf macht nichts mehr, wenn die DB bereits
 * Eintraege hat.
 *
 * Wirft nicht -- bei Fehler wird strukturiert geloggt und Server startet
 * trotzdem (lieber leerer Salon als Crash-Loop).
 */

const fs = require("fs/promises");

const { APPOINTMENTS_FILE, CLOSED_DAYS_FILE } = require("./config");
const db = require("./db");
const logger = require("./logger").child("migrate");

async function maybeImportFromJson() {
  if (!db.IS_ENABLED) return { skipped: true, reason: "DATABASE_URL not set" };

  try {
    const existing = await db.countAppointments();
    if (existing > 0) {
      return { skipped: true, reason: `DB already has ${existing} appointments` };
    }

    let raw;
    try {
      raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return { skipped: true, reason: "no appointments.json to import" };
      }
      throw err;
    }

    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length === 0) {
      return { skipped: true, reason: "appointments.json empty or not an array" };
    }

    logger.warn("importing_from_json", {
      count: data.length,
      from: APPOINTMENTS_FILE,
    });

    let imported = 0;
    let failed = 0;
    for (const appt of data) {
      if (!appt?.id) {
        failed++;
        continue;
      }
      try {
        await db.upsertAppointment(appt);
        imported++;
      } catch (err) {
        failed++;
        logger.error("import_row_failed", {
          id: appt.id,
          error: err.message,
        });
      }
    }

    logger.info("import_complete", { imported, failed });
    return { imported, failed };
  } catch (err) {
    logger.error("import_failed", { error: err.message });
    return { error: err.message };
  }
}

/**
 * Migriert closed-days.json einmalig nach settings.closed_days.
 * Idempotent: ueberschreibt nicht, wenn der DB-Eintrag schon existiert.
 */
async function maybeImportClosedDays() {
  if (!db.IS_ENABLED) return { skipped: true };
  try {
    const existing = await db.getSetting("closed_days");
    if (existing) {
      return { skipped: true, reason: "closed_days already in DB" };
    }
    let raw;
    try {
      raw = await fs.readFile(CLOSED_DAYS_FILE, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return { skipped: true, reason: "no closed-days.json" };
      }
      throw err;
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.days)) {
      return { skipped: true, reason: "no 'days' array in file" };
    }
    await db.setSetting("closed_days", { days: data.days });
    logger.info("closed_days_imported", { count: data.days.length });
    return { imported: data.days.length };
  } catch (err) {
    logger.error("closed_days_import_failed", { error: err.message });
    return { error: err.message };
  }
}

module.exports = {
  maybeImportFromJson,
  maybeImportClosedDays,
};
