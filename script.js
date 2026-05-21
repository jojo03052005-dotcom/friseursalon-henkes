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
 */
bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

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

  try {
    const response = await fetch(`${API_BASE}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

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
        ? "Server nicht erreichbar. Bitte starten Sie den Server mit „npm start“ und laden Sie die Seite neu."
        : error.message
    );
  } finally {
    bookingForm.classList.remove("is-submitting");
    submitBtn.disabled = false;
  }
});
