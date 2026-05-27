/**
 * Wrapper, damit async-Route-Handler bei einem unhandled reject nicht
 * den Prozess crashen. Statt in jedem Handler try/catch zu duplizieren,
 * machen wir das hier einmal und delegieren an die zentrale Error-
 * Middleware.
 *
 * Faengt sowohl Promise-Rejects als auch versehentliche sync-Throws
 * (z.B. JSON.parse mit invalid input) und reicht sie an next() weiter.
 *
 * Verwendung:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      // Sync-Throw vor dem ersten await -- direkt an next.
      next(err);
    }
  };
}

module.exports = { asyncHandler };
