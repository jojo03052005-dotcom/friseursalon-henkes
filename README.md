# Friseursalon Henkes - Website & Terminbuchung

Statische Website mit Express-Backend, JSON-Speicher und transaktionalen
E-Mails via [Resend](https://resend.com).

- **Frontend:** Statische HTML/CSS/JS-Seite, deployed auf Netlify
- **Backend:** Node/Express auf Render (Free Tier), API + Admin + Storno-Flow
- **Mail:** Resend HTTP-API (sofort + 24h-Erinnerung + Storno-Benachrichtigung)
- **Speicher:** `data/appointments.json` (achtung: Render-Disk noetig fuer Persistenz)

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
server.js                # Express-API (Routes, Validation, Admin-Auth, Storno-HTML)
services/emailService.js # Resend-Integration + Mail-Templates
data/appointments.json   # JSON-Speicher (ephemer ohne Render Disk!)
index.html               # Startseite + Buchungsformular
script.js                # Frontend-Logik (Form-Submit, Reveal-Animationen)
styles.css               # Salon-Design
admin.html / .js / .css  # Admin-Panel
render.yaml              # Render-Deploy-Config
.env / .env.example      # Lokale Konfiguration (.env ist gitignored)
```

## Bekannte Einschraenkungen / TODOs

- [ ] **Persistenz**: JSON liegt auf Render-Filesystem -> Render Disk anbinden oder DB
- [ ] **Eigene Domain bei Resend verifizieren** (sonst landen Mails im Spam)
- [ ] **Impressum + Datenschutzerklaerung** (TMG/DSGVO-Pflicht in DE)
- [ ] **Slot-Konflikt-Pruefung** (zwei Kunden koennen denselben Slot anfragen)
- [ ] **Bessere Mobile-UX im Admin** (Tabelle scrollt horizontal)
