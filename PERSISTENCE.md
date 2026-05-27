# Persistenz-Architektur

## Warum gibt's das?

Render Free-Tier hat **kein** persistentes Filesystem. Bei jedem Deploy oder Auto-Restart (passiert oft) wird `data/appointments.json` zurückgesetzt — alle Termine weg. Render Disks lösen das, brauchen aber Starter-Plan ($7/Monat).

Die Lösung in diesem Repo: **kostenloses Neon Postgres** als optionale Production-Persistenz, automatischer Fallback auf JSON-Datei für lokale Entwicklung.

## Architektur-Entscheidung

| Frage | Antwort | Warum |
|---|---|---|
| Welche DB? | **Neon Postgres** | Free-Tier 500MB ist 50× mehr als wir je brauchen, eu-central-1 nahe Render, eingebaute Branching für Test/Prod, gute API-Stabilität |
| ORM? | **Nein, pures `pg`** | 2 Tabellen, ~30 Zeilen SQL. Prisma/Drizzle wären 5× mehr Code, 50× mehr Build-Komplexität |
| Schema? | **JSONB statt Spalten** | Appointment-Form ändert sich oft (Status-Felder, conflictsWith, idempotencyKey…). JSONB heißt: keine Migrations bei Code-Änderungen |
| Engine-Switch? | **`DATABASE_URL` gesetzt = Postgres, sonst JSON** | Zero-Config für Tests + Dev, ein Env-Var für Production |

## Wo lebt was

```
lib/db.js       Postgres-Layer (Pool, Schema-Init, SQL-Queries).
                Wird nur angefasst wenn DATABASE_URL gesetzt ist.
lib/storage.js  Engine-Switch: routes/* sehen identische API egal ob JSON/DB.
lib/migrate.js  Einmal-Import von appointments.json -> DB beim ersten Boot.
lib/backup.js   Im Postgres-Mode automatisch deaktiviert (DB hat eigene Backups).
```

## Schema

```sql
CREATE TABLE appointments (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX appointments_cancel_token_idx
  ON appointments ((data->>'cancelToken'));

CREATE INDEX appointments_idempotency_key_idx
  ON appointments ((data->>'idempotencyKey'))
  WHERE data->>'idempotencyKey' IS NOT NULL;

CREATE INDEX appointments_dedupe_idx
  ON appointments (
    (LOWER(data->>'email')),
    (data->>'date'),
    (data->>'time'),
    (data->>'service')
  );

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
```

`appointments.data` enthält das vollständige Termin-Objekt (selbe Form wie in der alten JSON-Datei). Indexe decken die häufigsten Zugriffsmuster ab:
- Storno per Token
- Idempotency-Replay-Check
- Doppel-Submit-Dedupe

`settings` hält aktuell `closed_days` (Feiertage/Betriebsferien).

## Lebenszyklus

```
Server-Start
    ↓
DATABASE_URL gesetzt?
  ├── nein → JSON-Mode (lib/storage.js liest/schreibt Datei)
  └── ja   → Postgres-Mode
              ↓
         Pool öffnen, Schema sicherstellen (idempotent)
              ↓
         appointments.json existiert + DB leer?
           ├── ja  → einmal importieren
           └── nein → skip
              ↓
         Boot-OK, requests werden bedient
              ↓
         SIGTERM bei Deploy → Pool sauber schließen
```

## Recovery / Backup im Postgres-Mode

- **Crash-Recovery**: macht Postgres selbst (WAL, transaktional)
- **Point-in-Time-Recovery**: Neon Free-Tier hält 7 Tage History (Dashboard → Branches → "Restore to point in time")
- **Off-Site-Backup**: `pg_dump` via lokales Script ODER weiter den `/api/admin/backup` Endpoint nutzen (zieht jetzt aus der DB statt aus Datei)
- **Auto-Recovery aus Datei-Backup**: im Postgres-Mode deaktiviert (Postgres recovert selbst). Falls Daten weg sind: PITR im Neon-Dashboard

## Failure-Modi & was passiert

| Was passiert | Verhalten |
|---|---|
| Neon down | `/api/health` zeigt `storage.writable: false` + `warnings`. POST /api/appointments antwortet 500 mit klarer Message. Kunde wird gebeten anzurufen. |
| `DATABASE_URL` falsch | Boot-Diagnostik loggt `storage_not_writable`. Server läuft trotzdem (kein Crash-Loop), aber Buchungen scheitern. |
| Connection-Timeout (transient) | pg-Pool retries automatisch. Bei Erfolg: nichts. Bei Failure: 500 mit erklärendem Log. |
| Neon Free-Tier-Suspend nach Inaktivität | Erste Query nach Idle dauert 2-3s (Auto-Resume). Frontend Pre-Warm-Ping deckt das ab. |

## Migration zurück (falls je nötig)

`DATABASE_URL` in Render entfernen → Server-Restart → läuft im JSON-Mode auf ephemerem FS. **Daten in der DB bleiben unangefasst** — wenn du später wieder Postgres aktivierst, sind sie wieder da.

Für sauberen Export aus Postgres in eine JSON-Datei: `/api/admin/backup` aufrufen — der Endpoint funktioniert engine-agnostisch.
