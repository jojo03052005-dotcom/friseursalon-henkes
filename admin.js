/**
 * Admin: laedt alle Termine vom Backend und zeigt sie in einer Tabelle.
 * Bestaetigen / Ablehnen geht ueber /api/admin/appointments/:id/...
 *
 * Die Seite wird hinter HTTP Basic Auth ausgeliefert; der Browser merkt
 * sich die Credentials fuer die Session und schickt sie automatisch bei
 * allen fetch()-Calls auf denselben Origin mit.
 */

const metaEl = document.querySelector("[data-admin-meta]");
const alertEl = document.querySelector("[data-admin-alert]");
const tbody = document.querySelector("[data-appointments-body]");
const refreshBtn = document.querySelector("[data-refresh]");

const API_BASE = window.HENKES_API_BASE || window.location.origin;
const COLSPAN = 10;

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
 * Buttons "Bestaetigen" / "Ablehnen" -- nur bei ausstehenden Anfragen.
 */
const renderActionsCell = (item) => {
  const workflow = getWorkflowStatus(item);
  if (workflow !== "pending") {
    return '<span class="admin-actions-empty">—</span>';
  }
  return `
    <div class="admin-actions">
      <button type="button" class="admin-action-btn admin-action-confirm" data-action="confirm" data-id="${escapeHtml(item.id)}">Bestätigen</button>
      <button type="button" class="admin-action-btn admin-action-decline" data-action="decline" data-id="${escapeHtml(item.id)}">Ablehnen</button>
    </div>`;
};

const renderRows = (appointments) => {
  if (appointments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${COLSPAN}" class="admin-empty">Noch keine Terminanfragen vorhanden.</td>
      </tr>`;
    metaEl.textContent = "0 Termine";
    return;
  }

  tbody.innerHTML = appointments
    .map((item) => {
      const workflow = getWorkflowStatus(item);
      const rowClass = workflow === "pending" ? "" : ` class="is-${workflow}"`;
      const notesHtml = item.notes
        ? `<div class="admin-notes">${escapeHtml(item.notes)}</div>`
        : '<div class="admin-notes is-empty">—</div>';
      return `
        <tr${rowClass}>
          <td>${formatDate(item.date)}</td>
          <td>${item.time} Uhr</td>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td>
            <a class="admin-phone" href="tel:${escapeHtml(String(item.phone).replace(/\s/g, ""))}">
              ${escapeHtml(item.phone)}
            </a>
          </td>
          <td>
            <a class="admin-email" href="mailto:${escapeHtml(item.email || "")}">
              ${escapeHtml(item.email || "—")}
            </a>
          </td>
          <td>${escapeHtml(item.service)}</td>
          <td>${notesHtml}</td>
          <td>${formatCreated(item.createdAt)}</td>
          <td>${renderStatusCell(item)}</td>
          <td>${renderActionsCell(item)}</td>
        </tr>`;
    })
    .join("");

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

/**
 * Fuehrt eine Admin-Aktion (confirm/decline) aus. Buttons werden waehrend
 * des Requests deaktiviert, danach laedt die Tabelle neu.
 */
const performAdminAction = async (id, action, buttons) => {
  if (!id || !["confirm", "decline"].includes(action)) return;

  const confirmText =
    action === "confirm"
      ? "Termin jetzt bestätigen? Der Kunde bekommt eine Bestätigungs-Mail und 24 h vorher automatisch eine Erinnerung."
      : "Termin ablehnen? Der Kunde bekommt eine höfliche Absage-Mail mit Bitte, einen anderen Zeitpunkt anzufragen.";

  if (!window.confirm(confirmText)) return;

  buttons.forEach((btn) => {
    btn.disabled = true;
    btn.classList.add("is-loading");
  });
  showAlert("");

  try {
    const response = await fetch(
      `${API_BASE}/api/admin/appointments/${encodeURIComponent(id)}/${action}`,
      { method: "POST" }
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

refreshBtn.addEventListener("click", loadAppointments);
loadAppointments();
