/**
 * Server-rendered HTML-Seiten fuer den Storno-Flow.
 *
 * Bewusst kein Template-Engine (kein EJS/Pug/Handlebars) -- die paar
 * Seiten und der einheitliche Design-Look rechtfertigen keine
 * zusaetzliche Dependency. Plain Template Literals reichen.
 *
 * CSP-Hinweis: Wir nutzen aktuell inline <style>. Wenn wir spaeter
 * eine nonce-basierte CSP einfuehren, muss der Style-Block die Nonce
 * bekommen. Bis dahin ist CSP in helmet bewusst aus.
 */

const { SALON } = require("../config");
const { escapeHtml } = require("../escape");

const PAGE_STYLES = `
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:#f8efe3;font-family:Arial,Helvetica,sans-serif;color:#241713;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px}
  .card{width:100%;max-width:560px;background:#fffaf0;border:1px solid rgba(75,48,40,.16);border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(75,48,40,.08)}
  .card-header{background:#4b3028;padding:28px 32px;text-align:center;color:#fffaf0}
  .card-header .kicker{margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#caa45d;font-weight:bold}
  .card-header h1{margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;line-height:1.2}
  .card-body{padding:28px 32px}
  .card-body p{font-size:15px;line-height:1.7;color:#4b3028;margin:0 0 16px}
  .details{width:100%;border-collapse:collapse;margin:8px 0 20px}
  .details td{padding:10px 0;border-bottom:1px solid rgba(75,48,40,.12);font-size:14px;vertical-align:top}
  .details td:first-child{color:#77675c;width:38%}
  .details td:last-child{color:#4b3028;font-weight:bold}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
  .btn{display:inline-block;padding:12px 22px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:.02em;border:none;cursor:pointer;font-family:inherit}
  .btn-primary{background:#4b3028;color:#fffaf0}
  .btn-primary:hover{background:#5a3a30}
  .btn-secondary{background:#efe1cc;color:#4b3028}
  .btn-secondary:hover{background:#e3d2b6}
  .note{font-size:13px;color:#77675c;line-height:1.6;margin-top:8px}
  .card-footer{background:#efe1cc;padding:18px 32px;text-align:center;font-size:13px;color:#77675c;border-top:1px solid rgba(75,48,40,.12)}
  .card-footer a{color:#9f7630;text-decoration:none}
  form{margin:0}
`;

function formatGermanDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function renderLayout(kicker, title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} | ${escapeHtml(SALON.name)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <p class="kicker">${escapeHtml(kicker)}</p>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <div class="card-body">${bodyHtml}</div>
    <div class="card-footer">
      ${escapeHtml(SALON.name)} · ${escapeHtml(SALON.address)} · ${escapeHtml(SALON.city)}<br>
      Tel. <a href="tel:${SALON.phoneTel}">${escapeHtml(SALON.phone)}</a>
    </div>
  </div>
</body>
</html>`;
}

/** Bestaetigungsseite vor dem Stornieren (GET /storno/:token). */
function renderConfirm(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const detailsHtml = `
    <table class="details">
      <tr><td>Name</td><td>${escapeHtml(appointment.name)}</td></tr>
      <tr><td>Leistung</td><td>${escapeHtml(appointment.service)}</td></tr>
      <tr><td>Wann</td><td>${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr</td></tr>
      ${appointment.notes ? `<tr><td>Ihre Notiz</td><td><em style="font-weight:normal">${escapeHtml(appointment.notes)}</em></td></tr>` : ""}
    </table>`;

  const body = `
    <p>Hallo <strong>${escapeHtml(appointment.name)}</strong>,</p>
    <p>möchten Sie folgenden Termin wirklich stornieren?</p>
    ${detailsHtml}
    <form method="POST" action="/storno/${encodeURIComponent(appointment.cancelToken)}">
      <div class="actions">
        <button type="submit" class="btn btn-primary">Ja, Termin stornieren</button>
        <a href="/" class="btn btn-secondary">Doch nicht – zurück</a>
      </div>
    </form>
    <p class="note">Falls Sie nur einen Termin <strong>verschieben</strong> möchten, antworten Sie einfach auf die Bestätigungs-Mail oder rufen Sie uns kurz an: <a href="tel:${SALON.phoneTel}" style="color:#9f7630">${escapeHtml(SALON.phone)}</a>.</p>`;

  return renderLayout("Termin stornieren", "Wirklich absagen?", body);
}

/** Erfolgs- oder "war-schon-storniert"-Seite. */
function renderDone(appointment, justCancelled) {
  const dateLabel = formatGermanDate(appointment.date);
  const intro = justCancelled
    ? "Ihr Termin wurde storniert. Schade, dass es nicht klappt &mdash; aber kein Problem!"
    : "Dieser Termin wurde bereits storniert.";

  const body = `
    <p>Hallo <strong>${escapeHtml(appointment.name)}</strong>,</p>
    <p>${intro}</p>
    <table class="details">
      <tr><td>Leistung</td><td>${escapeHtml(appointment.service)}</td></tr>
      <tr><td>Wäre gewesen</td><td>${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr</td></tr>
    </table>
    <p>Wir freuen uns, wenn Sie bei Gelegenheit einen neuen Termin buchen &mdash; einfach <a href="/#termin" style="color:#9f7630;font-weight:bold">hier wieder Anfrage senden</a>.</p>
    <div class="actions">
      <a href="/" class="btn btn-secondary">Zur Website</a>
    </div>`;

  return renderLayout(
    justCancelled ? "Erledigt" : "Bereits storniert",
    justCancelled ? "Termin abgesagt" : "Schon storniert",
    body
  );
}

/** Token unbekannt oder Termin nicht vorhanden. */
function renderNotFound() {
  const body = `
    <p>Dieser Stornier-Link gehört zu keinem aktiven Termin.</p>
    <p>Mögliche Gründe:</p>
    <ul style="font-size:15px;line-height:1.7;color:#4b3028;margin:0 0 16px;padding-left:20px">
      <li>Der Termin wurde bereits storniert</li>
      <li>Der Link ist abgelaufen</li>
      <li>Der Termin liegt schon in der Vergangenheit</li>
    </ul>
    <p>Bei Fragen rufen Sie uns gern an: <a href="tel:${SALON.phoneTel}" style="color:#9f7630;font-weight:bold">${escapeHtml(SALON.phone)}</a></p>
    <div class="actions">
      <a href="/" class="btn btn-secondary">Zur Website</a>
    </div>`;
  return renderLayout("Hmm", "Termin nicht gefunden", body);
}

/** Unerwarteter Server-Fehler beim Storno-Versuch. */
function renderError() {
  const body = `
    <p>Da ist gerade etwas schiefgelaufen. Bitte rufen Sie uns kurz an, dann erledigen wir das telefonisch:</p>
    <p style="font-size:18px"><a href="tel:${SALON.phoneTel}" style="color:#9f7630;font-weight:bold">${escapeHtml(SALON.phone)}</a></p>
    <div class="actions">
      <a href="/" class="btn btn-secondary">Zur Website</a>
    </div>`;
  return renderLayout("Fehler", "Da ist was schiefgelaufen", body);
}

module.exports = {
  renderConfirm,
  renderDone,
  renderNotFound,
  renderError,
};
