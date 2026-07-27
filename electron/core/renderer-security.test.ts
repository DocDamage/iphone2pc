import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "./renderer-security.js";

describe("isTrustedRendererUrl", () => {
  it("accepts only the configured packaged renderer document", () => {
    const trusted = "file:///C:/Program%20Files/PocketDock/resources/app.asar/dist/index.html";

    expect(isTrustedRendererUrl(trusted, trusted)).toBe(true);
    expect(isTrustedRendererUrl(`${trusted}?theme=dark#activity`, trusted)).toBe(true);
    expect(
      isTrustedRendererUrl(
        "file:///C:/Program%20Files/PocketDock/resources/app.asar/dist/admin.html",
        trusted
      )
    ).toBe(false);
    expect(isTrustedRendererUrl(`${trusted}.attacker`, trusted)).toBe(false);
  });

  it("requires the exact development origin and entry path", () => {
    const trusted = "http://127.0.0.1:5173/";

    expect(isTrustedRendererUrl("http://127.0.0.1:5173/?v=1", trusted)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173/", trusted)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/", trusted)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/mobile/", trusted)).toBe(false);
    expect(isTrustedRendererUrl("https://127.0.0.1:5173/", trusted)).toBe(false);
  });

  it("rejects malformed, credentialed, and active-content URLs", () => {
    const trusted = "http://127.0.0.1:5173/";

    expect(isTrustedRendererUrl("not a url", trusted)).toBe(false);
    expect(isTrustedRendererUrl("http://user@127.0.0.1:5173/", trusted)).toBe(false);
    expect(isTrustedRendererUrl("data:text/html,hello", trusted)).toBe(false);
    expect(isTrustedRendererUrl("javascript:alert(1)", trusted)).toBe(false);
  });
});
