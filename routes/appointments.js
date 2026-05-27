/**
 * Buchungs-API (oeffentlich) + Admin-Listen-Endpoint.
 *
 *   POST /api/appointments        -- Kunde legt einen neuen Termin an
 *   GET  /api/appointments        -- Admin sieht alle Termine
 */

const express = require("express");
const { randomUUID } = require("crypto");

const { DEDUPE_WINDOW_MS } = require("../lib/config");
const { readAll, writeAll } = require("../lib/storage");
const { validateAppointment } = require("../lib/validate");
const { requireAdminAuth } = require("../lib/auth");
const { bookingLimiter, adminLimiter } = require("../lib/rate-limit");
const { deriveBaseUrl } = require("../lib/url");
const { asyncHandler } = require("../lib/async-handler");
const logger = require("../lib/logger").child("appointments");

const {
  sendAppointmentEmails,
  isEmailConfigured,
} = require("../services/emailService");

const router = express.Router();

/**
 * Mappt das emailStatus-Objekt auf einen kurzen String fuer die DB
 * (sent | partial | failed | not_configured).
 */
function summarizeEmailStatus(emailStatus) {
  if (emailStatus?.configured === false) return "not_configured";
  const customerOk = emailStatus?.customer?.sent;
  const salonOk = emailStatus?.salon?.sent;
  if (customerOk && salonOk) return "sent";
  if (customerOk || salonOk) return "partial";
  return "failed";
}

/** Admin-Liste, sortiert nach Datum/Uhrzeit. */
router.get(
  "/",
  adminLimiter,
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const appointments = await readAll();
    appointments.sort((a, b) =>
      `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)
    );
    res.json({ success: true, appointments });
  })
);

/** Kunde legt eine neue Anfrage an. */
router.post(
  "/",
  bookingLimiter,
  asyncHandler(async (req, res) => {
    // Honeypot: das Feld "website" ist im HTML versteckt. Echte Kunden
    // sehen es nie, Bots fuellen alle Felder aus. Wenn das Feld einen
    // Wert hat, antworten wir freundlich mit 200 (damit der Bot nicht
    // weiss dass er erkannt wurde), legen aber nichts an.
    const honeypot =
      typeof req.body?.website === "string" ? req.body.website.trim() : "";
    if (honeypot.length > 0) {
      logger.warn("honeypot_triggered", { sample: honeypot.slice(0, 40) });
      return res.status(200).json({
        success: true,
        message: "Vielen Dank! Wir haben Ihre Anfrage erhalten.",
      });
    }

    // Idempotency-Key: bulletproof Schutz gegen Doppel-Submit bei
    // Netzwerk-Blip. Wenn der Client denselben Key zweimal schickt,
    // liefern wir das existierende Appointment zurueck statt ein neues
    // anzulegen. Funktioniert auch wenn die Payload sich minimal
    // unterscheidet (z.B. Whitespace in Notes), waehrend der reine
    // 60s-Payload-Dedupe nur exakte Matches faengt.
    const idempotencyKey =
      typeof req.headers["x-idempotency-key"] === "string"
        ? req.headers["x-idempotency-key"].trim().slice(0, 100)
        : "";

    const validation = await validateAppointment(req.body);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        message: validation.errors[0],
        errors: validation.errors,
      });
    }

    const appointments = await readAll();
    const createdAt = new Date().toISOString();

    if (idempotencyKey) {
      const existing = appointments.find(
        (item) => item.idempotencyKey === idempotencyKey
      );
      if (existing) {
        logger.info("idempotent_replay", {
          id: existing.id,
          key: idempotencyKey.slice(0, 8) + "...",
        });
        return res.status(200).json({
          success: true,
          duplicate: true,
          message:
            "Wir haben Ihre Anfrage bereits erhalten – alles gut. Sie bekommen gleich (oder haben gerade schon) eine Eingangs-Mail von uns.",
          appointment: {
            id: existing.id,
            name: existing.name,
            email: existing.email,
            date: existing.date,
            time: existing.time,
            service: existing.service,
            emailStatus: existing.emailStatus,
          },
        });
      }
    }

    // Doppel-Submit-Dedupe: gleiche (email, date, time, service) innerhalb
    // des Dedupe-Fensters -> bestehenden Eintrag zurueckliefern, kein neuer.
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
      logger.info("appointment_duplicate_ignored", {
        id: duplicate.id,
        name: duplicate.name,
        date: duplicate.date,
        time: duplicate.time,
      });
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

    // Slot-Konflikt-Erkennung: nicht blockierend (zwei Stylistinnen
    // koennten parallel arbeiten), nur als Warnung im Admin-UI.
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
      idempotencyKey: idempotencyKey || null,
      ...validation.data,
      createdAt,
      cancelled: false,
      cancelledAt: null,
      conflictsWith: conflicts,
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
    await writeAll(appointments);

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

    // Re-read + update: zwischen unserem write und jetzt koennte
    // theoretisch ein anderer Request reingekommen sein. Wir re-lesen,
    // finden unseren Eintrag, updaten und schreiben zurueck.
    const refreshed = await readAll();
    const index = refreshed.findIndex((item) => item.id === appointment.id);
    if (index !== -1) {
      refreshed[index] = appointment;
      await writeAll(refreshed);
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
      if (!customerOk)
        details.push(emailStatus.customer.error || "Kunden-E-Mail fehlgeschlagen");
      if (!salonOk)
        details.push(emailStatus.salon.error || "Salon-E-Mail fehlgeschlagen");

      return res.status(502).json({
        success: false,
        message: `Termin wurde gespeichert, aber der E-Mail-Versand ist fehlgeschlagen: ${details.join(" | ")}`,
        emailStatus,
        appointmentId: appointment.id,
      });
    }

    logger.info("appointment_created", {
      id: appointment.id,
      name: appointment.name,
      date: appointment.date,
      time: appointment.time,
      service: appointment.service,
    });

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
  })
);

module.exports = router;
