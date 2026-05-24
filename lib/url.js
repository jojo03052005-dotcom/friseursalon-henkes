/**
 * URL-Helfer.
 */

/**
 * Basis-URL fuer Stornier-Links: env-var hat Vorrang (Production),
 * sonst aus Request ableiten (Dev).
 *
 * Production-Hinweis: PUBLIC_BASE_URL sollte in Render gesetzt sein,
 * damit Mails immer die korrekte oeffentliche URL nennen, auch wenn
 * Render-internal-Hostnames in den X-Forwarded-Headern stehen.
 */
function deriveBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL?.trim()) {
    return process.env.PUBLIC_BASE_URL.trim();
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${proto}://${host}` : "";
}

module.exports = {
  deriveBaseUrl,
};
