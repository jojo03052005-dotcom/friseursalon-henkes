/**
 * Postgres-Persistenz-Layer.
 *
 * Aktiv wenn process.env.DATABASE_URL gesetzt ist (Production auf
 * Render mit Neon-Postgres). Wenn nicht gesetzt -> dieses Modul wird
 * gar nicht erst angefasst, lib/storage.js bleibt im File-Mode.
 *
 * Bewusst nur reines SQL via 'pg', kein ORM/Query-Builder. Zwei kleine
 * Tabellen, ~30 Zeilen SQL -- jedes weitere Layer waere Overkill.
 *
 * Schema:
 *   appointments (id TEXT PK, data JSONB, created_at TIMESTAMPTZ)
 *   settings     (key TEXT PK, value JSONB)
 *
 * appointments.data ist das vollstaendige Appointment-Objekt als JSONB
 * -- selbe Form wie bisher in appointments.json. Damit:
 *   - keine Schema-Migration noetig wenn ein neues Feld hinzukommt
 *   - alle Routes sehen exakt dieselbe Datenstruktur wie vorher
 *   - JSONB-Index auf email/date/time fuer dedupe-Performance
 *
 * settings haelt aktuell nur closed-days, ist aber generisch fuer
 * spaetere salon-konfigurierbare Werte.
 */

const { Pool } = require("pg");
const logger = require("./logger").child("db");

const IS_ENABLED = Boolean(process.env.DATABASE_URL?.trim());

let pool = null;
let initPromise = null;

function getPool() {
  if (!IS_ENABLED) {
    throw new Error("DATABASE_URL not set -- db.js should not be used in JSON mode");
  }
  if (pool) return pool;

  // Neon und die meisten Postgres-Hoster verlangen SSL. Wir aktivieren
  // es immer, akzeptieren aber das Server-Zertifikat ohne strenge
  // Validierung -- Neon hat ein vertrauenswuerdiges Setup, wir muessen
  // nicht das Render-CA-Bundle pflegen.
  const ssl = process.env.PGSSLMODE === "disable"
    ? false
    : { rejectUnauthorized: false };

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    // Free-Tier-Database: ein paar Connections reichen dicke.
    max: 5,
    // Bei Idle-Drop kein Crash, sondern frische Connection holen.
    idleTimeoutMillis: 30 * 1000,
    connectionTimeoutMillis: 10 * 1000,
  });

  pool.on("error", (err) => {
    logger.error("pool_error", { error: err.message });
  });

  return pool;
}

/**
 * Legt die Tabellen an wenn sie fehlen. Idempotent.
 * Wird beim ersten DB-Zugriff aufgerufen (siehe ensureSchema).
 */
async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id          TEXT PRIMARY KEY,
        data        JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Indexe fuer die heissesten Lookups: Storno-Token + Idempotency.
    await client.query(`
      CREATE INDEX IF NOT EXISTS appointments_cancel_token_idx
        ON appointments ((data->>'cancelToken'));
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS appointments_idempotency_key_idx
        ON appointments ((data->>'idempotencyKey'))
        WHERE data->>'idempotencyKey' IS NOT NULL;
    `);
    // Index fuer dedupe-Query (email + date + time + service).
    await client.query(`
      CREATE INDEX IF NOT EXISTS appointments_dedupe_idx
        ON appointments (
          (LOWER(data->>'email')),
          (data->>'date'),
          (data->>'time'),
          (data->>'service')
        );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key    TEXT PRIMARY KEY,
        value  JSONB NOT NULL
      );
    `);
    logger.info("schema_initialized", {});
  } finally {
    client.release();
  }
}

function ensureSchema() {
  if (!initPromise) initPromise = initSchema();
  return initPromise;
}

/* ---------------- High-level Operations ---------------- */

async function readAllAppointments() {
  await ensureSchema();
  const { rows } = await getPool().query(
    "SELECT data FROM appointments ORDER BY (data->>'date'), (data->>'time')"
  );
  return rows.map((r) => r.data);
}

/**
 * Schreibt eine vollstaendige Liste. Wird vom Storage-Layer als Ersatz
 * fuer "write das ganze JSON-File neu" benutzt. Wir machen das in einer
 * Transaktion: DELETE + bulk-insert. Bei <1000 Eintraegen voellig
 * unproblematisch.
 *
 * Wichtig: das ist NICHT die normale Hot-Path-Operation. Routes sollten
 * spaeter direkt upsert/delete einzelner Rows benutzen (siehe upsert/
 * removeAppointment). writeAllAppointments existiert nur fuer API-
 * Kompatibilitaet mit dem File-Layer.
 */
async function writeAllAppointments(appointments) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM appointments");
    for (const appt of appointments) {
      if (!appt?.id) continue;
      await client.query(
        `INSERT INTO appointments (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [appt.id, appt]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function upsertAppointment(appointment) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO appointments (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [appointment.id, appointment]
  );
}

async function findAppointmentById(id) {
  await ensureSchema();
  const { rows } = await getPool().query(
    "SELECT data FROM appointments WHERE id = $1",
    [id]
  );
  return rows[0]?.data || null;
}

async function findAppointmentByCancelToken(token) {
  await ensureSchema();
  const { rows } = await getPool().query(
    "SELECT data FROM appointments WHERE data->>'cancelToken' = $1",
    [token]
  );
  return rows[0]?.data || null;
}

async function removeAppointment(id) {
  await ensureSchema();
  const { rows } = await getPool().query(
    "DELETE FROM appointments WHERE id = $1 RETURNING data",
    [id]
  );
  return rows[0]?.data || null;
}

async function countAppointments() {
  await ensureSchema();
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM appointments");
  return rows[0]?.n ?? 0;
}

/* ---------------- Settings (closed-days etc.) ---------------- */

async function getSetting(key) {
  await ensureSchema();
  const { rows } = await getPool().query(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

/* ---------------- Health / Connection ---------------- */

/**
 * Probiert die DB-Connection. Wirft bei Fehler -- Aufrufer
 * (z.B. /api/health) faengt das und meldet structured.
 */
async function ping() {
  await getPool().query("SELECT 1");
  return true;
}

/**
 * Schliesst den Pool sauber. Wird vom server.js bei SIGTERM gerufen,
 * damit laufende Queries noch zu Ende koennen.
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

module.exports = {
  IS_ENABLED,
  readAllAppointments,
  writeAllAppointments,
  upsertAppointment,
  findAppointmentById,
  findAppointmentByCancelToken,
  removeAppointment,
  countAppointments,
  getSetting,
  setSetting,
  ping,
  close,
  // Fuer Tests:
  _resetForTesting: () => {
    pool = null;
    initPromise = null;
  },
};
