# Backup & Recovery Strategy

> **Goldene Regel:** Kein System ist sicher, bei dem du nie versucht hast, ein Backup wiederherzustellen.

---

## 1. Die 3 Backup-Ebenen

| Ebene | Wer | Wie oft | Wo | Retention |
|---|---|---|---|---|
| **L1: Auto-Snapshots** | Server-Prozess (`lib/backup.js`) | alle 6h | `<DATA_DIR>/backups/` auf Render Disk | 14 Snapshots (~3.5 Tage) |
| **L2: Manueller Pull** | Salon-Mitarbeiter via Admin-UI | empfohlen: wöchentlich | Lokaler PC, Dropbox, Mail | unbegrenzt |
| **L3: Cron-gepullte Off-Site** | externer Cron (cron-job.org) | täglich | Cloud-Storage (S3, B2, Dropbox-API) | unbegrenzt |

L1 schützt vor App-Bugs + Korruption. L2 schützt vor Disk-Crash. L3 schützt vor Account-Verlust bei Render. **Mindestens L1 und L2 müssen aktiv sein.**

---

## 2. L1: Automatische Snapshots (eingebaut)

Bereits aktiv sobald der Server läuft, kein Setup nötig.

### Konfiguration (alle optional)

| Env-Var | Default | Bedeutung |
|---|---|---|
| `HENKES_BACKUP_INTERVAL_HOURS` | `6` | Wie oft ein Snapshot gezogen wird |
| `HENKES_BACKUP_RETENTION` | `14` | Wie viele Snapshots behalten werden |
| `HENKES_BACKUP_DISABLED` | `0` | `1` = komplett aus (nur für Tests) |

### Verifikation

- **Beim Boot:** `setTimeout(60s)` → erstes Backup
- **Im Log:** `"event":"backup_created"` mit Anzahl/Größe
- **Im Health:** `backup.lastBackupAt` aktualisiert sich

### Speicherort

```
/var/data/henkes/
├── appointments.json
├── closed-days.json
└── backups/
    ├── appointments-2026-05-25T00-00-00-000Z.json
    ├── appointments-2026-05-25T06-00-00-000Z.json
    ├── appointments-2026-05-25T12-00-00-000Z.json
    └── ...
```

### Integrität

Vor jedem Backup wird die Quelle auf valides JSON geprüft. Bei Korruption wird **kein** Backup geschrieben — wir wollen keine Trash-Daten als „Backup" einfrieren, das später die guten Snapshots überschreibt.

---

## 3. L2: Manueller Wöchentlicher Pull

### Wie

1. Admin-Panel öffnen: `https://...onrender.com/admin.html`
2. Oben rechts: **„Backup ↓"** klicken
3. Datei wird heruntergeladen: `henkes-backup-2026-05-25.json`
4. **Sicher ablegen**: Dropbox, OneDrive, E-Mail an dich selbst, USB-Stick

### Empfohlene Routine

- **Jeden Sonntagabend**: Backup ziehen, in einen Ordner pro Monat ablegen
- **Vor jedem geplanten Deploy**: Backup ziehen, mit Datum + „pre-deploy" markieren
- **Aufbewahren mindestens 6 Monate**

---

## 4. L3: Automatisierter Cloud-Off-Site-Pull

Wenn dem Salon das wichtig ist (Datenmenge wächst, Render-Risiko größer):

### Setup mit cron-job.org

1. Account bei https://cron-job.org/de/
2. Neuer Cronjob:
   - **URL:** `https://USER:PASSWORD@friseursalon-henkes-backend.onrender.com/api/admin/backup`
     (Basic-Auth in der URL, Cron-Job.org speichert die Credentials)
   - **Schedule:** täglich 03:00 Uhr (Berliner Zeit)
   - **Notification:** bei Fehler → E-Mail an Operator
3. cron-job.org speichert die Antwort 7 Tage — d.h. du hast eine 7-Tage-Rolling-Backup-Historie für 0€

### Setup mit Backblaze B2 / Wasabi (für ambitionierter)

- B2-Bucket einrichten (kostenlos für 10GB)
- GitHub Action / Render Background Worker zieht täglich das Backup und lädt es nach B2
- Lifecycle Policy: behalte 30 Tage täglich + 12 Monate monatlich
- Geschätzte Kosten: < $1/Jahr für diese Datenmenge

---

## 5. Recovery: Schritt-für-Schritt

### Szenario A: Auto-Recovery hat schon angeschlagen

Im Health-Endpoint siehst du `warnings: []` und alles ist gesund. In den Logs findest du:

```
{ "event": "appointments_file_corrupted", ... }
{ "event": "auto_recovery_success", "from": "appointments-2026-05-25T06-00-00-000Z.json" }
```

**Was tun:**
- Im Admin-Panel prüfen, ob die Termin-Anzahl plausibel ist
- Wenn ja: passiert, weiter normal arbeiten, nächstes Backup zieht in <6h
- Forensik: die Datei `data/appointments.json.corrupted-<ts>` enthält die kaputte Originaldatei. Mailen an dev für Analyse, oder einfach löschen

### Szenario B: Auto-Recovery fehlgeschlagen (alle Backups korrupt)

Selten — passiert nur wenn Disk komplett kaputt geht oder jemand `rm -rf` macht.

**Was tun:**
1. Server läuft mit leerer `appointments.json` weiter (er crashed nicht — der Kunde kann buchen, der Salon sieht nur keine alten Termine)
2. **Wichtig:** der Salon kann normal arbeiten, neue Buchungen werden gespeichert
3. Aus L2 oder L3 das jüngste Backup heraussuchen
4. Mit dem unten gezeigten Verfahren manuell restoren

### Manueller Restore aus einer Backup-Datei

Du brauchst:
- Eine valide `henkes-backup-YYYY-MM-DD.json` (aus L2 oder L3)
- Render-Shell-Zugriff (Render-Dashboard → Service → „Shell")

```bash
# 1. In den Disk-Mount wechseln
cd /var/data/henkes

# 2. Aktuelle Datei sichern (falls schon was drauf ist)
mv appointments.json appointments.json.before-restore-$(date +%s)

# 3. Backup-Datei reinkopieren -- das Format des Backups hat einen Wrapper:
#    { exportedAt, count, appointments: [...] }
#    Wir brauchen NUR den inneren `appointments`-Array
cat /tmp/henkes-backup-2026-05-25.json | jq '.appointments' > appointments.json

# 4. Verifizieren
jq 'length' appointments.json
cat appointments.json | head -c 200

# 5. Server-Restart erzwingen
# Render-Dashboard -> "Manual Deploy" -> "Deploy latest commit"
```

Nach dem Restart:
- Health-Endpoint: `appointmentsFile.count` sollte den restaurierten Wert zeigen
- Admin-Panel: alle Termine wieder sichtbar
- Backup-Scheduler zieht nach 60s einen frischen Snapshot des restaurierten Stands

### Wenn keine Shell verfügbar (Render Free)

Free-Tier hat keinen Shell-Zugriff. Workaround:

1. Lokal: Backup-Datei nehmen, in `data/appointments.json` (Repo-Root) reinkopieren
   - **Achtung:** nur den `appointments`-Inneren-Array, nicht den Wrapper
2. `git commit -am "restore: emergency restore from backup 2026-05-25"`
3. Push → Render redeployed
4. **WICHTIG NACH DEM RESTORE:** den Commit wieder reverten + push, weil sonst beim nächsten Deploy dein Restore deine Live-Termine wieder überschreibt

```bash
# Restore
cp ~/Downloads/henkes-backup-2026-05-25.json data/raw-backup.json
jq '.appointments' data/raw-backup.json > data/appointments.json
git add data/appointments.json
git commit -m "restore: emergency from backup 2026-05-25"
git push

# Nach erfolgreichem Restore + Verifikation
git revert HEAD --no-edit
git push
```

---

## 6. Backup-Drill (Recovery-Test)

**Jedes Quartal**, oder nach jedem größeren Code-Change am Storage-Layer:

1. Backup-Datei ziehen (L2)
2. Lokal eine zweite Kopie der App starten mit dieser Datei
3. Admin-Panel anschauen — alle Termine drin?
4. Eine Test-Buchung machen — wird gespeichert?
5. Restart der lokalen App — Termine noch da?

Wenn ja: Backup funktioniert. Wenn nein: jetzt fixen, nicht im Notfall.

---

## 7. Was NICHT in Backups ist

- **Mails (Resend-Server-side).** Resend bewahrt Sent-History 7 Tage auf. Für längere Historie → Resend Pro Plan oder eigene SMTP-Loggerei.
- **Logs (Render).** Render Free behält Logs 7 Tage. Für längere Historie → Render Logs Stream zu externem Service (Logtail, Better Stack).
- **Admin-Auth-Versuche.** Wer wann versucht hat sich einzuloggen, ist nur im Live-Log. Nicht in den Backups.
- **Reminder-Status nach Termin.** Wenn ein Termin durchgeführt wurde, gibt's keinen „abgeschlossen"-Status — der Termin bleibt einfach in der Liste. Manuelles Aufräumen via Delete-Button.
