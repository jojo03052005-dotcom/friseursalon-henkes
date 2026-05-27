const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml, escapeIcs } = require("../lib/escape");

test("escapeHtml: basic XSS payload becomes inert", () => {
  assert.equal(
    escapeHtml('<script>alert("xss")</script>'),
    "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
  );
});

test("escapeHtml: ampersand encoded once, not double", () => {
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  // Wenn schon escapet -> Doppel-Escape ist gewollt (keine Magie).
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
});

test("escapeHtml: handles null and undefined", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml: numbers and bools coerced to string", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(true), "true");
});

test("escapeHtml: single quote NOT escaped (acceptable for double-quoted attrs)", () => {
  // Wir setzen Werte immer in doppelte Anfuehrungszeichen, daher ist
  // der einfache Apostroph kein Problem. Doku-Hinweis im Code.
  assert.equal(escapeHtml("can't"), "can't");
});

test("escapeIcs: comma and semicolon escaped", () => {
  assert.equal(escapeIcs("Hallo, Welt"), "Hallo\\, Welt");
  assert.equal(escapeIcs("foo;bar"), "foo\\;bar");
});

test("escapeIcs: backslash escaped first", () => {
  assert.equal(escapeIcs("a\\b"), "a\\\\b");
});

test("escapeIcs: newline replaced with literal \\n", () => {
  assert.equal(escapeIcs("Zeile1\nZeile2"), "Zeile1\\nZeile2");
});

test("escapeIcs: empty/null safe", () => {
  assert.equal(escapeIcs(""), "");
  assert.equal(escapeIcs(null), "");
});
