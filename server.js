/**
 * Friseursalon Henkes - Terminbuchungs-Backend
 * Express, JSON-Speicher, Resend-Mail (Kunde + Salon + 24h-Erinnerung + Storno)
 */

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { randomUUID } = require("crypto");

const {
  ALLOWED_SERVICES,
  DEDUPE_WINDOW_MS,
  ROOT_DIR,
  DEFAULT_ALLOWED_ORIGINS,
  NETLIFY_PREVIEW_REGEX,
} = require("./lib/config");

const {
  sendAppointmentEmails,
  sendCancellationEmail,
  sendAdminCancellationEmail,
  sendConfirmationEmail,
  sendDeclineEmail,
  sendDailyDigestEmail,
  isEmailConfigured,
} = require("./services/emailService");

const logger = require("./lib/logger");
const {
  readAll: readAppointments,
  writeAll: writeAppointments,
  findById: findAppointmentById,
  findByCancelToken,
  remove: removeAppointment,
} = require("./lib/storage");
const { requireAdminAuth, safeStringEqual } = require("./lib/auth");
const { validateAppointment } = require("./lib/validate");
const stornoViews = require("./lib/views/storno");

const log = logger.child("server");

const app = express();
const PORT = process.env.PORT || 3000;

function isAllowedOrigin(origin, exactSet) {
  if (!origin) return false;
  if (exactSet.has(origin)) return true;
  if (NETLIFY_PREVIEW_REGEX.test(origin)) return true;
  return false;
}

/* ---------------- Rate-Limiting ---------------- */

// Strenger Limiter fuer die Buchungs-API: jede neue Anfrage kostet uns
// 2 Resend-Mails -- ein Bot kann unser Resend-Kontingent in Minuten
// auffressen. 5 Buchungen pro 15 Minuten pro IP reichen fuer echte
// Kunden dicke (selbst eine Familie bucht selten 5 Termine gleichzeitig).
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Zu viele Anfragen von dieser Adresse. Bitte versuchen Sie es in ein paar Minuten erneut oder rufen Sie uns kurz an.",
  },
});

// Storno-Endpoint: Token ist 128 Bit Zufall, brute-force ist praktisch
// unmoeglich -- trotzdem etwas Rate-Limit, damit niemand Resend-Cancel-
// Calls in Massen ausloesen kann.
const cancelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin-Endpoints: pro IP grosszuegig, da bereits durch Basic-Auth
// geschuetzt. Schuetzt vor Auth-Brute-Force, ohne den echten Admin
// auszusperren.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

// Render terminiert TLS und schickt uns die Original-IP via x-forwarded-*.
// Ohne "trust proxy" sieht Express alle Requests als von der Proxy-IP -- das
// bricht (a) Stornier-Link-Bau aus dem Request, (b) jeden IP-basierten
// Rate-Limiter. Auf "1" weil es vor uns genau einen Render-Hop gibt.
app.set("trust proxy", 1);

// Security-Header (helmet). CSP ist hier deaktiviert, weil die Storno-HTML-
// Seiten und das admin-Panel inline <style>-Bloecke benutzen -- spaeter
// koennen wir eine Nonce-basierte CSP nachruesten. Cross-Origin-Embedder-
// Policy ist auch aus, damit Bilder/Fonts aus fremden Origins (Google
// Fonts) im Browser nicht blockiert werden.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

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

  if (isAllowedOrigin(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  // DELETE ist fuer den Admin-Loesch-Endpoint dabei. Authorization fuer
  // Basic-Auth-Header bei evtl. zukuenftigen Cross-Origin-Admin-Calls
  // (aktuell sitzen Admin und Backend auf gleicher Origin, schadet nicht).
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});
// Admin-Static-Files (admin.html, admin.js) hinter Basic Auth.
// admin.css ist bewusst frei, enthaelt keine PII.
app.use((req, res, next) => {
  if (req.path === "/admin.html" || req.path === "/admin.js") {
    return requireAdminAuth(req, res, next);
  }
  return next();
});

app.use(express.static(ROOT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "friseursalon-henkes-backend",
    emailConfigured: isEmailConfigured(),
  });
});

/**
 * Liefert die Liste der buchbaren Leistungen. Frontend zieht das beim
 * Laden, damit das <select> auf der Buchungsseite immer synchron mit der
 * Server-Validierung ist. Frontend hat eine eingebaute Default-Liste als
 * Fallback fuer den Fall dass das Backend gerade schlaeft.
 */
app.get("/api/services", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300"); // 5 Min cache
  res.json({ success: true, services: ALLOWED_SERVICES });
});

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

/** GET /api/appointments – Admin-only Liste aller Buchungen. */
app.get("/api/appointments", adminLimiter, requireAdminAuth, async (_req, res) => {
  try {
    const appointments = await readAppointments();
    appointments.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    res.json({ success: true, appointments });
  } catch (error) {
    console.error("Fehler beim Lesen der Termine:", error);
    res.status(500).json({ success: false, message: "Termine konnten nicht geladen werden." });
  }
});

/**
 * GET /api/admin/backup
 *
 * Liefert die rohen appointments.json als Download. Lebenswichtig solange
 * der Render-Free-Tier nutzt -- der Filesystem-Storage ist ephemer und
 * jeder Deploy wischt die Datei. Mit diesem Endpoint kann sich der Salon
 * regelmaessig (oder vor einem Deploy) ein Backup runterladen.
 *
 * Wenn man's automatisieren will: einfach von cron-job.org aus alle paar
 * Stunden pullen und in einem Cloud-Storage-Bucket ablegen (Auth via
 * Basic-Auth in der URL: https://user:pass@host/api/admin/backup).
 */
app.get("/api/admin/backup", adminLimiter, requireAdminAuth, async (_req, res) => {
  try {
    const appointments = await readAppointments();
    const filename = `henkes-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          count: appointments.length,
          appointments,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("Fehler beim Backup-Export:", error);
    res.status(500).json({ success: false, message: "Backup-Export fehlgeschlagen." });
  }
});

/** POST /api/appointments */
app.post("/api/appointments", bookingLimiter, async (req, res) => {
  try {
    // Honeypot: das Feld "website" ist im HTML versteckt. Echte Kunden
    // sehen es nie, Bots aber fuellen alle Felder aus. Wenn das Feld
    // einen Wert hat, antworten wir mit einem freundlichen 200 (damit
    // der Bot nicht weiss dass er erkannt wurde) -- legen aber nichts
    // an und senden keine Mail.
    const honeypot = typeof req.body?.website === "string" ? req.body.website.trim() : "";
    if (honeypot.length > 0) {
      log.warn("honeypot_triggered", { sample: honeypot.slice(0, 40) });
      return res.status(200).json({
        success: true,
        message: "Vielen Dank! Wir haben Ihre Anfrage erhalten.",
      });
    }

    const validation = await validateAppointment(req.body);

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        message: validation.errors[0],
        errors: validation.errors,
      });
    }

    const appointments = await readAppointments();
    const createdAt = new Date().toISOString();

    // Doppel-Submit-Dedupe: Wenn der Kunde aus Versehen doppelt klickt oder
    // der Browser einen Retry macht, koennen identische Buchungen in
    // Sekundenabstand reinkommen. Wir betrachten gleiche (email, date,
    // time, service) innerhalb des Dedupe-Fensters als Duplikat und
    // liefern den bestehenden Eintrag zurueck, statt einen neuen anzulegen.
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    const duplicate = appointments.find(
      (item) =>
        item.email?.toLowerCase() === validation.data.email.toLowerCase() &&
        item.date === validation.data.date &&
        item.time === validation.data.time &&
        item.service === validation.data.service &&
        new Date(item.createdAt).getTime() >= cutoff
    );
    if (duplicate) {
      console.log(
        `[Termin] Duplikat ignoriert: ${duplicate.name} – ${duplicate.date} ${duplicate.time}`
      );
      return res.status(200).json({
        success: true,
        duplicate: true,
        message:
          "Wir haben Ihre Anfrage bereits erhalten – alles gut. Sie bekommen gleich (oder haben gerade schon) eine Eingangs-Mail von uns.",
        appointment: {
          id: duplicate.id,
          name: duplicate.name,
          email: duplicate.email,
          date: duplicate.date,
          time: duplicate.time,
          service: duplicate.service,
        },
      });
    }

    // Slot-Konflikt-Erkennung: gibt es schon (mind.) einen offenen oder
    // bestaetigten Termin zur exakt gleichen Uhrzeit? Wir blockieren NICHT
    // (zwei Stylistinnen koennten parallel arbeiten), markieren den Termin
    // aber als "konfliktbehaftet", damit der Salon im Admin entscheiden kann.
    const conflicts = appointments
      .filter(
        (item) =>
          item.date === validation.data.date &&
          item.time === validation.data.time &&
          !item.cancelled &&
          !item.declined
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        service: item.service,
        confirmed: Boolean(item.confirmed),
      }));

    const appointment = {
      id: randomUUID(),
      cancelToken: randomUUID(),
      ...validation.data,
      createdAt,
      cancelled: false,
      cancelledAt: null,
      // Slot-Konflikte mit anderen offenen/bestaetigten Terminen.
      conflictsWith: conflicts,
      // Anfrage-Workflow: Salon bestaetigt oder lehnt ueber den Admin-Bereich ab.
      confirmed: false,
      confirmedAt: null,
      declined: false,
      declinedAt: null,
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
      confirmationStatus: {
        customer: { sent: false, sentAt: null, error: null },
        reminder: {
          scheduled: false,
          scheduledFor: null,
          emailId: null,
          error: null,
        },
      },
      declineStatus: {
        customer: { sent: false, sentAt: null, error: null },
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
        ` (Eingangs-Mails OK, Bestaetigung steht aus)`
    );

    res.status(201).json({
      success: true,
      message:
        "Vielen Dank! Wir haben Ihre Anfrage erhalten und melden uns in Kürze mit einer persönlichen Bestätigung. Sie bekommen gleich eine Eingangs-E-Mail von uns.",
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

/* ---------------- Admin: Bestaetigen / Ablehnen ---------------- */

/**
 * POST /api/admin/appointments/:id/confirm
 * Markiert den Termin als bestaetigt, sendet die Bestaetigungs-Mail
 * an den Kunden und plant die 24h-Erinnerung via Resend.
 */
app.post("/api/admin/appointments/:id/confirm", adminLimiter, requireAdminAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const { appointments, appointment, index } = await findAppointmentById(id);

    if (!appointment) {
      return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
    }

    if (appointment.cancelled) {
      return res
        .status(409)
        .json({ success: false, message: "Termin wurde bereits vom Kunden storniert." });
    }

    if (appointment.declined) {
      return res.status(409).json({
        success: false,
        message: "Termin wurde bereits abgelehnt. Statuswechsel nicht moeglich.",
      });
    }

    if (appointment.confirmed) {
      return res.status(200).json({
        success: true,
        message: "Termin war bereits bestaetigt.",
        appointment,
      });
    }

    appointment.confirmed = true;
    appointment.confirmedAt = new Date().toISOString();

    const baseUrl = deriveBaseUrl(req);

    if (isEmailConfigured()) {
      try {
        const confirmResult = await sendConfirmationEmail(appointment, baseUrl);
        appointment.confirmationStatus = confirmResult;
      } catch (mailError) {
        console.error("[Bestaetigen] E-Mail-Aktionen fehlgeschlagen:", mailError);
        appointment.confirmationStatus = {
          customer: {
            sent: false,
            sentAt: null,
            error: String(mailError?.message || mailError),
          },
          reminder: {
            scheduled: false,
            scheduledFor: null,
            emailId: null,
            error: String(mailError?.message || mailError),
          },
        };
      }
    } else {
      appointment.confirmationStatus = {
        customer: { sent: false, sentAt: null, error: "E-Mail nicht konfiguriert." },
        reminder: {
          scheduled: false,
          scheduledFor: null,
          emailId: null,
          error: "E-Mail nicht konfiguriert.",
        },
      };
    }

    appointments[index] = appointment;
    await writeAppointments(appointments);

    console.log(
      `[Bestaetigen] ${appointment.name} – ${appointment.date} ${appointment.time}` +
        ` (Mail ${appointment.confirmationStatus.customer.sent ? "OK" : "FAIL"},` +
        ` Reminder ${appointment.confirmationStatus.reminder.scheduled ? "geplant" : "skipped"})`
    );

    const customerOk = appointment.confirmationStatus.customer.sent;
    if (!customerOk) {
      return res.status(502).json({
        success: false,
        message: `Termin bestätigt, aber die Bestätigungs-Mail an den Kunden ist fehlgeschlagen: ${appointment.confirmationStatus.customer.error || "unbekannter Fehler"}`,
        appointment,
      });
    }

    return res.json({
      success: true,
      message: "Termin bestätigt – Mail an Kunde versendet.",
      appointment,
    });
  } catch (error) {
    console.error("Fehler bei /api/admin/.../confirm:", error);
    res.status(500).json({
      success: false,
      message: "Bestätigung fehlgeschlagen. Bitte erneut versuchen.",
    });
  }
});

/**
 * POST /api/admin/appointments/:id/decline
 * Markiert den Termin als abgelehnt und sendet eine Absage-Mail
 * an den Kunden mit Bitte, einen anderen Termin anzufragen.
 */
app.post("/api/admin/appointments/:id/decline", adminLimiter, requireAdminAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const { appointments, appointment, index } = await findAppointmentById(id);

    if (!appointment) {
      return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
    }

    if (appointment.cancelled) {
      return res
        .status(409)
        .json({ success: false, message: "Termin wurde bereits vom Kunden storniert." });
    }

    if (appointment.confirmed) {
      return res.status(409).json({
        success: false,
        message: "Termin wurde bereits bestaetigt. Statuswechsel nicht moeglich.",
      });
    }

    if (appointment.declined) {
      return res.status(200).json({
        success: true,
        message: "Termin war bereits abgelehnt.",
        appointment,
      });
    }

    appointment.declined = true;
    appointment.declinedAt = new Date().toISOString();

    const baseUrl = deriveBaseUrl(req);

    if (isEmailConfigured()) {
      try {
        const declineResult = await sendDeclineEmail(appointment, baseUrl);
        appointment.declineStatus = declineResult;
      } catch (mailError) {
        console.error("[Ablehnen] E-Mail-Aktionen fehlgeschlagen:", mailError);
        appointment.declineStatus = {
          customer: {
            sent: false,
            sentAt: null,
            error: String(mailError?.message || mailError),
          },
        };
      }
    } else {
      appointment.declineStatus = {
        customer: { sent: false, sentAt: null, error: "E-Mail nicht konfiguriert." },
      };
    }

    appointments[index] = appointment;
    await writeAppointments(appointments);

    console.log(
      `[Ablehnen] ${appointment.name} – ${appointment.date} ${appointment.time}` +
        ` (Mail ${appointment.declineStatus.customer.sent ? "OK" : "FAIL"})`
    );

    const customerOk = appointment.declineStatus.customer.sent;
    if (!customerOk) {
      return res.status(502).json({
        success: false,
        message: `Termin abgelehnt, aber die Absage-Mail an den Kunden ist fehlgeschlagen: ${appointment.declineStatus.customer.error || "unbekannter Fehler"}`,
        appointment,
      });
    }

    return res.json({
      success: true,
      message: "Termin abgelehnt – Mail an Kunde versendet.",
      appointment,
    });
  } catch (error) {
    console.error("Fehler bei /api/admin/.../decline:", error);
    res.status(500).json({
      success: false,
      message: "Ablehnung fehlgeschlagen. Bitte erneut versuchen.",
    });
  }
});

/**
 * POST /api/admin/appointments/:id/cancel
 * Salon-initiierte Stornierung eines bereits bestaetigten oder ausstehenden
 * Termins. Sendet eine entschuldigende Absage-Mail an den Kunden und
 * canceled die geplante 24h-Erinnerung.
 */
app.post(
  "/api/admin/appointments/:id/cancel",
  adminLimiter,
  requireAdminAuth,
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!id) {
        return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
      }

      const { appointments, appointment, index } = await findAppointmentById(id);

      if (!appointment) {
        return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
      }

      if (appointment.cancelled) {
        return res.status(200).json({
          success: true,
          message: "Termin war bereits storniert.",
          appointment,
        });
      }

      if (appointment.declined) {
        return res.status(409).json({
          success: false,
          message: "Termin war bereits abgelehnt – Statuswechsel nicht moeglich.",
        });
      }

      appointment.cancelled = true;
      appointment.cancelledAt = new Date().toISOString();
      appointment.cancelledByAdmin = true;

      const baseUrl = deriveBaseUrl(req);

      if (isEmailConfigured()) {
        try {
          const cancelResult = await sendAdminCancellationEmail(appointment, baseUrl);
          appointment.adminCancellationStatus = cancelResult;
        } catch (mailError) {
          console.error("[Admin-Storno] E-Mail-Aktionen fehlgeschlagen:", mailError);
          appointment.adminCancellationStatus = {
            customer: {
              sent: false,
              sentAt: null,
              error: String(mailError?.message || mailError),
            },
            reminderCancelled: false,
            reminderCancelError: String(mailError?.message || mailError),
          };
        }
      } else {
        appointment.adminCancellationStatus = {
          customer: { sent: false, sentAt: null, error: "E-Mail nicht konfiguriert." },
          reminderCancelled: false,
          reminderCancelError: null,
        };
      }

      appointments[index] = appointment;
      await writeAppointments(appointments);

      console.log(
        `[Admin-Storno] ${appointment.name} – ${appointment.date} ${appointment.time}` +
          ` (Mail ${appointment.adminCancellationStatus.customer.sent ? "OK" : "FAIL"},` +
          ` Reminder ${appointment.adminCancellationStatus.reminderCancelled ? "abgebrochen" : "skipped"})`
      );

      const customerOk = appointment.adminCancellationStatus.customer.sent;
      if (!customerOk) {
        return res.status(502).json({
          success: false,
          message: `Termin storniert, aber die Absage-Mail an den Kunden ist fehlgeschlagen: ${appointment.adminCancellationStatus.customer.error || "unbekannter Fehler"}`,
          appointment,
        });
      }

      return res.json({
        success: true,
        message: "Termin storniert – Absage-Mail an Kunde versendet.",
        appointment,
      });
    } catch (error) {
      console.error("Fehler bei /api/admin/.../cancel:", error);
      res.status(500).json({
        success: false,
        message: "Stornierung fehlgeschlagen. Bitte erneut versuchen.",
      });
    }
  }
);

/**
 * DELETE /api/admin/appointments/:id
 * Loescht den Termin permanent aus dem Speicher. Sendet keine Mail --
 * dient nur zum Aufraeumen alter / fehlgeschlagener Eintraege im Admin-UI.
 */
app.delete(
  "/api/admin/appointments/:id",
  adminLimiter,
  requireAdminAuth,
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!id) {
        return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
      }

      const removed = await removeAppointment(id);
      if (!removed) {
        return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
      }

      log.info("appointment_deleted", {
        id: removed.id,
        name: removed.name,
        date: removed.date,
        time: removed.time,
      });

      return res.json({
        success: true,
        message: "Termin gelöscht.",
        appointment: { id: removed.id },
      });
    } catch (error) {
      console.error("Fehler bei DELETE /api/admin/...:", error);
      res.status(500).json({
        success: false,
        message: "Löschen fehlgeschlagen. Bitte erneut versuchen.",
      });
    }
  }
);

/* ---------------- Cron / Tageserinnerung ---------------- */

/**
 * GET /api/cron/daily-digest
 *
 * Wird morgens von einem externen Cron (cron-job.org, github actions, ...)
 * aufgerufen. Sendet eine Uebersicht der heutigen bestaetigten Termine an
 * SALON_EMAIL. Schuetzt sich per Shared-Secret in ?secret=... oder
 * "Authorization: Bearer <SECRET>", damit kein Fremder die Mail triggern
 * (und damit den Render-Container aufwecken + Mail-Quota anzapfen) kann.
 *
 * Hat den schoenen Nebeneffekt, den Server jeden Morgen warm zu halten,
 * sodass der erste echte Kunden-Klick keinen Cold-Start mehr abkriegt.
 */
app.get("/api/cron/daily-digest", async (req, res) => {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) {
    return res.status(503).json({
      success: false,
      message: "Cron ist nicht konfiguriert (CRON_SECRET fehlt).",
    });
  }

  const headerAuth = req.headers.authorization || "";
  const bearerMatch = headerAuth.match(/^Bearer\s+(.+)$/i);
  const provided = (bearerMatch ? bearerMatch[1] : req.query.secret || "").toString().trim();

  if (!provided || !safeStringEqual(provided, expectedSecret)) {
    return res.status(401).json({ success: false, message: "Ungueltiges Cron-Secret." });
  }

  try {
    const appointments = await readAppointments();
    // Lokale Zeitzone "heute" -- wir gehen vom Salon-Standort Deutschland aus.
    // Berlin-Datum YYYY-MM-DD via Intl-API ableiten.
    const todayBerlin = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const todays = appointments.filter(
      (item) =>
        item.date === todayBerlin && item.confirmed && !item.cancelled && !item.declined
    );

    if (!isEmailConfigured()) {
      return res.status(503).json({
        success: false,
        message: "E-Mail ist nicht konfiguriert.",
        today: todayBerlin,
        count: todays.length,
      });
    }

    const result = await sendDailyDigestEmail(todays, todayBerlin);
    console.log(
      `[Daily-Digest] ${todayBerlin}: ${todays.length} Termine, Mail ${result.sent ? "OK" : "FAIL"}`
    );

    return res.json({
      success: result.sent,
      message: result.sent
        ? `Tagesübersicht gesendet (${todays.length} Termine).`
        : `Versand fehlgeschlagen: ${result.error || "unbekannt"}`,
      today: todayBerlin,
      count: todays.length,
      result,
    });
  } catch (error) {
    console.error("Fehler bei /api/cron/daily-digest:", error);
    res
      .status(500)
      .json({ success: false, message: "Tagesübersicht fehlgeschlagen." });
  }
});

/* ---------------- Stornier-Flow ---------------- */

const renderStornoConfirm = stornoViews.renderConfirm;
const renderStornoDone = stornoViews.renderDone;
const renderStornoNotFound = stornoViews.renderNotFound;
const renderStornoError = stornoViews.renderError;

/** GET /storno/:token – Bestaetigungsseite */
app.get("/storno/:token", cancelLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    const { appointment } = await findByCancelToken(token);

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
app.post("/storno/:token", cancelLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

    const { appointments, appointment, index } = await findByCancelToken(token);

    if (!appointment) {
      return res.status(404).type("html").send(renderStornoNotFound());
    }

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

/* ---------------- 404 / Fallback ---------------- */

/**
 * Catch-all am Schluss: alles, was bis hier nicht gematcht hat, kriegt
 * unsere schoene 404-Seite. Fuer /api/* geben wir JSON zurueck statt HTML,
 * damit Aufrufer (Frontend, externe Tools) den Fehler verstehen.
 */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      message: `Endpoint nicht gefunden: ${req.method} ${req.path}`,
    });
  }
  res.status(404).sendFile(path.join(ROOT_DIR, "404.html"));
});

const server = app.listen(PORT, () => {
  log.info("server_started", {
    port: PORT,
    env: process.env.NODE_ENV || "development",
    emailConfigured: isEmailConfigured(),
    pid: process.pid,
  });
  if (!isEmailConfigured()) {
    log.warn("email_not_configured", {
      hint: "RESEND_API_KEY and SALON_EMAIL must be set for email delivery",
    });
  }
});

/* ---------------- Graceful shutdown ---------------- */

/**
 * Render schickt SIGTERM bei Deploys. Ohne sauberen Shutdown koennen
 * laufende Requests abgehackt werden und atomare File-Writes ggf. im
 * .tmp-Zustand stecken bleiben (-> nicht-existente appointments.json
 * beim naechsten Start). Mit close() warten wir die offenen Requests
 * ab und stoppen dann.
 */
function gracefulShutdown(signal) {
  log.info("shutdown_requested", { signal });
  // 10s Hard-Timeout: wenn Requests haengen, trotzdem rausgehen.
  // Render gibt 30s zwischen SIGTERM und SIGKILL.
  const forceTimer = setTimeout(() => {
    log.error("shutdown_forced", { reason: "timeout after 10s" });
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  server.close((err) => {
    if (err) {
      log.error("shutdown_error", { error: String(err.message || err) });
      process.exit(1);
    }
    log.info("shutdown_complete", {});
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
