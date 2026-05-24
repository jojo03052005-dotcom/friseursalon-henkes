/**
 * String-Escape-Utilities.
 *
 * Wichtig: jeder dieser Helfer dient EINEM Ausgabe-Kontext. Niemals
 * escapeHtml() benutzen, um etwas in ein HTML-Attribut zu schreiben
 * (dort braucht es zusaetzlich escape von Backticks / Newlines), und
 * niemals escapeIcs() fuer HTML.
 */

/**
 * Escapt Text fuer den sicheren Einbau in HTML-Body.
 * Akzeptiert null/undefined (-> leerer String).
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escapt Text fuer das ICS-Calendar-Format (RFC 5545).
 * Komma, Semikolon, Backslash und Newline sind die Trennzeichen
 * innerhalb von Property-Werten und muessen escapet werden.
 */
function escapeIcs(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

module.exports = {
  escapeHtml,
  escapeIcs,
};
