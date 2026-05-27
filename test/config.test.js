const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SERVICES,
  ALLOWED_SERVICES,
  SERVICE_DURATIONS_MINUTES,
  SALON_HOURS,
  ALLOWED_MINUTES,
  MAX_BOOKING_HORIZON_DAYS,
} = require("../lib/config");

test("SERVICES catalog and ALLOWED_SERVICES are in sync", () => {
  assert.deepEqual(
    ALLOWED_SERVICES,
    SERVICES.map((s) => s.name),
    "ALLOWED_SERVICES must be derived from SERVICES.name"
  );
});

test("Every service has a duration", () => {
  for (const name of ALLOWED_SERVICES) {
    assert.ok(
      SERVICE_DURATIONS_MINUTES[name] > 0,
      `Service '${name}' has no duration in SERVICE_DURATIONS_MINUTES`
    );
  }
});

test("Sunday and Monday are closed by convention", () => {
  assert.equal(SALON_HOURS[0], undefined, "Sunday must be closed");
  assert.equal(SALON_HOURS[1], undefined, "Monday must be closed");
});

test("Saturday closes early (14:00)", () => {
  assert.equal(SALON_HOURS[6].close, 14 * 60);
});

test("Open hours are valid (open < close, both in 0..24*60)", () => {
  for (const day of Object.keys(SALON_HOURS)) {
    const { open, close } = SALON_HOURS[day];
    assert.ok(open >= 0 && open < 24 * 60, `weekday ${day} open out of range`);
    assert.ok(close > open && close <= 24 * 60, `weekday ${day} close out of range`);
  }
});

test("ALLOWED_MINUTES is exactly the 15-minute raster", () => {
  assert.deepEqual([...ALLOWED_MINUTES].sort(), ["00", "15", "30", "45"]);
});

test("Booking horizon is sane (between 14 and 365 days)", () => {
  assert.ok(MAX_BOOKING_HORIZON_DAYS >= 14, "less than 2 weeks would frustrate customers");
  assert.ok(MAX_BOOKING_HORIZON_DAYS <= 365, "more than a year is unrealistic");
});

test("Constants are frozen (mutation attempts throw in strict mode)", () => {
  assert.throws(() => {
    "use strict";
    SERVICES.push({ name: "Hack", durationMinutes: 1 });
  }, /Cannot add property|object is not extensible/);
});
