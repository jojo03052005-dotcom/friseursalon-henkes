# Friseursalon Henkes - Website & Terminbuchung

Statische Website mit Express-Backend, JSON-Speicher und transaktionalen
E-Mails via [Resend](https://resend.com).

- **Frontend:** Statische HTML/CSS/JS-Seite, deployed auf Netlify
- **Backend:** Node/Express auf Render (Free Tier), API + Admin + Storno-Flow
- **Mail:** Resend HTTP-API (sofort + 24h-Erinnerung + Storno-Benachrichtigung)
- **Speicher:** zwei Modi automatisch erkannt:
  - **Postgres** wenn `DATABASE_URL` gesetzt (empfohlen für Production, Neon kostenlos)
  - **JSON-Datei** in `data/appointments.json` (Default für lokale Entwicklung + Tests)

## Schnellstart lokal

```bash
npm install
cp .env.example .env     # Werte eintragen, siehe unten
npm start
```

Server laeuft dann auf <http://localhost:3000>.

| Seite | URL |
|-------|-----|
| Website | <http://localhost:3000/> |
| Buchung | <http://localhost:3000/#termin> |
| Admin | <http://localhost:3000/admin.html> |

> Die Seite muss ueber den Server geoeffnet werden, nicht per Doppelklick
> auf `index.html` (sonst funktionieren die API-Calls nicht).

## Environment-Variablen

Siehe `.env.example` fuer den vollstaendigen Stand und Kommentare.

### Pflicht

| Variable | Zweck |
|----------|-------|
| `RESEND_API_KEY` | API-Key aus <https://resend.com> (Format `re_...`) |
| `SALON_EMAIL` | Empfaenger fuer Salon-Benachrichtigungen |
| `ADMIN_USER` | Benutzername fuer das Admin-Panel (HTTP Basic Auth) |
| `ADMIN_PASSWORD` | Passwort fuer das Admin-Panel |

### Optional

| Variable | Zweck |
|----------|-------|
| `EMAIL_FROM` | Absender, z.B. `Friseursalon Henkes <noreply@friseursalon-henkes.de>`. Default: `onboarding@resend.dev` (Sandbox, landet im Spam-Filter). |
| `EMAIL_USER` | Reply-To fuer Kunden-Mails. Default: `SALON_EMAIL`. |
| `PUBLIC_BASE_URL` | Basis-URL fuer Stornier-Links in den Mails (z.B. `https://friseursalon-henkes-backend.onrender.com`). Default: aus Request abgeleitet. |
| `ALLOWED_ORIGINS` | Zusaetzliche erlaubte CORS-Origins, Komma-getrennt. |
| `PORT` | Server-Port (default 3000). |

## Was passiert bei einer Buchung?

1. Formular auf `/#termin` wird abgeschickt
2. Backend validiert, speichert in `data/appointments.json`
3. **Sofort-Mails:**
   - "Anfrage erhalten" an den Kunden (mit Stornier-Link)
   - "Neue Terminanfrage" an `SALON_EMAIL`
4. Termin landet im Admin-Panel als **Ausstehend**
5. Salon bestaetigt im Admin -> **Bestaetigungs-Mail** an Kunden + Resend
   plant automatisch eine 24h-Erinnerung
6. Salon lehnt im Admin ab -> **Absage-Mail** an Kunden mit Bitte um neuen Termin
7. Kunde klickt Stornier-Link -> Termin als storniert markiert, geplante
   Erinnerung wird gecancelt, Salon bekommt Info-Mail

## Architektur

```
[Browser]
    |
    | https
    v
[Netlify (statisch)]                   <- index.html, styles.css, script.js
    |
    | XHR/fetch (window.HENKES_API_BASE)
    v
[Render (Node + Express)]              <- server.js, services/emailService.js
    |        |
    |        +---> Resend HTTP-API     <- Mails (sofort + scheduled)
    v
[data/appointments.json]               <- JSON-Speicher, achtung ephemer
                                          ohne Render Disk!
```

## Persistente Speicherung (Postgres via Neon)

Render Free-Tier hat keinen persistenten Storage — `data/appointments.json` würde bei jedem Deploy/Auto-Restart verloren gehen. Lösung: kostenlose Postgres-DB bei [Neon](https://neon.tech).

### Einmaliges Setup (5 Min)

1. **Neon-Account** auf <https://neon.tech> anlegen (GitHub-Login geht)
2. **New Project** erstellen:
   - Name: `henkes-salon`
   - Region: `Frankfurt (eu-central-1)` (nahe Render, niedrige Latenz)
   - Postgres Version: Default (16+)
3. Nach Projekt-Erstellung wird die **Connection String** angezeigt:
   ```
   postgresql://user:pass@ep-xxxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```
   Kopieren.
4. **In Render**: Dashboard → Service → Environment → `DATABASE_URL` setzen → Save Changes
5. Render deployt automatisch. Beim Start:
   - Schema wird automatisch angelegt (`appointments` + `settings` Tabellen)
   - Falls eine alte `appointments.json` existiert, wird sie einmalig in die DB importiert
6. **Verifizieren**: `https://...onrender.com/api/health` → `storage.engine: "postgres"`, `storage.writable: true`

### Lokale Entwicklung

Ohne `DATABASE_URL` läuft alles wie vorher (JSON-Datei in `data/`). Wer lokal gegen die echte Neon-DB testen will: `DATABASE_URL` in `.env` setzen. **NIEMALS Produktions-DB für Experimente — eigenes Neon-Branch nutzen** (Neon hat Postgres-Branches eingebaut, eine Zeile im Dashboard).

### Migration

Beim ersten Boot mit gesetztem `DATABASE_URL`:
- Tabellen werden angelegt (idempotent — zweiter Boot macht nichts)
- Wenn `data/appointments.json` existiert UND DB leer ist → einmaliger Import
- Wenn DB schon Daten hat → nichts (Production-Safe)
- Log-Events: `appointments_import`, `closed_days_import`

## Deployment

### Frontend (Netlify)

Repo verbinden, Build-Command leer, Publish-Directory `/`. In `index.html`
ist `window.HENKES_API_BASE` auf die Render-URL hardcoded -- bei Wechsel
der Backend-URL dort anpassen.

### Backend (Render)

Repo verbinden, `render.yaml` wird automatisch erkannt. Im Render-Dashboard
unter **Environment** die Variablen aus `.env.example` setzen (alle mit
`sync: false` markierten muessen manuell rein).

Achtung: **Render Free Tier hat ephemeren Storage**. Wenn die Buchungen
einen Deploy ueberleben sollen, brauchst du einen Render Disk (kostet
ca. 1$/Monat) oder eine externe DB.

Ausserdem schlaeft Render Free nach ~15 Min ohne Traffic -- der naechste
Request weckt ihn auf (Cold Start, ~30-60 Sek). Fuer echten Betrieb
entweder Cron-Pinger (z.B. cron-job.org auf `/api/health` alle 10 Min) oder
Render Starter-Plan ($7/Monat).

## Admin-Panel

Erreichbar unter `/admin.html`. Geschuetzt per HTTP Basic Auth -- der
Browser merkt sich die Credentials fuer die Session.

Zeigt alle Terminanfragen mit Status:

- **Ausstehend** - Anfrage eingegangen, wartet auf Salon-Entscheidung
- **Bestaetigt** - Salon hat zugesagt, Bestaetigungs-Mail + 24h-Reminder sind raus
- **Abgelehnt** - Salon hat abgesagt, Absage-Mail ging an Kunden
- **Storniert** - Kunde hat den Stornier-Link benutzt

## Projektstruktur

```
server.js                  # App-Komposition (Middleware + Router-Mount + Shutdown)
salon.config.json          # Salon-Daten (Name, Telefon, Stunden, Services) - 1 Datei pro Salon
lib/                       # Geschaeftslogik (rein, ohne Express)
  config.js                # zentrale Konstanten
  db.js                    # Postgres-Layer (aktiv wenn DATABASE_URL gesetzt)
  storage.js               # Engine-Switch (Postgres/JSON), gleiche API
  migrate.js               # einmaliger JSON->DB Import beim Boot
  backup.js                # File-Backup-Scheduler (im DB-Mode automatisch aus)
  validate.js              # Buchungs-Validierung
  auth.js                  # HTTP Basic Auth (timing-safe)
  rate-limit.js            # Limits pro Endpoint
  logger.js                # JSON-Lines in Production, lesbar in Dev
  escape.js                # HTML/ICS-Escape
  url.js                   # Base-URL-Ableitung
  async-handler.js         # Promise/sync-Throw -> next(err)
  startup-check.js         # Config-Warnings beim Boot
  views/storno.js          # server-rendered HTML fuer Storno-Flow
routes/                    # Express-Router pro Domain
  public.js                # /api/health, /api/services, /api/salon
  appointments.js          # POST/GET /api/appointments
  admin.js                 # /api/admin/* (Auth + Aktionen + CSV)
  cron.js                  # /api/cron/daily-digest
  storno.js                # /storno/:token (GET + POST)
services/emailService.js   # Resend-Integration + Mail-Templates
test/                      # node:test (built-in, keine Test-Lib-Dependency)
data/                      # nur Closed-Days getrackt; appointments.json gitignored
index.html                 # Startseite + Buchungsformular
script.js / styles.css     # Frontend-Logik + Design
admin.html / .js / .css    # Admin-Panel (hinter Basic Auth)
render.yaml                # Render-Deploy-Config
.env / .env.example        # Lokale Konfiguration (.env ist gitignored)
```

### Wichtigste API-Endpoints

| Methode | Pfad | Zweck |
|---------|------|-------|
| `HEAD` / `GET` | `/api/health` | Liveness + Operational-Status (no-cache, fuer Uptime-Monitore) |
| `GET` | `/api/services` | Service-Namen (5-Min-Cache) |
| `GET` | `/api/salon` | Stunden, Service-Dauern, Salon-Meta (5-Min-Cache) |
| `POST` | `/api/appointments` | Neue Buchung (Honeypot + Idempotency-Key + Dedupe) |
| `GET` | `/api/appointments` | Admin: alle Termine *(Basic Auth)* |
| `POST` | `/api/admin/appointments/:id/confirm\|decline\|cancel` | Status-Wechsel + Mail *(Basic Auth)* |
| `DELETE` | `/api/admin/appointments/:id` | Permanent loeschen *(Basic Auth)* |
| `GET` | `/api/admin/backup` | JSON-Export aller Termine *(Basic Auth)* |
| `GET` | `/api/admin/backup.csv` | CSV-Export fuer Excel/Numbers *(Basic Auth)* |
| `GET` | `/api/cron/daily-digest` | Tages-Uebersicht-Mail *(CRON_SECRET)* |
| `GET` / `POST` | `/storno/:token` | Kunden-Storno-Flow (UUID-Token + Mail) |

## Bekannte Einschraenkungen / TODOs

- [x] **Persistenz**: Postgres via Neon (kostenlos) implementiert -- siehe oben
- [x] **Slot-Konflikt-Pruefung**: Markiert (nicht blockierend, da zwei Stylistinnen parallel arbeiten koennten)
- [x] **Mobile Admin-UX**: Stacked Layout unter 760px, Live-Suche, Filter
- [x] **Live-Buchungs-Hints**: Datum-/Zeit-Validation passiert im Browser BEVOR submit
- [x] **Backup + Auto-Recovery**: File-Backups rotieren, korrupte JSON wird auto-repariert
- [ ] **Eigene Domain bei Resend verifizieren** (sonst landen Mails im Spam)
- [ ] **Impressum + Datenschutzerklaerung** (TMG/DSGVO-Pflicht in DE) -- Platzhalter eingebaut, Inhalte ergaenzen
- [ ] **DATABASE_URL in Render setzen** (sonst weiter ephemerer Storage)
