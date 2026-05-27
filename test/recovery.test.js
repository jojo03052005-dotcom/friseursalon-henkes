/**
 * Tests fuer den Recovery-Pfad: korrupte appointments.json soll aus
 * dem letzten validen Backup wiederhergestellt werden.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const tmpDir = path.join(os.tmpdir(), `henkes-recovery-test-${process.pid}-${Date.now()}`);
process.env.HENKES_DATA_DIR = tmpDir;
process.env.HENKES_APPOINTMENTS_FILE = path.join(tmpDir, "appointments.json");
process.env.HENKES_CLOSED_DAYS_FILE = path.join(tmpDir, "closed-days.json");

const storage = require("../lib/storage");
const { APPOINTMENTS_FILE } = require("../lib/config");
const BACKUPS_DIR = path.join(tmpDir, "backups");

test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("checkAppointmentsFile: missing file -> healthy + count 0", async () => {
  await fs.rm(APPOINTMENTS_FILE, { force: true });
  const result = await storage.checkAppointmentsFile();
  assert.equal(result.healthy, true);
  assert.equal(result.exists, false);
  assert.equal(result.count, 0);
});

test("checkAppointmentsFile: valid array -> healthy with count", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, JSON.stringify([{ id: "1" }, { id: "2" }]));
  const result = await storage.checkAppointmentsFile();
  assert.equal(result.healthy, true);
  assert.equal(result.count, 2);
  assert.equal(result.isArray, true);
});

test("checkAppointmentsFile: corrupted JSON -> unhealthy with error", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, "{ bad");
  const result = await storage.checkAppointmentsFile();
  assert.equal(result.healthy, false);
  assert.match(result.error, /JSON/i);
});

test("recoverFromBackup: no backups dir -> restored false", async () => {
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  await fs.writeFile(APPOINTMENTS_FILE, "{ corrupt");
  const result = await storage.recoverFromBackup();
  assert.equal(result.restored, false);
  assert.match(result.reason, /no backups/i);
});

test("recoverFromBackup: empty backups dir -> restored false", async () => {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.writeFile(APPOINTMENTS_FILE, "{ corrupt");
  const result = await storage.recoverFromBackup();
  assert.equal(result.restored, false);
  assert.match(result.reason, /empty/i);
});

test("recoverFromBackup: picks newest valid backup", async () => {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  // 3 backups, neueste enthaelt 3 Termine
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-20T00-00-00-000Z.json"),
    JSON.stringify([{ id: "old" }])
  );
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-21T00-00-00-000Z.json"),
    JSON.stringify([{ id: "mid1" }, { id: "mid2" }])
  );
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-22T00-00-00-000Z.json"),
    JSON.stringify([{ id: "new1" }, { id: "new2" }, { id: "new3" }])
  );
  await fs.writeFile(APPOINTMENTS_FILE, "{ corrupt");

  const result = await storage.recoverFromBackup();
  assert.equal(result.restored, true);
  assert.match(result.from, /2026-05-22/);

  // appointments.json sollte jetzt die 3 Termine aus dem neuesten Backup haben
  const restored = JSON.parse(await fs.readFile(APPOINTMENTS_FILE, "utf8"));
  assert.equal(restored.length, 3);
});

test("recoverFromBackup: skips invalid backups, falls back to next", async () => {
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  // Neuestes Backup ist KAPUTT, das mittlere ist gut, das aelteste ebenfalls
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-22T00-00-00-000Z.json"),
    "{ broken"
  );
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-21T00-00-00-000Z.json"),
    JSON.stringify([{ id: "valid-fallback" }])
  );
  await fs.writeFile(APPOINTMENTS_FILE, "{ also broken");

  const result = await storage.recoverFromBackup();
  assert.equal(result.restored, true);
  assert.match(result.from, /2026-05-21/, "should skip corrupted newest, pick valid older");

  const restored = JSON.parse(await fs.readFile(APPOINTMENTS_FILE, "utf8"));
  assert.equal(restored[0].id, "valid-fallback");
});

test("recoverFromBackup: quarantines corrupted file as .corrupted-<ts>", async () => {
  // Vorige Tests koennen Quarantaene-Dateien hinterlassen haben -- aufraeumen.
  for (const f of await fs.readdir(tmpDir)) {
    if (f.startsWith("appointments.json.corrupted-")) {
      await fs.unlink(path.join(tmpDir, f));
    }
  }
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(BACKUPS_DIR, "appointments-2026-05-25T00-00-00-000Z.json"),
    JSON.stringify([{ id: "from-backup" }])
  );
  await fs.writeFile(APPOINTMENTS_FILE, "{ broken-original");

  await storage.recoverFromBackup();

  const files = await fs.readdir(tmpDir);
  const quarantined = files
    .filter((f) => f.startsWith("appointments.json.corrupted-"))
    .sort()
    .pop(); // neueste Quarantaene
  assert.ok(quarantined, "Original should be quarantined, not lost");
  const original = await fs.readFile(path.join(tmpDir, quarantined), "utf8");
  assert.equal(original, "{ broken-original");
});

test("checkWritable: detects writable dir + reports persistent flag", async () => {
  const result = await storage.checkWritable();
  assert.equal(result.writable, true);
  assert.equal(result.path, tmpDir);
  // HENKES_DATA_DIR ist hier gesetzt -> persistent:true
  assert.equal(result.persistent, true);
});

test("checkWritable: no .write-probe leftover after success", async () => {
  await storage.checkWritable();
  await assert.rejects(
    () => fs.access(path.join(tmpDir, ".write-probe")),
    /ENOENT/
  );
});
