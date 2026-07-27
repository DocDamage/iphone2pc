import { describe, expect, it } from "vitest";
import { detectIphoneBrowser } from "../../scripts/mobile-runtime.js";

describe("iPhone browser identification", () => {
  it("detects Chrome before the Safari compatibility token", () => {
    expect(
      detectIphoneBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/150.0 Mobile/15E148 Safari/604.1"
      )
    ).toEqual({ name: "Chrome", platform: "chrome" });
  });

  it("detects Safari", () => {
    expect(
      detectIphoneBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
      )
    ).toEqual({ name: "Safari", platform: "safari" });
  });

  it("uses a safe generic identity for unknown iPhone browsers", () => {
    expect(detectIphoneBrowser("PocketDockBrowser/1.0")).toEqual({
      name: "browser",
      platform: "browser"
    });
  });
});
