/**
 * Friseursalon Henkes - Terminbuchungs-Backend
 * Express, JSON-Speicher, Resend-Mail (Kunde + Salon + 24h-Erinnerung + Storno)
 */

require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  sendAppointmentEmails,
  sendCancellationEmail,
  isEmailConfigured,
  SALON,
} = require("./services/emailService");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://friseursalon-henkes-website.netlify.app",
];

const ALLOWED_SERVICES = [
  "Haarschnitt",
  "Färbung",
  "Strähnen",
  "Styling",
  "Haarpflege",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const MAX_NOTES_LENGTH = 500;

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "4kb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ]);

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});
app.use(express.static(ROOT));

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "friseursalon-henkes-backend",
    emailConfigured: isEmailConfigured(),
  });
});

async function readAppointments() {
  try {
    const raw = await fs.readFile(APPOINTMENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(APPOINTMENTS_FILE, "[]", "utf8");
      return [];
    }
    throw error;
  }
}

async function writeAppointments(appointments) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${APPOINTMENTS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(appointments, null, 2), "utf8");
  await fs.rename(tempFile, APPOINTMENTS_FILE);
}

function validateAppointment(payload) {
  const errors = [];
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const date = typeof payload.date === "string" ? payload.date.trim() : "";
  const time = typeof payload.time === "string" ? payload.time.trim() : "";
  const service = typeof payload.service === "string" ? payload.service.trim() : "";
  const rawNotes = typeof payload.notes === "string" ? payload.notes : "";
  // Whitespace trimmen, mehrfache Zeilenumbrueche normalisieren, Laenge begrenzen.
  const notes = rawNotes
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES_LENGTH);

  if (!name || name.length < 2) {
    errors.push("Bitte geben Sie einen gültigen Namen ein.");
  }

  if (!phone || phone.replace(/\D/g, "").length < 6) {
    errors.push("Bitte geben Sie eine gültige Telefonnummer ein.");
  }

  if (!email) {
    errors.push("Bitte geben Sie Ihre E-Mail-Adresse ein.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("Bitte geben Sie eine gültige E-Mail-Adresse ein.");
  }

  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (!dateMatch) {
    errors.push("Bitte wählen Sie ein gültiges Datum.");
  } else {
    const parsed = new Date(`${date}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      errors.push("Das gewählte Datum ist ungültig.");
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (parsed < today) {
        errors.push("Das Datum darf nicht in der Vergangenheit liegen.");
      }
    }
  }

  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
  if (!timeMatch) {
    errors.push("Bitte wählen Sie eine gültige Uhrzeit.");
  }

  if (!service || !ALLOWED_SERVICES.includes(service)) {
    errors.push("Bitte wählen Sie eine Leistung aus.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: { name, phone, email, date, time, service, notes },
  };
}

function summarizeEmailStatus(emailStatus) {
  if (emailStatus?.configured === false) return "not_configured";

  const customerOk = emailStatus?.customer?.sent;
  const salonOk = emailStatus?.salon?.sent;

  if (customerOk && salonOk) return "sent";
  if (customerOk || salonOk) return "partial";
  return "failed";
}

/**
 * Basis-URL fuer Stornier-Links: env-var hat Vorrang, sonst aus Request ableiten.
 */
function deriveBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL?.trim()) {
    return process.env.PUBLIC_BASE_URL.trim();
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${proto}://${host}` : "";
}

/** GET /api/appointments */
app.get("/api/appointments", async (_req, res) => {
  try {
    const appointments = await readAppointments();
    appointments.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    res.json({ success: true, appointments });
  } catch (error) {
    console.error("Fehler beim Lesen der Termine:", error);
    res.status(500).json({ success: false, message: "Termine konnten nicht geladen werden." });
  }
});

/** POST /api/appointments */
app.post("/api/appointments", async (req, res) => {
  try {
    const validation = validateAppointment(req.body);

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        message: validation.errors[0],
        errors: validation.errors,
      });
    }

    const appointments = await readAppointments();
    const createdAt = new Date().toISOString();

    const appointment = {
      id: randomUUID(),
      cancelToken: randomUUID(),
      ...validation.data,
      createdAt,
      cancelled: false,
      cancelledAt: null,
      emailStatus: {
        customer: { sent: false, sentAt: null, error: null },
        salon: { sent: false, sentAt: null, error: null },
        reminder: {
          scheduled: false,
          scheduledFor: null,
          emailId: null,
          error: null,
        },
      },
    };

    appointments.push(appointment);
    await writeAppointments(appointments);

    const baseUrl = deriveBaseUrl(req);

    const emailStatus = isEmailConfigured()
      ? await sendAppointmentEmails(appointment, baseUrl)
      : {
          configured: false,
          customer: {
            sent: false,
            sentAt: null,
            error: "E-Mail-Versand ist noch nicht eingerichtet.",
          },
          salon: {
            sent: false,
            sentAt: null,
            error: "E-Mail-Versand ist noch nicht eingerichtet.",
          },
          reminder: {
            scheduled: false,
            scheduledFor: null,
            emailId: null,
            error: "E-Mail-Versand ist noch nicht eingerichtet.",
          },
        };
    appointment.emailStatus = emailStatus;
    appointment.emailDeliveryStatus = summarizeEmailStatus(emailStatus);

    const index = appointments.findIndex((item) => item.id === appointment.id);
    if (index !== -1) {
      appointments[index] = appointment;
      await writeAppointments(appointments);
    }

    const customerOk = emailStatus.customer.sent;
    const salonOk = emailStatus.salon.sent;

    if (emailStatus.configured === false) {
      return res.status(201).json({
        success: true,
        message:
          "Ihre Terminanfrage wurde gespeichert. Wir melden uns zur Bestätigung bei Ihnen.",
        appointment: {
          id: appointment.id,
          name: appointment.name,
          email: appointment.email,
          date: appointment.date,
          time: appointment.time,
          service: appointment.service,
          emailStatus: appointment.emailStatus,
        },
      });
    }

    if (!customerOk || !salonOk) {
      const details = [];
      if (!customerOk) details.push(emailStatus.customer.error || "Kunden-E-Mail fehlgeschlagen");
      if (!salonOk) details.push(emailStatus.salon.error || "Salon-E-Mail fehlgeschlagen");

      return res.status(502).json({
        success: false,
        message: `Termin wurde gespeichert, aber der E-Mail-Versand ist fehlgeschlagen: ${details.join(" | ")}`,
        emailStatus,
        appointmentId: appointment.id,
      });
    }

    console.log(
      `[Termin] ${appointment.name} – ${appointment.date} ${appointment.time}` +
        ` (Mails OK, Reminder ${emailStatus.reminder.scheduled ? "geplant" : "skipped"})`
    );

    res.status(201).json({
      success: true,
      message:
        "Ihre Terminanfrage wurde erfolgreich gesendet. Sie erhalten in Kürze eine Bestätigungs-E-Mail.",
      appointment: {
        id: appointment.id,
        name: appointment.name,
        email: appointment.email,
        date: appointment.date,
        time: appointment.time,
        service: appointment.service,
        emailStatus: appointment.emailStatus,
      },
    });
  } catch (error) {
    console.error("Fehler bei der Buchung:", error);

    if (error.code === "EMAIL_NOT_CONFIGURED") {
      return res.status(503).json({ success: false, message: error.message });
    }

    res.status(500).json({
      success: false,
      message: "Die Buchung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.",
    });
  }
});

/* ---------------- Stornier-Flow ---------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

const STORNO_PAGE_STYLES = `
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

function renderStornoLayout(kicker, title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} | ${escapeHtml(SALON.name)}</title>
  <style>${STORNO_PAGE_STYLES}</style>
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

function renderStornoConfirm(appointment) {
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

  return renderStornoLayout("Termin stornieren", "Wirklich absagen?", body);
}

function renderStornoDone(appointment, justCancelled) {
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

  return renderStornoLayout(
    justCancelled ? "Erledigt" : "Bereits storniert",
    justCancelled ? "Termin abgesagt" : "Schon storniert",
    body
  );
}

function renderStornoNotFound() {
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
  return renderStornoLayout("Hmm", "Termin nicht gefunden", body);
}

function renderStornoError() {
  const body = `
    <p>Da ist gerade etwas schiefgelaufen. Bitte rufen Sie uns kurz an, dann erledigen wir das telefonisch:</p>
    <p style="font-size:18px"><a href="tel:${SALON.phoneTel}" style="color:#9f7630;font-weight:bold">${escapeHtml(SALON.phone)}</a></p>
    <div class="actions">
      <a href="/" class="btn btn-secondary">Zur Website</a>
    </div>`;
  return renderStornoLayout("Fehler", "Da ist was schiefgelaufen", body);
}

/** GET /storno/:token – Bestaetigungsseite */
app.get("/storno/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    const appointments = await readAppointments();
    const appointment = appointments.find((item) => item.cancelToken === token);

    if (!appointment) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    if (appointment.cancelled) {
      return res.type("html").send(renderStornoDone(appointment, false));
    }

    res.type("html").send(renderStornoConfirm(appointment));
  } catch (error) {
    console.error("Fehler bei /storno GET:", error);
    res.status(500).type("html").send(renderStornoError());
  }
});

/** POST /storno/:token – fuehrt die Stornierung aus */
app.post("/storno/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    const appointments = await readAppointments();
    const index = appointments.findIndex((item) => item.cancelToken === token);

    if (index === -1) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    const appointment = appointments[index];

    // Bereits storniert -> idempotent
    if (appointment.cancelled) {
      return res.type("html").send(renderStornoDone(appointment, false));
    }

    appointment.cancelled = true;
    appointment.cancelledAt = new Date().toISOString();

    // Reminder canceln + Salon informieren (E-Mail). Fehler schlucken,
    // damit die Stornierung trotzdem als erledigt angezeigt wird.
    if (isEmailConfigured()) {
      try {
        const cancelResult = await sendCancellationEmail(appointment);
        appointment.cancellationStatus = cancelResult;
      } catch (mailError) {
        console.error("[Storno] E-Mail-Aktionen fehlgeschlagen:", mailError);
        appointment.cancellationStatus = {
          salon: { sent: false, error: String(mailError?.message || mailError) },
          reminderCancelled: false,
        };
      }
    } else {
      appointment.cancellationStatus = {
        salon: { sent: false, error: "E-Mail nicht konfiguriert." },
        reminderCancelled: false,
      };
    }

    appointments[index] = appointment;
    await writeAppointments(appointments);

    console.log(
      `[Storno] ${appointment.name} – ${appointment.date} ${appointment.time}` +
        ` (Reminder ${appointment.cancellationStatus?.reminderCancelled ? "abgebrochen" : "nicht abgebrochen"})`
    );

    res.type("html").send(renderStornoDone(appointment, true));
  } catch (error) {
    console.error("Fehler bei /storno POST:", error);
    res.status(500).type("html").send(renderStornoError());
  }
});

app.listen(PORT, () => {
  console.log("");
  console.log("  Friseursalon Henkes – Server läuft");
  console.log("  ---------------------------------");
  console.log(`  Website:  http://localhost:${PORT}/`);
  console.log(`  Termin:   http://localhost:${PORT}/#termin`);
  console.log(`  Admin:    http://localhost:${PORT}/admin.html`);
  console.log(
    isEmailConfigured()
      ? "  E-Mail:   Resend konfiguriert"
      : "  E-Mail:   WARNUNG – .env fehlt (RESEND_API_KEY, SALON_EMAIL)"
  );
  console.log("");
});
