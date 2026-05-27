/**
 * Admin-Aktionen auf einzelnen Terminen.
 *   POST   /api/admin/appointments/:id/confirm   -- bestaetigen
 *   POST   /api/admin/appointments/:id/decline   -- ablehnen
 *   POST   /api/admin/appointments/:id/cancel    -- Salon-Storno
 *   DELETE /api/admin/appointments/:id           -- permanent loeschen
 *   GET    /api/admin/backup                     -- alle Termine als JSON-Download
 *
 * Alle hinter Basic-Auth.
 */

const express = require("express");

const {
  findById,
  writeAll,
  remove,
  readAll,
} = require("../lib/storage");
const { requireAdminAuth } = require("../lib/auth");
const { adminLimiter } = require("../lib/rate-limit");
const { deriveBaseUrl } = require("../lib/url");
const { asyncHandler } = require("../lib/async-handler");
const logger = require("../lib/logger").child("admin");

const {
  sendConfirmationEmail,
  sendDeclineEmail,
  sendAdminCancellationEmail,
  isEmailConfigured,
} = require("../services/emailService");

const router = express.Router();

// Alle Admin-Routes hinter Auth + Rate-Limit
router.use(adminLimiter);
router.use(requireAdminAuth);

/* ---------------- Backup ---------------- */

router.get(
  "/backup",
  asyncHandler(async (_req, res) => {
    const appointments = await readAll();
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
  })
);

/**
 * CSV-Export -- fuer Operator die Excel/Numbers nutzen wollen statt JSON.
 * UTF-8 BOM voran, damit Excel die Umlaute korrekt liest.
 * Semikolon als Trennzeichen (deutsches Excel-Default).
 */
router.get(
  "/backup.csv",
  asyncHandler(async (_req, res) => {
    const appointments = await readAll();
    const filename = `henkes-termine-${new Date().toISOString().slice(0, 10)}.csv`;

    const headers = [
      "ID",
      "Erstellt",
      "Datum",
      "Uhrzeit",
      "Name",
      "Telefon",
      "E-Mail",
      "Leistung",
      "Status",
      "Notizen",
    ];

    const escape = (val) => {
      const s = String(val ?? "");
      // CSV-Escape: bei ; " oder Newline -> in Anfuehrungszeichen,
      // " im Inhalt verdoppeln.
      if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const statusOf = (a) => {
      if (a.cancelled) return "Storniert";
      if (a.declined) return "Abgelehnt";
      if (a.confirmed) return "Bestaetigt";
      return "Ausstehend";
    };

    const lines = [headers.map(escape).join(";")];
    appointments
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
      .forEach((a) => {
        lines.push(
          [
            a.id,
            a.createdAt,
            a.date,
            a.time,
            a.name,
            a.phone,
            a.email,
            a.service,
            statusOf(a),
            (a.notes || "").replace(/\r?\n/g, " | "),
          ]
            .map(escape)
            .join(";")
        );
      });

    // BOM ﻿ damit Excel utf-8 erkennt
    const csv = "﻿" + lines.join("\r\n") + "\r\n";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  })
);

/* ---------------- Confirm ---------------- */

router.post(
  "/appointments/:id/confirm",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const { appointments, appointment, index } = await findById(id);
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
        appointment.confirmationStatus = await sendConfirmationEmail(
          appointment,
          baseUrl
        );
      } catch (mailError) {
        logger.error("confirm_mail_failed", {
          id: appointment.id,
          error: String(mailError?.message || mailError),
        });
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
    await writeAll(appointments);

    logger.info("appointment_confirmed", {
      id: appointment.id,
      name: appointment.name,
      date: appointment.date,
      time: appointment.time,
      mailSent: appointment.confirmationStatus.customer.sent,
      reminderScheduled: appointment.confirmationStatus.reminder.scheduled,
    });

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
  })
);

/* ---------------- Decline ---------------- */

router.post(
  "/appointments/:id/decline",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const { appointments, appointment, index } = await findById(id);
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
        appointment.declineStatus = await sendDeclineEmail(appointment, baseUrl);
      } catch (mailError) {
        logger.error("decline_mail_failed", {
          id: appointment.id,
          error: String(mailError?.message || mailError),
        });
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
    await writeAll(appointments);

    logger.info("appointment_declined", {
      id: appointment.id,
      name: appointment.name,
      date: appointment.date,
      time: appointment.time,
      mailSent: appointment.declineStatus.customer.sent,
    });

    if (!appointment.declineStatus.customer.sent) {
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
  })
);

/* ---------------- Admin-Storno ---------------- */

router.post(
  "/appointments/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const { appointments, appointment, index } = await findById(id);
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
        appointment.adminCancellationStatus = await sendAdminCancellationEmail(
          appointment,
          baseUrl
        );
      } catch (mailError) {
        logger.error("admin_cancel_mail_failed", {
          id: appointment.id,
          error: String(mailError?.message || mailError),
        });
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
    await writeAll(appointments);

    logger.info("appointment_admin_cancelled", {
      id: appointment.id,
      name: appointment.name,
      date: appointment.date,
      time: appointment.time,
      mailSent: appointment.adminCancellationStatus.customer.sent,
      reminderCancelled: appointment.adminCancellationStatus.reminderCancelled,
    });

    if (!appointment.adminCancellationStatus.customer.sent) {
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
  })
);

/* ---------------- Delete (Aufraeumen) ---------------- */

router.delete(
  "/appointments/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!id) {
      return res.status(400).json({ success: false, message: "Termin-ID fehlt." });
    }

    const removed = await remove(id);
    if (!removed) {
      return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
    }

    logger.info("appointment_deleted", {
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
  })
);

module.exports = router;
