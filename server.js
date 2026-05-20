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

const ALLOWED_SERVICES = [
  "Haarschnitt",
  "Faerbung",
  "Straehnen",
  "Styling",
  "Haarpflege",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(ROOT));

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
    errors.push("Bitte geben Sie einen gueltigen Namen ein.");
  }

  if (!phone || phone.replace(/\D/g, "").length < 6) {
    errors.push("Bitte geben Sie eine gueltige Telefonnummer ein.");
  }

  if (!email) {
    errors.push("Bitte geben Sie Ihre E-Mail-Adresse ein.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("Bitte geben Sie eine gueltige E-Mail-Adresse ein.");
  }

  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (!dateMatch) {
    errors.push("Bitte waehlen Sie ein gueltiges Datum.");
  } else {
    const parsed = new Date(`${date}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      errors.push("Das gewaehlte Datum ist ungueltig.");
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
    errors.push("Bitte waehlen Sie eine gueltige Uhrzeit.");
  }

  if (!service || !ALLOWED_SERVICES.includes(service)) {
    errors.push("Bitte waehlen Sie eine Leistung aus.");
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
    if (!isEmailConfigured()) {
      return res.status(503).json({
        success: false,
        message:
          "E-Mail-Versand ist nicht eingerichtet. Bitte tragen Sie EMAIL_USER, EMAIL_PASS und SALON_EMAIL in der .env Datei ein.",
      });
    }

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

    const emailStatus = await sendAppointmentEmails(appointment);
    appointment.emailStatus = emailStatus;
    appointment.emailDeliveryStatus = summarizeEmailStatus(emailStatus);

    const index = appointments.findIndex((item) => item.id === appointment.id);
    if (index !== -1) {
      appointments[index] = appointment;
      await writeAppointments(appointments);
    }

    const customerOk = emailStatus.customer.sent;
    const salonOk = emailStatus.salon.sent;

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
        "Ihre Terminanfrage wurde erfolgreich gesendet. Sie erhalten in Kuerze eine Bestaetigungs-E-Mail.",
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
  console.log("  Friseursalon Henkes – Server laeuft");
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
