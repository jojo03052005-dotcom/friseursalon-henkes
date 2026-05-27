/**
 * Tests fuer lib/views/storno.js -- die HTML-Seiten die der Kunde
 * sieht, wenn er den Storno-Link aus der Mail klickt.
 *
 * Wichtig: hier laufen User-PII durch (Name, Datum) -- alles muss
 * korrekt HTML-escaped sein, sonst sind wir XSS-Vector wenn ein
 * Angreifer einen Namen mit <script>-Tag in einer Buchung anlegt.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const stornoViews = require("../lib/views/storno");

const sampleAppointment = {
  id: "abc-123",
  cancelToken: "00000000-0000-0000-0000-000000000000",
  name: "Anna Beispiel",
  email: "anna@example.com",
  phone: "0209 41793",
  date: "2026-05-25",
  time: "10:00",
  service: "Haarschnitt",
  notes: "",
  cancelled: false,
};

test("renderConfirm: zeigt Name + Datum + Bestaetigungs-Button", () => {
  const html = stornoViews.renderConfirm(sampleAppointment);
  assert.match(html, /Anna Beispiel/);
  assert.match(html, /25\.\s*Mai|Mai 2026/); // formatGermanDate
  assert.match(html, /Wirklich absagen/);
  // POST-Form aufs Token
  assert.match(html, /<form[^>]+action="\/storno\/00000000-0000-0000-0000-000000000000"/);
  assert.match(html, /method="post"/i);
});

test("renderConfirm: HTML-escaped Name (XSS-defense)", () => {
  const evil = { ...sampleAppointment, name: '<script>alert("xss")</script>' };
  const html = stornoViews.renderConfirm(evil);
  assert.equal(html.includes("<script>alert"), false, "Name darf NICHT als roher Script-Tag landen");
  assert.match(html, /&lt;script&gt;/);
});

test("renderConfirm: HTML-escaped Notiz (XSS-defense)", () => {
  const evil = {
    ...sampleAppointment,
    notes: '<img src=x onerror=alert(1)>',
  };
  const html = stornoViews.renderConfirm(evil);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;img/);
});

test("renderDone(success=true): zeigt Bestaetigung", () => {
  const html = stornoViews.renderDone(sampleAppointment, true);
  assert.match(html, /Termin abgesagt|erfolgreich/i);
});

test("renderDone(success=false): zeigt 'war schon storniert'", () => {
  const html = stornoViews.renderDone(sampleAppointment, false);
  assert.match(html, /Schon storniert|bereits storniert/i);
});

test("renderNotFound: 404-Seite mit Hinweis", () => {
  const html = stornoViews.renderNotFound();
  assert.match(html, /Termin nicht gefunden|Storno|unguelt/i);
});

test("renderError: Fallback-Seite mit Telefon-Link", () => {
  const html = stornoViews.renderError();
  assert.match(html, /tel:/);
  // Salon-Telefonnummer ist im Footer
  assert.match(html, /41793/);
});

test("alle Views liefern komplettes HTML-Dokument", () => {
  for (const html of [
    stornoViews.renderConfirm(sampleAppointment),
    stornoViews.renderDone(sampleAppointment, true),
    stornoViews.renderDone(sampleAppointment, false),
    stornoViews.renderNotFound(),
    stornoViews.renderError(),
  ]) {
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<html lang="de">/);
    assert.match(html, /<\/html>\s*$/);
    // noindex/nofollow ist Pflicht (Storno-Seiten gehoeren nicht in Google)
    assert.match(html, /noindex/i);
  }
});
