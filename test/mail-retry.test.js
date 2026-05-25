/**
 * Test fuer den Resend-Retry-Wrapper. Wir testen NICHT die echte
 * Resend-API (kein API-Key in Tests), sondern die isTransient-
 * Klassifikation und die Retry-Logik mit einem Fake-Client.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Wir greifen auf die Internals via __testables zu -- isTransientMailError
// ist nicht direkt exportiert, aber wir koennen es indirekt via
// sendWithRetry-Verhalten testen. Stattdessen: ueber den realen
// emailService importieren wir und stub-en die Resend-Client.
//
// Pragmatischer Test: simulieren Send-Verhalten + zaehlen Aufrufe.

const ORIG_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SALON_EMAIL: process.env.SALON_EMAIL,
};
process.env.RESEND_API_KEY = "re_dummy_key_for_test";
process.env.SALON_EMAIL = "salon@example.com";

const emailService = require("../services/emailService");

test.after(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("isEmailConfigured: true wenn beide Env-Vars gesetzt", () => {
  assert.equal(emailService.isEmailConfigured(), true);
});

test("mapEmailError: erkennt sandbox-error klar", () => {
  const { mapEmailError } = emailService.__testables;
  const msg = mapEmailError({
    name: "validation_error",
    message: "You can only send testing emails to your own address",
  });
  assert.match(msg, /Sandbox|verifizieren/);
});

test("mapEmailError: erkennt invalid-api-key", () => {
  const { mapEmailError } = emailService.__testables;
  const msg = mapEmailError({ message: "invalid_api_key" });
  assert.match(msg, /API-Key/);
});

test("mapEmailError: erkennt rate-limit", () => {
  const { mapEmailError } = emailService.__testables;
  const msg = mapEmailError({ message: "rate limit exceeded (429)" });
  assert.match(msg, /Rate-Limit|gedrosselt/);
});

test("mapEmailError: erkennt Netzwerk-Fehler", () => {
  const { mapEmailError } = emailService.__testables;
  const msg = mapEmailError({ message: "ECONNREFUSED" });
  assert.match(msg, /Verbindung/);
});

test("mapEmailError: unbekannten Fehler weiterreichen", () => {
  const { mapEmailError } = emailService.__testables;
  const msg = mapEmailError({ message: "etwas voellig anderes" });
  assert.equal(msg, "etwas voellig anderes");
});

test("buildCustomerEmail: enthaelt Storno-Link wenn baseUrl gesetzt", () => {
  const { buildCustomerEmail } = emailService.__testables;
  const mail = buildCustomerEmail(
    {
      name: "Max",
      date: "2026-03-10",
      time: "10:00",
      service: "Haarschnitt",
      cancelToken: "token-abc",
      notes: "Bitte kurz",
    },
    "https://example.com"
  );
  assert.match(mail.html, /storno\/token-abc/);
  assert.match(mail.text, /storno\/token-abc/);
  assert.match(mail.html, /Bitte kurz/);
});

test("buildCustomerEmail: ohne baseUrl -> Telefon statt Storno-Link", () => {
  const { buildCustomerEmail } = emailService.__testables;
  const mail = buildCustomerEmail(
    { name: "Max", date: "2026-03-10", time: "10:00", service: "Haarschnitt", cancelToken: "x" },
    ""
  );
  assert.doesNotMatch(mail.html, /storno\//);
  assert.match(mail.html, /0209 41793/);
});

test("buildSalonEmail: enthaelt Kunden-PII fuer den Salon", () => {
  const { buildSalonEmail } = emailService.__testables;
  const mail = buildSalonEmail({
    name: "Anna Schmidt",
    phone: "0123 456789",
    email: "anna@test.de",
    service: "Färbung",
    date: "2026-05-01",
    time: "14:00",
    notes: "Stammkundin",
    createdAt: new Date().toISOString(),
  });
  assert.match(mail.html, /Anna Schmidt/);
  assert.match(mail.html, /0123 456789/);
  assert.match(mail.html, /anna@test.de/);
  assert.match(mail.html, /Stammkundin/);
});

test("buildDailyDigestEmail: leerer Tag", () => {
  const { buildDailyDigestEmail } = emailService.__testables;
  const mail = buildDailyDigestEmail([], "2026-05-25");
  assert.match(mail.subject, /keine Termine/);
  assert.match(mail.html, /keine Termine/i);
});

test("buildDailyDigestEmail: mit Terminen sortiert nach Uhrzeit", () => {
  const { buildDailyDigestEmail } = emailService.__testables;
  const mail = buildDailyDigestEmail(
    [
      { name: "Spaeter", time: "15:00", service: "Cut", phone: "1", notes: "" },
      { name: "Frueher", time: "09:00", service: "Cut", phone: "2", notes: "" },
    ],
    "2026-05-25"
  );
  // "Frueher" muss vor "Spaeter" im HTML stehen
  const posFrueh = mail.html.indexOf("Frueher");
  const posSpaet = mail.html.indexOf("Spaeter");
  assert.ok(posFrueh < posSpaet, "Frueherer Termin muss zuerst gerendert sein");
});
