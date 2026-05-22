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
 * Bestaetigung an den Kunden, nachdem der Salon den Termin bestaetigt hat.
 */
function buildConfirmedEmail(appointment, baseUrl) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Termin bestätigt – ${dateLabel}, ${appointment.time} Uhr`;
  const cancelUrl = buildCancelUrl(baseUrl, appointment.cancelToken);

  const detailRows = [
    ["Leistung", escapeHtml(appointment.service)],
    ["Wann", `${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr`],
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
      kurz und gut: <strong>Ihr Termin steht.</strong> Wir freuen uns sehr auf Sie!
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Ihr Termin</p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      24 Stunden vorher schicken wir Ihnen automatisch nochmal eine kleine Erinnerung &mdash; damit kein Termin zwischen Tür und Angel vergessen wird.
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
    "kurz und gut: Ihr Termin steht. Wir freuen uns sehr auf Sie!",
    "",
    "Ihr Termin:",
    `  Leistung: ${appointment.service}`,
    `  Wann: ${dateLabel}, ${appointment.time} Uhr`,
    `  Wo: ${SALON.address}, ${SALON.city}`,
  ];
  if (appointment.notes) {
    textLines.push(`  Ihre Notiz: ${appointment.notes}`);
  }
  textLines.push(
    "",
    "24 Stunden vorher bekommen Sie noch eine automatische Erinnerung von uns.",
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
    `Ihr Team vom ${SALON.name}`
  );

  return {
    subject,
    html: wrapEmailHtml("Ihr Termin ist bestätigt", "Termin bestätigt", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Absage an den Kunden, wenn der Salon die Anfrage nicht annehmen kann.
 */
function buildDeclineEmail(appointment, baseUrl) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Ihre Terminanfrage – leider nicht möglich`;
  const bookingUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/#termin` : "";

  const detailRows = [
    ["Leistung", escapeHtml(appointment.service)],
    ["Gewünscht war", `${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr`],
  ];

  const newRequestCta = bookingUrl
    ? `
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 16px;">
        <tr>
          <td style="background:#4b3028;border-radius:4px;">
            <a href="${escapeHtml(bookingUrl)}" style="display:inline-block;padding:12px 22px;color:#fffaf0;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:0.02em;">Neuen Termin anfragen</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#77675c;">
        … oder direkt anrufen: <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;">${SALON.phone}</a>
      </p>`
    : `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#77675c;">
        Am schnellsten geht's per Anruf:
        <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;font-weight:bold;">${SALON.phone}</a>
      </p>`;

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Hallo <strong>${escapeHtml(appointment.name)}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      vielen Dank für Ihre Anfrage. Leider können wir Ihren Wunschtermin nicht anbieten &mdash; an dem Tag ist bei uns leider schon alles dicht.
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Ihre Anfrage</p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#4b3028;">
      Wir würden uns sehr freuen, einen anderen Termin für Sie zu finden &mdash; oft klappt's nur ein paar Tage verschoben, oder zu einer anderen Uhrzeit.
    </p>
    ${newRequestCta}
    <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#4b3028;">
      Bis bald hoffentlich!<br>
      <strong>Ihr Team vom ${escapeHtml(SALON.name)}</strong>
    </p>`;

  const textLines = [
    `Hallo ${appointment.name},`,
    "",
    "vielen Dank für Ihre Anfrage.",
    `Leider können wir den Wunschtermin am ${dateLabel} um ${appointment.time} Uhr nicht anbieten.`,
    "",
    "Wir würden uns sehr freuen, einen anderen Termin für Sie zu finden – oft klappt's nur ein paar Tage verschoben, oder zu einer anderen Uhrzeit.",
    "",
  ];
  if (bookingUrl) {
    textLines.push(`Neuen Termin anfragen: ${bookingUrl}`);
  }
  textLines.push(
    `Oder direkt anrufen: ${SALON.phone}`,
    "",
    "Bis bald hoffentlich!",
    `Ihr Team vom ${SALON.name}`
  );

  return {
    subject,
    html: wrapEmailHtml("Anfrage leider nicht möglich", "Terminanfrage", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Wenn der Salon einen bereits bestaetigten Termin nachtraeglich absagen
 * muss (z.B. Krankheit, Stylistin ausgefallen). Hoeflich, bittet um neuen Termin.
 */
function buildAdminCancellationEmail(appointment, baseUrl) {
  const dateLabel = formatGermanDate(appointment.date);
  const subject = `Wichtig: Ihr Termin am ${dateLabel} muss leider entfallen`;
  const bookingUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/#termin` : "";

  const detailRows = [
    ["Leistung", escapeHtml(appointment.service)],
    ["Wäre gewesen", `${escapeHtml(dateLabel)}, ${escapeHtml(appointment.time)} Uhr`],
  ];

  const newRequestCta = bookingUrl
    ? `
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 16px;">
        <tr>
          <td style="background:#4b3028;border-radius:4px;">
            <a href="${escapeHtml(bookingUrl)}" style="display:inline-block;padding:12px 22px;color:#fffaf0;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:0.02em;">Neuen Termin anfragen</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#77675c;">
        … oder direkt anrufen: <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;">${SALON.phone}</a>
      </p>`
    : `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#77675c;">
        Bitte rufen Sie uns kurz an, dann finden wir gemeinsam einen neuen Termin:
        <a href="tel:${SALON.phoneTel}" style="color:#9f7630;text-decoration:none;font-weight:bold;">${SALON.phone}</a>
      </p>`;

  const bodyContent = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
      Hallo <strong>${escapeHtml(appointment.name)}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
      es tut uns wirklich leid &mdash; wir müssen Ihren Termin leider absagen. Da ist bei uns kurzfristig etwas dazwischengekommen.
    </p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#9f7630;font-weight:bold;">Betroffener Termin</p>
    ${buildDetailsTable(detailRows)}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#4b3028;">
      Wir würden uns sehr freuen, schnell einen Ersatztermin für Sie zu finden. Am einfachsten ist ein kurzer Anruf, dann besprechen wir's direkt.
    </p>
    ${newRequestCta}
    <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#4b3028;">
      Nochmals Entschuldigung &mdash; bis bald hoffentlich!<br>
      <strong>Ihr Team vom ${escapeHtml(SALON.name)}</strong>
    </p>`;

  const textLines = [
    `Hallo ${appointment.name},`,
    "",
    "es tut uns wirklich leid – wir müssen Ihren Termin leider absagen.",
    "Da ist bei uns kurzfristig etwas dazwischengekommen.",
    "",
    "Betroffener Termin:",
    `  Leistung: ${appointment.service}`,
    `  Wäre gewesen: ${dateLabel}, ${appointment.time} Uhr`,
    "",
    "Wir würden uns sehr freuen, schnell einen Ersatztermin für Sie zu finden.",
    "Am einfachsten ist ein kurzer Anruf, dann besprechen wir's direkt.",
    "",
  ];
  if (bookingUrl) {
    textLines.push(`Neuen Termin anfragen: ${bookingUrl}`);
  }
  textLines.push(
    `Oder direkt anrufen: ${SALON.phone}`,
    "",
    "Nochmals Entschuldigung – bis bald hoffentlich!",
    `Ihr Team vom ${SALON.name}`
  );

  return {
    subject,
    html: wrapEmailHtml("Termin muss entfallen", "Wichtige Information", bodyContent),
    text: textLines.join("\n"),
  };
}

/**
 * Tages-Digest fuer den Salon (morgens als Cron getriggert):
 * "Heute habt ihr X Termine".
 */
function buildDailyDigestEmail(appointments, today) {
  const dateLabel = formatGermanDate(today);
  const subject =
    appointments.length === 0
      ? `Heute, ${dateLabel}: keine Termine`
      : `Heute, ${dateLabel}: ${appointments.length} Termin${appointments.length === 1 ? "" : "e"}`;

  let bodyContent;
  let textLines;

  if (appointments.length === 0) {
    bodyContent = `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
        Guten Morgen,
      </p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
        heute (${escapeHtml(dateLabel)}) sind <strong>keine Termine</strong> bestätigt. Falls noch Anfragen offen sind, schauen Sie kurz im Admin-Panel.
      </p>`;
    textLines = [
      "Guten Morgen,",
      "",
      `heute (${dateLabel}) sind keine Termine bestaetigt.`,
      "Falls noch Anfragen offen sind, schauen Sie kurz im Admin-Panel.",
    ];
  } else {
    const rows = appointments
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((item) => {
        const phoneClean = String(item.phone || "").replace(/\s/g, "");
        return `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);font-size:15px;font-weight:bold;color:#4b3028;white-space:nowrap;vertical-align:top;">${escapeHtml(item.time)}</td>
            <td style="padding:10px 10px;border-bottom:1px solid rgba(75,48,40,0.12);font-size:14px;color:#4b3028;vertical-align:top;">
              <strong>${escapeHtml(item.name)}</strong><br>
              <span style="color:#77675c;">${escapeHtml(item.service)}</span>
              ${item.notes ? `<br><em style="color:#77675c;font-size:13px;">${escapeHtml(item.notes)}</em>` : ""}
            </td>
            <td style="padding:10px 0;border-bottom:1px solid rgba(75,48,40,0.12);font-size:13px;color:#4b3028;vertical-align:top;text-align:right;white-space:nowrap;">
              <a href="tel:${escapeHtml(phoneClean)}" style="color:#9f7630;text-decoration:none;">${escapeHtml(item.phone)}</a>
            </td>
          </tr>`;
      })
      .join("");

    bodyContent = `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b3028;">
        Guten Morgen,
      </p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b3028;">
        heute (${escapeHtml(dateLabel)}) habt ihr <strong>${appointments.length} Termin${appointments.length === 1 ? "" : "e"}</strong>:
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;">
        ${rows}
      </table>
      <p style="margin:0;font-size:13px;color:#77675c;line-height:1.6;">
        Schoenen Tag!
      </p>`;

    textLines = ["Guten Morgen,", "", `heute (${dateLabel}) habt ihr ${appointments.length} Termin${appointments.length === 1 ? "" : "e"}:`, ""];
    appointments.forEach((item) => {
      textLines.push(`${item.time} Uhr – ${item.name} (${item.service}) – ${item.phone}`);
      if (item.notes) textLines.push(`            Notiz: ${item.notes}`);
    });
    textLines.push("", "Schoenen Tag!");
  }

  return {
    subject,
    html: wrapEmailHtml("Heute im Salon", "Tagesübersicht", bodyContent),
    text: textLines.join("\n"),
  };
}

async function sendDailyDigestEmail(appointments, today) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const mail = buildDailyDigestEmail(appointments, today);

  const result = { sent: false, sentAt: null, error: null };

  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.salonEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (error) throw error;
    result.sent = true;
    result.sentAt = new Date().toISOString();
  } catch (error) {
    result.error = mapEmailError(error);
    console.error("[Daily-Digest] Versand fehlgeschlagen:", error?.message || error);
  }

  return result;
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
 * Sendet die Eingangs-Mails fuer eine neue Terminanfrage:
 *   - "Anfrage erhalten" an den Kunden
 *   - Benachrichtigung an den Salon
 *
 * Die 24h-Erinnerung wird hier NICHT mehr geplant. Sie wird erst beim
 * Bestaetigen ausgeloest (siehe sendConfirmationEmail), damit nicht-
 * bestaetigte Termine keine Reminder verschicken.
 */
async function sendAppointmentEmails(appointment, baseUrl) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const effectiveBaseUrl = config.publicBaseUrl || baseUrl || "";

  const status = {
    configured: true,
    customer: { sent: false, sentAt: null, error: null },
    salon: { sent: false, sentAt: null, error: null },
    // Feld bleibt aus Daten-Kompatibilitaets-Gruenden erhalten; der eigentliche
    // Plan-Schritt findet jetzt beim Bestaetigen statt.
    reminder: {
      scheduled: false,
      scheduledFor: null,
      emailId: null,
      error: "Wird erst beim Bestätigen des Termins geplant.",
    },
  };

  const customerMail = buildCustomerEmail(appointment, effectiveBaseUrl);
  const salonMail = buildSalonEmail(appointment);

  // 1. Kunden-Eingangs-Mail (sofort)
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

  return status;
}

/**
 * Sendet die Bestaetigungs-Mail an den Kunden und plant die 24h-Erinnerung
 * via Resend `scheduledAt`. Wird vom Admin-Endpoint aufgerufen, sobald der
 * Salon den Termin bestaetigt.
 */
async function sendConfirmationEmail(appointment, baseUrl) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const effectiveBaseUrl = config.publicBaseUrl || baseUrl || "";

  const status = {
    customer: { sent: false, sentAt: null, error: null },
    reminder: {
      scheduled: false,
      scheduledFor: null,
      emailId: null,
      error: null,
    },
  };

  const confirmedMail = buildConfirmedEmail(appointment, effectiveBaseUrl);

  // 1. Bestaetigungs-Mail
  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: appointment.email,
      replyTo: config.replyTo,
      subject: confirmedMail.subject,
      text: confirmedMail.text,
      html: confirmedMail.html,
    });
    if (error) throw error;
    status.customer.sent = true;
    status.customer.sentAt = new Date().toISOString();
  } catch (error) {
    status.customer.error = mapEmailError(error);
    console.error("[Bestaetigung] Kunde:", error?.message || error);
  }

  // 2. 24h-Erinnerung planen
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
      console.error("[Bestaetigung] Erinnerung-Planung:", error?.message || error);
    }
  }

  return status;
}

/**
 * Sendet die Absage-Mail an den Kunden. Wird vom Admin-Endpoint aufgerufen,
 * wenn der Salon eine Anfrage nicht annehmen kann.
 */
async function sendDeclineEmail(appointment, baseUrl) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const effectiveBaseUrl = config.publicBaseUrl || baseUrl || "";

  const status = {
    customer: { sent: false, sentAt: null, error: null },
  };

  const declineMail = buildDeclineEmail(appointment, effectiveBaseUrl);

  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: appointment.email,
      replyTo: config.replyTo,
      subject: declineMail.subject,
      text: declineMail.text,
      html: declineMail.html,
    });
    if (error) throw error;
    status.customer.sent = true;
    status.customer.sentAt = new Date().toISOString();
  } catch (error) {
    status.customer.error = mapEmailError(error);
    console.error("[Ablehnung] Kunde:", error?.message || error);
  }

  return status;
}

/**
 * Wenn der Salon einen bestaetigten/ausstehenden Termin nachtraeglich
 * absagen muss: Kunde benachrichtigen + geplante 24h-Erinnerung
 * canceln (falls vorhanden).
 */
async function sendAdminCancellationEmail(appointment, baseUrl) {
  const config = getMailConfig();
  const resend = new Resend(config.apiKey);
  const effectiveBaseUrl = config.publicBaseUrl || baseUrl || "";

  const result = {
    customer: { sent: false, sentAt: null, error: null },
    reminderCancelled: false,
    reminderCancelError: null,
  };

  // 1. Geplante Erinnerung abbrechen (falls vorhanden)
  const reminderEmailId =
    appointment.confirmationStatus?.reminder?.emailId ||
    appointment.emailStatus?.reminder?.emailId;
  if (reminderEmailId) {
    try {
      const { error } = await resend.emails.cancel(reminderEmailId);
      if (error) throw error;
      result.reminderCancelled = true;
    } catch (error) {
      result.reminderCancelError = mapEmailError(error);
      console.error("[Admin-Storno] Erinnerung-Abbruch:", error?.message || error);
    }
  }

  // 2. Kunden informieren
  const mail = buildAdminCancellationEmail(appointment, effectiveBaseUrl);
  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: appointment.email,
      replyTo: config.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (error) throw error;
    result.customer.sent = true;
    result.customer.sentAt = new Date().toISOString();
  } catch (error) {
    result.customer.error = mapEmailError(error);
    console.error("[Admin-Storno] Kunde:", error?.message || error);
  }

  return result;
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

  // 1. Geplante Erinnerung abbrechen (falls vorhanden).
  // Seit der Workflow-Umstellung wird die Erinnerung erst beim Bestaetigen
  // geplant und liegt in confirmationStatus. Alte Datensaetze (vor dem
  // Umbau) koennten sie noch unter emailStatus haben -- daher Fallback.
  const reminderEmailId =
    appointment.confirmationStatus?.reminder?.emailId ||
    appointment.emailStatus?.reminder?.emailId;
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
  sendAdminCancellationEmail,
  sendConfirmationEmail,
  sendDeclineEmail,
  sendDailyDigestEmail,
  isEmailConfigured,
  getMailConfig,
  SALON,
};
