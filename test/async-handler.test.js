/**
 * Tests fuer lib/async-handler.js -- der unscheinbare Wrapper, der
 * verhindert dass ein unhandled-reject in einem async-Route-Handler
 * den Prozess crasht.
 *
 * Wenn dieser Wrapper still kaputt geht (z.B. doppeltes next, oder
 * sync-Throws nicht abgefangen), wuerden Server-Crashes bei Production-
 * Bugs nur in den Render-Logs sichtbar.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { asyncHandler } = require("../lib/async-handler");

test("asyncHandler: resolved promise -> next NICHT mit Fehler aufgerufen", async () => {
  let nextErr = "not-called";
  const handler = asyncHandler(async () => {
    return "ok";
  });
  await handler({}, {}, (err) => {
    nextErr = err;
  });
  // next sollte gar nicht oder ohne Argument aufgerufen werden -- aber
  // niemals mit einem Error.
  assert.notEqual(nextErr instanceof Error, true);
});

test("asyncHandler: rejected promise -> next(error)", async () => {
  let captured = null;
  const handler = asyncHandler(async () => {
    throw new Error("kaboom");
  });
  await handler({}, {}, (err) => {
    captured = err;
  });
  assert.ok(captured instanceof Error);
  assert.equal(captured.message, "kaboom");
});

test("asyncHandler: sync throw wird auch abgefangen", async () => {
  let captured = null;
  // Promise.resolve(handler()) faengt sync throws via try/catch der
  // Promise-Konstruktion -- bzw. der Promise.resolve dreht den Throw
  // in einen rejected Promise um.
  const handler = asyncHandler(() => {
    throw new Error("sync-boom");
  });
  await handler({}, {}, (err) => {
    captured = err;
  });
  assert.ok(captured instanceof Error);
  assert.equal(captured.message, "sync-boom");
});

test("asyncHandler: non-Error-Reject (string) wird durchgereicht", async () => {
  // Wir nutzen ein Promise das wir aufloesen, sobald next aufgerufen
  // wird -- vermeidet den Microtask-Race wenn handler einen Promise
  // mit return zurueckgibt (im Gegensatz zu throw).
  let resolveNext;
  const nextCalled = new Promise((r) => (resolveNext = r));

  const handler = asyncHandler(async () => {
    return Promise.reject("string-failure");
  });
  handler({}, {}, (err) => {
    resolveNext(err);
  });
  const captured = await nextCalled;

  // Wir reichen den Wert durch wie er ist -- Express' default-handler
  // weiss damit umzugehen.
  assert.equal(captured, "string-failure");
});

test("asyncHandler: req+res werden korrekt durchgereicht", async () => {
  let receivedReq = null;
  let receivedRes = null;
  const fakeReq = { id: 42 };
  const fakeRes = { sent: false };
  const handler = asyncHandler(async (req, res) => {
    receivedReq = req;
    receivedRes = res;
  });
  await handler(fakeReq, fakeRes, () => {});
  assert.equal(receivedReq, fakeReq);
  assert.equal(receivedRes, fakeRes);
});
