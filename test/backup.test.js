/**
 * Tests fuer lib/backup.js.
 * Isoliert in tmp-Verzeichnis via HENKES_DATA_DIR (vor allen require).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const tmpDir = path.join(os.tmpdir(), `henkes-backup-test-${process.pid}-${Date.now()}`);
process.env.HENKES_DATA_DIR = tmpDir;
process.env.HENKES_APPOINTMENTS_FILE = path.join(tmpDir, "appointments.json");
process.env.HENKES_CLOSED_DAYS_FILE = path.join(tmpDir, "closed-days.json");
process.env.HENKES_BACKUP_DISABLED = "0"; // wir wollen testen

const backup = require("../lib/backup");
const { APPOINTMENTS_FILE } = require("../lib/config");
const BACKUPS_DIR = backup.BACKUPS_DIR;

test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  backup.stop();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ---------------- makeBackup ---------------- */

test("makeBackup: skips when no source file (first boot)", async () => {
  await fs.rm(APPOINTMENTS_FILE, { force: true });
  const result = await backup.makeBackup();
  assert.equal(result.skipped, true);
});

test("makeBackup: creates timestamped snapshot of valid file", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, JSON.stringify([{ id: "a" }, { id: "b" }]));
  const result = await backup.makeBackup();
  assert.ok(result.path);
  assert.match(result.filename, /^appointments-.+\.json$/);
  assert.equal(result.count, 2);

  const written = await fs.readFile(result.path, "utf8");
  assert.deepEqual(JSON.parse(written), [{ id: "a" }, { id: "b" }]);
});

test("makeBackup: throws on corrupted source (no garbage backup)", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, "{ this is not json");
  await assert.rejects(() => backup.makeBackup(), /corrupted/i);
});

test("makeBackup: atomically writes (no .tmp leaks)", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, JSON.stringify([{ id: "c" }]));
  const result = await backup.makeBackup();
  const tmp = `${result.path}.tmp`;
  await assert.rejects(() => fs.access(tmp), /ENOENT/, ".tmp must not remain after rename");
});

/* ---------------- rotate ---------------- */

test("rotate: keeps latest N, deletes the rest", async () => {
  // Sauberer Start -- vorige Tests koennen Snapshots hinterlassen haben
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const ts = `2026-05-${String(20 + i).padStart(2, "0")}T00-00-00-000Z`;
    await fs.writeFile(path.join(BACKUPS_DIR, `appointments-${ts}.json`), "[]");
  }
  const { kept, deleted } = await backup.rotate(3);
  assert.equal(kept, 3);
  assert.equal(deleted, 2);
  const remaining = (await fs.readdir(BACKUPS_DIR)).filter((f) =>
    f.startsWith("appointments-")
  );
  assert.equal(remaining.length, 3);
  assert.ok(!remaining.includes("appointments-2026-05-20T00-00-00-000Z.json"));
  assert.ok(remaining.includes("appointments-2026-05-24T00-00-00-000Z.json"));
});

test("rotate: noop when under retention", async () => {
  // dir hat noch 3 von vorigem Test
  const { deleted } = await backup.rotate(10);
  assert.equal(deleted, 0);
});

test("rotate: ENOENT-safe (no backups dir yet)", async () => {
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  const { kept, deleted } = await backup.rotate(5);
  assert.equal(kept, 0);
  assert.equal(deleted, 0);
});

/* ---------------- listBackups ---------------- */

test("listBackups: empty dir returns count 0", async () => {
  await fs.rm(BACKUPS_DIR, { recursive: true, force: true });
  const result = await backup.listBackups();
  assert.equal(result.count, 0);
  assert.equal(result.lastBackupAt, null);
});

test("listBackups: returns count + most recent timestamp", async () => {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.writeFile(path.join(BACKUPS_DIR, "appointments-2026-05-20T00-00-00-000Z.json"), "[]");
  await fs.writeFile(path.join(BACKUPS_DIR, "appointments-2026-05-21T00-00-00-000Z.json"), "[]");
  const result = await backup.listBackups();
  assert.equal(result.count, 2);
  assert.ok(result.lastBackupAt);
  assert.ok(result.files.length >= 2);
  // Neueste zuerst -- per Filename sortiert
  assert.equal(result.files[0].name, "appointments-2026-05-21T00-00-00-000Z.json");
});

/* ---------------- backupAndRotate ---------------- */

test("backupAndRotate: full cycle records lastBackupAt and clears error", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, JSON.stringify([{ id: "ok" }]));
  await backup.backupAndRotate();
  const s = backup.status();
  assert.ok(s.lastBackupAt, "lastBackupAt must be set after success");
  assert.equal(s.lastError, null);
});

test("backupAndRotate: failure records lastError but does not throw", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, "definitely not json");
  await backup.backupAndRotate(); // muss NICHT werfen
  const s = backup.status();
  assert.ok(s.lastError, "lastError must capture failure");
  assert.match(s.lastError.message, /corrupted/i);
});

/* ---------------- status ---------------- */

test("status: reports enabled/interval/retention", () => {
  const s = backup.status();
  assert.equal(typeof s.enabled, "boolean");
  assert.ok(s.intervalHours > 0);
  assert.ok(s.retention > 0);
  assert.equal(s.backupsDir, BACKUPS_DIR);
});

/* ---------------- start/stop (idempotent) ---------------- */

test("start + stop: safe to call multiple times", () => {
  backup.start();
  backup.start(); // alter Handle wird in stop() abgeraeumt
  backup.stop();
  backup.stop(); // doppelter Stop ist no-op
});
