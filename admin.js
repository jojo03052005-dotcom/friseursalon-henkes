/**
 * Admin: lädt alle Termine vom Backend und zeigt sie in einer Tabelle.
 */

const metaEl = document.querySelector("[data-admin-meta]");
const alertEl = document.querySelector("[data-admin-alert]");
const tbody = document.querySelector("[data-appointments-body]");
const refreshBtn = document.querySelector("[data-refresh]");

const API_BASE = window.HENKES_API_BASE || window.location.origin;
const COLSPAN = 9;

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
      "Das Backend antwortet noch nicht korrekt. Bitte prüfen Sie die Railway-Backend-URL."
    );
  }

  return response.json();
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
 * Zeigt Versandstatus + Storniert-Badge.
 */
const renderStatusCell = (item) => {
  if (item.cancelled) {
    const when = item.cancelledAt
      ? new Date(item.cancelledAt).toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const title = when ? `Storniert am ${when}` : "Storniert";
    return `<span class="status-badge status-cancelled" title="${escapeHtml(title)}">Storniert</span>`;
  }

  const status = item.emailStatus;
  if (!status) {
    return '<span class="status-badge status-unknown">Unbekannt</span>';
  }

  const customerOk = status.customer?.sent;
  const salonOk = status.salon?.sent;
  const reminderHtml = formatReminderInfo(status);

  if (customerOk && salonOk) {
    return `<span class="status-badge status-sent">Beide gesendet</span>${reminderHtml}`;
  }

  if (customerOk || salonOk) {
    const parts = [];
    if (customerOk) parts.push("Kunde OK");
    else parts.push(`Kunde: ${status.customer?.error || "fehlgeschlagen"}`);
    if (salonOk) parts.push("Salon OK");
    else parts.push(`Salon: ${status.salon?.error || "fehlgeschlagen"}`);
    return `<span class="status-badge status-partial" title="${escapeHtml(parts.join(" | "))}">Teilweise</span>${reminderHtml}`;
  }

  const error = status.customer?.error || status.salon?.error || "Versand fehlgeschlagen";
  return `<span class="status-badge status-failed" title="${escapeHtml(error)}">Fehlgeschlagen</span>`;
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
      const rowClass = item.cancelled ? ' class="is-cancelled"' : "";
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
        </tr>`;
    })
    .join("");

  const cancelledCount = appointments.filter((item) => item.cancelled).length;
  const activeCount = appointments.length - cancelledCount;
  const cancelledNote = cancelledCount > 0 ? ` · ${cancelledCount} storniert` : "";
  metaEl.textContent = `${activeCount} aktive Termin${activeCount === 1 ? "" : "e"}${cancelledNote} – sortiert nach Wunschdatum`;
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
        ? "Server nicht erreichbar. Bitte „npm start“ im Projektordner ausführen."
        : error.message
    );
    tbody.innerHTML = `
      <tr>
        <td colspan="${COLSPAN}" class="admin-empty">Termine konnten nicht geladen werden.</td>
      </tr>`;
    metaEl.textContent = "Fehler beim Laden";
  }
};

refreshBtn.addEventListener("click", loadAppointments);
loadAppointments();
