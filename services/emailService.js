/**
 * E-Mail-Versand per Resend HTTP-API.
 *
 * Sendet vier Mail-Arten:
 *   1. Bestaetigung an den Kunden (sofort nach Buchung)
 *   2. Benachrichtigung an den Salon (sofort nach Buchung)
 *   3. Erinnerung an den Kunden (24 h vor Termin, geplant via Resend `scheduledAt`)
 *   4. Storno-Info an den Salon (wenn Kunde den Stornier-Link klickt)
 *
 * Hintergrund: Render-Free (und viele andere PaaS-Free-Tiers) blockieren
 * ausgehende SMTP-Verbindungen. Resend nutzt HTTPS und funktioniert auf
 * praktisch jedem Host. Reminder werden Resend-seitig gehalten -- unser
 * Server muss zum Sende-Zeitpunkt nicht laufen.
 *
 * Erforderliche Umgebungsvariablen:
 *   RESEND_API_KEY  - API-Key aus https://resend.com (re_...)
 *   SALON_EMAIL     - Empfaenger fuer interne Salon-Benachrichtigungen
 *
 * Optionale Umgebungsvariablen:
 *   EMAIL_FROM        - Absender (Default: "Friseursalon Henkes <onboarding@resend.dev>")
 *   EMAIL_USER        - Wenn gesetzt: Reply-To fuer Kunden-Mails
 *   PUBLIC_BASE_URL   - Basis-URL fuer Stornier-Links (z.B. https://...onrender.com).
 *                       Wird zur Laufzeit aus der Request abgeleitet, falls nicht gesetzt.
 */

const { Resend } = require("resend");

const SALON = {
  name: "Friseursalon Henkes",
  phone: "0209 41793",
  phoneTel: "020941793",
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
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim() || "";

  return { apiKey, salonEmail, from, replyTo, publicBaseUrl };
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCancelUrl(baseUrl, token) {
  if (!baseUrl || !token) return "";
  return `${baseUrl.replace(/\/$/, "")}/storno/${encodeURIComponent(token)}`;
}

/**
 * Wandelt Berlin-Lokalzeit (YYYY-MM-DD + HH:MM) in UTC-ISO-String.
 * Beruecksichtigt automatisch Sommer-/Winterzeit via Intl-API; fallback
 * heuristisch (Apr-Sep = UTC+2, sonst UTC+1).
 */
function germanLocalToISOString(dateStr, timeStr) {
  const [y, mo, d] = String(dateStr || "").split("-").map(Number);
  const [h, mi] = String(timeStr || "").split(":").map(Number);

  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return null;

  const probe = new Date(Date.UTC(y, mo - 1, d, 12));
  let offsetMinutes = 60;

  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      timeZoneName: "longOffset",
    });
    const parts = fmt.formatToParts(probe);
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value;
    const match = offsetPart?.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (match) {
      const sign = match[1] === "+" ? 1 : -1;
      offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
    }
  } catch (_err) {
    offsetMinutes = mo >= 4 && mo <= 9 ? 120 : 60;
  }

  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes * 60 * 1000;
  return new Date(utcMs).toISOString();
}

/**
 * Berechnet wann die 24h-Erinnerung gesendet werden soll.
 * Gibt { scheduledFor, skipReason } zurueck.
 */
function getReminderTime(appointment) {
  const appointmentIso = germanLocalToISOString(appointment.date, appointment.time);
  if (!appointmentIso) {
    return { scheduledFor: null, skipReason: "Termin-Zeitstempel ungültig." };
  }

  const reminderMs = new Date(appointmentIso).getTime() - 24 * 60 * 60 * 1000;
  const now = Date.now();
  const diffHours = (reminderMs - now) / (60 * 60 * 1000);

  if (diffHours < 1) {
    return {
      scheduledFor: null,
      skipReason: "Termin liegt weniger als 25 h in der Zukunft – keine Erinnerung geplant.",
    };
  }
  if (diffHours > 30 * 24) {
    return {
      scheduledFor: null,
      skipReason: "Termin liegt mehr als 30 Tage in der Zukunft – Resend-Limit für scheduledAt.",
    };
  }

  return { scheduledFor: new Date(reminderMs).toISOString(), skipReason: null };
}

/**
 * Gemeinsames HTML-Grundlayout (Gold / Beige / Creme).
 */
function wrapEmailHtml(title, kicker, bodyContent) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f8efe3;font-family:Arial,Helvetica,sans-serif;color:#241713;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8efe3;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffaf0;border:1px solid rgba(75,48,40,0.16);border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#4b3028;padding:28px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#caa45d;font-weight:bold;">${escapeHtml(kicker)}</p>
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#fffaf0;line-height:1.2;">${escapeHtml(title)}</h1>
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
                Tel. <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;">${SALON.phone}</a>
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
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);color:#77675c;font-size:14px;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);color:#4b3028;font-size:15px;font-weight:bold;vertical-align:top;">${value}</td>
      </tr>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0 24px;">${items}</table>`;
}

function buildStornoCta(cancelUrl) {
  if (!cancelUrl) {
    return `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#77675c;">
        Sollte doch etwas dazwischenkommen, rufen Sie uns gern kurz an unter
        <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;font-weight:bold;">${SALON.phone}</a>.
      </p>`;
  }

  return `
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 16px;">
      <tr>
        <td style="background:#4b3028;border-radius:4px;">
          <a href="${escapeHtml(cancelUrl)}" style="display:inline-block;padding:12px 22px;color:#fffaf0;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:0.02em;">Termin stornieren</a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#77675c;">
      … oder kurz anrufen: <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;">${SALON.phone}</a>
    </p>`;
}

/**
 * Kundenbestaetigung (sofort nach Buchung).
 */
function buildCustomerEmail(appointment, baseUrl) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Wir haben Ihre Anfrage – ${SALON.name}`;
  const cancelUrl = buildCancelUrl(baseUrl, appointment.cancelToken);

  const detailRows = [
    ["Leistung", escapeHtml(appointment.service)],
    ["Wann", `${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr`],
  ];
  if (appointment.notes) {
    detailRows.push([
      "Ihre Notiz",
      `<em style="font-weight:normal;color:#4b3028;">${escapeHtml(appointment.notes)}</em>`,
    ]);
  }

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Hallo <strong>${escapeHtml(appointment.name)}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      schön, dass Sie sich für uns entschieden haben &mdash; wir freuen uns riesig auf Sie!
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Ihre Anfrage</p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      Wir schauen kurz in den Kalender und melden uns persönlich, sobald der Termin fest steht. Falls Sie uns vorab noch etwas mitteilen möchten &mdash; einfach auf diese Mail antworten, das landet direkt bei uns im Salon.
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Plan geändert?</p>
    ${buildStornoCta(cancelUrl)}
    <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#4b3028;">
      Bis bald in der Fürstinnenstraße!<br>
      <strong>Ihr Team vom ${escapeHtml(SALON.name)}</strong>
    </p>`;

  const textLines = [
    `Hallo ${appointment.name},`,
    "",
    "schön, dass Sie sich für uns entschieden haben – wir freuen uns riesig auf Sie!",
    "",
    "Ihre Anfrage:",
    `  Leistung: ${appointment.service}`,
    `  Wann: ${dateLabel}, ${appointment.time} Uhr`,
  ];
  if (appointment.notes) {
    textLines.push(`  Ihre Notiz: ${appointment.notes}`);
  }
  textLines.push(
    "",
    "Wir schauen kurz in den Kalender und melden uns persönlich, sobald der Termin fest steht.",
    "Falls Sie uns vorab etwas mitteilen möchten – einfach auf diese Mail antworten.",
    "",
    "Plan geändert?"
  );
  if (cancelUrl) {
    textLines.push(`  Termin stornieren: ${cancelUrl}`);
  }
  textLines.push(
    `  oder Anruf: ${SALON.phone}`,
    "",
    "Bis bald in der Fürstinnenstraße!",
    `Ihr Team vom ${SALON.name}`,
    "",
    `${SALON.name} · ${SALON.address}, ${SALON.city}`,
    `Tel. ${SALON.phone}`
  );

  return {
    subject,
    html: wrapEmailHtml("Wir freuen uns auf Sie", "Anfrage erhalten", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * 24h-Erinnerung (geplant via Resend scheduledAt).
 */
function buildReminderEmail(appointment, baseUrl) {
  const subject = `Bis morgen! – Ihr Termin bei ${SALON.name}`;
  const cancelUrl = buildCancelUrl(baseUrl, appointment.cancelToken);

  const detailRows = [
    ["Leistung", escapeHtml(appointment.service)],
    ["Wann", `morgen, ${escapeHtml(appointment.time)} Uhr`],
    ["Wo", `${escapeHtml(SALON.address)}, ${escapeHtml(SALON.city)}`],
  ];
  if (appointment.notes) {
    detailRows.push([
      "Ihre Notiz",
      `<em style="font-weight:normal;color:#4b3028;">${escapeHtml(appointment.notes)}</em>`,
    ]);
  }

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Hallo <strong>${escapeHtml(appointment.name)}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      kleine Erinnerung &mdash; <strong>morgen um ${escapeHtml(appointment.time)} Uhr</strong> sind Sie bei uns. Wir freuen uns!
    </p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Sollte was dazwischenkommen</p>
    ${buildStornoCta(cancelUrl)}
    <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#4b3028;">
      Bis morgen!<br>
      <strong>Ihr Team vom ${escapeHtml(SALON.name)}</strong>
    </p>`;

  const textLines = [
    `Hallo ${appointment.name},`,
    "",
    `kleine Erinnerung – morgen um ${appointment.time} Uhr sind Sie bei uns für ${appointment.service}. Wir freuen uns!`,
    "",
    `Wo: ${SALON.address}, ${SALON.city}`,
  ];
  if (appointment.notes) {
    textLines.push(`Ihre Notiz: ${appointment.notes}`);
  }
  textLines.push("", "Sollte was dazwischenkommen:");
  if (cancelUrl) {
    textLines.push(`  Termin stornieren: ${cancelUrl}`);
  }
  textLines.push(
    `  oder Anruf: ${SALON.phone}`,
    "",
    "Bis morgen!",
    `Ihr Team vom ${SALON.name}`
  );

  return {
    subject,
    html: wrapEmailHtml("Bis morgen!", "Terminerinnerung", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Salon-Benachrichtigung bei neuer Anfrage.
 */
function buildSalonEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Neue Terminanfrage: ${appointment.name} – ${appointment.date}`;

  const phoneClean = String(appointment.phone || "").replace(/\s/g, "");
  const detailRows = [
    ["Name", escapeHtml(appointment.name)],
    ["Telefon", `<a href="tel:${escapeHtml(phoneClean)}" style="color:#9f7630;">${escapeHtml(appointment.phone)}</a>`],
    ["E-Mail", `<a href="mailto:${escapeHtml(appointment.email)}" style="color:#9f7630;">${escapeHtml(appointment.email)}</a>`],
    ["Leistung", escapeHtml(appointment.service)],
    ["Datum", escapeHtml(dateLabel)],
    ["Uhrzeit", `${escapeHtml(appointment.time)} Uhr`],
    [
      "Notizen",
      appointment.notes
        ? `<em style="font-weight:normal;color:#4b3028;">${escapeHtml(appointment.notes)}</em>`
        : '<span style="color:#a89684;font-weight:normal;">—</span>',
    ],
    ["Angelegt am", escapeHtml(new Date(appointment.createdAt).toLocaleString("de-DE"))],
  ];

  const bodyContent = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      Neue Terminanfrage über die Website:
    </p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0;font-size:14px;color:#77675c;line-height:1.6;">
      Antworten auf diese Mail gehen direkt an die Kunden-E-Mail.<br>
      Die 24h-Erinnerung an den Kunden wird automatisch geplant.
    </p>`;

  const textLines = [
    "Neue Terminanfrage über die Website",
    "",
    `Name: ${appointment.name}`,
    `Telefon: ${appointment.phone}`,
    `E-Mail: ${appointment.email}`,
    `Leistung: ${appointment.service}`,
    `Datum: ${dateLabel}`,
    `Uhrzeit: ${appointment.time} Uhr`,
    `Notizen: ${appointment.notes || "—"}`,
    `Angelegt am: ${appointment.createdAt}`,
  ];

  return {
    subject,
    html: wrapEmailHtml("Neue Terminanfrage", "Eingang", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Stornierungs-Benachrichtigung an den Salon.
 */
function buildCancellationEmail(appointment) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Termin abgesagt: ${appointment.name} – ${appointment.date}`;
  const phoneClean = String(appointment.phone || "").replace(/\s/g, "");

  const detailRows = [
    ["Name", escapeHtml(appointment.name)],
    ["Telefon", `<a href="tel:${escapeHtml(phoneClean)}" style="color:#9f7630;">${escapeHtml(appointment.phone)}</a>`],
    ["E-Mail", `<a href="mailto:${escapeHtml(appointment.email)}" style="color:#9f7630;">${escapeHtml(appointment.email)}</a>`],
    ["Leistung", escapeHtml(appointment.service)],
    ["Wäre gewesen", `${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr`],
    [
      "Storniert am",
      escapeHtml(new Date(appointment.cancelledAt || Date.now()).toLocaleString("de-DE")),
    ],
  ];

  const bodyContent = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b3028;">
      <strong>${escapeHtml(appointment.name)}</strong> hat den Termin per Online-Stornier-Link abgesagt.
    </p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0;font-size:14px;color:#77675c;line-height:1.6;">
      Der Slot ist wieder frei. Die geplante 24h-Erinnerung wurde automatisch abgebrochen.
    </p>`;

  const textLines = [
    `${appointment.name} hat den Termin per Online-Stornier-Link abgesagt.`,
    "",
    `Wäre gewesen: ${dateLabel}, ${appointment.time} Uhr`,
    `Leistung: ${appointment.service}`,
    `Telefon: ${appointment.phone}`,
    `E-Mail: ${appointment.email}`,
    "",
    "Slot wieder frei. Erinnerung wurde abgebrochen.",
  ];

  return {
    subject,
    html: wrapEmailHtml("Termin abgesagt", "Stornierung", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Sendet Kunden- und Salon-Mail sofort + plant 24h-Erinnerung via Resend.
 */
async function sendAppointmentEmails(appointment, baseUrl) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const effectiveBaseUrl = config.publicBaseUrl || baseUrl || "";

  const status = {
    configured: true,
    customer: { sent: false, sentAt: null, error: null },
    salon: { sent: false, sentAt: null, error: null },
    reminder: {
      scheduled: false,
      scheduledFor: null,
      emailId: null,
      error: null,
    },
  };

  const customerMail = buildCustomerEmail(appointment, effectiveBaseUrl);
  const salonMail = buildSalonEmail(appointment);

  // 1. Kunden-Bestaetigung (sofort)
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

  // 2. Salon-Benachrichtigung (sofort)
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

  // 3. 24h-Erinnerung (geplant)
  const { scheduledFor, skipReason } = getReminderTime(appointment);
  if (!scheduledFor) {
    status.reminder.error = skipReason;
  } else {
    try {
      const reminderMail = buildReminderEmail(appointment, effectiveBaseUrl);
      const { data, error } = await resend.emails.send({
        from: config.from,
        to: appointment.email,
        replyTo: config.replyTo,
        subject: reminderMail.subject,
        text: reminderMail.text,
        html: reminderMail.html,
        scheduledAt: scheduledFor,
      });
      if (error) throw error;
      status.reminder.scheduled = true;
      status.reminder.scheduledFor = scheduledFor;
      status.reminder.emailId = data?.id || null;
    } catch (error) {
      status.reminder.error = mapEmailError(error);
      console.error("[E-Mail] Erinnerung-Planung:", error?.message || error);
    }
  }

  return status;
}

/**
 * Wenn Kunde storniert: Salon informieren + geplante Erinnerung abbrechen.
 */
async function sendCancellationEmail(appointment) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);

  const result = {
    salon: { sent: false, sentAt: null, error: null },
    reminderCancelled: false,
    reminderCancelError: null,
  };

  // 1. Geplante Erinnerung abbrechen (falls vorhanden)
  const reminderEmailId = appointment.emailStatus?.reminder?.emailId;
  if (reminderEmailId) {
    try {
      const { error } = await resend.emails.cancel(reminderEmailId);
      if (error) throw error;
      result.reminderCancelled = true;
    } catch (error) {
      result.reminderCancelError = mapEmailError(error);
      console.error("[Storno] Erinnerung-Abbruch fehlgeschlagen:", error?.message || error);
    }
  }

  // 2. Salon informieren
  try {
    const mail = buildCancellationEmail(appointment);
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.salonEmail,
      replyTo: appointment.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (error) throw error;
    result.salon.sent = true;
    result.salon.sentAt = new Date().toISOString();
  } catch (error) {
    result.salon.error = mapEmailError(error);
    console.error("[Storno] Salon-Mail fehlgeschlagen:", error?.message || error);
  }

  return result;
}

/**
 * Uebersetzt technische Resend-/Netzwerk-Fehler in verstaendliche Hinweise.
 */
function mapEmailError(error) {
  const name = error?.name || "";
  const message = error?.message || String(error || "Unbekannter Fehler");
  const combined = `${name} ${message}`;

  if (/invalid_api_key|unauthorized|401/i.test(combined)) {
    return "Resend-API-Key ungültig oder fehlt. Bitte RESEND_API_KEY in den Umgebungsvariablen prüfen.";
  }
  if (/testing emails|only send.*to your own|verified.*recipient|you can only send/i.test(combined)) {
    return "Resend-Sandbox: Im Test-Modus können nur Mails an die bei Resend registrierte Adresse gehen. Bitte Domain bei Resend verifizieren und EMAIL_FROM auf die Domain setzen.";
  }
  if (/validation_error.*from|from.*not.*verified|domain.*not.*verified/i.test(combined)) {
    return "Absender-Domain bei Resend nicht verifiziert. Bitte EMAIL_FROM auf eine verifizierte Domain setzen oder Default 'onboarding@resend.dev' verwenden.";
  }
  if (/forbidden|403/i.test(combined)) {
    return "Resend hat die Anfrage abgelehnt (403). Häufig: API-Key gehört zu anderem Account oder Empfänger nicht erlaubt im Test-Modus.";
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
 * Prueft ob E-Mail-Konfiguration vorhanden ist (ohne API-Call).
 */
function isEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.SALON_EMAIL?.trim()
  );
}

module.exports = {
  sendAppointmentEmails,
  sendCancellationEmail,
  isEmailConfigured,
  getMailConfig,
  SALON,
};
