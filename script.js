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
async function submitBooking(payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  let lastError = null;
  let success = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await submitBooking(payload, PER_ATTEMPT_TIMEOUT_MS);
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
