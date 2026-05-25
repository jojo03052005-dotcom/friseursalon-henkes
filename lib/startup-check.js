/**
 * Startup-Config-Validation.
 *
 * Wird beim Server-Start aufgerufen und gibt Warnungen aus, wenn die
 * Production-Konfiguration unvollstaendig oder unsicher ist. Crasht nie --
 * der Server soll auch ohne perfekte Config starten koennen, damit der
 * Operator das Problem im Admin-Panel oder per Mail melden kann statt
 * vor einem schwarzen Bildschirm zu stehen.
 *
 * Aufrufer: server.js direkt nach dem Listener-Start.
 */

const logger = require("./logger").child("startup");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Liste der Pflicht-Env-Vars in Production.
 * In Dev werden fehlende Werte tolerant behandelt -- der Salon
 * kriegt halt keine Mails / Admin geht nicht.
 */
const REQUIRED_IN_PROD = [
  { name: "RESEND_API_KEY", reason: "Sonst gehen keine Bestaetigungs-/Erinnerungs-Mails raus." },
  { name: "SALON_EMAIL", reason: "Sonst weiss der Salon nichts von neuen Anfragen." },
  { name: "ADMIN_USER", reason: "Ohne diesen Wert ist /admin.html komplett gesperrt (fail-closed)." },
  { name: "ADMIN_PASSWORD", reason: "Ohne diesen Wert ist /admin.html komplett gesperrt (fail-closed)." },
];

/**
 * Empfohlene aber optionale Vars (Warnung in Production).
 */
const RECOMMENDED_IN_PROD = [
  {
    name: "EMAIL_FROM",
    reason:
      "Default 'onboarding@resend.dev' ist Resend-Sandbox -- Mails landen oft im Spam. Eigene Domain bei Resend verifizieren.",
  },
  {
    name: "PUBLIC_BASE_URL",
    reason:
      "Storno-Links in Mails koennten auf falsche URL zeigen, wenn Render-Headers nicht stimmen.",
  },
  {
    name: "CRON_SECRET",
    reason:
      "Ohne diesen Wert ist /api/cron/daily-digest deaktiviert. Konsequenz: keine Tageserinnerung an den Salon, kein Pre-Warm.",
  },
];

/**
 * Prueft Passwort-Qualitaet (sehr permissiv). Wer in seinem .env
 * "password" oder "admin" oder "1234" als Admin-Passwort steht, kriegt
 * eine Warnung -- aber wir blockieren NICHT, falls jemand bewusst
 * lokal ein einfaches Passwort nimmt.
 */
function isWeakPassword(value) {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (v.length < 12) return true;
  const blocklist = ["password", "admin", "henkes", "friseur", "1234", "secret"];
  return blocklist.some((b) => v.includes(b));
}

/**
 * Macht den Self-Check. Logged Warnungen/Fehler aber wirft NIE.
 * Liefert ein { errors, warnings, ok }-Objekt zurueck (fuer Tests).
 */
function runStartupCheck() {
  const errors = [];
  const warnings = [];

  for (const { name, reason } of REQUIRED_IN_PROD) {
    if (!process.env[name]?.trim()) {
      if (IS_PRODUCTION) {
        errors.push({ name, reason });
      } else {
        warnings.push({ name, reason });
      }
    }
  }

  if (IS_PRODUCTION) {
    for (const { name, reason } of RECOMMENDED_IN_PROD) {
      if (!process.env[name]?.trim()) {
        warnings.push({ name, reason });
      }
    }

    if (isWeakPassword(process.env.ADMIN_PASSWORD)) {
      warnings.push({
        name: "ADMIN_PASSWORD",
        reason: "Passwort scheint kurz oder offensichtlich. Bitte mind. 12 Zeichen und Passwort-Manager-Format.",
      });
    }
  }

  errors.forEach((e) =>
    logger.error("config_required_missing", { var: e.name, reason: e.reason })
  );
  warnings.forEach((w) =>
    logger.warn("config_warning", { var: w.name, reason: w.reason })
  );

  if (errors.length === 0 && warnings.length === 0) {
    logger.info("config_check_passed", {
      env: process.env.NODE_ENV || "development",
    });
  }

  return { errors, warnings, ok: errors.length === 0 };
}

module.exports = { runStartupCheck, isWeakPassword };
