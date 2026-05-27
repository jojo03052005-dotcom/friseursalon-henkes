const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const revealElements = document.querySelectorAll(".reveal");
const bookingForm = document.querySelector("[data-booking-form]");
const formMessage = document.querySelector("[data-form-message]");
const submitBtn = document.querySelector("[data-submit-btn]");

const API_BASE = window.HENKES_API_BASE || window.location.origin;

/**
 * Render-Free-Tier schlaeft nach 15 Min ohne Traffic. Beim ersten Klick
 * auf "Anfrage senden" wuerde der Kunde sonst 30-60 Sek warten.
 *
 * Strategie:
 *   1. 800ms nach Page-Load: Pre-Warm-Ping auf /api/health (best-effort)
 *   2. Wenn der erste Ping fehlschlaegt: nach 3s nochmal, dann nach 8s
 *      (in dieser Zeit wacht Render auf -- typisch 30-60s, aber sobald
 *      EIN Ping durchgekommen ist, ist der Server bis zur naechsten
 *      15-Min-Idle-Phase wach).
 *
 * Wir geben nach 3 Versuchen auf. Das spaetere Submit-Handling hat
 * seine eigene Retry-Logik fuer den Kunden-Fall.
 */
function preWarmBackend(attempt = 0) {
  const maxAttempts = 3;
  const delays = [800, 3000, 8000]; // ms

  window.setTimeout(() => {
    fetch(`${API_BASE}/api/health`, {
      method: "GET",
      cache: "no-store",
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok && attempt + 1 < maxAttempts) {
          preWarmBackend(attempt + 1);
        }
        // Bei OK: nichts tun. Bei letztem Versuch + nicht-ok: still
        // resignieren, Submit-Handler uebernimmt.
      })
      .catch(() => {
        if (attempt + 1 < maxAttempts) {
          preWarmBackend(attempt + 1);
        }
        // Bewusst still: Submit-Handler zeigt eh den Cold-Start-Hint.
      });
  }, delays[attempt] || 8000);
}

preWarmBackend();

const updateHeader = () => {
  header.classList.toggle("is-scrolled", window.scrollY > 24);
};

window.addEventListener("scroll", updateHeader);
updateHeader();

navToggle.addEventListener("click", () => {
  const isOpen = nav.classList.toggle("is-open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
  navToggle.setAttribute("aria-label", isOpen ? "Navigation schließen" : "Navigation öffnen");
});

nav.addEventListener("click", (event) => {
  if (event.target.matches("a")) {
    nav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Navigation öffnen");
  }
});

// A11y: ESC schliesst die mobile Nav. Tastatur-Nutzer und Screen-Reader
// erwarten das. Triggert nur wenn Nav offen ist, sonst stoeren wir nicht.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav.classList.contains("is-open")) {
    nav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Navigation öffnen");
    navToggle.focus();
  }
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.16 }
);

revealElements.forEach((element) => revealObserver.observe(element));

/** Mindestdatum für Datumsfeld: heute */
const setMinBookingDate = () => {
  const dateInput = bookingForm?.querySelector('input[name="date"]');
  if (!dateInput) return;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  dateInput.min = `${yyyy}-${mm}-${dd}`;
};

setMinBookingDate();

/**
 * Speichert das halb-ausgefuellte Formular in localStorage und stellt
 * es beim naechsten Besuch wieder her. Schuetzt Kunden mit wackeliger
 * Verbindung -- wenn der Submit fehlschlaegt und sie die Seite neu
 * laden, sind ihre Eingaben noch da.
 *
 * Wird bei erfolgreicher Buchung wieder geleert.
 *
 * Keine PII-Bedenken: Daten liegen NUR im Browser des Kunden selbst,
 * werden nirgendwo hingesendet.
 */
const FORM_STORAGE_KEY = "henkes-booking-draft-v1";
const FORM_STORAGE_FIELDS = ["name", "phone", "email", "date", "time", "service", "notes"];

function saveFormDraft() {
  if (!bookingForm) return;
  try {
    const draft = {};
    for (const field of FORM_STORAGE_FIELDS) {
      const el = bookingForm.elements[field];
      if (el && el.value) draft[field] = el.value;
    }
    if (Object.keys(draft).length === 0) {
      window.localStorage.removeItem(FORM_STORAGE_KEY);
      return;
    }
    draft._savedAt = new Date().toISOString();
    window.localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(draft));
  } catch (_err) {
    // localStorage voll oder disabled -> still ignorieren
  }
}

function restoreFormDraft() {
  if (!bookingForm) return;
  try {
    const raw = window.localStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    // Drafts aelter als 7 Tage verwerfen (uralte Wunschtermine
    // koennten in der Vergangenheit liegen).
    if (draft._savedAt) {
      const ageMs = Date.now() - new Date(draft._savedAt).getTime();
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        window.localStorage.removeItem(FORM_STORAGE_KEY);
        return;
      }
    }
    for (const field of FORM_STORAGE_FIELDS) {
      const el = bookingForm.elements[field];
      if (el && draft[field]) el.value = draft[field];
    }
  } catch (_err) {
    // ignore
  }
}

function clearFormDraft() {
  try {
    window.localStorage.removeItem(FORM_STORAGE_KEY);
  } catch (_err) {
    // ignore
  }
}

/**
 * Berechnet live den aktuellen Oeffnungs-Status anhand der Salon-
 * Stunden. Default-Werte spiegeln lib/config.js -- werden aber, sobald
 * /api/salon antwortet, durch die Server-Werte ueberschrieben (siehe
 * `applySalonInfo`). Dadurch reichen Config-Aenderungen am Server,
 * ohne dass das Frontend nachgepflegt werden muss.
 *
 * Bewusst lokale Zeit (Salon ist in DE, Kunde auch -- wer aus dem
 * Ausland bucht, dem ist die exakte "jetzt offen"-Anzeige egal).
 */
let SALON_HOURS = {
  // 0=So, 1=Mo => zu
  2: { open: 9 * 60, close: 18 * 60, label: "Di" },
  3: { open: 9 * 60, close: 18 * 60, label: "Mi" },
  4: { open: 9 * 60, close: 18 * 60, label: "Do" },
  5: { open: 9 * 60, close: 18 * 60, label: "Fr" },
  6: { open: 8 * 60, close: 14 * 60, label: "Sa" },
};
const WEEKDAY_NAMES = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// Wird vom Server gesetzt (s. fetchSalonInfo). Default: leere Liste --
// dann faellt die Service-Hint-Logik still in den No-Op.
let SERVICE_DURATIONS = {};

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  return `${h}:${String(mins % 60).padStart(2, "0")}`;
}

function computeOpeningStatus(now = new Date()) {
  const dow = now.getDay();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const today = SALON_HOURS[dow];

  if (today && nowMins >= today.open && nowMins < today.close) {
    return {
      open: true,
      label: "Jetzt geöffnet",
      detail: `Schließt um ${formatTime(today.close)} Uhr`,
    };
  }
  if (today && nowMins < today.open) {
    return {
      open: false,
      label: "Heute geschlossen",
      detail: `Öffnet um ${formatTime(today.open)} Uhr`,
    };
  }
  // Heute schon zu oder Salon hat heute ganz zu. Naechsten Oeffnungstag suchen.
  for (let offset = 1; offset <= 7; offset++) {
    const nextDow = (dow + offset) % 7;
    const nextHours = SALON_HOURS[nextDow];
    if (nextHours) {
      const dayLabel = offset === 1 ? "morgen" : WEEKDAY_NAMES[nextDow];
      return {
        open: false,
        label: "Heute geschlossen",
        detail: `Öffnet ${dayLabel} um ${formatTime(nextHours.open)} Uhr`,
      };
    }
  }
  return { open: false, label: "Geschlossen", detail: "" };
}

function renderOpeningStatus() {
  const status = computeOpeningStatus();
  const widget = document.querySelector("[data-opening-status]");
  if (widget) {
    const strong = widget.querySelector("strong");
    const span = widget.querySelector("span");
    if (strong) strong.textContent = status.label;
    if (span) span.textContent = status.detail || "Di–Fr 9–18 · Sa 8–14";
    widget.classList.toggle("is-open", status.open);
    widget.classList.toggle("is-closed", !status.open);
  }
  const contact = document.querySelector("[data-contact-status]");
  if (contact) {
    contact.textContent = status.open
      ? `Jetzt geöffnet · ${status.detail}`
      : status.detail;
  }
}

renderOpeningStatus();

/**
 * Holt Salon-Stunden + Service-Dauer vom Server (additive Quelle-of-truth).
 * Bei Fehler bleiben die Default-Werte stehen -- alles funktioniert weiter,
 * nur ohne Live-Sync mit salon.config.json.
 */
async function fetchSalonInfo() {
  try {
    const response = await fetch(`${API_BASE}/api/salon`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.success) return;

    // Hours uebernehmen (Server liefert "HH:MM"-Strings).
    if (data.hours && typeof data.hours === "object") {
      const next = {};
      for (const [day, slot] of Object.entries(data.hours)) {
        const open = parseHHMM(slot.open);
        const close = parseHHMM(slot.close);
        if (open !== null && close !== null && close > open) {
          next[Number(day)] = { open, close, label: WEEKDAY_NAMES[Number(day)]?.slice(0, 2) || "" };
        }
      }
      if (Object.keys(next).length > 0) {
        SALON_HOURS = next;
        renderOpeningStatus();
        updateDateHint();
      }
    }

    // Service-Dauern uebernehmen (fuer "ca. 45 Min"-Hint bei Auswahl).
    if (Array.isArray(data.services)) {
      const map = {};
      for (const s of data.services) {
        if (s.name && Number(s.durationMinutes) > 0) {
          map[s.name] = Number(s.durationMinutes);
        }
      }
      SERVICE_DURATIONS = map;
      updateServiceHint();
    }
  } catch (_err) {
    // Bewusst still: Defaults sind brauchbar, Buchung funktioniert weiter.
  }
}

function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Live-Hint unter dem Datums-Feld: zeigt, ob der Salon am gewaehlten
 * Wochentag offen ist (und wenn ja, wann). Spart einen Submit-Fehler-
 * Roundtrip wenn der Kunde versehentlich Sonntag/Montag waehlt.
 */
const dateInput = bookingForm?.querySelector('input[name="date"]');
const timeInput = bookingForm?.querySelector('input[name="time"]');
const serviceSelect = bookingForm?.querySelector('select[name="service"]');
const dateHintEl = bookingForm?.querySelector("[data-date-hint]");
const timeHintEl = bookingForm?.querySelector("[data-time-hint]");

function updateDateHint() {
  if (!dateInput || !dateHintEl) return;
  const value = dateInput.value;
  if (!value) {
    dateHintEl.textContent = "";
    dateHintEl.classList.remove("is-ok", "is-warn");
    return;
  }
  // YYYY-MM-DD -> Wochentag in Lokal-Zeit (T12:00 vermeidet TZ-Edge)
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    dateHintEl.textContent = "";
    dateHintEl.classList.remove("is-ok", "is-warn");
    return;
  }
  const dow = d.getDay();
  const slot = SALON_HOURS[dow];
  const dayName = WEEKDAY_NAMES[dow];
  if (!slot) {
    dateHintEl.textContent = `${dayName} ist Ruhetag – bitte Di–Sa wählen.`;
    dateHintEl.classList.remove("is-ok");
    dateHintEl.classList.add("is-warn");
    // Time-Hint zuruecksetzen, da Tag eh ungueltig.
    if (timeHintEl) {
      timeHintEl.textContent = "";
      timeHintEl.classList.remove("is-ok", "is-warn");
    }
    return;
  }
  dateHintEl.textContent = `${dayName}: ${formatTime(slot.open)}–${formatTime(slot.close)} Uhr geöffnet.`;
  dateHintEl.classList.remove("is-warn");
  dateHintEl.classList.add("is-ok");
  // Time-Input min/max dynamisch auf die Salon-Stunden setzen, damit
  // der Browser-Picker nicht 03:00 vorschlaegt.
  if (timeInput) {
    timeInput.min = formatTime(slot.open);
    timeInput.max = formatTime(slot.close);
  }
  updateTimeHint();
}

/**
 * Time-Hint: prueft live ob die gewaehlte Uhrzeit ins Salon-Fenster
 * passt. Faengt z.B. ein versehentliches "17:30 Färbung" am Samstag
 * (Salon schliesst 14:00) ab.
 */
function updateTimeHint() {
  if (!timeInput || !timeHintEl) return;
  if (!dateInput?.value || !timeInput.value) {
    timeHintEl.textContent = "";
    timeHintEl.classList.remove("is-ok", "is-warn");
    return;
  }
  const d = new Date(`${dateInput.value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return;
  const slot = SALON_HOURS[d.getDay()];
  if (!slot) return; // Date-Hint zeigt eh schon Warnung
  const tMins = parseHHMM(timeInput.value);
  if (tMins === null) return;
  if (tMins < slot.open || tMins >= slot.close) {
    timeHintEl.textContent = `Außerhalb der Öffnungszeiten (${formatTime(slot.open)}–${formatTime(slot.close)}).`;
    timeHintEl.classList.remove("is-ok");
    timeHintEl.classList.add("is-warn");
  } else {
    timeHintEl.textContent = "";
    timeHintEl.classList.remove("is-ok", "is-warn");
  }
}

/**
 * Service-Hint: nach Service-Auswahl zeigen wir die Dauer ("ca. 90 Min")
 * unter dem Time-Hint -- hilft Kunden bei Slot-Wahl.
 */
function updateServiceHint() {
  if (!serviceSelect || !timeHintEl) return;
  const service = serviceSelect.value;
  // Nur anzeigen wenn Date+Time noch keine Warnung erzeugen.
  if (timeHintEl.classList.contains("is-warn")) return;
  if (!service || !SERVICE_DURATIONS[service]) {
    if (!timeHintEl.classList.contains("is-warn")) {
      timeHintEl.textContent = "";
      timeHintEl.classList.remove("is-ok");
    }
    return;
  }
  timeHintEl.textContent = `Geplante Dauer: ca. ${SERVICE_DURATIONS[service]} Min.`;
  timeHintEl.classList.remove("is-warn");
  timeHintEl.classList.add("is-ok");
}

if (dateInput) {
  dateInput.addEventListener("change", updateDateHint);
  dateInput.addEventListener("input", updateDateHint);
}
if (timeInput) {
  timeInput.addEventListener("change", updateTimeHint);
  timeInput.addEventListener("input", updateTimeHint);
}
if (serviceSelect) {
  serviceSelect.addEventListener("change", updateServiceHint);
}

fetchSalonInfo();

// Sticky Mobile-CTA erst einblenden wenn der Kunde gescrollt hat
// (sofort sichtbar bei Page-Load waere aufdringlich). Versteckt sich
// wieder, wenn der Buchungs-Bereich sichtbar ist (dort gibt's eh den
// Submit-Button).
const mobileCta = document.querySelector("[data-mobile-cta]");
const bookingSection = document.querySelector("#termin");
if (mobileCta && bookingSection && "IntersectionObserver" in window) {
  let scrolled = false;
  window.addEventListener("scroll", () => {
    if (!scrolled && window.scrollY > 600) {
      scrolled = true;
      mobileCta.classList.add("is-visible");
    }
  }, { passive: true });

  // Wenn der Termin-Bereich im Viewport ist -> CTA verstecken.
  const bookingObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      mobileCta.classList.toggle("is-visible", !entry.isIntersecting && scrolled);
    });
  }, { threshold: 0.1 });
  bookingObserver.observe(bookingSection);
}
// Status alle 60s aktualisieren -- relevant fuer Kunden, die die Seite
// lange offen lassen und ueber die Schliessungszeit hinwegrutschen.
setInterval(renderOpeningStatus, 60 * 1000);

restoreFormDraft();
if (bookingForm) {
  let saveTimer = null;
  bookingForm.addEventListener("input", () => {
    // Stale Error-/Success-Feedback ausblenden, sobald der Kunde
    // wieder tippt -- sonst steht der alte "E-Mail ist ungueltig"-
    // Hinweis noch da, waehrend man korrigiert.
    if (formMessage && (
      formMessage.classList.contains("is-error") ||
      formMessage.classList.contains("is-success")
    )) {
      formMessage.classList.remove("is-error", "is-success");
      formMessage.textContent = "";
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFormDraft, 500);
  });
}

/**
 * Holt die aktuelle Service-Liste vom Backend und ersetzt die Optionen im
 * <select>, falls sie sich geaendert haben. Schlaegt der Fetch fehl (z.B.
 * Render-Cold-Start), bleibt die statische Default-Liste aus dem HTML
 * stehen -- der Kunde kann ganz normal buchen.
 */
const syncServiceOptions = async () => {
  const select = bookingForm?.querySelector('select[name="service"]');
  if (!select) return;

  try {
    const response = await fetch(`${API_BASE}/api/services`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.success || !Array.isArray(data.services)) return;

    const current = Array.from(select.options)
      .filter((opt) => opt.value)
      .map((opt) => opt.value);

    if (
      current.length === data.services.length &&
      current.every((value, index) => value === data.services[index])
    ) {
      return;
    }

    const previous = select.value;
    const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const escapeText = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    select.innerHTML =
      '<option value="">Bitte auswählen</option>' +
      data.services
        .map((s) => `<option value="${escapeAttr(s)}">${escapeText(s)}</option>`)
        .join("");
    if (previous && data.services.includes(previous)) {
      select.value = previous;
    }
  } catch (_err) {
    // Bewusst still: Default-Optionen aus dem HTML bleiben funktionsfaehig.
  }
};

syncServiceOptions();

/**
 * Zeigt Feedback unter dem Formular (Erfolg, Fehler, Laden).
 */
const showFormFeedback = (type, text) => {
  formMessage.classList.remove("is-success", "is-error", "is-loading");
  formMessage.textContent = text;

  if (type) {
    formMessage.classList.add(`is-${type}`);
  }
};

const readJsonResponse = async (response) => {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    throw new Error(
      "Das Backend antwortet noch nicht korrekt. Bitte prüfen Sie die Backend-URL."
    );
  }

  return response.json();
};

/**
 * Sendet Terminanfrage an das Express-Backend.
 *
 * Guard `isSubmitting` verhindert zusaetzlich zum disabled-Button, dass
 * der Handler waehrend eines laufenden Requests erneut feuert (z.B. wenn
 * der Kunde Enter doppelt drueckt, bevor das Disable wirkt).
 */
let isSubmitting = false;

/**
 * Sendet das Buchungs-Payload mit AbortController-Timeout.
 * Bei Network-Fehler (kein Response) wird vom Aufrufer ein Retry
 * versucht -- haeufige Ursache ist Render-Cold-Start, der nach
 * 30-60s bereit ist.
 */
/**
 * Generiert einen Idempotency-Key. randomUUID gibt's in allen modernen
 * Browsern; Fallback fuer alte: Math.random-Hash. Ein Key wird PRO
 * Submit-Zyklus generiert -- nicht pro Versuch -- damit Retries
 * idempotent zur Server-Sicht sind.
 */
function makeIdempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return (
    "k-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 12)
  );
}

async function submitBooking(payload, timeoutMs, idempotencyKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/api/appointments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;

  const formData = new FormData(bookingForm);
  const payload = {
    name: formData.get("name")?.toString().trim() ?? "",
    phone: formData.get("phone")?.toString().trim() ?? "",
    email: formData.get("email")?.toString().trim() ?? "",
    date: formData.get("date")?.toString().trim() ?? "",
    time: formData.get("time")?.toString().trim() ?? "",
    service: formData.get("service")?.toString().trim() ?? "",
    notes: formData.get("notes")?.toString().trim() ?? "",
    // Honeypot
    website: formData.get("website")?.toString() ?? "",
  };

  showFormFeedback("loading", "Ihre Anfrage wird gesendet …");
  bookingForm.classList.add("is-submitting");
  submitBtn.disabled = true;

  // Render-Free-Tier-Cold-Start: 30-60s Wake-up. Wir zeigen progressive
  // Hinweise statt einem statischen "lädt"-Spinner.
  const slowHintTimer = setTimeout(() => {
    showFormFeedback(
      "loading",
      "Ihre Anfrage wird gesendet … (der Server wacht gerade auf, das dauert kurz)"
    );
  }, 5000);
  const verySlowHintTimer = setTimeout(() => {
    showFormFeedback(
      "loading",
      "Server startet noch … bitte nicht doppelt klicken, das kann bis zu einer Minute dauern."
    );
  }, 15000);

  // Retry-Strategie: max 2 Versuche, 90s Timeout pro Versuch (gibt
  // Render-Cold-Start genug Zeit), zwischen Versuchen 2s Pause.
  const MAX_ATTEMPTS = 2;
  const PER_ATTEMPT_TIMEOUT_MS = 90 * 1000;

  // Ein Key fuer den gesamten Submit-Zyklus -- der Server erkennt
  // damit Retry-Duplikate auch wenn die Payload sich minimal aendert.
  const idempotencyKey = makeIdempotencyKey();

  let lastError = null;
  let success = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await submitBooking(
        payload,
        PER_ATTEMPT_TIMEOUT_MS,
        idempotencyKey
      );
      clearTimeout(slowHintTimer);
      clearTimeout(verySlowHintTimer);

      const result = await readJsonResponse(response);

      if (!response.ok || !result.success) {
        // 4xx-Fehler (Validation, etc.) sollen NICHT geretryt werden --
        // ist ein Kunden-Fehler, kein Cold-Start-Problem.
        throw new Error(
          result.message || "Die Buchung konnte nicht gespeichert werden."
        );
      }

      showFormFeedback(
        "success",
        result.message ||
          "Ihre Terminanfrage wurde erfolgreich gesendet. Sie erhalten in Kürze eine Bestätigungs-E-Mail."
      );

      bookingForm.reset();
      setMinBookingDate();
      clearFormDraft();

      // Erfolgs-Message in den Viewport scrollen -- bei mobile wird
      // der Submit-Button nach dem Form-Reset eingeschoben und der Kunde
      // koennte den gruenen Hint sonst nicht direkt sehen. "smooth"
      // ist nicht aggressiv und respektiert prefers-reduced-motion via
      // den nativen Browser-Settings.
      if (formMessage?.scrollIntoView) {
        formMessage.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      success = true;
      break;
    } catch (error) {
      lastError = error;
      const isNetworkOrTimeout =
        error.name === "AbortError" ||
        error.name === "TypeError" ||
        error.message === "Failed to fetch";

      if (!isNetworkOrTimeout || attempt === MAX_ATTEMPTS) {
        // Validation-Fehler oder letzter Versuch: nicht mehr retryen.
        break;
      }

      // Cold-Start-Retry: kurzer Hinweis, 2s warten, dann nochmal.
      showFormFeedback(
        "loading",
        "Erster Versuch hat nicht geklappt – wir versuchen es nochmal …"
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  clearTimeout(slowHintTimer);
  clearTimeout(verySlowHintTimer);

  if (!success && lastError) {
    const isNetwork =
      lastError.name === "AbortError" ||
      lastError.name === "TypeError" ||
      lastError.message === "Failed to fetch";

    showFormFeedback(
      "error",
      isNetwork
        ? "Verbindung zum Server fehlgeschlagen. Bitte einen Moment warten und es nochmal versuchen – oder kurz anrufen: 0209 41793."
        : lastError.message
    );
  }

  bookingForm.classList.remove("is-submitting");
  submitBtn.disabled = false;
  isSubmitting = false;
});
