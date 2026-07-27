import { describe, expect, it } from "vitest";
import { normalizeMusicName, similarity } from "./artwork-service.js";

describe("artwork title matching", () => {
  it("normalizes punctuation, accents, and common release suffixes", () => {
    expect(normalizeMusicName("Échoes (Official Audio)")).toBe("echoes");
    expect(normalizeMusicName("Night-Drive — Remastered Version")).toBe("night drive");
  });

  it("tolerates misspellings and transposed letters without equating unrelated songs", () => {
    expect(similarity("Midnight Pressure", "Midnite Presure")).toBeGreaterThan(0.5);
    expect(similarity("Midnight Pressure", "Sunday Morning")).toBeLessThan(0.45);
  });

  it("treats feat and featuring spellings as equivalent", () => {
    expect(similarity("Runaway feat. Nova", "Runaway featuring Nova")).toBeGreaterThan(0.98);
  });
});
