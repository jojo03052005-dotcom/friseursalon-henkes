# Betriebs-Handbuch fuer den Salon

Praktische Anleitung fuer den Alltag mit der Website und dem Admin-Panel.
Wenn etwas nicht passt: erst hier nachschauen, dann anrufen / fragen.

## 1. Wo ist was?

| Was | URL |
|-----|-----|
| Oeffentliche Salon-Seite | <https://friseursalon-henkes-website.netlify.app/> |
| Admin-Panel (Terminliste) | <https://friseursalon-henkes-backend.onrender.com/admin.html> |
| Status-Check (technisch) | <https://friseursalon-henkes-backend.onrender.com/api/health> |

Den Admin-Link im Browser als Lesezeichen speichern -- dann ist er immer
einen Klick weit weg.

## 2. Anmelden im Admin-Panel

Beim Aufruf von `/admin.html` poppt ein Browser-Dialog auf:

- **Benutzername** und **Passwort** wurden bei der Einrichtung im
  Render-Dashboard gesetzt (Variablen `ADMIN_USER` / `ADMIN_PASSWORD`).
- Beim ersten Login Chrome auf "Passwort speichern" klicken -- dann
  ist es danach automatisch ausgefuellt.
- **Passwort vergessen?** Im Render-Dashboard unter Environment
  `ADMIN_PASSWORD` neu setzen, ~1 Min auf den Redeploy warten, dann
  geht's wieder.

## 3. Tagesablauf

### Morgens

Wenn der Cron-Job (siehe Setup unten) eingerichtet ist, kommt ein
Tages-Mail an die Salon-Adresse mit den heutigen Terminen.

Sonst: einfach Admin-Panel oeffnen, Filter "Bestaetigt" anklicken,
nach Datum filtern. Heutige Termine sind oben.

### Wenn eine neue Anfrage reinkommt

Du bekommst sofort eine E-Mail "Neue Terminanfrage: NAME -- DATUM".
Im Admin-Panel taucht sie als **Ausstehend** auf (gelbes Badge).

**Schritte:**

1. Admin-Panel oeffnen, ggf. "Neu laden" klicken.
2. Pruefen ob der Slot passt (achten auf rotes "Slot-Konflikt"-Badge!).
3. Entweder:
   - **Bestaetigen** -- Kunde kriegt eine Bestaetigungs-Mail + 24 h
     vorher automatisch eine Erinnerung.
   - **Ablehnen** -- Kunde kriegt eine hoefliche Absage mit Bitte, einen
     anderen Termin anzufragen.

### Wenn ein Kunde anruft "ich kann doch nicht"

Drei Optionen:

1. **Am besten:** Kunden bitten, in seiner Bestaetigungs-Mail unten den
   "Termin stornieren"-Button zu klicken. Dann ist alles automatisch
   sauber (Reminder wird gestoppt, du kriegst eine Info-Mail).
2. **Schneller:** Im Admin-Panel den Termin suchen und auf **"Absagen"**
   klicken. Kunde bekommt eine entschuldigende Mail, der Reminder wird
   gestoppt.
3. **Falls's egal ist:** "Loeschen"-Button. Achtung: keine Mail an den
   Kunden!

### Wenn DU absagen musst (Krankheit, Stylistin ausgefallen)

Im Admin-Panel den Termin suchen, **"Absagen"** klicken. Der Kunde
bekommt eine Mail "Wir muessen leider absagen, bitte nimm einen neuen
Termin".

## 4. Status-Bedeutung

| Badge | Was es heisst | Was tun? |
|-------|---------------|----------|
| **Ausstehend** | Anfrage da, wartet auf deine Entscheidung | Bestaetigen oder Ablehnen |
| **Bestaetigt** | Termin steht, Kunde hat Mail bekommen | Nichts -- 24 h vorher gibt's automatisch eine Erinnerung |
| **Abgelehnt** | Du hast die Anfrage abgesagt | Nichts |
| **Storniert** | Kunde hat selbst storniert (oder du hast "Absagen" geklickt) | Nichts |

## 5. Warnzeichen

### "Slot-Konflikt"-Badge

Heisst: zur exakt gleichen Uhrzeit gibt es schon einen anderen offenen
oder bestaetigten Termin. Maus drueber halten zeigt mit wem.

**Was tun:** Pruefen ob das ein Problem ist (z.B. zwei Kund:innen, eine
Stylistin = Problem; zwei Kund:innen, zwei Stylistinnen = ok). Wenn
Konflikt: einen ablehnen, anrufen und verschieben.

### "Eingangs-Mail teilweise fehlgeschlagen" / "Bestaetigungs-Mail fehlgeschlagen"

Heisst: die Bestaetigung an den Kunden oder die Info an den Salon ist
nicht durchgegangen. Maus drueber zeigt den Grund.

**Haeufige Ursachen:**

- **Resend-Sandbox-Modus:** wenn `EMAIL_FROM` noch auf der Default-
  Adresse `onboarding@resend.dev` steht, koennen Mails nur an die bei
  Resend registrierte Adresse gehen. Loesung: eigene Domain bei Resend
  verifizieren (DNS-Records eintragen), dann `EMAIL_FROM` im
  Render-Dashboard setzen.
- **Resend-API-Key falsch:** im Render-Dashboard unter Environment
  pruefen.
- **Kontingent ueberschritten:** Resend Free-Tier hat ein Mail-Limit
  pro Monat. Bei einem aktiven Salon irgendwann notwendig zu upgraden.

### Server wird nicht erreicht

Wenn die Buchungsseite hakt: ist Render Free Tier, schlaeft nach
15 Min ohne Traffic. Erster Klick wartet 30-60 Sek auf den Aufwach-
Vorgang ("Cold Start").

**Workaround:** der Tages-Cron weckt den Server jeden Morgen.
**Langfristig:** Render Starter Plan ($7/Monat) -- kein Cold Start mehr.

## 6. Tageserinnerung einrichten (einmalig)

So bekommst du morgens eine Mail mit den heutigen Terminen, und der
Server wird gleichzeitig aufgeweckt:

1. **CRON_SECRET generieren** -- irgendeine lange zufaellige Zeichen-
   kette. Im Render-Dashboard unter Environment -> Add Variable:
   `CRON_SECRET=DEINE_ZUFAELLIGE_ZEICHENKETTE`.

2. **cron-job.org** (kostenlos) -- Account anlegen, dann "Create
   cronjob":
   - **URL:** `https://friseursalon-henkes-backend.onrender.com/api/cron/daily-digest?secret=DEINE_ZUFAELLIGE_ZEICHENKETTE`
   - **Schedule:** jeden Tag um 07:00 (Berliner Zeit)
   - **Save**

3. **Testen:** auf cron-job.org einmal "Run now" -- du solltest sofort
   die Mail "Heute, [Datum]: X Termine" bekommen.

## 7. Wartung & Aufraeumen

Alte erledigte Termine bleiben in der Liste stehen. Wenn's zu voll
wird: Filter "Erledigt" und einzelne mit "Loeschen" wegklicken.
Bestaetigte alte Termine genauso, wenn der Tag vorbei ist.

**Achtung:** "Loeschen" sendet keine Mail und ist permanent.

## 8. Hilfe holen

Bei technischen Problemen, die ueber das hier hinausgehen:

- **Render-Status:** <https://status.render.com>
- **Resend-Status:** <https://status.resend.com>
- **Logs:** Render-Dashboard -> Logs -- zeigt Fehler vom Server in
  Echtzeit.

Wenn alles brennt: kurze Notiz an den/die Entwickler:in mit Screenshot.
