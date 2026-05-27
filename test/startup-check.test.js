const test = require("node:test");
const assert = require("node:assert/strict");

const { isWeakPassword } = require("../lib/startup-check");

test("isWeakPassword: short passwords flagged", () => {
  assert.equal(isWeakPassword("short"), true);
  assert.equal(isWeakPassword("12345678"), true);
});

test("isWeakPassword: common words flagged", () => {
  assert.equal(isWeakPassword("password-something-long"), true);
  assert.equal(isWeakPassword("admin12345678"), true);
  assert.equal(isWeakPassword("henkes-salon"), true);
  assert.equal(isWeakPassword("friseur-test"), true);
  assert.equal(isWeakPassword("mysecret-pass"), true);
});

test("isWeakPassword: strong random passes", () => {
  assert.equal(isWeakPassword("Xz9!q2L#p$Mn8vK"), false);
  assert.equal(isWeakPassword("correct-horse-battery-staple"), false);
});

test("isWeakPassword: undefined/empty -> not weak (other checks handle)", () => {
  assert.equal(isWeakPassword(""), false);
  assert.equal(isWeakPassword(null), false);
  assert.equal(isWeakPassword(undefined), false);
});

test("runStartupCheck: dev mode passes with no env vars", () => {
  const { runStartupCheck } = require("../lib/startup-check");
  const orig = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const result = runStartupCheck();
    assert.equal(result.ok, true, "dev must always pass");
  } finally {
    if (orig !== undefined) process.env.NODE_ENV = orig;
  }
});

test("runStartupCheck: production needs RESEND_API_KEY, SALON_EMAIL, ADMIN_USER, ADMIN_PASSWORD", () => {
  // Frischer Reload, weil das Modul IS_PRODUCTION cached.
  delete require.cache[require.resolve("../lib/startup-check")];
  delete require.cache[require.resolve("../lib/logger")];

  const origs = {
    NODE_ENV: process.env.NODE_ENV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SALON_EMAIL: process.env.SALON_EMAIL,
    ADMIN_USER: process.env.ADMIN_USER,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };
  process.env.NODE_ENV = "production";
  delete process.env.RESEND_API_KEY;
  delete process.env.SALON_EMAIL;
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASSWORD;

  try {
    const { runStartupCheck } = require("../lib/startup-check");
    const result = runStartupCheck();
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 4);
    const names = result.errors.map((e) => e.name).sort();
    assert.deepEqual(names, ["ADMIN_PASSWORD", "ADMIN_USER", "RESEND_API_KEY", "SALON_EMAIL"]);
  } finally {
    for (const [k, v] of Object.entries(origs)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Modul-Cache aufraeumen
    delete require.cache[require.resolve("../lib/startup-check")];
    delete require.cache[require.resolve("../lib/logger")];
  }
});
