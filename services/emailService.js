/**
 * E-Mail-Versand per Resend HTTP-API.
 *
 * Hintergrund: Render-Free (und viele andere PaaS-Free-Tiers) blockieren
 * ausgehende SMTP-Verbindungen, um Spam-Versand zu verhindern. Resend nutzt
 * HTTPS und funktioniert daher auf praktisch jedem Host.
 *
 * Erforderliche Umgebungsvariablen:
 *   RESEND_API_KEY  – API-Key aus https://resend.com (re_...)
 *   SALON_EMAIL     – Empfänger für interne Salon-Benachrichtigungen
 *
 * Optionale Umgebungsvariablen:
 *   EMAIL_FROM      – Absender (Default: "Friseursalon Henkes <onboarding@resend.dev>").
 *                     Für eigene Domain bei Resend verifizieren und hier eintragen,
 *                     z.B. 'Friseursalon Henkes <noreply@friseursalon-henkes.de>'.
 *   EMAIL_USER      – Wenn gesetzt, wird die Adresse als Reply-To für die Kunden-Mail
 *                     verwendet (so gehen Antworten an die echte Salon-Mailbox).
 */

const { Resend } = require("resend");

const SALON = {
  name: "Friseursalon Henkes",
  phone: "0209 41793",
  address: "Fürstinnenstraße 40",
  city: "45883 Gelsenkirchen",
};

const DEFAULT_FROM = `${SALON.name} <onboarding@resend.dev>`;

/**
 * Liest Resend-Konfiguration aus Umgebungsvariablen.
 */
function getMailConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const salonEmail = process.env.SALON_EMAIL?.trim();

  if (!apiKey || !salonEmail) {
    const error = new Error(
      "E-Mail-Versand ist nicht konfiguriert. Bitte RESEND_API_KEY und SALON_EMAIL setzen."
    );
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  const replyTo = process.env.EMAIL_USER?.trim() || salonEmail;

  return { apiKey, salonEmail, from, replyTo };
}

/**
 * Formatiert ISO-Datum für E-Mails (deutsch).
 */
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

/**
 * Gemeinsames HTML-Grundlayout (Gold / Beige / Creme).
 */
function wrapEmailHtml(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f8efe3;font-family:Arial,Helvetica,sans-serif;color:#241713;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8efe3;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffaf0;border:1px solid rgba(75,48,40,0.16);border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#4b3028;padding:28px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#caa45d;font-weight:bold;">Friseursalon Henkes</p>
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#fffaf0;line-height:1.2;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td style="background:#efe1cc;padding:20px 32px;text-align:center;border-top:1px solid rgba(75,48,40,0.12);">
              <p style="margin:0;font-size:13px;color:#77675c;line-height:1.6;">
                ${SALON.name} · ${SALON.address} · ${SALON.city}<br>
                Tel. <a href="tel:020941793" style="color:#9f7630;text-decoration:none;">${SALON.phone}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildDetailsTable(rows) {
  const items = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);color:#77675c;font-size:14px;width:38%;vertical-align:top;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);color:#4b3028;font-size:15px;font-weight:bold;vertical-align:top;">${value}</td>
      </tr>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0 24px;">${items}</table>`;
}

/**
 * HTML + Text für Kundenbestätigung.
 */
function buildCustomerEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Ihre Terminanfrage bei ${SALON.name} – ${dateLabel}`;

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Guten Tag <strong>${appointment.name}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      vielen Dank für Ihre Terminanfrage. Wir haben Ihre Wunschzeit erhalten und melden uns zur endgültigen Bestätigung bei Ihnen.
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Ihre Terminübersicht</p>
    ${buildDetailsTable([
      ["Leistung", appointment.service],
      ["Datum", dateLabel],
      ["Uhrzeit", `${appointment.time} Uhr`],
      ["Telefon", appointment.phone],
    ])}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#4b3028;">
      <strong>So erreichen Sie uns:</strong><br>
      Tel. ${SALON.phone}<br>
      ${SALON.address}, ${SALON.city}
    </p>
    <p style="margin:0;font-size:15px;line-height:1.65;color:#4b3028;">
      Wir freuen uns auf Ihren Besuch!<br><br>
      Herzliche Grüße<br>
      <strong>Ihr Team vom ${SALON.name}</strong>
    </p>`;

  const text = [
    `Guten Tag ${appointment.name},`,
    "",
    "vielen Dank für Ihre Terminanfrage bei Friseursalon Henkes.",
    "",
    "Ihre Terminübersicht:",
    `Leistung: ${appointment.service}`,
    `Datum: ${dateLabel}`,
    `Uhrzeit: ${appointment.time} Uhr`,
    `Telefon: ${appointment.phone}`,
    "",
    `Kontakt: ${SALON.phone}, ${SALON.address}, ${SALON.city}`,
    "",
    "Herzliche Grüße",
    `Ihr Team vom ${SALON.name}`,
  ].join("\n");

  return {
    subject,
    html: wrapEmailHtml("Terminanfrage erhalten", bodyContent),
    text,
  };
}

/**
 * HTML + Text für Salon-Benachrichtigung.
 */
function buildSalonEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Neue Terminanfrage: ${appointment.name} – ${appointment.date}`;

  const bodyContent = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      Es ist eine neue Terminanfrage über die Website eingegangen:
    </p>
    ${buildDetailsTable([
      ["Name", appointment.name],
      ["Telefon", appointment.phone],
      ["E-Mail", `<a href="mailto:${appointment.email}" style="color:#9f7630;">${appointment.email}</a>`],
      ["Leistung", appointment.service],
      ["Datum", dateLabel],
      ["Uhrzeit", `${appointment.time} Uhr`],
      ["Angelegt am", new Date(appointment.createdAt).toLocaleString("de-DE")],
    ])}
    <p style="margin:0;font-size:14px;color:#77675c;">
      Bitte den Kunden telefonisch oder per E-Mail zur Bestätigung kontaktieren.
    </p>`;

  const text = [
    "Neue Terminanfrage über die Website",
    "",
    `Name: ${appointment.name}`,
    `Telefon: ${appointment.phone}`,
    `E-Mail: ${appointment.email}`,
    `Leistung: ${appointment.service}`,
    `Datum: ${dateLabel}`,
    `Uhrzeit: ${appointment.time} Uhr`,
    `Angelegt am: ${appointment.createdAt}`,
  ].join("\n");

  return {
    subject,
    html: wrapEmailHtml("Neue Terminanfrage", bodyContent),
    text,
  };
}

/**
 * Sendet Kunden- und Salon-E-Mail über Resend; gibt Versandstatus zurück.
 */
async function sendAppointmentEmails(appointment) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);

  const status = {
    configured: true,
    customer: { sent: false, sentAt: null, error: null },
    salon: { sent: false, sentAt: null, error: null },
  };

  const customerMail = buildCustomerEmail(appointment);
  const salonMail = buildSalonEmail(appointment);

  // Kunden-Bestätigung
  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: appointment.email,
      replyTo: config.replyTo,
      subject: customerMail.subject,
      text: customerMail.text,
      html: customerMail.html,
    });
    if (error) throw error;
    status.customer.sent = true;
    status.customer.sentAt = new Date().toISOString();
  } catch (error) {
    status.customer.error = mapEmailError(error);
    console.error("[E-Mail] Kunde:", error?.message || error);
  }

  // Salon-Benachrichtigung
  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.salonEmail,
      replyTo: appointment.email,
      subject: salonMail.subject,
      text: salonMail.text,
      html: salonMail.html,
    });
    if (error) throw error;
    status.salon.sent = true;
    status.salon.sentAt = new Date().toISOString();
  } catch (error) {
    status.salon.error = mapEmailError(error);
    console.error("[E-Mail] Salon:", error?.message || error);
  }

  return status;
}

/**
 * Übersetzt technische Resend-/Netzwerk-Fehler in verständliche Hinweise.
 */
function mapEmailError(error) {
  const name = error?.name || "";
  const message = error?.message || String(error || "Unbekannter Fehler");
  const combined = `${name} ${message}`;

  if (/invalid_api_key|unauthorized|forbidden|401|403/i.test(combined)) {
    return "Resend-API-Key ungültig oder fehlt. Bitte RESEND_API_KEY in den Umgebungsvariablen prüfen.";
  }
  if (/validation_error.*from|from.*not.*verified|domain.*not.*verified|not allowed to send/i.test(combined)) {
    return "Absender-Adresse bei Resend nicht verifiziert. Bitte EMAIL_FROM auf eine verifizierte Domain setzen oder Default (onboarding@resend.dev) verwenden.";
  }
  if (/rate.?limit|too.many.requests|429/i.test(combined)) {
    return "Resend hat den Versand vorübergehend gedrosselt (Rate-Limit). Bitte später erneut versuchen.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|fetch failed/i.test(combined)) {
    return "Verbindung zu Resend fehlgeschlagen. Bitte Internetverbindung und Status (status.resend.com) prüfen.";
  }
  return message;
}

/**
 * Prüft ob E-Mail-Konfiguration vorhanden ist (ohne API-Call).
 */
function isEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.SALON_EMAIL?.trim()
  );
}

module.exports = {
  sendAppointmentEmails,
  isEmailConfigured,
  getMailConfig,
};
