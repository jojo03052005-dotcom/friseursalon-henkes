# Operations Handbook

Wer dieses Dokument liest, ist verantwortlich dafür, dass die Buchungs-Plattform für den Salon Henkes 24/7 erreichbar bleibt.

---

## 1. Was läuft wo?

| Komponente | Host | URL | Plan |
|---|---|---|---|
| Frontend (statisch) | Netlify | `https://friseursalon-henkes-website.netlify.app/` | Free |
| Backend (Node/Express) | Render | `https://friseursalon-henkes-backend.onrender.com/` | Free Tier |
| Persistente Daten | Render Disk | Mount: `/var/data/henkes` | Starter ($1/Mo) |
| E-Mail-Versand | Resend | API | Free (3000/Mo) |
| Daily-Digest-Cron | cron-job.org | externer Pinger | Free |

---

## 2. Tägliche Checks (für den Operator)

### Automatisch (Render-Logs überfliegen, 1 Min/Tag)

- Suche nach `"level":"error"` — sollte nahe Null sein
- Suche nach `"event":"backup_created"` — sollte ~4× pro Tag (alle 6h) auftauchen
- Suche nach `"event":"appointment_created"` — Aktivitäts-Indikator

### Wöchentlich (5 Min)

- Health-Endpoint aufrufen: `https://friseursalon-henkes-backend.onrender.com/api/health`
- Im JSON-Output prüfen:
  - `storage.writable === true`
  - `storage.persistent === true` (sonst → Render Disk fehlt!)
  - `appointmentsFile.healthy === true`
  - `backup.lastBackupAt` ist max. 6h alt
  - `warnings` ist leer (oder nur "warn"-Level, nichts "error")

---

## 3. Health-Endpoint lesen

```
GET https://friseursalon-henkes-backend.onrender.com/api/health
```

### Was erwartet ist (gesund)

```json
{
  "success": true,
  "service": "friseursalon-henkes-backend",
  "version": "1.0.0",
  "env": "production",
  "uptimeSeconds": 12345,
  "emailConfigured": true,
  "storage": {
    "writable": true,
    "persistent": true,
    "path": "/var/data/henkes"
  },
  "appointmentsFile": {
    "healthy": true,
    "exists": true,
    "count": 42
  },
  "backup": {
    "enabled": true,
    "intervalHours": 6,
    "retention": 14,
    "lastBackupAt": "2026-05-25T06:00:00.000Z",
    "lastError": null
  },
  "warnings": []
}
```

### Rote Flaggen

| Symptom | Bedeutung | Aktion |
|---|---|---|
| `storage.writable === false` | Disk-Mount kaputt oder Permissions falsch | Render-Dashboard → Disk-Tab → Status. Notfall: Disk detach/reattach. |
| `storage.persistent === false` | HENKES_DATA_DIR fehlt → Render-Free-Filesystem | Render-Env-Vars setzen (siehe DEPLOYMENT_CHECKLIST.md) |
| `appointmentsFile.healthy === false` | JSON-Datei korrupt | Auto-Recovery sollte beim nächsten Restart greifen. Manuell: siehe BACKUP_RECOVERY.md |
| `backup.lastBackupAt` älter als 12h | Scheduler crashed oder Disk voll | Render-Logs nach `backup_cycle_failed` durchsuchen |
| `backup.lastError !== null` | Letzter Backup-Versuch ging schief | Logs lesen, Disk-Speicher prüfen |
| `emailConfigured === false` | RESEND_API_KEY oder SALON_EMAIL fehlt | Render-Env-Vars setzen |
| `warnings[].level === "error"` | Es brennt irgendwo | Den jeweiligen `area` und `message` lesen |

---

## 4. Logs lesen

Render-Dashboard → Service → Logs.

Alle Log-Zeilen sind **JSON Lines** in Production. Wichtige Events:

| Event | Bedeutung |
|---|---|
| `server_started` | Boot OK |
| `storage_writable` | Disk-Probe erfolgreich |
| `storage_ephemeral_in_production` | ⚠️ Disk fehlt! Termine gehen bei nächstem Deploy verloren! |
| `storage_not_writable` | ⚠️ Disk-Mount-Fehler |
| `appointments_file_ok` | Termin-Datei OK beim Boot |
| `appointments_file_corrupted` | Korruption beim Boot erkannt → Auto-Recovery startet |
| `auto_recovery_success` | Recovery aus Backup hat geklappt |
| `auto_recovery_failed` | Recovery fehlgeschlagen → manuelle Intervention nötig |
| `backup_created` | Routine-Backup OK |
| `backup_source_corrupted` | Backup übersprungen weil Quelle kaputt |
| `backup_cycle_failed` | Backup-Versuch fehlgeschlagen |
| `appointment_created` | Neue Buchung |
| `honeypot_triggered` | Bot abgewehrt (kein Insert) |
| `admin_auth_failed` | Falscher Login-Versuch im Admin |
| `shutdown_requested` | SIGTERM erhalten (Deploy oder Manual) |

### Grep-Beispiele

```bash
# Render-Logs als JSON Lines anzeigen + filtern
render logs --tail | jq 'select(.level == "error")'
render logs --tail | jq 'select(.event == "backup_created")'
render logs --tail | jq 'select(.component == "auth")'
```

---

## 5. Incident-Playbook

### "Kunden können nicht buchen"

1. **`curl https://friseursalon-henkes-backend.onrender.com/api/health`** — antwortet er? Wie lange dauert es?
2. Falls **Timeout >60s** → Render-Cold-Start, einfach nochmal versuchen (server.js braucht 30-60s aus Idle)
3. Falls **non-200 oder JSON-Fehler** → Render-Dashboard → Service-Status. Crashloop? Logs lesen.
4. Falls **Health OK aber Frontend zeigt Fehler** → Netlify-Status prüfen. Browser-DevTools-Console.

### "Buchung kam an, aber keine Mail kam"

1. Health: `emailConfigured === true`?
2. Render-Logs: `[email]` → suchen nach `customer:` Status. Wenn `error` enthält "sandbox" → Resend-Domain noch nicht verifiziert
3. Resend-Dashboard: `https://resend.com/emails` → ist die Mail dort gelistet? Status `bounced`?
4. Häufigste Ursache: Domain nicht verifiziert → Mails landen im Spam-Filter des Empfängers. Mit Resend eigene Domain einrichten.

### "Admin zeigt 0 Termine, ich weiß aber dass welche da waren"

1. SOFORT **Backup-Endpoint manuell aufrufen**: `https://...onrender.com/api/admin/backup` (Basic-Auth) → JSON-Datei speichern, prüfen ob sie etwas enthält
2. Falls leer → wahrscheinlich Disk-Mount-Problem oder Restart ohne Persistenz
3. **Render-Logs**: nach `auto_recovery_success` suchen — wenn ja, ein Recovery hat schon stattgefunden
4. Wenn Disk-Mount kaputt: Render-Dashboard → Disks → reattach. **DANN** auf Restart warten und Health-Endpoint prüfen
5. Falls Daten verloren UND kein Backup → manuell aus letztem heruntergeladenen Backup wiederherstellen (siehe BACKUP_RECOVERY.md)

### "Server crashloop"

1. Render-Logs: letzte Zeilen vor Crash
2. `uncaught_exception`-Event → der eigentliche Fehler
3. 90% der Fälle: kaputte Env-Var-Konfiguration. Fix: Render-Env-Vars korrigieren, Restart
4. Falls Code-Fehler (selten nach unseren Tests): **rollback** via `git revert` + push (Render auto-redeployed von main)

### "Backup-Datei zu groß" / "Disk voll"

Sollte bei 14 Backups × ~10kb = 140kb nie passieren. Falls doch:
1. SSH/Shell in Render → `du -sh /var/data/henkes/*`
2. Eventuell quarantinierte `.corrupted-*` Files aufräumen (sind forensisch, nicht funktional nötig)
3. `HENKES_BACKUP_RETENTION` heruntersetzen (z.B. auf 7)

---

## 6. Routine-Wartung

### Monatlich

- **Resend-Quota prüfen** (Free: 3000 Mails/Monat, ~100/Tag). Bei steigender Auslastung auf Pro-Plan ($20/Mo, 50k Mails)
- **Render-Logs durchsuchen** nach unbekannten Errors
- **ADMIN_PASSWORD rotieren** (optional, aber gute Hygiene)
- **`data/closed-days.json` pflegen**: kommende Feiertage / Betriebsferien eintragen

### Vor jedem geplanten Deploy

1. **Manuelles Backup runterladen**: Admin → "Backup ↓" Button. JSON-Datei sicher woanders ablegen
2. `git log main..HEAD` — was wird deployed?
3. `npm test` lokal → 125/125 grün?
4. Push → Render auto-deployed
5. Nach Deploy: `/api/health` aufrufen, prüfen dass `appointmentsFile.count` plausibel ist

### Nach jedem ungeplanten Restart (Render-Maintenance, OOM, etc.)

Health-Endpoint prüfen — die Auto-Recovery-Logik macht den Rest. Logs nach `auto_recovery_*` durchsuchen.

---

## 7. Notfall-Kontakte

| Was | Wo |
|---|---|
| Render-Status | https://status.render.com |
| Resend-Status | https://status.resend.com |
| Netlify-Status | https://www.netlifystatus.com |
| Repo | https://github.com/jojo03052005-dotcom/friseursalon-henkes |
| Salon Telefon (für "wir nehmen Anrufe statt online") | 0209 41793 |

**Goldener Notfall-Trick:** Wenn die Online-Buchung 30 Min ausfällt, am Telefon Termine annehmen und am Abend manuell in `data/closed-days.json` blockieren. Der Salon hat sein Geschäft schon ohne Software geführt und kann es 1 Tag wieder tun.
