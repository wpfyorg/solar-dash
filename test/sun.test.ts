import { describe, expect, it } from "vitest";
import { sunTimes } from "../src/sun";

describe("sunTimes", () => {
  it("matches a known worked example (21.13N, 86.73E, 25 Sep 2026)", () => {
    // Verified against that location's real ephemeris for that date:
    // sunrise 05:31, sunset 17:37 IST. Pinned to fixed coordinates (not
    // DEFAULT_LAT/LON) so this stays a fixed regression check regardless
    // of what the defaults are set to.
    const { sunrise, sunset } = sunTimes(21.13, 86.73, 2026, 9, 25);
    expect(sunrise).toBe("05:31");
    expect(sunset).toBe("17:37");
  });
});
