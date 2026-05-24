# Naechste Schritte / Backlog

Lebende Liste. Was abgehakt ist, kann in den Notizen bleiben oder geloescht werden.

## Bevor irgendwas anderes passiert (deine TODOs nach PR #8 Merge)

- [ ] **PR #8 mergen** -- die Sammelung aller bisherigen Verbesserungen.
- [ ] **`PUBLIC_BASE_URL`** in Render setzen auf `https://friseursalon-henkes-backend.onrender.com`. Sonst zeigen Stornier-Links in Mails ggf. auf die falsche Domain.
- [ ] **Impressum + Datenschutz** ausfuellen (`[PLATZHALTER]` in `impressum.html` und `datenschutz.html`).
- [ ] **`CRON_SECRET`** in Render setzen + bei [cron-job.org](https://cron-job.org) Account anlegen + Cronjob auf `https://friseursalon-henkes-backend.onrender.com/api/cron/daily-digest?secret=DEIN_SECRET` taeglich 07:00.
- [ ] **Erste Backups runterladen** -- im Admin oben rechts der "Backup ↓"-Button. Mach das einmal pro Woche, speichere die Datei woanders (Dropbox, Mail an dich selbst, USB-Stick).
- [ ] **`data/closed-days.json` pflegen** -- vor Weihnachten Feiertage eintragen, vor Sommer Betriebsferien.

## Code-TODOs fuer den naechsten Schub

### Hoch (echtes Risiko / hoher Nutzen)

- [ ] **Persistente DB statt JSON.** Optionen:
  - **Render Disk** (~1$/Mo) -- minimaler Change, JSON bleibt
  - **SQLite-on-Disk** (besser fuer mehr Daten + Transaktionen)
  - **Postgres** (Supabase free / Neon free / Render Postgres)
  - Empfehlung: erst Render Disk -- billiger Wechsel mit grossem Effekt.
- [ ] **Resend-Domain verifizieren.** Solange `EMAIL_FROM` auf `onboarding@resend.dev` steht, landen viele Mails im Spam. DNS-Eintrag bei der Domain-Verwaltung setzen, dann `EMAIL_FROM=Friseursalon Henkes <noreply@DEINE-DOMAIN.de>` in Render.

### Mittel (Nice-to-have, klar definiert)

- [ ] **Salon-Tagesansicht im Admin** -- "Heute / Morgen / Diese Woche"-Tabs statt nur Statusfilter. Aktuell sortiert nach Datum/Uhrzeit aufsteigend, das reicht oft nicht.
- [ ] **Mehrere Stylistinnen** -- Termine mit Stylistin-Feld, damit Konflikt-Check pro Person statt pro Slot. Aktuell warnt der Server bei Slot-Konflikt auch wenn zwei Stylistinnen parallel arbeiten koennten.
- [ ] **Service-Dauer pro Termin editierbar im Admin** -- aktuell hartkodiert in `SERVICE_DURATIONS_MINUTES` in emailService.js (fuer den ICS-Eintrag). Wenn der Salon mal 90 Min fuer eine Faerbung braucht, mal 120, sollte das pro Termin gehen.
- [ ] **Suche im Admin** -- Volltextsuche nach Name/Telefon/E-Mail (gerade wichtig, wenn 100+ Termine in der Liste sind).
- [ ] **CSV-Export** im Admin (zusaetzlich zum JSON-Backup, fuer Excel).
- [ ] **Tests** -- Jest mit Tests fuer `validateAppointment`, `getReminderTime`, `buildICSAttachment`. War im Plan, immer aufgeschoben.
- [ ] **Strukturiertes Logging** (pino) statt console.log. Macht Render-Logs lesbarer.

### Niedrig / Polish

- [ ] **Cookie-Banner** nur wenn wir Analytics/Marketing-Tools einbinden. Aktuell brauchen wir keinen (kein Tracking).
- [ ] **OG-Image hochladen** -- der Pfad `/og-image.jpg` in den Meta-Tags zeigt aktuell auf eine Datei, die's nicht gibt. Ein nettes Foto vom Salon (1200x630) als `og-image.jpg` ins Root, fertig.
- [ ] **Schema.org Stylist-Reviews** -- die 6 Reviews aus index.html als `Review`-Objekte im JSON-LD, dann zeigt Google sie in den Suchergebnissen mit Sternen.
- [ ] **PWA-Manifest** + `apple-touch-icon` -- damit "Zum Startbildschirm hinzufuegen" auf dem iPhone schoen aussieht.
- [ ] **Print-Stylesheet** -- damit die Bestaetigungs-Seite im Admin sauber druckbar ist.
- [ ] **CSS- und JS-Minifizierung** -- braucht aktuell keinen Build-Schritt; wenn wir mal einen einbauen, dabei.
- [ ] **CSP mit Nonce** -- die helmet-CSP haben wir bewusst aus gelassen wegen inline-`<style>` in Storno-Seiten und admin. Mit Nonce-Strategie nachruesten.
- [ ] **Light/Dark-Mode** -- Salon-Design hat klar warme/helle Palette, ein Dark-Mode waere ein netter Bonus.

## Erkannte Limits (kein Bug, aber gut zu wissen)

- **Render Free Tier** schlaeft nach 15 Min Idle. Cold Start 30-60 Sek. Workarounds: cron-pinger (machen wir mit dem Daily Digest), Render Starter ($7/Mo) -> kein Schlaf.
- **Resend Free Tier**: 3000 Mails/Monat, 100/Tag. Bei einem aktiven Salon mit 5-10 Terminen/Tag werden's pro Termin 3 Mails (Anfrage-Kunde, Anfrage-Salon, Bestaetigung) + 1 Reminder = 4 Mails. 10 Termine/Tag = 40 Mails = 1200/Monat. Reicht. Wenn mehr -> Resend Pro (20$).
- **Render Disk** ist persistent, aber wenn Free-Service deleted wird, gehen die Daten auch. Backup-Endpoint ist unsere Versicherung.

## Sammlung der heute eingebauten Verbesserungen

(Was gestern + heute bereits gemacht ist, nur als Referenz)

- Hardening: helmet, rate-limit, Dedupe, trust proxy, Honeypot
- Validation: Sonntag/Montag zu, Samstag 14:00, 15-Min-Raster, 60-Min-Vorlauf, 90-Tage-Horizon, Schliesstage-Datei
- Admin: Confirm/Decline/Cancel/Delete + Filter + Mobile Card-Layout + Konflikt-Badge + Backup-Button
- Mails: Confirmed/Decline/Admin-Cancel-Templates + 24h-Reminder via Resend scheduledAt + Tages-Digest + ICS-Anhang
- SEO: Schema.org HairSalon, OG-Tags, Twitter Card, sitemap.xml, robots.txt
- A11y: Skip-Link, Focus-Visible, ARIA-Required
- UX: Cold-Start-Hints, Pre-Warm-Ping, freundliche 404-Seite
- Doku: README, BETRIEB.md, NEXT.md (diese Datei)
- Legal: Impressum + Datenschutz Stubs
- CORS: Pattern fuer Netlify-Previews + Branch-Deploys
- DRY: GET /api/services -> Frontend syncing
