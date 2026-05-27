/**
 * Integrationstests: echte HTTP-Requests gegen einen gespawnten Server.
 *
 * Keine 'supertest'-Dependency -- wir nutzen das built-in 'http'-Modul.
 * Storage lebt im tmpdir, damit die echte appointments.json nicht
 * angefasst wird. Email-Service ist NICHT konfiguriert (kein
 * RESEND_API_KEY), darum gehen Mails ins Leere (= erwartetes
 * configured:false-Verhalten).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// Isoliertes Daten-Verzeichnis VOR allem.
const tmpDir = path.join(os.tmpdir(), `henkes-integration-${process.pid}-${Date.now()}`);
process.env.HENKES_DATA_DIR = tmpDir;
process.env.HENKES_APPOINTMENTS_FILE = path.join(tmpDir, "appointments.json");
process.env.HENKES_CLOSED_DAYS_FILE = path.join(tmpDir, "closed-days.json");
process.env.PORT = "0"; // freien Port automatisch waehlen
process.env.ADMIN_USER = "testadmin";
process.env.ADMIN_PASSWORD = "testpass-very-long";
process.env.CRON_SECRET = "test-cron-secret";
// Rate-Limits hoch, damit die Test-Suite nicht 429 von sich selbst kriegt
process.env.HENKES_BOOKING_RATE_MAX = "10000";
process.env.HENKES_CANCEL_RATE_MAX = "10000";
process.env.HENKES_ADMIN_RATE_MAX = "10000";
// Resend nicht konfigurieren -- Mails landen im "not_configured"-Pfad.
delete process.env.RESEND_API_KEY;
delete process.env.SALON_EMAIL;
delete process.env.NODE_ENV;

let server;
let port;

test.before(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  // App-Komposition manuell nachbauen (kein require('../server'),
  // weil das die Production-Listener + SIGTERM-Handler triggert).
  const app = await buildTestApp();
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  port = server.address().port;
});

test.after(async () => {
  if (server && server.close) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildTestApp() {
  const express = require("express");
  const helmet = require("helmet");
  const { ROOT_DIR, DEFAULT_ALLOWED_ORIGINS, NETLIFY_PREVIEW_REGEX } =
    require("../lib/config");
  const { requireAdminAuth } = require("../lib/auth");
  const publicRouter = require("../routes/public");
  const appointmentsRouter = require("../routes/appointments");
  const adminRouter = require("../routes/admin");
  const cronRouter = require("../routes/cron");
  const stornoRouter = require("../routes/storno");

  const a = express();
  a.set("trust proxy", 1);
  a.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  a.use(express.json({ limit: "32kb" }));
  a.use(express.urlencoded({ extended: false, limit: "4kb" }));
  a.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = new Set(DEFAULT_ALLOWED_ORIGINS);
    if (origin && (allowed.has(origin) || NETLIFY_PREVIEW_REGEX.test(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-Idempotency-Key"
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  a.use((req, res, next) => {
    if (req.path === "/admin.html" || req.path === "/admin.js") {
      return requireAdminAuth(req, res, next);
    }
    next();
  });
  a.use(express.static(ROOT_DIR));
  a.use("/api", publicRouter);
  a.use("/api/appointments", appointmentsRouter);
  a.use("/api/admin", adminRouter);
  a.use("/api/cron", cronRouter);
  a.use("/storno", stornoRouter);
  a.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ success: false, message: "not found" });
    }
    res.status(404).type("html").send("<h1>404</h1>");
  });
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ success: false, message: "internal error" });
  });
  return a;
}

/* ---------------- Helper ---------------- */

/**
 * Kapselt http-Request als Promise. Liefert { status, headers, body, json }.
 * body ist UTF-8 String, json wird best-effort geparsed.
 */
function request(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const data = options.body ? JSON.stringify(options.body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_e) { /* not json */ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function basicAuth(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/* ---------------- Health / Services ---------------- */

test("GET /api/health -> 200 with operational status", async () => {
  const r = await request("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.service, "friseursalon-henkes-backend");
  assert.equal(r.json.emailConfigured, false); // RESEND_API_KEY nicht gesetzt
  assert.ok(typeof r.json.uptimeSeconds === "number");
  assert.equal(typeof r.json.appointmentsFile, "object");
  assert.equal(typeof r.json.appointmentsFile.count, "number");
  assert.equal(typeof r.json.storage, "object");
  assert.equal(typeof r.json.backup, "object");
  assert.equal(typeof r.json.memory, "object");
  assert.ok(Array.isArray(r.json.warnings));
  assert.ok(typeof r.json.version === "string");
});

test("GET /api/services -> 200 with the 5 services", async () => {
  const r = await request("GET", "/api/services");
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.deepEqual(r.json.services, [
    "Haarschnitt", "Färbung", "Strähnen", "Styling", "Haarpflege",
  ]);
  assert.match(r.headers["cache-control"] || "", /max-age=300/);
});

/* ---------------- Booking ---------------- */

function futureTuesday() {
  // Naechster Dienstag in 14 Tagen -- weit weg vom 60-Min-Lead und
  // sicher im 90-Tage-Horizon.
  const d = new Date();
  d.setDate(d.getDate() + 14);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function validBooking(overrides = {}) {
  return {
    name: "Integration Test",
    phone: "0209 41793",
    email: "it@example.com",
    date: futureTuesday(),
    time: "10:00",
    service: "Haarschnitt",
    notes: "Integration test",
    ...overrides,
  };
}

test("POST /api/appointments: valid -> 201 (email not_configured but ok)", async () => {
  const r = await request("POST", "/api/appointments", { body: validBooking() });
  // Wenn Mail nicht konfiguriert ist -> 201 mit configured:false
  assert.equal(r.status, 201);
  assert.equal(r.json.success, true);
  assert.equal(r.json.appointment.name, "Integration Test");
  assert.ok(r.json.appointment.id, "appointment must have id");
  assert.equal(r.json.appointment.emailStatus.configured, false);
});

test("POST /api/appointments: honeypot -> 200 silent reject (kein appointment)", async () => {
  const before = (await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  })).json.appointments.length;

  const r = await request("POST", "/api/appointments", {
    body: validBooking({ website: "spam-link.tld" }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.appointment, undefined, "kein appointment in response");

  // Liste darf NICHT gewachsen sein
  const after = (await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  })).json.appointments.length;
  assert.equal(after, before, "Honeypot-Submission darf nicht gespeichert werden");
});

test("POST /api/appointments: invalid email -> 400", async () => {
  const r = await request("POST", "/api/appointments", {
    body: validBooking({ email: "no-at-sign" }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.success, false);
  assert.match(r.json.message, /E-Mail/);
});

test("POST /api/appointments: past date -> 400", async () => {
  const r = await request("POST", "/api/appointments", {
    body: validBooking({ date: "2020-01-01" }),
  });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /Vergangenheit/);
});

test("POST /api/appointments: invalid service -> 400", async () => {
  const r = await request("POST", "/api/appointments", {
    body: validBooking({ service: "Massage" }),
  });
  assert.equal(r.status, 400);
});

test("POST /api/appointments: idempotency-key replay returns same appointment", async () => {
  const key = "test-idempotency-key-abc-12345";
  const payload = validBooking({ email: "idem@example.com", time: "12:00" });

  const r1 = await request("POST", "/api/appointments", {
    body: payload,
    headers: { "X-Idempotency-Key": key },
  });
  assert.equal(r1.status, 201);
  const firstId = r1.json.appointment.id;

  // Selber Key + leicht geaenderte Payload -> immer noch der gleiche Termin
  const r2 = await request("POST", "/api/appointments", {
    body: { ...payload, notes: "different notes" },
    headers: { "X-Idempotency-Key": key },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.appointment.id, firstId);

  // Ohne Key + identische Payload -> normale Dedupe greift (gleiches Resultat,
  // aber anderer Code-Path)
  const r3 = await request("POST", "/api/appointments", {
    body: payload,
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.json.duplicate, true);
});

test("POST /api/appointments: different idempotency-key creates new appointment", async () => {
  const payload = validBooking({ email: "diff-key@example.com", time: "12:15" });
  const r1 = await request("POST", "/api/appointments", {
    body: payload,
    headers: { "X-Idempotency-Key": "key-A-xyz-001" },
  });
  assert.equal(r1.status, 201);

  // Anderer Key -> aber identische Payload -> 60s-Dedupe greift trotzdem
  // (das ist gewollt -- der ist die zweite Verteidigungslinie)
  const r2 = await request("POST", "/api/appointments", {
    body: payload,
    headers: { "X-Idempotency-Key": "key-B-xyz-002" },
  });
  // Dedupe greift -> duplicate:true, gleicher Termin
  assert.equal(r2.status, 200);
  assert.equal(r2.json.duplicate, true);
});

test("POST /api/appointments: duplicate within 60s -> 200 duplicate:true", async () => {
  const payload = validBooking({
    email: "dup-test@example.com",
    time: "11:00",
  });
  const r1 = await request("POST", "/api/appointments", { body: payload });
  assert.equal(r1.status, 201);

  const r2 = await request("POST", "/api/appointments", { body: payload });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.appointment.id, r1.json.appointment.id);
});

test("POST /api/appointments: slot conflict marked but not blocked", async () => {
  const date = futureTuesday();
  await request("POST", "/api/appointments", {
    body: validBooking({ email: "first@example.com", time: "15:00", date }),
  });
  // Zweiter Kunde am gleichen Slot -- wir blockieren NICHT, aber markieren.
  const r2 = await request("POST", "/api/appointments", {
    body: validBooking({ email: "second@example.com", time: "15:00", date }),
  });
  assert.equal(r2.status, 201);

  // Beide muessen in der Admin-Liste auftauchen.
  const list = await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  const sameSlot = list.json.appointments.filter(
    (a) => a.date === date && a.time === "15:00"
  );
  assert.ok(sameSlot.length >= 2);
  // Mind. einer hat conflictsWith != []
  const withConflict = sameSlot.find((a) => (a.conflictsWith || []).length > 0);
  assert.ok(withConflict, "ein Termin muss conflictsWith haben");
});

/* ---------------- Admin auth + actions ---------------- */

test("GET /api/appointments OHNE Auth -> 401", async () => {
  const r = await request("GET", "/api/appointments");
  assert.equal(r.status, 401);
  assert.match(r.headers["www-authenticate"] || "", /Basic realm/);
});

test("GET /api/appointments mit falschem Passwort -> 401", async () => {
  const r = await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "wrong") },
  });
  assert.equal(r.status, 401);
});

test("GET /api/admin/backup mit Auth -> 200 mit Content-Disposition", async () => {
  const r = await request("GET", "/api/admin/backup", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-disposition"] || "", /attachment;.*\.json/);
  const data = JSON.parse(r.body);
  assert.ok(Array.isArray(data.appointments));
  assert.ok(typeof data.count === "number");
});

test("GET /api/admin/backup.csv -> CSV mit BOM, Semikolon, Header", async () => {
  const r = await request("GET", "/api/admin/backup.csv", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"] || "", /text\/csv/);
  assert.match(r.headers["content-disposition"] || "", /\.csv/);
  // BOM am Anfang
  assert.equal(r.body.charCodeAt(0), 0xFEFF);
  // Header-Zeile enthaelt alle Spalten
  const lines = r.body.replace(/^﻿/, "").split(/\r?\n/);
  assert.match(lines[0], /ID;Erstellt;Datum;Uhrzeit;Name;Telefon;E-Mail;Leistung;Status;Notizen/);
});

test("GET /api/admin/backup.csv ohne Auth -> 401", async () => {
  const r = await request("GET", "/api/admin/backup.csv");
  assert.equal(r.status, 401);
});

test("POST /api/admin/appointments/:id/confirm: idempotent + not-found", async () => {
  // Setup: einen frischen Termin anlegen
  const created = await request("POST", "/api/appointments", {
    body: validBooking({ email: "confirm-test@example.com", time: "13:00" }),
  });
  const id = created.json.appointment.id;

  // 1. Confirm
  const r1 = await request("POST", `/api/admin/appointments/${id}/confirm`, {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  // Email nicht konfiguriert -> 502 (Termin steht, Mail fehlte)
  // Das ist OK: der Termin wurde geandert, nur die Mail haut nicht hin.
  assert.ok(r1.status === 200 || r1.status === 502, `unexpected status ${r1.status}`);
  assert.equal(r1.json.appointment.confirmed, true);

  // 2. Erneuter Confirm-Call -> sollte "war bereits bestaetigt" zurueckgeben
  const r2 = await request("POST", `/api/admin/appointments/${id}/confirm`, {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(r2.status, 200);
  assert.match(r2.json.message, /bereits/i);

  // 3. Unbekannte ID -> 404
  const r3 = await request("POST", "/api/admin/appointments/nope-not-real/confirm", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(r3.status, 404);
});

test("DELETE /api/admin/appointments/:id: removes appointment", async () => {
  const created = await request("POST", "/api/appointments", {
    body: validBooking({ email: "delete-test@example.com", time: "16:00" }),
  });
  const id = created.json.appointment.id;

  const r = await request("DELETE", `/api/admin/appointments/${id}`, {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);

  // Nicht mehr in der Liste
  const list = await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  assert.equal(list.json.appointments.find((a) => a.id === id), undefined);
});

/* ---------------- Cron ---------------- */

test("GET /api/cron/daily-digest ohne secret -> 401", async () => {
  const r = await request("GET", "/api/cron/daily-digest");
  assert.equal(r.status, 401);
});

test("GET /api/cron/daily-digest mit falschem secret -> 401", async () => {
  const r = await request("GET", "/api/cron/daily-digest?secret=wrong");
  assert.equal(r.status, 401);
});

test("GET /api/cron/daily-digest mit korrektem secret -> entweder skipped (So/Mo) oder 503 (mail not configured)", async () => {
  const r = await request("GET", "/api/cron/daily-digest?secret=test-cron-secret");
  // Je nach Wochentag: an Ruhetagen 200 mit skipped:true, sonst 503
  // (E-Mail nicht konfiguriert).
  if (r.status === 200) {
    assert.equal(r.json.skipped, true);
    assert.match(r.json.reason, /closed/);
  } else {
    assert.equal(r.status, 503);
  }
});

/* ---------------- Storno-Flow ---------------- */

test("GET /storno/:token: unbekannt -> 404 HTML", async () => {
  const r = await request("GET", "/storno/nonexistent-token");
  assert.equal(r.status, 404);
  assert.match(r.headers["content-type"] || "", /text\/html/);
  assert.match(r.body, /Termin nicht gefunden/);
});

test("GET + POST /storno/:token: full happy path", async () => {
  // Setup: einen Termin anlegen, den cancelToken auslesen
  const created = await request("POST", "/api/appointments", {
    body: validBooking({ email: "storno-test@example.com", time: "17:00" }),
  });
  const list = await request("GET", "/api/appointments", {
    headers: { Authorization: basicAuth("testadmin", "testpass-very-long") },
  });
  const found = list.json.appointments.find((a) => a.id === created.json.appointment.id);
  assert.ok(found?.cancelToken, "appointment must have cancelToken");
  const token = found.cancelToken;

  // GET -> Bestaetigungsseite
  const r1 = await request("GET", `/storno/${token}`);
  assert.equal(r1.status, 200);
  assert.match(r1.body, /Wirklich absagen/);

  // POST -> ausfuehren
  const r2 = await request("POST", `/storno/${token}`);
  assert.equal(r2.status, 200);
  assert.match(r2.body, /Termin abgesagt/);

  // POST nochmal -> idempotent, zeigt "bereits storniert"
  const r3 = await request("POST", `/storno/${token}`);
  assert.equal(r3.status, 200);
  assert.match(r3.body, /Schon storniert|bereits storniert/);
});

/* ---------------- CORS ---------------- */

test("CORS: Production-Origin erlaubt", async () => {
  const r = await request("GET", "/api/health", {
    headers: { Origin: "https://friseursalon-henkes-website.netlify.app" },
  });
  assert.equal(r.headers["access-control-allow-origin"],
    "https://friseursalon-henkes-website.netlify.app");
});

test("CORS: Netlify deploy-preview Origin erlaubt", async () => {
  const r = await request("GET", "/api/health", {
    headers: { Origin: "https://deploy-preview-42--friseursalon-henkes-website.netlify.app" },
  });
  assert.equal(r.headers["access-control-allow-origin"],
    "https://deploy-preview-42--friseursalon-henkes-website.netlify.app");
});

test("CORS: fremder Origin nicht erlaubt", async () => {
  const r = await request("GET", "/api/health", {
    headers: { Origin: "https://attacker.example.com" },
  });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("CORS: Spoofing-Attempt mit Suffix abgewiesen", async () => {
  const r = await request("GET", "/api/health", {
    headers: { Origin: "https://friseursalon-henkes-website.netlify.app.attacker.com" },
  });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

/* ---------------- 404 Catch-all ---------------- */

test("GET /api/unknown-endpoint -> JSON 404", async () => {
  const r = await request("GET", "/api/unknown-endpoint");
  assert.equal(r.status, 404);
  assert.equal(r.json.success, false);
});
