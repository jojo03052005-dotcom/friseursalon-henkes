/**
 * Tests fuer den ICS-Kalender-Anhang.
 * Date-/Timezone-Bugs sind die unangenehmsten -- der Kunde kriegt
 * einen Termin zur falschen Zeit in seinen Kalender. Daher hier
 * sorgfaeltige Tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { __testables } = require("../services/emailService");
const { buildICSAttachment, germanLocalToISOString, getReminderTime } = __testables;

test("germanLocalToISOString: winter (UTC+1, CET)", () => {
  // 15.01.2026 um 10:00 Berlin = 09:00 UTC
  const iso = germanLocalToISOString("2026-01-15", "10:00");
  assert.equal(iso, "2026-01-15T09:00:00.000Z");
});

test("germanLocalToISOString: summer (UTC+2, CEST)", () => {
  // 15.07.2026 um 10:00 Berlin = 08:00 UTC
  const iso = germanLocalToISOString("2026-07-15", "10:00");
  assert.equal(iso, "2026-07-15T08:00:00.000Z");
});

test("germanLocalToISOString: invalid input -> null", () => {
  assert.equal(germanLocalToISOString("not-a-date", "10:00"), null);
  assert.equal(germanLocalToISOString("2026-01-15", "abc"), null);
  assert.equal(germanLocalToISOString("", ""), null);
});

test("buildICSAttachment: returns Buffer with RFC 5545 structure", () => {
  const buf = buildICSAttachment({
    id: "abc-123",
    name: "Anna",
    service: "Haarschnitt",
    date: "2026-03-10",
    time: "14:00",
    notes: "",
  });
  assert.ok(Buffer.isBuffer(buf), "should return a Buffer");
  const text = buf.toString("utf8");
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /\r\nEND:VCALENDAR$/);
  assert.match(text, /\r\nBEGIN:VEVENT\r\n/);
  assert.match(text, /\r\nEND:VEVENT\r\n/);
  assert.match(text, /UID:abc-123@friseursalon-henkes/);
  assert.match(text, /SUMMARY:Friseur-Termin: Haarschnitt/);
  assert.match(text, /BEGIN:VALARM/);
});

test("buildICSAttachment: DTSTART/DTEND have correct duration per service", () => {
  // Haarschnitt = 45 Minuten
  const cut = buildICSAttachment({
    id: "1",
    name: "X",
    service: "Haarschnitt",
    date: "2026-03-10",
    time: "10:00",
    notes: "",
  }).toString("utf8");
  // DTSTART = 10:00 Berlin = 09:00 UTC, +45 Min = 09:45 UTC = DTEND
  assert.match(cut, /DTSTART:20260310T090000Z/);
  assert.match(cut, /DTEND:20260310T094500Z/);

  // Faerbung = 90 Minuten
  const color = buildICSAttachment({
    id: "2",
    name: "X",
    service: "Färbung",
    date: "2026-03-10",
    time: "10:00",
    notes: "",
  }).toString("utf8");
  assert.match(color, /DTEND:20260310T103000Z/); // 10:00 + 1h30 = 11:30 Berlin = 10:30 UTC
});

test("buildICSAttachment: escapes special chars in SUMMARY/DESCRIPTION", () => {
  const buf = buildICSAttachment({
    id: "x",
    name: "Anna, Schmidt; und so",
    service: "Haarschnitt",
    date: "2026-03-10",
    time: "10:00",
    notes: "Mit Komma, und Semikolon; und\nNewline",
  });
  const text = buf.toString("utf8");
  // Notes-Komma muss als \, escapet sein
  assert.match(text, /Mit Komma\\,/);
  // Semikolon als \;
  assert.match(text, /Semikolon\\;/);
  // Newline als literal \n
  assert.match(text, /und\\nNewline/);
});

test("buildICSAttachment: null on invalid date", () => {
  const buf = buildICSAttachment({
    id: "x",
    service: "Haarschnitt",
    date: "garbage",
    time: "10:00",
  });
  assert.equal(buf, null);
});

test("getReminderTime: 48h ahead -> reminder scheduled for 24h before", () => {
  const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const dateStr = future.toISOString().slice(0, 10);
  const result = getReminderTime({ date: dateStr, time: "12:00" });
  assert.ok(result.scheduledFor, "should schedule");
  assert.equal(result.skipReason, null);
});

test("getReminderTime: too soon (< 25h) -> skipped", () => {
  // Termin in 2 Stunden -> Reminder waere in der Vergangenheit
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const dateStr = soon.toISOString().slice(0, 10);
  const time = `${String(soon.getUTCHours()).padStart(2, "0")}:00`;
  const result = getReminderTime({ date: dateStr, time });
  assert.equal(result.scheduledFor, null);
  assert.match(result.skipReason, /weniger als 25/);
});

test("getReminderTime: more than 30 days -> skipped (Resend limit)", () => {
  const far = new Date(Date.now() + 40 * 86400 * 1000);
  const dateStr = far.toISOString().slice(0, 10);
  const result = getReminderTime({ date: dateStr, time: "10:00" });
  assert.equal(result.scheduledFor, null);
  assert.match(result.skipReason, /30 Tage/);
});
