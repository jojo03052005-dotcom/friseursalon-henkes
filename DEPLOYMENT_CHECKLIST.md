# Deployment Checklist

Pflichtablauf bei jedem Deploy nach Production.

---

## 1. Einmaliges Production-Setup (Render Disk anbinden)

> **Macht man genau einmal beim Wechsel von „demo" auf „Produktion".**
> Danach überleben Termine alle Deploys.

### Schritt 1.1 — Render Disk erstellen

1. Render Dashboard → Service `friseursalon-henkes-backend` → **„Disks"** Tab links
2. **„Add Disk"** klicken
3. Felder ausfüllen:
   - **Name:** `henkes-data`
   - **Mount Path:** `/var/data/henkes` ← exakt so
   - **Size (GB):** `1` (mehr als 100MB werden wir nie brauchen)
4. **„Save"** → Render restartet den Service. ~2 Min Downtime.

**Kosten:** $0.25/GB/Monat → ~$0.25/Monat.

### Schritt 1.2 — Env-Variable setzen

1. Render Dashboard → Service → **„Environment"** Tab
2. Neue Variable hinzufügen:
   ```
   Key:   HENKES_DATA_DIR
   Value: /var/data/henkes
   ```
3. **„Save Changes"** → Render redeployed automatisch.

### Schritt 1.3 — Verifizieren

Nach ~2 Min:

```bash
curl https://friseursalon-henkes-backend.onrender.com/api/health
```

Prüfen:
- `"storage": { "writable": true, "persistent": true, "path": "/var/data/henkes" }`
- `"warnings": []` (keine "storage_ephemeral_in_production" Warning mehr)

Render-Logs sollten zeigen:
```
{ "event": "storage_writable", "writable": true, "path": "/var/data/henkes", "persistent": true }
```

### Schritt 1.4 — Existierende Daten rüberbringen (wenn du schon Termine hattest)

Wenn schon Buchungen im alten ephemeren Storage waren — die sind verloren, sorry. Daher: **diese Migration als erste Aktion nach Live-Gang machen, bevor Kunden buchen**.

Falls schon Live-Daten da sind:
1. Vor der Migration: **manuell Backup ziehen** (Admin → „Backup ↓")
2. Schritte 1.1–1.3 durchführen
3. Backup-Datei via Render-Shell (kostet $7/Mo Starter-Plan für Shell) oder via einmaligen Git-Commit (siehe BACKUP_RECOVERY.md § 5 „Wenn keine Shell verfügbar") zurückspielen

---

## 2. Pflicht-Env-Vars (alle in Render → Environment)

| Variable | Pflicht? | Wert / Beispiel | Was passiert ohne |
|---|---|---|---|
| `NODE_ENV` | ja | `production` | Logger spielt Dev-Format aus, Performance schlechter |
| `HENKES_DATA_DIR` | ja (für Production) | `/var/data/henkes` | Termine gehen bei jedem Deploy verloren |
| `RESEND_API_KEY` | ja | `re_xxxxx...` | Keine Mails |
| `SALON_EMAIL` | ja | `empfang@friseursalon-henkes.de` | Salon weiß nichts von Anfragen |
| `ADMIN_USER` | ja | `henkes` | Admin-Panel deaktiviert (fail-closed) |
| `ADMIN_PASSWORD` | ja | mind. 16 Zeichen, Passwort-Manager | Admin-Panel deaktiviert |
| `PUBLIC_BASE_URL` | empfohlen | `https://friseursalon-henkes-backend.onrender.com` | Storno-Links in Mails könnten falsche URL haben |
| `EMAIL_FROM` | empfohlen | `Friseursalon Henkes <noreply@deine-domain.de>` | Default = Resend-Sandbox → Spam-Falle |
| `EMAIL_USER` | optional | `salon@friseursalon-henkes.de` | Reply-To geht an SALON_EMAIL |
| `ALLOWED_ORIGINS` | optional | Komma-getrennte zusätzliche Origins | Default-Liste deckt Netlify + Localhost ab |
| `CRON_SECRET` | empfohlen | min. 32 Zeichen Zufall | Tagesüberblick deaktiviert, kein Pre-Warm |
| `HENKES_BACKUP_INTERVAL_HOURS` | optional | `6` (default) | — |
| `HENKES_BACKUP_RETENTION` | optional | `14` (default) | — |

> 🚨 **NIEMALS** `.env`-Datei oder API-Keys ins Git committen. `.env` ist gitignored, das muss so bleiben.

---

## 3. Pre-Deploy Checklist (vor jedem `git push origin main`)

- [ ] `npm test` lokal → 125/125 grün
- [ ] Branch ist gerebased auf aktuelles `main`
- [ ] CHANGELOG/Commit-Message beschreibt was sich ändert
- [ ] **Manuelles Backup** runtergeladen (Admin → „Backup ↓")
- [ ] Wenn Schema-Änderung am `appointment`-Objekt: dokumentieren, in welchem Commit
- [ ] Wenn Env-Vars dazu kommen: in Render gesetzt **vor** dem Code-Deploy

---

## 4. Deploy

Render auto-deployed bei push to `main`. Du musst nichts machen außer `git push`.

Render-Build dauert typisch 1–2 Min:
```
npm ci           (Build-Command in render.yaml)
npm start        (Start-Command)
```

Health-Check (`/api/health`) muss antworten, sonst rolled Render automatisch zurück.

---

## 5. Post-Deploy Checklist (innerhalb 5 Min nach Deploy)

- [ ] `curl https://...onrender.com/api/health` → 200 + alle wichtigen Felder gesetzt
- [ ] `appointmentsFile.count` ist plausibel (gleich oder höher als vor Deploy)
- [ ] `warnings` ist leer (oder nur erwartete `warn`-Level-Hinweise)
- [ ] **Render-Logs** durchsehen:
  - `server_started` mit `emailConfigured: true`
  - `storage_writable` mit `persistent: true`
  - `appointments_file_ok`
  - Kein `error`-Level außer erwartet
- [ ] Test-Buchung mit der eigenen E-Mail durchführen → Beide Mails kommen an (Kunde + Salon)?
- [ ] Admin-Panel öffnen → neuer Termin sichtbar?
- [ ] Bei der nächsten 6h-Backup-Welle: `lastBackupAt` aktualisiert?

---

## 6. Rollback (wenn Deploy schiefging)

### Variante A: Code-Rollback via Git (empfohlen)

```bash
git revert HEAD --no-edit
git push origin main
```

Render deployed binnen 2 Min die vorherige Version. Daten auf der Render Disk bleiben unangetastet.

### Variante B: Render-Dashboard

1. Render Dashboard → Service → **„Manual Deploy"** Dropdown
2. **Vorherigen Commit** auswählen → **„Deploy"**
3. Nach Deploy: Health-Check

### Variante C: Daten-Rollback (wenn der Deploy die Daten korrumpiert hat)

Wenn nicht der Code, sondern die Daten kaputt sind:

1. Eingebauter Auto-Recovery sollte beim nächsten Restart anschlagen → Logs nach `auto_recovery_success` durchsuchen
2. Falls Auto-Recovery scheitert: BACKUP_RECOVERY.md § 5 folgen

---

## 7. Cron-Job (Daily-Digest + Keep-Warm) einrichten

> **Empfohlen, nicht Pflicht.** Hält den Server morgens warm, schickt Salon eine Tagesübersicht.

### Schritt 7.1 — `CRON_SECRET` setzen

In Render-Env:
```
CRON_SECRET = mind-32-zeichen-zufallsstring-aus-passwort-manager
```

Anschließend Restart abwarten (~2 Min).

### Schritt 7.2 — cron-job.org einrichten

1. Account bei https://cron-job.org/de/
2. **„Create cronjob"**:
   - **URL:** `https://friseursalon-henkes-backend.onrender.com/api/cron/daily-digest?secret=DEIN_SECRET`
     (oder mit Authorization-Header: `Bearer DEIN_SECRET` für besseren Schutz)
   - **Schedule:** Täglich 07:00 (Berliner Zeit)
   - **Notifications:** „Notify on failure" → E-Mail
3. **Test-Run** → `Run now` klicken → in Render-Logs sollte `daily_digest_sent` auftauchen

---

## 8. Domain-Setup (optional aber empfohlen)

### Eigene Domain für die Website (Netlify)

1. Domain kaufen (Namecheap, INWX, Hetzner …)
2. Netlify-Dashboard → Site → **„Domain Settings"** → **„Add custom domain"**
3. DNS-Records gemäß Netlify-Anweisung setzen (A oder CNAME)
4. Wenn live: in `index.html` den `<script>window.HENKES_API_BASE=...</script>` ggf. auf eigene Backend-Domain ändern (oder unverändert lassen, der Render-Host funktioniert weiter)

### Eigene Mail-Domain (Resend)

Wichtig, sonst landen Mails im Spam.

1. Resend-Dashboard → **„Domains"** → **„Add domain"** → `friseursalon-henkes.de`
2. DNS-Records (SPF, DKIM, DMARC) bei der Domain-Verwaltung setzen
3. Warten auf Verifikation (5 Min bis 24h)
4. In Render-Env setzen:
   ```
   EMAIL_FROM = Friseursalon Henkes <noreply@friseursalon-henkes.de>
   ```
5. Test-Buchung → Mail sollte jetzt mit grünem „Verified"-Indikator beim Empfänger ankommen

---

## 9. Uptime-Monitoring

> **Empfohlen für 24/7-Betrieb.** Kostet nichts.

### Variante A: cron-job.org Health-Ping

Wenn du eh den Daily-Digest-Cron einrichtest: zusätzlich einen 5-Min-Ping auf `/api/health` als Liveness-Check. cron-job.org schickt bei Fehler E-Mail.

### Variante B: UptimeRobot

1. https://uptimerobot.com → Free-Account (50 Monitors)
2. Add Monitor:
   - Type: HTTP(s)
   - URL: `https://...onrender.com/api/health`
   - Interval: 5 Min
   - Notification: E-Mail + ggf. SMS (Free-Quote)
3. UptimeRobot zeigt 24/7-Uptime-Statistik und benachrichtigt bei Outage

### Variante C: Better Uptime / Better Stack

Wenn echte Operativ-Eskalation gewünscht (Bereitschaft via SMS, Slack, etc.). Kostenpflichtig ab $25/Mo.

---

## 10. Im echten Notfall

Wenn alles brennt und keiner mehr antwortet:

1. **Salon anrufen:** „Telefon-Termine annehmen, online ist temporär aus"
2. **Last Resort:** Letztes manuelles Backup aus L2 reinkopieren (siehe BACKUP_RECOVERY.md § 5)
3. **Forensik später:** Render-Logs runterladen (Render Free behält 7 Tage), in Ruhe analysieren
4. **Lessons learned:** in dieses Dokument einarbeiten, damit der Nachfolger es weiß
