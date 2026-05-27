/**
 * Tests fuer storage.ENGINE und storage.IS_PERSISTENT.
 *
 * Diese beiden Konstanten steuern indirekt das ganze Boot-Verhalten:
 *   - ENGINE wird in /api/health, Logs und Boot-Diagnostics ausgegeben
 *   - IS_PERSISTENT loest in production die "ephemeral storage"-
 *     Warnung aus, wenn weder DATABASE_URL noch HENKES_DATA_DIR
 *     gesetzt sind
 *
 * Wenn die Logik hier still divergiert, sieht der Operator nicht mehr,
 * dass Buchungen beim naechsten Deploy verloren gehen koennten.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const tmpDir = path.join(os.tmpdir(), `henkes-storage-mode-${process.pid}-${Date.now()}`);

test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("storage.ENGINE = 'json' wenn DATABASE_URL nicht gesetzt", () => {
  const origDb = process.env.DATABASE_URL;
  const origDir = process.env.HENKES_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.HENKES_DATA_DIR = tmpDir;
  try {
    // Cache loeschen damit IS_ENABLED neu berechnet wird
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
    const storage = require("../lib/storage");
    assert.equal(storage.ENGINE, "json");
  } finally {
    if (origDb !== undefined) process.env.DATABASE_URL = origDb;
    if (origDir === undefined) delete process.env.HENKES_DATA_DIR;
    else process.env.HENKES_DATA_DIR = origDir;
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
  }
});

test("storage.IS_PERSISTENT = true wenn HENKES_DATA_DIR gesetzt", () => {
  const origDb = process.env.DATABASE_URL;
  const origDir = process.env.HENKES_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.HENKES_DATA_DIR = tmpDir;
  try {
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
    const storage = require("../lib/storage");
    assert.equal(storage.IS_PERSISTENT, true);
  } finally {
    if (origDb !== undefined) process.env.DATABASE_URL = origDb;
    if (origDir === undefined) delete process.env.HENKES_DATA_DIR;
    else process.env.HENKES_DATA_DIR = origDir;
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
  }
});

test("storage.IS_PERSISTENT = false wenn weder DATABASE_URL noch HENKES_DATA_DIR", () => {
  const origDb = process.env.DATABASE_URL;
  const origDir = process.env.HENKES_DATA_DIR;
  delete process.env.DATABASE_URL;
  delete process.env.HENKES_DATA_DIR;
  try {
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
    const storage = require("../lib/storage");
    assert.equal(storage.IS_PERSISTENT, false);
    assert.equal(storage.ENGINE, "json");
  } finally {
    if (origDb !== undefined) process.env.DATABASE_URL = origDb;
    if (origDir !== undefined) process.env.HENKES_DATA_DIR = origDir;
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
  }
});

test("storage.recoverFromBackup ist im JSON-Mode aktiv (kein no-op)", async () => {
  const origDb = process.env.DATABASE_URL;
  const origDir = process.env.HENKES_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.HENKES_DATA_DIR = tmpDir;
  try {
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
    const storage = require("../lib/storage");
    // Keine Backups-Dir vorhanden -> sauberer { restored:false, reason:'no backups directory' }
    const result = await storage.recoverFromBackup();
    assert.equal(result.restored, false);
    assert.match(result.reason, /backup|directory/i);
  } finally {
    if (origDb !== undefined) process.env.DATABASE_URL = origDb;
    if (origDir === undefined) delete process.env.HENKES_DATA_DIR;
    else process.env.HENKES_DATA_DIR = origDir;
    delete require.cache[require.resolve("../lib/db")];
    delete require.cache[require.resolve("../lib/storage")];
    delete require.cache[require.resolve("../lib/config")];
  }
});
