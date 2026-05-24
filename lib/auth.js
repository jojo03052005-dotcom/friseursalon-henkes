/**
 * Admin-Authentifizierung via HTTP Basic Auth.
 *
 * Bewusst Basic Auth -- kein Session-/Cookie-Geraffel, keine
 * Login-Seite, der Browser merkt sich die Credentials fuer die
 * Session. Genug fuer einen 1-Person-Salon mit gelegentlichem Login.
 *
 * Wichtige Sicherheitsdetails:
 *   - String-Vergleich konstantzeit (timingSafeEqual + Laengen-Dummy)
 *   - Wenn ADMIN_USER/PASSWORD nicht gesetzt sind -> 503 statt offen
 *     (fail-closed, NIE versehentlich freischalten)
 *   - Realm im Challenge-Header, charset UTF-8 fuer Umlaute
 */

const { timingSafeEqual } = require("crypto");
const logger = require("./logger").child("auth");

/**
 * Konstantzeit-Vergleich zweier Strings. Bei unterschiedlicher Laenge
 * wird trotzdem ein Dummy-Vergleich gegen einen gleichlangen Nullbuffer
 * ausgefuehrt, damit kein Timing-Leak ueber die Laenge entsteht.
 */
function safeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""), "utf8");
  const bBuf = Buffer.from(String(b ?? ""), "utf8");
  if (aBuf.length !== bBuf.length) {
    // Dummy-Vergleich gleicher Laenge, Ergebnis verwerfen.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function sendAuthChallenge(res, status, message) {
  res.setHeader(
    "WWW-Authenticate",
    'Basic realm="Friseursalon Henkes Admin", charset="UTF-8"'
  );
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

/**
 * Express-Middleware: schuetzt Admin-Routen per HTTP Basic Auth.
 *
 * Erwartet ADMIN_USER und ADMIN_PASSWORD in den Umgebungsvariablen.
 * Fehlen die Vars -> 503 (fail-closed, damit Admin nicht aus
 * Versehen offen ist).
 */
function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER?.trim();
  const expectedPass = process.env.ADMIN_PASSWORD?.trim();

  if (!expectedUser || !expectedPass) {
    return res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send(
        "Admin-Login ist nicht konfiguriert. Bitte ADMIN_USER und ADMIN_PASSWORD in den Render-Env-Vars setzen."
      );
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    return sendAuthChallenge(res, 401, "Anmeldung erforderlich.");
  }

  let user = "";
  let pass = "";
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) {
      user = decoded.slice(0, colon);
      pass = decoded.slice(colon + 1);
    }
  } catch (_err) {
    return sendAuthChallenge(res, 401, "Ungueltige Anmeldedaten.");
  }

  const userOk = safeStringEqual(user, expectedUser);
  const passOk = safeStringEqual(pass, expectedPass);

  if (!userOk || !passOk) {
    // Bewusst kein loggen des versuchten Usernames -- waere PII fuer
    // einen geleakten Wert, und gibt einem Angreifer nur Bestaetigung
    // dass der Endpoint existiert.
    logger.warn("admin_auth_failed", { ip: req.ip });
    return sendAuthChallenge(res, 401, "Falsche Anmeldedaten.");
  }

  return next();
}

module.exports = {
  safeStringEqual,
  sendAuthChallenge,
  requireAdminAuth,
};
