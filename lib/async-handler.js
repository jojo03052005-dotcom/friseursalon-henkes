/**
 * Wrapper, damit async-Route-Handler bei einem unhandled reject nicht
 * den Prozess crashen. Statt in jedem Handler try/catch zu duplizieren,
 * machen wir das hier einmal und delegieren an die zentrale Error-
 * Middleware.
 *
 * Verwendung:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
