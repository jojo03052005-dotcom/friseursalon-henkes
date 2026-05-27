/**
 * Tests fuer lib/url.js -- Base-URL-Ableitung fuer Storno-Mails.
 *
 * Wichtig weil ein falscher Base-URL -> der Kunde klickt den Storno-
 * Link und landet auf der Render-internal-URL oder localhost statt
 * der echten Domain.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveBaseUrl } = require("../lib/url");

/** Fake-Request mit Get-Header. */
function makeReq({ headers = {}, protocol = "http" } = {}) {
  return {
    protocol,
    get(name) {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) return v;
      }
      return undefined;
    },
  };
}

test("deriveBaseUrl: PUBLIC_BASE_URL wins over request", () => {
  process.env.PUBLIC_BASE_URL = "https://example-prod.com";
  try {
    const req = makeReq({ headers: { host: "irrelevant.local" } });
    assert.equal(deriveBaseUrl(req), "https://example-prod.com");
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test("deriveBaseUrl: trims whitespace in PUBLIC_BASE_URL", () => {
  process.env.PUBLIC_BASE_URL = "   https://trimmed.example.com   ";
  try {
    const req = makeReq();
    assert.equal(deriveBaseUrl(req), "https://trimmed.example.com");
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test("deriveBaseUrl: falls back to req protocol + host", () => {
  const req = makeReq({
    protocol: "https",
    headers: { host: "localhost:3000" },
  });
  assert.equal(deriveBaseUrl(req), "https://localhost:3000");
});

test("deriveBaseUrl: x-forwarded-proto/host (Render-Reverse-Proxy)", () => {
  const req = makeReq({
    protocol: "http", // Render terminiert TLS und reicht http intern weiter
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "friseursalon-henkes-backend.onrender.com",
      host: "internal.render.local",
    },
  });
  assert.equal(
    deriveBaseUrl(req),
    "https://friseursalon-henkes-backend.onrender.com"
  );
});

test("deriveBaseUrl: leerer host -> leerer string (defensiv)", () => {
  const req = makeReq({ headers: {} });
  assert.equal(deriveBaseUrl(req), "");
});

test("deriveBaseUrl: ignoriert leeres PUBLIC_BASE_URL (only whitespace)", () => {
  process.env.PUBLIC_BASE_URL = "   ";
  try {
    const req = makeReq({
      protocol: "https",
      headers: { host: "fallback.example.com" },
    });
    // Whitespace-only PUBLIC_BASE_URL muss IGNORIERT werden -- sonst
    // bekommen Kunden Stornier-Links mit leerem Host.
    assert.equal(deriveBaseUrl(req), "https://fallback.example.com");
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});
