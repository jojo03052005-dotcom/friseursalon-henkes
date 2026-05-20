/**
 * Friseursalon Henkes – Terminbuchungs-Backend
 * Express, JSON-Speicher, Nodemailer (Kunde + Salon)
 */

require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  sendAppointmentEmails,
  isEmailConfigured,
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

app.use(express.json({ limit: "32kb" }));
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
    data: { name, phone, email, date, time, service },
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
      ...validation.data,
      createdAt,
      emailStatus: {
        customer: { sent: false, sentAt: null, error: null },
        salon: { sent: false, sentAt: null, error: null },
      },
    };

    appointments.push(appointment);
    await writeAppointments(appointments);

    const emailStatus = isEmailConfigured()
      ? await sendAppointmentEmails(appointment)
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

    console.log(`[Termin] ${appointment.name} – ${appointment.date} ${appointment.time} (E-Mails gesendet)`);

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

app.listen(PORT, () => {
  console.log("");
  console.log("  Friseursalon Henkes – Server läuft");
  console.log("  ---------------------------------");
  console.log(`  Website:  http://localhost:${PORT}/`);
  console.log(`  Termin:   http://localhost:${PORT}/#termin`);
  console.log(`  Admin:    http://localhost:${PORT}/admin.html`);
  console.log(
    isEmailConfigured()
      ? "  E-Mail:   SMTP konfiguriert"
      : "  E-Mail:   WARNUNG – .env fehlt (EMAIL_USER, EMAIL_PASS, SALON_EMAIL)"
  );
  console.log("");
});
