const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAppointment, normalizeNotes } = require("../lib/validate");

// "Heute" fuer Tests: Sonntag 04.01.2026. Unser Standard-Termin (2026-02-03,
// Dienstag) liegt 30 Tage in der Zukunft -- innerhalb des 90-Tage-Horizons.
const FIXED_NOW = new Date("2026-01-04T12:00:00Z");

/**
 * Helper: vollstaendiges valides Payload mit Overrides.
 * Datum = Di 03.02.2026, Zeit 10:00, Leistung Haarschnitt.
 */
function makePayload(overrides = {}) {
  return {
    name: "Max Mustermann",
    phone: "0209 41793",
    email: "max@example.com",
    date: "2026-02-03", // Dienstag, ~30 Tage nach FIXED_NOW
    time: "10:00",
    service: "Haarschnitt",
    notes: "",
    ...overrides,
  };
}

/** readClosedDays-Mock: per Default leer. */
function noClosedDays() {
  return Promise.resolve(new Set());
}

test("happy path: complete payload validates", async () => {
  const result = await validateAppointment(makePayload(), {
    now: FIXED_NOW,
    readClosedDays: noClosedDays,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.name, "Max Mustermann");
  assert.equal(result.data.notes, "");
});

test("name: missing or too short", async () => {
  for (const name of ["", " ", "A", null, undefined]) {
    const result = await validateAppointment(makePayload({ name }), {
      now: FIXED_NOW,
      readClosedDays: noClosedDays,
    });
    assert.equal(result.ok, false, `name="${name}" should fail`);
    assert.match(result.errors[0], /Name/);
  }
});

test("phone: letters rejected, ≥6 digits required", async () => {
  const lettersOnly = await validateAppointment(makePayload({ phone: "abc-defg" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(lettersOnly.ok, false);
  assert.match(lettersOnly.errors[0], /Ziffern und Trennzeichen/);

  const tooShort = await validateAppointment(makePayload({ phone: "123" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(tooShort.ok, false);
  assert.match(tooShort.errors[0], /vollständige Telefonnummer/);
});

test("email: missing or malformed rejected", async () => {
  const missing = await validateAppointment(makePayload({ email: "" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(missing.ok, false);

  const noAt = await validateAppointment(makePayload({ email: "kaputt.de" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(noAt.ok, false);
});

test("date: past date rejected", async () => {
  const past = await validateAppointment(makePayload({ date: "2020-06-15" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(past.ok, false);
  assert.match(past.errors[0], /Vergangenheit/);
});

test("date: too far in future rejected", async () => {
  // 2099-01-06 ist weit jenseits des 90-Tage-Horizons.
  const tooFar = await validateAppointment(makePayload({ date: "2099-01-06" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.errors[0], /maximal/);
});

test("date: exactly at 90-day horizon accepted, day 91 rejected", async () => {
  // FIXED_NOW = So 2026-01-04. +90d = Sa 2026-04-04 (Salon hat Sa offen).
  const at90 = await validateAppointment(makePayload({ date: "2026-04-04", time: "10:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(at90.ok, true, "day 90 must still be bookable");

  // +91d = So 2026-04-05 -> Sonntag, ohnehin zu. Also +92 = Mo (auch zu).
  // Wir testen mit einem Datum jenseits 90 das ein Oeffnungstag waere:
  // 2026-04-07 (Di, ~93 Tage spaeter) -> horizon-Fehler.
  const past90 = await validateAppointment(makePayload({ date: "2026-04-07", time: "10:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(past90.ok, false);
  assert.match(past90.errors[0], /maximal/);
});

test("date: Sunday is closed (Salon-Ruhetag)", async () => {
  // 2026-01-04 ist ein Sonntag (FIXED_NOW + Test-Datum identisch).
  // Wir nehmen einen anderen Sonntag in der Zukunft:
  const result = await validateAppointment(makePayload({ date: "2026-02-01" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Wochentag.*geschlossen/);
});

test("date: Monday is closed (Friseur-Ruhetag)", async () => {
  // 2026-02-02 ist ein Montag
  const result = await validateAppointment(makePayload({ date: "2026-02-02" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Wochentag.*geschlossen/);
});

test("date: closed-days file blocks date", async () => {
  const closed = () => Promise.resolve(new Set(["2026-02-03"])); // Dienstag
  const result = await validateAppointment(makePayload({ date: "2026-02-03" }), {
    now: FIXED_NOW, readClosedDays: closed,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Feiertag|Betriebsferien/);
});

test("time: must be in 15-minute raster", async () => {
  const result = await validateAppointment(makePayload({ time: "10:07" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /15-Minuten-Raster/);
});

test("time: outside opening hours rejected", async () => {
  // 2026-02-03 = Dienstag, oeffnen 09:00, schliessen 18:00
  const tooEarly = await validateAppointment(makePayload({ date: "2026-02-03", time: "07:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(tooEarly.ok, false);

  const tooLate = await validateAppointment(makePayload({ date: "2026-02-03", time: "19:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(tooLate.ok, false);
});

test("time: Saturday closes early (14:00)", async () => {
  // 2026-02-07 = Samstag
  const okSat = await validateAppointment(makePayload({ date: "2026-02-07", time: "13:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(okSat.ok, true);

  const tooLateSat = await validateAppointment(makePayload({ date: "2026-02-07", time: "14:00" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(tooLateSat.ok, false, "14:00 ist genau die Schliesszeit -- schon zu spaet");
});

test("service: only catalog values accepted", async () => {
  const result = await validateAppointment(makePayload({ service: "Hot Stones Massage" }), {
    now: FIXED_NOW, readClosedDays: noClosedDays,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Leistung/);
});

test("today: 60-minute lead time required", async () => {
  // now = Di 2026-02-03 09:00. Termin um 09:30 (30 Min Vorlauf) -> zu kurz.
  const earlyToday = new Date("2026-02-03T09:00:00");
  const result = await validateAppointment(
    makePayload({ date: "2026-02-03", time: "09:30" }),
    { now: earlyToday, readClosedDays: noClosedDays }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /60 Minuten Vorlauf/);
});

test("notes: trimmed, capped at 500 chars, no triple newlines", () => {
  const longNotes = "x".repeat(1000);
  const result = normalizeNotes(longNotes);
  assert.equal(result.length, 500);

  assert.equal(normalizeNotes("a\n\n\n\nb"), "a\n\nb");
  assert.equal(normalizeNotes("  hallo  "), "hallo");
  assert.equal(normalizeNotes(null), "");
});

test("name: rejected when too long (>120 chars)", async () => {
  const result = await validateAppointment(
    makePayload({ name: "A".repeat(121) }),
    { now: FIXED_NOW, readClosedDays: noClosedDays }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /zu lang/);
});

test("phone: rejected when too long (>40 chars)", async () => {
  const result = await validateAppointment(
    makePayload({ phone: "1".repeat(41) }),
    { now: FIXED_NOW, readClosedDays: noClosedDays }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /zu lang/);
});

test("email: rejected when too long (>254 chars)", async () => {
  // local-part + "@x.de" = 254+ insgesamt
  const localPart = "a".repeat(250);
  const result = await validateAppointment(
    makePayload({ email: `${localPart}@x.de` }),
    { now: FIXED_NOW, readClosedDays: noClosedDays }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /zu lang/);
});

test("multiple errors reported, first is user-facing", async () => {
  const broken = await validateAppointment(
    { name: "", phone: "", email: "", date: "", time: "", service: "" },
    { now: FIXED_NOW, readClosedDays: noClosedDays }
  );
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.length >= 5, "expected at least 5 errors");
});
