/**
 * E-Mail-Versand per Nodemailer (Gmail / Outlook SMTP)
 */

const nodemailer = require("nodemailer");

const SALON = {
  name: "Friseursalon Henkes",
  phone: "0209 41793",
  address: "Fürstinnenstraße 40",
  city: "45883 Gelsenkirchen",
};

/**
 * Liest SMTP-Konfiguration aus Umgebungsvariablen (.env).
 */
function getMailConfig() {
  const user = process.env.EMAIL_USER?.trim();
  const pass = process.env.EMAIL_PASS?.trim();
  const salonEmail = process.env.SALON_EMAIL?.trim();

  if (!user || !pass || !salonEmail) {
    const error = new Error(
      "E-Mail-Versand ist nicht konfiguriert. Bitte EMAIL_USER, EMAIL_PASS und SALON_EMAIL in der .env Datei eintragen."
    );
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const host =
    process.env.SMTP_HOST?.trim() ||
    (/@(outlook|hotmail|live|office365)\./i.test(user)
      ? "smtp.office365.com"
      : "smtp.gmail.com");

  const port = Number(process.env.SMTP_PORT || 587);

  return {
    user,
    pass,
    salonEmail,
    host,
    port,
    from: `"${SALON.name}" <${user}>`,
  };
}

/**
 * Erstellt einen wiederverwendbaren Nodemailer-Transporter.
 */
function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: portIsSecure(config.port),
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
}

function portIsSecure(port) {
  return port === 465;
}

/**
 * Formatiert ISO-Datum fuer E-Mails (deutsch).
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
 * HTML + Text fuer Kundenbestaetigung.
 */
function buildCustomerEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Ihre Terminanfrage bei ${SALON.name} – ${dateLabel}`;

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Guten Tag <strong>${appointment.name}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      vielen Dank fuer Ihre Terminanfrage. Wir haben Ihre Wunschzeit erhalten und melden uns zur endgueltigen Bestaetigung bei Ihnen.
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Ihre Terminuebersicht</p>
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
      Herzliche Gruesse<br>
      <strong>Ihr Team vom ${SALON.name}</strong>
    </p>`;

  const text = [
    `Guten Tag ${appointment.name},`,
    "",
    "vielen Dank fuer Ihre Terminanfrage bei Friseursalon Henkes.",
    "",
    "Ihre Terminuebersicht:",
    `Leistung: ${appointment.service}`,
    `Datum: ${dateLabel}`,
    `Uhrzeit: ${appointment.time} Uhr`,
    `Telefon: ${appointment.phone}`,
    "",
    `Kontakt: ${SALON.phone}, ${SALON.address}, ${SALON.city}`,
    "",
    "Herzliche Gruesse",
    `Ihr Team vom ${SALON.name}`,
  ].join("\n");

  return {
    subject,
    html: wrapEmailHtml("Terminanfrage erhalten", bodyContent),
    text,
  };
}

/**
 * HTML + Text fuer Salon-Benachrichtigung.
 */
function buildSalonEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Neue Terminanfrage: ${appointment.name} – ${appointment.date}`;

  const bodyContent = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      Es ist eine neue Terminanfrage ueber die Website eingegangen:
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
      Bitte den Kunden telefonisch oder per E-Mail zur Bestaetigung kontaktieren.
    </p>`;

  const text = [
    "Neue Terminanfrage ueber die Website",
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
 * Sendet Kunden- und Salon-E-Mail; gibt Versandstatus zurueck.
 */
async function sendAppointmentEmails(appointment) {
  const config = getMailConfig();
  const transporter = createTransporter(config);

  const status = {
    customer: { sent: false, sentAt: null, error: null },
    salon: { sent: false, sentAt: null, error: null },
  };

  // Verbindung pruefen (fruehe, verstaendliche Fehlermeldung)
  try {
    await transporter.verify();
  } catch (error) {
    const message = mapSmtpError(error);
    status.customer.error = message;
    status.salon.error = message;
    return status;
  }

  const customerMail = buildCustomerEmail(appointment);
  const salonMail = buildSalonEmail(appointment);

  try {
    await transporter.sendMail({
      from: config.from,
      to: appointment.email,
      subject: customerMail.subject,
      text: customerMail.text,
      html: customerMail.html,
    });
    status.customer.sent = true;
    status.customer.sentAt = new Date().toISOString();
  } catch (error) {
    status.customer.error = mapSmtpError(error);
    console.error("[E-Mail] Kunde:", error.message);
  }

  try {
    await transporter.sendMail({
      from: config.from,
      to: config.salonEmail,
      replyTo: appointment.email,
      subject: salonMail.subject,
      text: salonMail.text,
      html: salonMail.html,
    });
    status.salon.sent = true;
    status.salon.sentAt = new Date().toISOString();
  } catch (error) {
    status.salon.error = mapSmtpError(error);
    console.error("[E-Mail] Salon:", error.message);
  }

  return status;
}

/**
 * Übersetzt technische SMTP-Fehler in verstaendliche Hinweise.
 */
function mapSmtpError(error) {
  const msg = error?.message || "Unbekannter Fehler";

  if (error?.code === "EAUTH" || /auth/i.test(msg)) {
    return "SMTP-Anmeldung fehlgeschlagen. Pruefen Sie EMAIL_USER und EMAIL_PASS (Gmail: App-Passwort verwenden).";
  }
  if (/self signed|certificate/i.test(msg)) {
    return "SMTP-Zertifikatsfehler. Pruefen Sie SMTP_HOST und SMTP_PORT.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(error?.code || msg)) {
    return "SMTP-Server nicht erreichbar. Pruefen Sie Internetverbindung und SMTP-Einstellungen.";
  }

  return msg;
}

/**
 * Prueft ob E-Mail-Konfiguration vorhanden ist (ohne Verbindungstest).
 */
function isEmailConfigured() {
  return Boolean(
    process.env.EMAIL_USER?.trim() &&
      process.env.EMAIL_PASS?.trim() &&
      process.env.SALON_EMAIL?.trim()
  );
}

module.exports = {
  sendAppointmentEmails,
  isEmailConfigured,
  getMailConfig,
};
