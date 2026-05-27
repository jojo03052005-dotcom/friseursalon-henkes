/**
 * Admin: laedt alle Termine vom Backend und zeigt sie in einer Tabelle.
 * Bestaetigen / Ablehnen geht ueber /api/admin/appointments/:id/...
 *
 * Die Seite wird hinter HTTP Basic Auth ausgeliefert; der Browser merkt
 * sich die Credentials fuer die Session und schickt sie automatisch bei
 * allen fetch()-Calls auf denselben Origin mit.
 */

const metaEl = document.querySelector("[data-admin-meta]");
const statsEl = document.querySelector("[data-admin-stats]");
const alertEl = document.querySelector("[data-admin-alert]");
const tbody = document.querySelector("[data-appointments-body]");
const refreshBtn = document.querySelector("[data-refresh]");
const filtersEl = document.querySelector("[data-admin-filters]");
const searchEl = document.querySelector("[data-admin-search]");

const API_BASE = window.HENKES_API_BASE || window.location.origin;
const COLSPAN = 10;

// Aktueller Filter-Zustand und die letzte vom Backend geladene Liste.
// `lastAppointments` wird bei jedem loadAppointments() neu gesetzt; die
// Filter-Klicks rendern darauf, ohne neu zu fetchen.
let currentFilter = "all";
let currentSearch = "";
let lastAppointments = [];

const matchesFilter = (item) => {
  const workflow = getWorkflowStatus(item);
  if (currentFilter === "all") return true;
  if (currentFilter === "pending") return workflow === "pending";
  if (currentFilter === "confirmed") return workflow === "confirmed";
  if (currentFilter === "done") return workflow === "declined" || workflow === "cancelled";
  return true;
};

const matchesSearch = (item) => {
  if (!currentSearch) return true;
  const q = currentSearch.toLowerCase();
  return (
    String(item.name || "").toLowerCase().includes(q) ||
    String(item.phone || "").toLowerCase().includes(q) ||
    String(item.email || "").toLowerCase().includes(q) ||
    String(item.service || "").toLowerCase().includes(q) ||
    String(item.notes || "").toLowerCase().includes(q) ||
    String(item.date || "").includes(q)
  );
};

const formatDate = (isoDate) => {
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const formatCreated = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatShort = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const showAlert = (message) => {
  if (!message) {
    alertEl.hidden = true;
    alertEl.textContent = "";
    return;
  }
  alertEl.hidden = false;
  alertEl.textContent = message;
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
 * Liefert den aktuellen Workflow-Status eines Termins.
 * Reihenfolge: cancelled > declined > confirmed > pending.
 */
const getWorkflowStatus = (item) => {
  if (item.cancelled) return "cancelled";
  if (item.declined) return "declined";
  if (item.confirmed) return "confirmed";
  return "pending";
};

const formatReminderInfo = (status) => {
  if (!status?.reminder) return "";
  if (status.reminder.scheduled && status.reminder.scheduledFor) {
    const when = new Date(status.reminder.scheduledFor);
    if (!Number.isNaN(when.getTime())) {
      const label = when.toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `<span class="status-reminder" title="24h-Erinnerung an den Kunden">⏰ Reminder ${label}</span>`;
    }
  }
  return "";
};

/**
 * Zeigt Workflow-Status (Ausstehend / Bestaetigt / Abgelehnt / Storniert)
 * plus E-Mail-Versandinfo (Eingangs-Mails) und ggf. Reminder-Badge.
 */
const renderStatusCell = (item) => {
  const workflow = getWorkflowStatus(item);

  if (workflow === "cancelled") {
    const title = item.cancelledAt
      ? `Vom Kunden storniert am ${formatShort(item.cancelledAt)}`
      : "Vom Kunden storniert";
    return `<span class="status-badge status-cancelled" title="${escapeHtml(title)}">Storniert</span>`;
  }

  if (workflow === "declined") {
    const title = item.declinedAt
      ? `Abgelehnt am ${formatShort(item.declinedAt)}`
      : "Abgelehnt";
    const mailErr = item.declineStatus?.customer?.error;
    const mailNote = mailErr
      ? `<span class="status-reminder" title="${escapeHtml(mailErr)}">⚠ Absage-Mail fehlgeschlagen</span>`
      : "";
    return `<span class="status-badge status-declined" title="${escapeHtml(title)}">Abgelehnt</span>${mailNote}`;
  }

  if (workflow === "confirmed") {
    const title = item.confirmedAt
      ? `Bestätigt am ${formatShort(item.confirmedAt)}`
      : "Bestätigt";
    const reminderHtml = formatReminderInfo(item.confirmationStatus);
    const mailErr = item.confirmationStatus?.customer?.error;
    const mailNote =
      item.confirmationStatus && !item.confirmationStatus.customer?.sent && mailErr
        ? `<span class="status-reminder" title="${escapeHtml(mailErr)}">⚠ Bestätigungs-Mail fehlgeschlagen</span>`
        : "";
    return `<span class="status-badge status-confirmed" title="${escapeHtml(title)}">Bestätigt</span>${reminderHtml}${mailNote}`;
  }

  // pending: zeige Eingangs-Mail-Status, damit Salon weiss ob die Anfrage
  // ueberhaupt sauber durchgekommen ist.
  const emailStatus = item.emailStatus;
  if (!emailStatus) {
    return '<span class="status-badge status-pending">Ausstehend</span>';
  }

  const customerOk = emailStatus.customer?.sent;
  const salonOk = emailStatus.salon?.sent;

  let mailInfo = "";
  if (!customerOk || !salonOk) {
    const parts = [];
    if (!customerOk) parts.push(`Kunde: ${emailStatus.customer?.error || "fehlgeschlagen"}`);
    if (!salonOk) parts.push(`Salon: ${emailStatus.salon?.error || "fehlgeschlagen"}`);
    mailInfo = `<span class="status-reminder" title="${escapeHtml(parts.join(" | "))}">⚠ Eingangs-Mail teilweise fehlgeschlagen</span>`;
  }

  return `<span class="status-badge status-pending" title="Wartet auf Bestätigung durch den Salon">Ausstehend</span>${mailInfo}`;
};

/**
 * Aktions-Buttons je nach Termin-Status:
 *   - pending   -> Bestaetigen / Ablehnen / Loeschen
 *   - confirmed -> Absagen (mit Mail) / Loeschen
 *   - declined  -> Loeschen
 *   - cancelled -> Loeschen
 */
const renderActionsCell = (item) => {
  const workflow = getWorkflowStatus(item);
  const id = escapeHtml(item.id);

  const buttons = [];
  if (workflow === "pending") {
    buttons.push(
      `<button type="button" class="admin-action-btn admin-action-confirm" data-action="confirm" data-id="${id}">Bestätigen</button>`,
      `<button type="button" class="admin-action-btn admin-action-decline" data-action="decline" data-id="${id}">Ablehnen</button>`
    );
  } else if (workflow === "confirmed") {
    buttons.push(
      `<button type="button" class="admin-action-btn admin-action-cancel" data-action="cancel" data-id="${id}">Absagen</button>`
    );
  }

  buttons.push(
    `<button type="button" class="admin-action-btn admin-action-delete" data-action="delete" data-id="${id}" title="Termin permanent aus der Liste entfernen">Löschen</button>`
  );

  return `<div class="admin-actions">${buttons.join("")}</div>`;
};

/**
 * Konflikt-Badge: zeigt, wenn ein Termin zur gleichen Uhrzeit wie ein
 * anderer (offener oder bestaetigter) Termin liegt. Die Daten kommen aus
 * appointment.conflictsWith, gesetzt beim Anlegen vom Server.
 */
const renderConflictBadge = (item) => {
  const conflicts = Array.isArray(item.conflictsWith) ? item.conflictsWith : [];
  if (conflicts.length === 0) return "";
  const tooltipParts = conflicts.map(
    (c) => `${c.name} (${c.service})${c.confirmed ? " ✓bestätigt" : ""}`
  );
  return `<span class="status-reminder conflict-badge" title="Konflikt mit: ${escapeHtml(
    tooltipParts.join(", ")
  )}">⚠ Slot-Konflikt</span>`;
};

const renderRows = (appointments) => {
  lastAppointments = appointments;

  const filtered = appointments.filter((a) => matchesFilter(a) && matchesSearch(a));

  if (appointments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${COLSPAN}" class="admin-empty">Noch keine Terminanfragen vorhanden.</td>
      </tr>`;
    metaEl.textContent = "0 Termine";
    return;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${COLSPAN}" class="admin-empty">Keine Termine in dieser Ansicht.</td>
      </tr>`;
    // Meta laeuft trotzdem unten ueber alle Termine -- so sieht man auf einen
    // Blick die Gesamtzahlen.
  } else {
    tbody.innerHTML = filtered
      .map((item) => {
      const workflow = getWorkflowStatus(item);
      const rowClass = workflow === "pending" ? "" : ` class="is-${workflow}"`;
      const notesHtml = item.notes
        ? `<div class="admin-notes">${escapeHtml(item.notes)}</div>`
        : '<div class="admin-notes is-empty">—</div>';
      const conflictBadge =
        workflow === "pending" || workflow === "confirmed"
          ? renderConflictBadge(item)
          : "";
      return `
        <tr${rowClass}>
          <td data-label="Datum">${formatDate(item.date)}${conflictBadge ? "<br>" + conflictBadge : ""}</td>
          <td data-label="Uhrzeit">${item.time} Uhr</td>
          <td data-label="Name"><strong>${escapeHtml(item.name)}</strong></td>
          <td data-label="Telefon">
            <a class="admin-phone" href="tel:${escapeHtml(String(item.phone).replace(/\s/g, ""))}">
              ${escapeHtml(item.phone)}
            </a>
          </td>
          <td data-label="E-Mail">
            <a class="admin-email" href="mailto:${escapeHtml(item.email || "")}">
              ${escapeHtml(item.email || "—")}
            </a>
          </td>
          <td data-label="Leistung">${escapeHtml(item.service)}</td>
          <td data-label="Notizen">${notesHtml}</td>
          <td data-label="Eingegangen">${formatCreated(item.createdAt)}</td>
          <td data-label="Status">${renderStatusCell(item)}</td>
          <td data-label="Aktionen">${renderActionsCell(item)}</td>
        </tr>`;
      })
      .join("");
  }

  const counts = appointments.reduce(
    (acc, item) => {
      acc[getWorkflowStatus(item)] += 1;
      return acc;
    },
    { pending: 0, confirmed: 0, declined: 0, cancelled: 0 }
  );

  const segments = [];
  if (counts.pending > 0) segments.push(`${counts.pending} ausstehend`);
  if (counts.confirmed > 0) segments.push(`${counts.confirmed} bestätigt`);
  if (counts.declined > 0) segments.push(`${counts.declined} abgelehnt`);
  if (counts.cancelled > 0) segments.push(`${counts.cancelled} storniert`);
  metaEl.textContent = segments.join(" · ") || `${appointments.length} Termine`;

  renderStats(appointments);
};

/**
 * Quick-Glance-Stats: zaehlt aktive Termine fuer "heute" und
 * "diese Woche" (ab heute, +7 Tage). Aktive = pending oder
 * confirmed -- storniert/abgelehnt ist fuer den Salon irrelevant.
 *
 * Gibt dem Operator beim Page-Open auf einen Blick: "wie viel ist
 * los?" ohne durch die Liste scrollen zu muessen.
 */
const renderStats = (appointments) => {
  if (!statsEl) return;
  const todayIso = new Date().toISOString().slice(0, 10);
  const in7Days = new Date();
  in7Days.setDate(in7Days.getDate() + 7);
  const in7DaysIso = in7Days.toISOString().slice(0, 10);

  let today = 0;
  let week = 0;
  let confirmedToday = 0;

  for (const a of appointments) {
    if (a.cancelled || a.declined) continue;
    if (!a.date) continue;
    if (a.date === todayIso) {
      today += 1;
      if (a.confirmed) confirmedToday += 1;
    }
    if (a.date >= todayIso && a.date <= in7DaysIso) {
      week += 1;
    }
  }

  if (today === 0 && week === 0) {
    statsEl.hidden = true;
    statsEl.textContent = "";
    return;
  }

  const parts = [];
  if (today > 0) {
    const todayLabel = confirmedToday === today
      ? `<strong>${today}</strong> heute`
      : `<strong>${today}</strong> heute (davon ${confirmedToday} bestätigt)`;
    parts.push(todayLabel);
  }
  if (week > 0) parts.push(`<strong>${week}</strong> in den nächsten 7 Tagen`);
  statsEl.innerHTML = parts.join(" · ");
  statsEl.hidden = false;
};

const loadAppointments = async () => {
  showAlert("");
  tbody.innerHTML = `
    <tr>
      <td colspan="${COLSPAN}" class="admin-empty">Lade Termine …</td>
    </tr>`;
  metaEl.textContent = "Lade Termine …";

  try {
    const response = await fetch(`${API_BASE}/api/appointments`);
    const result = await readJsonResponse(response);

    if (!response.ok || !result.success) {
      throw new Error(result.message || "Termine konnten nicht geladen werden.");
    }

    renderRows(result.appointments);
  } catch (error) {
    const isNetwork = error.message === "Failed to fetch";
    showAlert(
      isNetwork
        ? "Server nicht erreichbar. Bitte 'npm start' im Projektordner ausführen."
        : error.message
    );
    tbody.innerHTML = `
      <tr>
        <td colspan="${COLSPAN}" class="admin-empty">Termine konnten nicht geladen werden.</td>
      </tr>`;
    metaEl.textContent = "Fehler beim Laden";
  }
};

// Bestaetigungstexte und HTTP-Mapping pro Aktion -- macht das Anfuegen
// neuer Aktionen oben einfach.
const ACTION_CONFIG = {
  confirm: {
    confirmText:
      "Termin jetzt bestätigen? Der Kunde bekommt eine Bestätigungs-Mail und 24 h vorher automatisch eine Erinnerung.",
    method: "POST",
    pathSuffix: "/confirm",
  },
  decline: {
    confirmText:
      "Termin ablehnen? Der Kunde bekommt eine höfliche Absage-Mail mit Bitte, einen anderen Zeitpunkt anzufragen.",
    method: "POST",
    pathSuffix: "/decline",
  },
  cancel: {
    confirmText:
      "Bestätigten Termin wirklich absagen? Der Kunde bekommt eine entschuldigende Absage-Mail, die geplante 24h-Erinnerung wird gestoppt.",
    method: "POST",
    pathSuffix: "/cancel",
  },
  delete: {
    confirmText:
      "Diesen Eintrag permanent aus der Liste entfernen? Der Kunde bekommt KEINE Mail – nutze diese Aktion nur fürs Aufräumen.",
    method: "DELETE",
    pathSuffix: "",
  },
};

/**
 * Fuehrt eine Admin-Aktion aus. Buttons werden waehrend des Requests
 * deaktiviert; danach wird die Tabelle neu geladen.
 */
const performAdminAction = async (id, action, buttons) => {
  if (!id) return;
  const config = ACTION_CONFIG[action];
  if (!config) return;

  if (!window.confirm(config.confirmText)) return;

  buttons.forEach((btn) => {
    btn.disabled = true;
    btn.classList.add("is-loading");
  });
  showAlert("");

  try {
    const response = await fetch(
      `${API_BASE}/api/admin/appointments/${encodeURIComponent(id)}${config.pathSuffix}`,
      { method: config.method }
    );
    const result = await readJsonResponse(response);

    if (!response.ok || !result.success) {
      throw new Error(result.message || "Aktion fehlgeschlagen.");
    }

    await loadAppointments();
  } catch (error) {
    showAlert(error.message || "Aktion fehlgeschlagen.");
    buttons.forEach((btn) => {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    });
  }
};

// Event-Delegation: Klicks auf Bestaetigen/Ablehnen werden hier abgefangen.
tbody.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  const buttons = btn.closest(".admin-actions")?.querySelectorAll("button") || [btn];
  performAdminAction(id, action, Array.from(buttons));
});

// Filter-Buttons: setzen den Status und rendern aus dem Cache (kein neuer
// Backend-Roundtrip noetig).
filtersEl?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  const filter = btn.dataset.filter;
  if (!filter || filter === currentFilter) return;

  currentFilter = filter;
  filtersEl.querySelectorAll("[data-filter]").forEach((b) => {
    const isActive = b.dataset.filter === filter;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-selected", String(isActive));
  });

  renderRows(lastAppointments);
});

// Live-Suche mit Debounce, damit jeder Tastendruck nicht das ganze DOM
// neu rendert.
if (searchEl) {
  let searchTimer = null;
  searchEl.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = searchEl.value.trim();
      renderRows(lastAppointments);
    }, 150);
  });
}

refreshBtn.addEventListener("click", loadAppointments);
loadAppointments();
