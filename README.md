# Friseursalon Henkes – Website & Terminbuchung

Statische Website mit Express-Backend, JSON-Speicher und E-Mail-Benachrichtigung per Nodemailer.

## Server starten

```bash
npm install
npm start
```

Falls `npm` nicht im PATH liegt (Windows):

```bash
"C:\Program Files\nodejs\npm.cmd" install
"C:\Program Files\nodejs\npm.cmd" start
```

Alternativ: **`start.bat`** doppelklicken.

| Seite | URL |
|--------|-----|
| Website | http://localhost:3000/ |
| Terminbuchung | http://localhost:3000/#termin |
| Admin | http://localhost:3000/admin.html |

> Die Seite muss über den Server geöffnet werden – nicht per Doppelklick auf `index.html`.

---

## E-Mail einrichten (Gmail SMTP)

### 1. `.env` anlegen

Kopieren Sie `.env.example` nach `.env` und tragen Sie ein:

```env
EMAIL_USER=ihre-adresse@gmail.com
EMAIL_PASS=ihr-16-stelliges-app-passwort
SALON_EMAIL=empfang@ihr-salon.de
```

| Variable | Bedeutung |
|----------|-----------|
| `EMAIL_USER` | Gmail-Adresse, die E-Mails versendet |
| `EMAIL_PASS` | **App-Passwort** (nicht Ihr normales Gmail-Passwort) |
| `SALON_EMAIL` | Empfänger für Salon-Benachrichtigungen |

### 2. Gmail App-Passwort erstellen

1. Google-Konto → **Sicherheit**
2. **Zwei-Faktor-Authentifizierung** aktivieren
3. **App-Passwörter** → App „Mail“, Gerät „Windows“
4. Das 16-stellige Passwort in `EMAIL_PASS` eintragen (ohne Leerzeichen)

### 3. Server neu starten

Nach Änderungen an `.env` den Server stoppen (`Strg+C`) und erneut `npm start` ausführen.

---

## Outlook / Microsoft 365

```env
EMAIL_USER=ihre-adresse@outlook.de
EMAIL_PASS=ihr-passwort-oder-app-passwort
SALON_EMAIL=empfang@ihr-salon.de
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
```

Bei Microsoft-Konten ggf. ebenfalls ein App-Passwort verwenden, wenn die normale Anmeldung blockiert wird.

---

## Was passiert bei einer Buchung?

1. Termin wird in `data/appointments.json` gespeichert
2. **Bestätigungs-E-Mail** an die Kunden-E-Mail (HTML, Salon-Design)
3. **Benachrichtigung** an `SALON_EMAIL`
4. Erfolgsmeldung im Formular nur, wenn beide E-Mails versendet wurden

Im **Admin** sehen Sie Kunden-E-Mail und Versandstatus (gesendet / teilweise / fehlgeschlagen).

---

## Projektstruktur

```
server.js              # Express-API
services/emailService.js
data/appointments.json
.env                   # Zugangsdaten (nicht committen)
index.html / admin.html
```
