/**
 * Storage-Tests: isoliert in einem tmp-Verzeichnis. Env-Vars
 * HENKES_DATA_DIR/HENKES_APPOINTMENTS_FILE/HENKES_CLOSED_DAYS_FILE
 * werden VOR dem require gesetzt, damit config.js sie aufgreift.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// Eigene tmp-Verzeichnis pro Test-Run, damit Tests sich nicht beeinflussen.
const tmpDir = path.join(os.tmpdir(), `henkes-storage-test-${process.pid}-${Date.now()}`);
process.env.HENKES_DATA_DIR = tmpDir;
process.env.HENKES_APPOINTMENTS_FILE = path.join(tmpDir, "appointments.json");
process.env.HENKES_CLOSED_DAYS_FILE = path.join(tmpDir, "closed-days.json");

// require NACH dem Env-Var-Setzen, sonst cached config die Defaults.
const storage = require("../lib/storage");
const { APPOINTMENTS_FILE, CLOSED_DAYS_FILE } = require("../lib/config");

// Setup: leeres tmp-Verzeichnis sicherstellen.
test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ---------------- readAll ---------------- */

test("readAll: missing file -> initializes empty array", async () => {
  await fs.rm(APPOINTMENTS_FILE, { force: true });
  const result = await storage.readAll();
  assert.deepEqual(result, []);
  // Datei sollte jetzt existieren
  const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
  assert.equal(raw.trim(), "[]");
});

test("readAll: existing file -> parsed array", async () => {
  await fs.writeFile(
    APPOINTMENTS_FILE,
    JSON.stringify([{ id: "1", name: "Anna" }, { id: "2", name: "Bob" }])
  );
  const result = await storage.readAll();
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "Anna");
});

test("readAll: non-array JSON -> empty array (defensive)", async () => {
  // Beispiel: jemand schreibt versehentlich ein Objekt statt Array
  await fs.writeFile(APPOINTMENTS_FILE, JSON.stringify({ oops: true }));
  const result = await storage.readAll();
  assert.deepEqual(result, []);
});

test("readAll: corrupted JSON -> throws (no silent data loss)", async () => {
  await fs.writeFile(APPOINTMENTS_FILE, "{ this is not json");
  await assert.rejects(() => storage.readAll(), /JSON/);
  // Wichtig: wir loeschen die kaputte Datei NICHT automatisch -- der
  // Operator soll sich das anschauen koennen.
});

/* ---------------- writeAll (atomic) ---------------- */

test("writeAll: persists data correctly", async () => {
  const data = [{ id: "x", name: "Test" }];
  await storage.writeAll(data);
  const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
  assert.deepEqual(JSON.parse(raw), data);
});

test("writeAll: cleans up .tmp file (rename, not copy)", async () => {
  await storage.writeAll([{ id: "y" }]);
  const tempPath = `${APPOINTMENTS_FILE}.tmp`;
  // .tmp darf nach erfolgreichem rename nicht existieren
  await assert.rejects(() => fs.access(tempPath), /ENOENT/);
});

test("writeAll: 50 sequential writes don't corrupt file", async () => {
  // Echte Atomicity unter Concurrency ist mit fs.rename garantiert,
  // aber sequenzielle Belastung deckt simple Race-Conditions auf.
  for (let i = 0; i < 50; i++) {
    await storage.writeAll([{ id: `item-${i}`, n: i }]);
  }
  const result = await storage.readAll();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "item-49");
});

/* ---------------- findById ---------------- */

test("findById: returns appointment + index + full array", async () => {
  await storage.writeAll([
    { id: "a", name: "Anna" },
    { id: "b", name: "Bob" },
    { id: "c", name: "Carla" },
  ]);
  const { appointments, appointment, index } = await storage.findById("b");
  assert.equal(appointment.name, "Bob");
  assert.equal(index, 1);
  assert.equal(appointments.length, 3);
});

test("findById: unknown id -> null + index -1", async () => {
  await storage.writeAll([{ id: "a" }]);
  const result = await storage.findById("nope");
  assert.equal(result.appointment, null);
  assert.equal(result.index, -1);
});

/* ---------------- findByCancelToken ---------------- */

test("findByCancelToken: matches by token", async () => {
  await storage.writeAll([
    { id: "a", cancelToken: "tok-1" },
    { id: "b", cancelToken: "tok-2" },
  ]);
  const result = await storage.findByCancelToken("tok-2");
  assert.equal(result.appointment.id, "b");
});

test("findByCancelToken: unknown token -> null", async () => {
  const result = await storage.findByCancelToken("nope");
  assert.equal(result.appointment, null);
});

/* ---------------- remove ---------------- */

test("remove: deletes and returns the removed appointment", async () => {
  await storage.writeAll([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const removed = await storage.remove("b");
  assert.equal(removed.id, "b");
  const remaining = await storage.readAll();
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((x) => x.id), ["a", "c"]);
});

test("remove: unknown id -> null", async () => {
  await storage.writeAll([{ id: "a" }]);
  const removed = await storage.remove("nope");
  assert.equal(removed, null);
  const remaining = await storage.readAll();
  assert.equal(remaining.length, 1);
});

/* ---------------- readClosedDays ---------------- */

test("readClosedDays: missing file -> empty set", async () => {
  await fs.rm(CLOSED_DAYS_FILE, { force: true });
  const set = await storage.readClosedDays();
  assert.equal(set.size, 0);
});

test("readClosedDays: malformed JSON -> empty set (silent fallback)", async () => {
  // Anders als appointments.json: Schliesstage sind nicht kritisch,
  // ein Fallback auf leer ist ok (im worst case wird ein Feiertag
  // versehentlich buchbar -- nicht dramatisch).
  await fs.writeFile(CLOSED_DAYS_FILE, "garbage");
  const set = await storage.readClosedDays();
  assert.equal(set.size, 0);
});

test("readClosedDays: valid file -> Set with dates", async () => {
  await fs.writeFile(
    CLOSED_DAYS_FILE,
    JSON.stringify({ days: ["2026-12-24", "2026-12-25"] })
  );
  const set = await storage.readClosedDays();
  assert.equal(set.size, 2);
  assert.equal(set.has("2026-12-24"), true);
  assert.equal(set.has("2026-12-25"), true);
  assert.equal(set.has("2026-12-26"), false);
});

test("readClosedDays: 'days' non-array -> empty set", async () => {
  await fs.writeFile(CLOSED_DAYS_FILE, JSON.stringify({ days: "not-an-array" }));
  const set = await storage.readClosedDays();
  assert.equal(set.size, 0);
});
