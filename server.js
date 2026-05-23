/**
 * Friseursalon Henkes - Terminbuchungs-Backend
 * Express, JSON-Speicher, Resend-Mail (Kunde + Salon + 24h-Erinnerung + Storno)
 */

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID, timingSafeEqual } = require("crypto");
const {
  sendAppointmentEmails,
  sendCancellationEmail,
  sendAdminCancellationEmail,
  sendConfirmationEmail,
  sendDeclineEmail,
  sendDailyDigestEmail,
  isEmailConfigured,
  SALON,
} = require("./services/emailService");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const CLOSED_DAYS_FILE = path.join(DATA_DIR, "closed-days.json");

// Wie weit in die Zukunft Buchungen erlaubt sind. 90 Tage decken
// realistische Vorausplanung ab, blockieren aber "Buche mich am
// 31.12.2030"-Spass.
const MAX_BOOKING_HORIZON_DAYS = 90;

// Salon-Oeffnungszeiten pro Wochentag (0=So .. 6=Sa). Wenn der Wochentag
// nicht im Objekt steht -> Salon zu. Wenn ja, muss die gewuenschte
// Uhrzeit im [openMinutes, closeMinutes)-Fenster liegen. Werte sind
// Minuten seit Mitternacht.
const SALON_HOURS = {
  // Mo (1) = zu -- klassischer Friseur-Ruhetag
  2: { open: 9 * 60, close: 18 * 60 }, // Di
  3: { open: 9 * 60, close: 18 * 60 }, // Mi
  4: { open: 9 * 60, close: 18 * 60 }, // Do
  5: { open: 9 * 60, close: 18 * 60 }, // Fr
  6: { open: 8 * 60, close: 14 * 60 }, // Sa
  // So (0) = zu (gesetzlich, plus Tradition)
};
// Name der Netlify-Site (Produktions-Slug). Wenn die Site umbenannt wird,
// hier aendern -- dann passen Produktion UND alle Deploy-Previews automatisch.
const NETLIFY_SITE = "friseursalon-henkes-website";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  `https://${NETLIFY_SITE}.netlify.app`,
];

// Pattern fuer Netlify-Deploy-Previews und Branch-Deploys, z.B.
//   https://deploy-preview-8--friseursalon-henkes-website.netlify.app
//   https://branchname--friseursalon-henkes-website.netlify.app
// Damit kann jeder PR vor Merge auf einer Live-URL gegen das echte Backend
// getestet werden. Der $-Anchor verhindert Spoofing wie
// "...netlify.app.attacker.com". Site-Name hat keine Regex-Sonderzeichen
// (nur a-z, Bindestrich), darum keine Escape-Logik noetig.
const NETLIFY_PREVIEW_REGEX = new RegExp(
  `^https://[a-z0-9-]+--${NETLIFY_SITE}\\.netlify\\.app$`
);

function isAllowedOrigin(origin, exactSet) {
  if (!origin) return false;
  if (exactSet.has(origin)) return true;
  if (NETLIFY_PREVIEW_REGEX.test(origin)) return true;
  return false;
}

// Die maßgebliche Liste der Leistungen. Wird via GET /api/services auch ans
// Frontend ausgeliefert, damit das Auswahlfeld nicht out-of-sync laeuft.
// Wenn der Salon eine neue Leistung anbietet -> hier ergaenzen, fertig.
// (Die Preise in index.html#preise sind statisch und muessen separat
// gepflegt werden, das ist ein anderer Use-Case.)
const ALLOWED_SERVICES = [
  "Haarschnitt",
  "Färbung",
  "Strähnen",
  "Styling",
  "Haarpflege",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
// Telefonnummern: nur sinnvolle Zeichen erlaubt. Buchstaben verraten Spam-Bots,
// die wirres Zeug einfuellen. Ziffern muessen mind. 6 sein -- weniger ist
// realistisch keine echte Nummer.
const PHONE_ALLOWED_CHARS = /^[\d\s+\-/()]+$/;
const MAX_NOTES_LENGTH = 500;

// Wir akzeptieren nur Slots im 15-Minuten-Raster (HH:00, HH:15, HH:30, HH:45).
// Krumme Zeiten wie 14:37 deuten auf Tipper oder Bot.
const ALLOWED_MINUTES = new Set(["00", "15", "30", "45"]);

/**
 * Liest die Schliesstage-Liste (Feiertage, Betriebsferien) aus
 * data/closed-days.json. Datei fehlt oder ungueltig? -> leer.
 * Wird einmal pro Validierung gelesen -- klein genug fuer JSON.
 */
async function readClosedDays() {
  try {
    const raw = await fs.readFile(CLOSED_DAYS_FILE, "utf8");
    const data = JSON.parse(raw);
    return new Set(Array.isArray(data.days) ? data.days : []);
  } catch (_err) {
    return new Set();
  }
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

app.use(express.static(ROOT));

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

async function validateAppointment(payload) {
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

  if (!phone) {
    errors.push("Bitte geben Sie Ihre Telefonnummer ein.");
  } else if (!PHONE_ALLOWED_CHARS.test(phone)) {
    errors.push("Telefonnummer darf nur Ziffern und Trennzeichen enthalten.");
  } else if (phone.replace(/\D/g, "").length < 6) {
    errors.push("Bitte geben Sie eine vollständige Telefonnummer ein.");
  }

  if (!email) {
    errors.push("Bitte geben Sie Ihre E-Mail-Adresse ein.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("Bitte geben Sie eine gültige E-Mail-Adresse ein.");
  }

  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(date);
  let dateIsValid = false;
  let parsedDate = null;
  let weekdayHours = null;
  if (!dateMatch) {
    errors.push("Bitte wählen Sie ein gültiges Datum.");
  } else {
    parsedDate = new Date(`${date}T12:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      errors.push("Das gewählte Datum ist ungültig.");
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const maxDate = new Date(today.getTime() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000);

      if (parsedDate < today) {
        errors.push("Das Datum darf nicht in der Vergangenheit liegen.");
      } else if (parsedDate > maxDate) {
        errors.push(
          `Termine können maximal ${MAX_BOOKING_HORIZON_DAYS} Tage im Voraus gebucht werden. Bei späteren Wünschen bitte kurz anrufen.`
        );
      } else {
        weekdayHours = SALON_HOURS[parsedDate.getDay()];
        if (!weekdayHours) {
          errors.push(
            "An diesem Wochentag ist der Salon geschlossen. Bitte wählen Sie Di–Sa."
          );
        } else {
          // Pruefe Schliesstage (Feiertage, Betriebsferien)
          const closedDays = await readClosedDays();
          if (closedDays.has(date)) {
            errors.push(
              "An diesem Tag ist der Salon geschlossen (Feiertag oder Betriebsferien). Bitte wählen Sie einen anderen Tag."
            );
          } else {
            dateIsValid = true;
          }
        }
      }
    }
  }

  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!timeMatch) {
    errors.push("Bitte wählen Sie eine gültige Uhrzeit.");
  } else {
    const [, hh, mm] = timeMatch;
    if (!ALLOWED_MINUTES.has(mm)) {
      errors.push("Bitte wählen Sie eine Uhrzeit im 15-Minuten-Raster (z.B. 10:00, 10:15).");
    }

    // Pro Wochentag andere Oeffnungszeiten (Samstag schliesst um 14:00).
    if (dateIsValid && weekdayHours) {
      const requestedMinutes = Number(hh) * 60 + Number(mm);
      if (requestedMinutes < weekdayHours.open || requestedMinutes >= weekdayHours.close) {
        const fmt = (mins) =>
          `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
        errors.push(
          `An diesem Tag haben wir von ${fmt(weekdayHours.open)} bis ${fmt(weekdayHours.close)} Uhr geöffnet. Bitte wählen Sie eine Uhrzeit in diesem Fenster.`
        );
      }
    }

    // Wenn der gewuenschte Termin heute ist, darf die Uhrzeit nicht in der
    // Vergangenheit liegen (mind. 60 Min Vorlauf, damit der Salon reagieren kann).
    if (dateIsValid && parsedDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const requestedDay = new Date(parsedDate);
      requestedDay.setHours(0, 0, 0, 0);
      if (requestedDay.getTime() === today.getTime()) {
        const requestedTime = new Date(`${date}T${hh}:${mm}:00`);
        const minimumLead = new Date(Date.now() + 60 * 60 * 1000);
        if (requestedTime < minimumLead) {
          errors.push(
            "Für heute brauchen wir mindestens 60 Minuten Vorlauf. Bitte wählen Sie eine spätere Uhrzeit oder rufen Sie kurz an."
          );
        }
      }
    }
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

/* ---------------- Admin-Auth (HTTP Basic) ---------------- */

/**
 * Konstantzeit-Vergleich zweier Strings. Bei unterschiedlicher Laenge wird
 * trotzdem ein Dummy-Vergleich gegen einen gleichlangen Nullbuffer ausgefuehrt,
 * damit kein Timing-Leak ueber die Laenge entsteht.
 */
function safeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""), "utf8");
  const bBuf = Buffer.from(String(b ?? ""), "utf8");
  if (aBuf.length !== bBuf.length) {
    // Dummy-Vergleich gleicher Laenge, Ergebnis verwerfen.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function sendAuthChallenge(res, status, message) {
  res.setHeader("WWW-Authenticate", 'Basic realm="Friseursalon Henkes Admin", charset="UTF-8"');
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

/**
 * Express-Middleware: schuetzt Admin-Routen per HTTP Basic Auth.
 * Erwartet ADMIN_USER und ADMIN_PASSWORD in den Umgebungsvariablen.
 * Wenn die Vars fehlen, antwortet die Route mit 503 -- der Admin-Bereich
 * ist dann komplett gesperrt, statt versehentlich offen zu sein.
 */
function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER?.trim();
  const expectedPass = process.env.ADMIN_PASSWORD?.trim();

  if (!expectedUser || !expectedPass) {
    return res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send(
        "Admin-Login ist nicht konfiguriert. Bitte ADMIN_USER und ADMIN_PASSWORD in den Render-Env-Vars setzen."
      );
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    return sendAuthChallenge(res, 401, "Anmeldung erforderlich.");
  }

  let user = "";
  let pass = "";
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) {
      user = decoded.slice(0, colon);
      pass = decoded.slice(colon + 1);
    }
  } catch (_err) {
    return sendAuthChallenge(res, 401, "Ungueltige Anmeldedaten.");
  }

  const userOk = safeStringEqual(user, expectedUser);
  const passOk = safeStringEqual(pass, expectedPass);

  if (!userOk || !passOk) {
    return sendAuthChallenge(res, 401, "Falsche Anmeldedaten.");
  }

  return next();
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
      console.warn(`[Honeypot] Bot-Submit ignoriert (website='${honeypot.slice(0, 40)}')`);
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
    // time, service) innerhalb von 60s als Duplikat und liefern den
    // bestehenden Eintrag zurueck, statt einen neuen anzulegen.
    const DEDUPE_WINDOW_MS = 60 * 1000;
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
 * Hilfsfunktion: liest Termine und gibt das passende Element +
 * Index zurueck. Setzt selbst keine HTTP-Antworten.
 */
async function findAppointmentById(id) {
  const appointments = await readAppointments();
  const index = appointments.findIndex((item) => item.id === id);
  if (index === -1) return { appointments, appointment: null, index: -1 };
  return { appointments, appointment: appointments[index], index };
}

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

      const appointments = await readAppointments();
      const index = appointments.findIndex((item) => item.id === id);

      if (index === -1) {
        return res.status(404).json({ success: false, message: "Termin nicht gefunden." });
      }

      const removed = appointments.splice(index, 1)[0];
      await writeAppointments(appointments);

      console.log(
        `[Admin-Loeschen] ${removed.name} – ${removed.date} ${removed.time} (id ${removed.id})`
      );

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
app.get("/storno/:token", cancelLimiter, async (req, res) => {
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
app.post("/storno/:token", cancelLimiter, async (req, res) => {
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
