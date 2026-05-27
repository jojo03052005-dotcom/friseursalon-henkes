/**
 * Validation fuer Terminanfragen.
 *
 * Pure async function: nimmt das rohe Request-Body, gibt entweder
 *   { ok: true, data: <gereinigtes-payload> }
 * oder
 *   { ok: false, errors: [<msg>, ...] }
 * zurueck. Erste Fehlermeldung ist die, die das Frontend dem Kunden zeigt.
 *
 * Die Schliesstage-Liste wird ueber readClosedDays() injiziert,
 * damit Tests ohne Filesystem laufen koennen. Default: aus lib/storage.
 *
 * Bewusst KEINE externen Side-Effects: kein Logging, kein Disk-Write,
 * keine Mails. Nur reine Validierung. Macht's testbar und vorhersagbar.
 */

const {
  ALLOWED_SERVICES,
  ALLOWED_MINUTES,
  SALON_HOURS,
  MAX_BOOKING_HORIZON_DAYS,
  MAX_NOTES_LENGTH,
  EMAIL_REGEX,
  PHONE_ALLOWED_CHARS,
  PHONE_MIN_DIGITS,
  SAME_DAY_LEAD_TIME_MS,
} = require("./config");

const { readClosedDays: defaultReadClosedDays } = require("./storage");

function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Normalisiert ein optionales Notizfeld: trimmt, normalisiert Newlines,
 * begrenzt auf MAX_NOTES_LENGTH. Bewusst niemals Markdown/HTML.
 */
function normalizeNotes(raw) {
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
}

/**
 * Defensive per-field max-Laengen. Der 32kb Body-Parser-Limit greift
 * fuer Gesamt-Payloads; das hier verhindert dass ein einzelnes Feld
 * mit 30kb Junk durch die App reicht und z.B. das CSV-Export-DOM oder
 * eine Mail mit absurder Headerzeile aufblaeht. Werte grosszuegig
 * geschaetzt -- echter Name >80 Zeichen ist unrealistisch.
 */
const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 40;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 SMTP-Praxis-Limit

async function validateAppointment(payload, options = {}) {
  const readClosedDays = options.readClosedDays || defaultReadClosedDays;
  const now = options.now || new Date();

  const errors = [];
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const phone = typeof payload?.phone === "string" ? payload.phone.trim() : "";
  const email = typeof payload?.email === "string" ? payload.email.trim() : "";
  const date = typeof payload?.date === "string" ? payload.date.trim() : "";
  const time = typeof payload?.time === "string" ? payload.time.trim() : "";
  const service = typeof payload?.service === "string" ? payload.service.trim() : "";
  const notes = normalizeNotes(payload?.notes);

  /* ----- Name ----- */
  if (!name || name.length < 2) {
    errors.push("Bitte geben Sie einen gültigen Namen ein.");
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push("Der Name ist zu lang.");
  }

  /* ----- Telefon ----- */
  if (!phone) {
    errors.push("Bitte geben Sie Ihre Telefonnummer ein.");
  } else if (phone.length > MAX_PHONE_LENGTH) {
    errors.push("Die Telefonnummer ist zu lang.");
  } else if (!PHONE_ALLOWED_CHARS.test(phone)) {
    errors.push("Telefonnummer darf nur Ziffern und Trennzeichen enthalten.");
  } else if (phone.replace(/\D/g, "").length < PHONE_MIN_DIGITS) {
    errors.push("Bitte geben Sie eine vollständige Telefonnummer ein.");
  }

  /* ----- E-Mail ----- */
  if (!email) {
    errors.push("Bitte geben Sie Ihre E-Mail-Adresse ein.");
  } else if (email.length > MAX_EMAIL_LENGTH) {
    errors.push("Die E-Mail-Adresse ist zu lang.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("Bitte geben Sie eine gültige E-Mail-Adresse ein.");
  }

  /* ----- Datum ----- */
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
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      // maxDate auf Tagesende -- sonst wird der 90. Tag selbst abgelehnt,
      // weil parsedDate auf 12:00 steht und maxDate auf 00:00 (off-by-12h).
      // Ausserdem immun gegen Sommerzeit-Wechsel im Horizon-Fenster.
      const maxDate = new Date(today.getTime() + MAX_BOOKING_HORIZON_DAYS * 86400 * 1000);
      maxDate.setHours(23, 59, 59, 999);

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

  /* ----- Uhrzeit ----- */
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!timeMatch) {
    errors.push("Bitte wählen Sie eine gültige Uhrzeit.");
  } else {
    const [, hh, mm] = timeMatch;
    if (!ALLOWED_MINUTES.has(mm)) {
      errors.push("Bitte wählen Sie eine Uhrzeit im 15-Minuten-Raster (z.B. 10:00, 10:15).");
    }

    if (dateIsValid && weekdayHours) {
      const requestedMinutes = Number(hh) * 60 + Number(mm);
      if (requestedMinutes < weekdayHours.open || requestedMinutes >= weekdayHours.close) {
        errors.push(
          `An diesem Tag haben wir von ${formatMinutes(weekdayHours.open)} bis ${formatMinutes(weekdayHours.close)} Uhr geöffnet. Bitte wählen Sie eine Uhrzeit in diesem Fenster.`
        );
      }
    }

    if (dateIsValid && parsedDate) {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      const requestedDay = new Date(parsedDate);
      requestedDay.setHours(0, 0, 0, 0);
      if (requestedDay.getTime() === today.getTime()) {
        const requestedTime = new Date(`${date}T${hh}:${mm}:00`);
        const minimumLead = new Date(now.getTime() + SAME_DAY_LEAD_TIME_MS);
        if (requestedTime < minimumLead) {
          errors.push(
            "Für heute brauchen wir mindestens 60 Minuten Vorlauf. Bitte wählen Sie eine spätere Uhrzeit oder rufen Sie kurz an."
          );
        }
      }
    }
  }

  /* ----- Leistung ----- */
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

module.exports = {
  validateAppointment,
  normalizeNotes,
  formatMinutes,
};
