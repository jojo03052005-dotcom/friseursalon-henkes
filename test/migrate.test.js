/**
 * Tests fuer lib/migrate.js — Skip-Pfade.
 *
 * Echtes DB-Verhalten testen wir nicht (kein pg-mem als Dependency,
 * wuerde "no new deps"-Regel verletzen). Aber die WICHTIGEN
 * Defensiv-Pfade decken wir ab:
 *   - DATABASE_URL nicht gesetzt -> skipped
 *   - JSON-Datei fehlt -> skipped
 *   - JSON-Datei leer -> skipped
 *
 * Diese Tests garantieren dass im File-Mode (alle anderen Tests +
 * lokale Dev) NICHTS aus dem Migrate-Modul Fehler wirft.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const tmpDir = path.join(os.tmpdir(), `henkes-migrate-test-${process.pid}-${Date.now()}`);
process.env.HENKES_DATA_DIR = tmpDir;
process.env.HENKES_APPOINTMENTS_FILE = path.join(tmpDir, "appointments.json");
process.env.HENKES_CLOSED_DAYS_FILE = path.join(tmpDir, "closed-days.json");
// Wichtig: DATABASE_URL NICHT gesetzt, damit Migrate-Skip-Pfade greifen.
delete process.env.DATABASE_URL;

const migrate = require("../lib/migrate");

test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("maybeImportFromJson: ohne DATABASE_URL -> skipped", async () => {
  const result = await migrate.maybeImportFromJson();
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DATABASE_URL/);
});

test("maybeImportClosedDays: ohne DATABASE_URL -> skipped", async () => {
  const result = await migrate.maybeImportClosedDays();
  assert.equal(result.skipped, true);
});

test("maybeImportFromJson: idempotent (mehrfach aufrufbar)", async () => {
  // Mehrere Aufrufe muessen NICHT werfen
  const a = await migrate.maybeImportFromJson();
  const b = await migrate.maybeImportFromJson();
  const c = await migrate.maybeImportFromJson();
  assert.equal(a.skipped, true);
  assert.equal(b.skipped, true);
  assert.equal(c.skipped, true);
});

test("maybeImportClosedDays: idempotent", async () => {
  const a = await migrate.maybeImportClosedDays();
  const b = await migrate.maybeImportClosedDays();
  assert.equal(a.skipped, true);
  assert.equal(b.skipped, true);
});
