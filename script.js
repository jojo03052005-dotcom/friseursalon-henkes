const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const revealElements = document.querySelectorAll(".reveal");
const bookingForm = document.querySelector("[data-booking-form]");
const formMessage = document.querySelector("[data-form-message]");
const submitBtn = document.querySelector("[data-submit-btn]");

const API_BASE = window.HENKES_API_BASE || window.location.origin;

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
  };

  showFormFeedback("loading", "Ihre Anfrage wird gesendet …");
  bookingForm.classList.add("is-submitting");
  submitBtn.disabled = true;

  // Render-Free-Tier schlaeft nach 15 Min ohne Traffic. Beim ersten Klick
  // dauert das Aufwecken 30-60 Sekunden, in denen das Formular einfach
  // "lädt" -- Kunde denkt's haengt. Nach 5s zeigen wir einen Hinweis, nach
  // 15s einen noch ausfuehrlicheren, damit klar ist: nicht kaputt, nur lahm.
  const slowHintTimer = setTimeout(() => {
    showFormFeedback(
      "loading",
      "Ihre Anfrage wird gesendet … (der Server wacht gerade auf, das dauert kurz)"
    );
  }, 5000);
  const verySlowHintTimer = setTimeout(() => {
    showFormFeedback(
      "loading",
      "Server startet noch … bitte gleich nicht doppelt klicken, das kann bis zu einer Minute dauern."
    );
  }, 15000);

  try {
    const response = await fetch(`${API_BASE}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    clearTimeout(slowHintTimer);
    clearTimeout(verySlowHintTimer);

    const result = await readJsonResponse(response);

    if (!response.ok || !result.success) {
      throw new Error(result.message || "Die Buchung konnte nicht gespeichert werden.");
    }

    showFormFeedback(
      "success",
      result.message ||
        "Ihre Terminanfrage wurde erfolgreich gesendet. Sie erhalten in Kürze eine Bestätigungs-E-Mail."
    );

    bookingForm.reset();
    setMinBookingDate();
  } catch (error) {
    const isNetwork =
      error.message === "Failed to fetch" ||
      error.name === "TypeError";

    showFormFeedback(
      "error",
      isNetwork
        ? "Verbindung zum Server fehlgeschlagen. Bitte einen Moment warten und es nochmal versuchen – oder kurz anrufen: 0209 41793."
        : error.message
    );
  } finally {
    clearTimeout(slowHintTimer);
    clearTimeout(verySlowHintTimer);
    bookingForm.classList.remove("is-submitting");
    submitBtn.disabled = false;
    isSubmitting = false;
  }
});
