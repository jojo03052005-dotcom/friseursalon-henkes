const test = require("node:test");
const assert = require("node:assert/strict");

const { safeStringEqual, requireAdminAuth } = require("../lib/auth");

/* ---------------- safeStringEqual ---------------- */

test("safeStringEqual: identical strings -> true", () => {
  assert.equal(safeStringEqual("hello", "hello"), true);
  assert.equal(safeStringEqual("", ""), true);
});

test("safeStringEqual: different strings -> false", () => {
  assert.equal(safeStringEqual("hello", "world"), false);
});

test("safeStringEqual: different lengths -> false (no length-leak)", () => {
  // Hauptpunkt: gibt false zurueck OHNE zu crashen, auch bei sehr
  // unterschiedlichen Laengen. Echtes Timing-Leak-Verhalten testen
  // ist im Unit-Test schwer; dieser Test schuetzt vor offensichtlichen
  // Regressionen (z.B. wenn jemand die Dummy-Vergleich-Logik entfernt).
  assert.equal(safeStringEqual("a", "abcdefghij"), false);
  assert.equal(safeStringEqual("abcdefghij", "a"), false);
});

test("safeStringEqual: null/undefined safely false", () => {
  assert.equal(safeStringEqual(null, "anything"), false);
  assert.equal(safeStringEqual(undefined, "anything"), false);
  assert.equal(safeStringEqual(null, null), true); // beide leer
});

test("safeStringEqual: UTF-8 vergleichbar (Umlaute)", () => {
  assert.equal(safeStringEqual("Schöne Grüße", "Schöne Grüße"), true);
  assert.equal(safeStringEqual("Schöne Grüße", "Schoene Gruesse"), false);
});

/* ---------------- requireAdminAuth Middleware ---------------- */

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

test("requireAdminAuth: 503 wenn ADMIN_USER/PASSWORD nicht gesetzt", () => {
  const orig = { user: process.env.ADMIN_USER, pass: process.env.ADMIN_PASSWORD };
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASSWORD;
  try {
    const req = { headers: {}, ip: "127.0.0.1" };
    const res = makeRes();
    let nextCalled = false;
    requireAdminAuth(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 503);
    assert.equal(nextCalled, false, "auth muss BLOCKIEREN bei fehlender Config -- fail-closed");
  } finally {
    if (orig.user !== undefined) process.env.ADMIN_USER = orig.user;
    if (orig.pass !== undefined) process.env.ADMIN_PASSWORD = orig.pass;
  }
});

test("requireAdminAuth: 401 ohne Authorization-Header", () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "secret123";
  const req = { headers: {}, ip: "127.0.0.1" };
  const res = makeRes();
  let nextCalled = false;
  requireAdminAuth(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["WWW-Authenticate"], 'Basic realm="Friseursalon Henkes Admin", charset="UTF-8"');
  assert.equal(nextCalled, false);
});

test("requireAdminAuth: 401 mit falschem Passwort", () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "secret123";
  const credentials = Buffer.from("admin:wrong-password").toString("base64");
  const req = { headers: { authorization: `Basic ${credentials}` }, ip: "127.0.0.1" };
  const res = makeRes();
  let nextCalled = false;
  requireAdminAuth(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireAdminAuth: next() bei korrekten Credentials", () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "secret123";
  const credentials = Buffer.from("admin:secret123").toString("base64");
  const req = { headers: { authorization: `Basic ${credentials}` }, ip: "127.0.0.1" };
  const res = makeRes();
  let nextCalled = false;
  requireAdminAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "next() muss aufgerufen werden bei korrektem Login");
  assert.equal(res.statusCode, 200, "Status darf nicht veraendert werden");
});

test("requireAdminAuth: malformed base64 -> 401", () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "secret123";
  // Kein Doppelpunkt im Header -- user/pass-Split scheitert sauber.
  const malformed = Buffer.from("nocolon").toString("base64");
  const req = { headers: { authorization: `Basic ${malformed}` }, ip: "127.0.0.1" };
  const res = makeRes();
  let nextCalled = false;
  requireAdminAuth(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireAdminAuth: header ohne 'Basic '-Prefix -> 401", () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "secret123";
  const req = { headers: { authorization: "Bearer some-token" }, ip: "127.0.0.1" };
  const res = makeRes();
  let nextCalled = false;
  requireAdminAuth(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});
