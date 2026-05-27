# NIGHT SHIFT REPORT
**Datum:** 2026-05-27 (Nachtschicht)
**Branch:** `feat/persistent-storage-neon`
**Start:** 145/145 Tests gruen, 11 vorherige Commits stabilisiert
**Ende:**   **186/186 Tests gruen**, +21 neue atomare Commits, alle gepusht

Branch ist in einem **stabilen, gepushten Zustand**. Keine offenen Aenderungen,
keine breaking changes, keine neuen heavy dependencies.

---

## 1. Was erledigt wurde (21 neue Commits)

Sortiert nach Bereich, in chronologischer Reihenfolge:

### Backend - Reliability & Defense in Depth
| Commit | Was | Warum |
|---|---|---|
| `feat(api): add /api/salon` | Neuer Endpoint mit Stunden, Service-Dauern, Salon-Meta | Frontend kann live syncen statt SALON_HOURS zu duplizieren |
| `fix(db): statement_timeout + idle_in_transaction_session_timeout` | 15s/30s harte Limits in der pg-Pool-Config | Verhindert dass eine haengende Query den Worker blockiert |
| `feat(storno): UUID-Format-Guard vor DB-Lookup` | Non-UUID-Tokens werden mit 404 abgewiesen ohne Storage-Call | Spart Scanner-Spam DB-Roundtrips |
| `feat(validate): per-field max length caps` | name <=120, phone <=40, email <=254 | Defense in Depth ueber den 32kb Body-Parser-Limit hinaus |
| `feat(cron): rate-limit /api/cron/*` | 30/15min/IP zusaetzlich zu CRON_SECRET | Wenn Secret leakt, kein Mail-Spam |
| `test+fix(async-handler): catch sync throws too` | Wrapper faengt jetzt auch sync-throws vor dem ersten await | Beim Schreiben der Tests entdeckte Defense-Luecke |
| `fix(server): freundlicher 400 fuer invalid JSON` | Body-Parser-Errors -> 400 statt 500 mit DE-Message | Bessere Client-DX + sauberere Error-Rate-Metriken |
| `fix(health): no-store Cache-Control` | Uptime-Monitore bekommen IMMER frischen Stand | Verhinderte stale-cache-masked Ausfaelle |
| `polish: health subsystem timings` | `timings.storageMs` + `timings.appointmentsCheckMs` im /api/health-Body | Ops sieht welcher Subsystem-Call langsam ist |

### Frontend - UX & Conversion
| Commit | Was | Warum |
|---|---|---|
| `feat(booking-ux): live date/time hints + service duration` | Inline-Hinweise BEVOR submit ("Sonntag ist Ruhetag", "Außerhalb der Öffnungszeiten", "ca. 90 Min") | Spart Submit-Fehler-Roundtrips, Salon wirkt smarter |
| `feat(admin): Quick-Glance-Stats-Badge` | "X heute · Y in den nächsten 7 Tagen" oben im Admin | Salon sieht beim Page-Open sofort die Tagesplanung |
| `feat(admin): date-range filter (Heute/Woche/Alle)` | Kombiniert mit Status-Filter und Suche per AND | Schneller fokussieren ohne scrollen |
| `feat(admin): keyboard shortcuts /, r, ESC` | / = Fokus Suche; r = Reload; ESC = Suche leeren | Power-User-Ergonomie |
| `feat(ux): ESC schliesst mobile Nav + smooth-scroll auf Success` | A11y win; Erfolgs-Hint scrollt in den Viewport | Tastatur-Nutzer + mobile Sichtbarkeit |
| `polish: clear stale form alert on edit` | Alter is-error wird ausgeblendet sobald getippt wird | Saubere UX, keine "stale" Hinweise |

### Tests + Coverage
| Commit | Was | Neue Tests |
|---|---|---|
| `test: GET /api/salon` (in NS-A bereits enthalten) | Verifiziert Hours + Services + keine Secrets im Body | +1 |
| `test: per-field length caps` | name/phone/email Limits | +3 |
| `test: storno garbage tokens -> 404` | 6 Garbage-Tokens inklusive /etc/passwd, XSS | +2 |
| `test+fix(async-handler)` | url.js (6 Tests) + async-handler.js (5 Tests) | +11 |
| `test: admin decline/cancel/CSV-content` | Admin-Workflow End-to-End | +4 |
| `test: helmet security headers` | XContentTypeOptions, ReferrerPolicy, no X-Powered-By-Leak | +1 |
| `test: malformed JSON -> 400` | Body-Parser-Error-Pfad | +1 |
| `test: Cache-Control no-store auf /api/health` | Monitor-Vertrag | +1 |
| `test: lib/logger.js coverage` | JSON-Lines, child(), level filter, stderr-Routing | +5 |
| `test: storage.ENGINE + IS_PERSISTENT` | env-Permutationen | +4 |
| `test: storno HTML views` | XSS-Escape, doctype, noindex-Pflicht | +8 |
| **Tests gesamt** | | **145 -> 186 (+41)** |

### Privacy / Ops
| Commit | Was | Warum |
|---|---|---|
| `chore(privacy): gitignore data/appointments.json + *.log` | PII-Datei nicht mehr getrackt, Logs ignoriert | **Echte Kunden-PII war im git-Index** -- jetzt nur noch in History (siehe Risiken) |

### Productization
| Commit | Was | Warum |
|---|---|---|
| `feat(api): /api/salon` | Wieder oben gelistet -- Foundation fuer Multi-Salon | Frontend kann salon.config.json aenderungen ohne Code-Patch live uebernehmen |
| `docs: README polish` | Projektstruktur + API-Tabelle + abgehakte TODOs | Onboarding fuer naechsten Maintainer |
| `polish: sitemap.xml lastmod` | Crawl-Hint fuer Google | SEO Mini-Boost |

---

## 2. Bugs gefunden + behoben

1. **`lib/async-handler.js` lieferte sync-throws an den default-Express-Handler weiter**, statt sie an die zentrale Error-Middleware. Beim Schreiben der Tests fiel auf. Fix: try/catch um den Promise.resolve. (Commit `3956f4b`)
2. **Body-Parser-Errors (invalid JSON, oversized body) wurden als 500 ausgeliefert**, obwohl Express sie korrekt mit `err.status = 400` markiert. Client sah "Ein interner Fehler", Fehler-Rate-Dashboards waren versaut. (Commit `892694f`)
3. **`/api/health` war ohne Cache-Control** -- Uptime-Monitore koennten stale Responses gesehen haben (z.B. nach einem 2-min-Aussetzer den letzten 200er aus einem CDN-Cache). (Commit `5dc205b`)
4. **`data/appointments.json` war im git Repo getrackt** -- enthielt echte Kunden-PII (Name, Telefon). Aus dem Index entfernt + gitignored. (Commit `1191601`) **Achtung: History ist NICHT geputzt -- siehe Risiken.**

---

## 3. Tests hinzugefuegt: +41

Detail im Abschnitt oben. Highlights:

- **Defense-in-Depth-Tests** (Storno-Tokens, helmet-Headers, body-parser-Errors)
- **End-to-End Admin-Workflow** (confirm/decline/cancel + CSV-content-Roundtrip)
- **lib/-Module-Coverage** (logger, url, async-handler, storno-views, storage-mode)
- **API-Contract** (`/api/salon`, `/api/health` no-store, alle Cache-Header)

Alle Tests laufen in <1 Sekunde, kein netz-/DB-Abhaengigkeit (DB-Tests werden geskippt wenn `DATABASE_URL` nicht gesetzt).

---

## 4. UX-Verbesserungen

- **Live-Validierung** im Buchungsformular (Datum/Zeit/Service-Dauer-Hint)
- **Smooth-Scroll** auf Success-Message
- **ESC** schliesst mobile Nav (a11y)
- **Stale-Error-Clear** beim erneuten Tippen
- **Admin Quick-Glance Stats** (heute / 7 Tage)
- **Admin Date-Range Filter** + bestehende Status-Filter kombiniert
- **Admin Keyboard Shortcuts** (/, r, ESC)
- **Friendly 400** bei kaputten Requests statt "interner Fehler"

---

## 5. Stabilitaets-Verbesserungen

- **Postgres-Pool** mit `statement_timeout=15s` und `idle_in_transaction_session_timeout=30s`
- **Cron-Rate-Limit** als 2. Verteidigungslinie
- **Storno-Token-Format-Guard** vor DB-Lookup
- **Per-Field Length Caps** in der Validierung
- **Async-Handler faengt jetzt auch sync-throws**
- **Helmet-Header-Regression-Test** -- merkt sofort wenn jemand helmet entfernt

---

## 6. Entdeckte Risiken (PRIORITAET FUER USER)

### HOCH: PII in git-History
`data/appointments.json` wurde im initialen Commit (`0b25542 erste version`) mit echten Daten committet (mindestens 1 Eintrag mit Name + Tel-Nr). Heutige Aenderung untrackt die Datei, aber **die History enthaelt die Daten weiterhin**.

**Empfehlung:**
- Wenn das Repo PRIVAT ist und bleibt: kein dringender Handlungsbedarf
- Wenn es PUBLIC geht oder Public-Mitarbeiter Zugriff bekommen sollen:
  ```bash
  # Nur 1 Eintrag betroffen -- git-filter-repo (modern, schneller als filter-branch):
  pip install git-filter-repo
  git filter-repo --path data/appointments.json --invert-paths --force
  git push --force-with-lease origin --all
  ```
  Achtung: jeder, der den Branch geforked oder lokal hat, muss neu klonen.

### MITTEL: PR `feat/persistent-storage-neon` noch ungemerged
26 Commits seit `main` Branch-Punkt. Branch ist stabil, aber je laenger ungemerged, desto schwerer der Review. Empfehlung: heute mergen.

### MITTEL: Keine Production-Eintraege, weil DB noch nicht angebunden
Branch ist deployment-ready, aber `DATABASE_URL` ist im Render-Dashboard noch nicht gesetzt -- ohne das laeuft Render noch im JSON-Mode auf ephemerem Filesystem.

### NIEDRIG: Resend onboarding@resend.dev landet im Spam
Default-Absender ist die Resend-Sandbox-Domain. Bei echten Kunden landet die Bestaetigungs-Mail im Spam-Ordner. Eigene Domain bei Resend verifizieren + `EMAIL_FROM` setzen.

### NIEDRIG: Impressum/Datenschutz noch Platzhalter
DSGVO/TMG-Pflicht in DE. Vor Go-Live mit Inhalten fuellen (Verantwortlicher, Postanschrift, Datenschutzbeauftragter falls relevant).

---

## 7. Verbleibende Tech-Debt (keine Bloecker)

- Frontend dupliziert immer noch ein `SALON_HOURS`-Objekt als Default (wird aber von `/api/salon` ueberschrieben sobald geladen) -- nicht entfernen, denn ohne Fallback wuerde der Live-Status NICHT funktionieren bevor `/api/salon` antwortet
- `routes/storno.js` hat seinen eigenen Error-Handler (HTML statt JSON); die zentrale Error-Middleware im server.js wird nicht erreicht
- Tests koennten parallelisiert werden (aktuell node:test mit `default sequential`), aber 186 Tests in 0.5s ist kein Problem
- `salon.config.json`-Schema-Validation (z.B. via Ajv) waere productization-grade, aber `pg`-only-policy verbietet neue Deps
- Backup-Files im JSON-Mode landen jetzt korrekt gitignored, aber wer JSON-Mode lokal nutzt sammelt sie -- evtl. Retention-Cleanup beim Boot

---

## 8. Empfohlene naechste Prioritaeten (in Reihenfolge)

1. **PR mergen** (`feat/persistent-storage-neon` -> `main`)
2. **Neon-Account anlegen** (gratis, <5 Min) + `DATABASE_URL` in Render setzen
3. **Resend-Domain verifizieren** (`friseursalon-henkes.de` falls vorhanden)
4. **UptimeRobot-Monitor** auf HEAD `/api/health` setzen (gratis, 5 Min, kostet nichts)
5. **Impressum + Datenschutz mit Inhalten fuellen**
6. **PII aus git-History scrubben** (siehe Risiken)
7. **Erster Real-Traffic-Test**: 1-2 echte Buchungen testen, Mails kommen an, Storno-Link funktioniert

---

## 9. Empfohlene Deployment-Schritte

```bash
# 1. Lokal final pruefen
npm test            # muss 186/186 zeigen
npm start           # http://localhost:3000 -> Buchung manuell durchtesten

# 2. PR mergen
gh pr merge feat/persistent-storage-neon --squash
# oder via Web-UI auf GitHub

# 3. Neon Postgres (5 Min)
#    - https://neon.tech registrieren
#    - Project "henkes" erstellen (Region: eu-central-1)
#    - Connection-String kopieren

# 4. Render-Env-Vars setzen
#    Dashboard -> friseursalon-henkes-backend -> Environment
#    NEU:    DATABASE_URL  =  postgresql://...neon.tech/neondb?sslmode=require
#    PRUEF:  RESEND_API_KEY, SALON_EMAIL, ADMIN_USER, ADMIN_PASSWORD, CRON_SECRET vorhanden
#    OPTIONAL: PUBLIC_BASE_URL = https://friseursalon-henkes-backend.onrender.com
#    OPTIONAL: EMAIL_FROM      = Friseursalon Henkes <noreply@yourdomain.de>

# 5. Render redeployen (automatisch beim Merge wenn auto-deploy an)
#    Logs schauen: 
#      "storage_engine engine=postgres"
#      "schema_initialized"
#      "appointments_import skipped=true" (kein alter JSON da)

# 6. Smoke-Test live
curl https://friseursalon-henkes-backend.onrender.com/api/health | jq '.storage.engine'
# -> "postgres"
curl https://friseursalon-henkes-backend.onrender.com/api/salon | jq '.services[0]'
# -> {"name": "Haarschnitt", "durationMinutes": 45}

# 7. Eine echte Buchung im Browser testen
#    -> Admin oeffnen, Termin sollte da sein
#    -> Bestaetigen, Mail an Kunden muss ankommen
#    -> Storno-Link in der Mail klicken, Stornierung muss funktionieren

# 8. UptimeRobot anlegen
#    HEAD https://friseursalon-henkes-backend.onrender.com/api/health
#    alle 5 Min -- hilft Render Free-Tier wach zu halten
```

---

## 10. Beste Produkt-Ideen fuer die Zukunft (Friseur-Saas-Plattform)

Wenn der Wunsch besteht, das hier zur **Multi-Salon-Plattform** zu skalieren -- in Reihenfolge realistischer Impact pro Aufwand:

### Quick Wins (1-2 Tage je)
1. **`salon.config.json` per URL-Pfad** (`/[salonId]/...`) -- ein einziges Deployment hostet mehrere Salons. Schon halb gemacht: Daten + Stunden + Services kommen aus der JSON.
2. **Customer-Login mit Magic-Link** statt Storno-Token. Nutzer kann seine Termine sehen und umbuchen.
3. **SMS-Erinnerung optional** (Twilio kostet ~$0.05/SMS). Bessere Conversion als Mail-Reminder bei zb 50% mehr no-show-Verhinderung.
4. **Stripe-Anzahlung bei riskanten Slots** (Färbung, Strähnen -- 2h+ Bindung). 10€ Anzahlung, voll anrechenbar -- killt 90% der No-Shows.

### Mittlere Ausbaustufen (1 Woche je)
5. **Stylistin-Kalender** -- multiple Stylistinnen pro Salon, Termine pro Stylistin, getrennte Kalender, Slot-Konflikt richtig blockieren.
6. **Wiederkehrende Termine** ("alle 6 Wochen Haarschnitt") -- Kunden bestellen die naechste Buchung mit 1 Klick.
7. **Google-Maps Auto-Wegbeschreibung** im Bestaetigungs-Mail (deep link).
8. **WhatsApp-Bot via Twilio** -- "Hallo, hier ist Salon Henkes, dein Termin morgen 10:00 -- noch Fragen?" antwortbar.

### Big Bets (2-4 Wochen je)
9. **Foto-Upload "so soll mein Haar aussehen"** -- Kunden laden Inspiration hoch, Salon sieht's vor dem Termin und kann sich vorbereiten.
10. **Stammkunden-System** -- "10. Haarschnitt gratis" automatisch, ohne dass jemand zaehlt.
11. **Multi-Salon-Marketplace** ("Friseur in Gelsenkirchen") -- aus dem Single-Salon-Repo wird eine Allesfresser-Plattform, Yelp-aehnlich aber fokussiert.

---

## TL;DR fuer den Morgen-Kaffee

Branch `feat/persistent-storage-neon` ist stabiler als gestern Abend:
- **+41 Tests** (jetzt 186/186 gruen)
- **+21 atomic commits**, alle gepusht
- **2 reale Bugs** gefunden + behoben (sync-throw escape, body-parser 500-statt-400)
- **Kunden-PII** aus git-Index entfernt (History noch zu putzen, siehe Risiken)
- **Frontend** hat jetzt Live-Validierung BEVOR submit (kein "ups, Sonntag")
- **Admin** hat Quick-Stats, Date-Range-Filter, Keyboard-Shortcuts
- **Postgres** hat statement_timeout, Cron-Endpoint hat Rate-Limit

Naechster Schritt: PR mergen, Neon anbinden, Resend-Domain verifizieren, live gehen. Siehe Abschnitt 9 fuer die Schritte.

Gute Erholung. -- Claude
