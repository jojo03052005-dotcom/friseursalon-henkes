/**
 * Tests fuer lib/logger.js -- minimaler strukturierter Logger.
 *
 * Wir checken nur die wichtigsten Vertraege:
 *   - JSON-Lines in Production (parsbar fuer Log-Sammler)
 *   - Pflicht-Felder (time, level, component, event) sind im Output
 *   - child() konkateniert die Komponente sauber
 *   - Levels filtern unterhalb von LOG_LEVEL
 */

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Capture: stoppt stdout/stderr.write fuer die Dauer eines Callbacks
 * und gibt das gesamte geschriebene als Array von Zeilen zurueck.
 */
function captureStdout(fn) {
  const lines = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    lines.push({ stream: "stdout", text: String(chunk) });
    return true;
  };
  process.stderr.write = (chunk) => {
    lines.push({ stream: "stderr", text: String(chunk) });
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return lines;
}

test("logger: JSON-Lines mit Pflicht-Feldern in production", () => {
  // logger liest NODE_ENV beim require -- darum muss der Toggle
  // VOR dem require passieren. Wir loeschen den Cache, setzen die
  // env, und re-requiren.
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    delete require.cache[require.resolve("../lib/logger")];
    const logger = require("../lib/logger");
    const captured = captureStdout(() => {
      logger.info("hello_event", { foo: "bar", n: 42 });
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].stream, "stdout");
    // Muss valider JSON sein
    const parsed = JSON.parse(captured[0].text.trim());
    assert.equal(parsed.level, "info");
    assert.equal(parsed.component, "app");
    assert.equal(parsed.event, "hello_event");
    assert.equal(parsed.foo, "bar");
    assert.equal(parsed.n, 42);
    assert.match(parsed.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    delete require.cache[require.resolve("../lib/logger")];
  }
});

test("logger.child: konkateniert Komponenten mit ':'", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    delete require.cache[require.resolve("../lib/logger")];
    const logger = require("../lib/logger");
    const sub = logger.child("admin").child("auth");
    const captured = captureStdout(() => {
      sub.warn("login_failed", { ip: "1.2.3.4" });
    });
    const parsed = JSON.parse(captured[0].text.trim());
    assert.equal(parsed.component, "admin:auth");
    assert.equal(parsed.event, "login_failed");
    assert.equal(parsed.level, "warn");
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    delete require.cache[require.resolve("../lib/logger")];
  }
});

test("logger: error landet auf stderr (nicht stdout)", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    delete require.cache[require.resolve("../lib/logger")];
    const logger = require("../lib/logger");
    const captured = captureStdout(() => {
      logger.error("boom", { reason: "test" });
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].stream, "stderr");
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    delete require.cache[require.resolve("../lib/logger")];
  }
});

test("logger: debug wird ohne LOG_LEVEL=debug verschluckt", () => {
  const origEnv = process.env.NODE_ENV;
  const origLogLevel = process.env.LOG_LEVEL;
  process.env.NODE_ENV = "production";
  delete process.env.LOG_LEVEL;
  try {
    delete require.cache[require.resolve("../lib/logger")];
    const logger = require("../lib/logger");
    const captured = captureStdout(() => {
      logger.debug("noise", { x: 1 });
    });
    assert.equal(captured.length, 0, "debug muss unterhalb von info gefiltert werden");
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    if (origLogLevel !== undefined) process.env.LOG_LEVEL = origLogLevel;
    delete require.cache[require.resolve("../lib/logger")];
  }
});

test("logger: LOG_LEVEL=debug schaltet debug-Events frei", () => {
  const origEnv = process.env.NODE_ENV;
  const origLogLevel = process.env.LOG_LEVEL;
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "debug";
  try {
    delete require.cache[require.resolve("../lib/logger")];
    const logger = require("../lib/logger");
    const captured = captureStdout(() => {
      logger.debug("trace_event", { id: "x" });
    });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0].text.trim());
    assert.equal(parsed.level, "debug");
    assert.equal(parsed.event, "trace_event");
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLogLevel;
    delete require.cache[require.resolve("../lib/logger")];
  }
});
