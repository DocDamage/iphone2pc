import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PocketDock public mobile pages", () => {
  it("loads the portable crypto bundle before private-share code", async () => {
    const [html, share, cryptoEntry] = await Promise.all([
      readFile("public/mobile/share.html", "utf8"),
      readFile("public/mobile/share.js", "utf8"),
      readFile("scripts/mobile-crypto-entry.ts", "utf8")
    ]);

    expect(html.indexOf('/mobile-crypto.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/mobile-crypto.js')).toBeLessThan(html.indexOf('/share.js'));
    expect(share).toContain("globalThis.PocketDockCrypto.decrypt");
    expect(share).toContain("globalThis.PocketDockCrypto.sha256");
    expect(cryptoEntry).toContain("sha256,");
  });

  it("keeps private bearer fragments available across refresh and copy", async () => {
    const [share, request] = await Promise.all([
      readFile("public/mobile/share.js", "utf8"),
      readFile("public/mobile/request.js", "utf8")
    ]);

    expect(share).not.toContain("history.replaceState");
    expect(request).not.toContain("history.replaceState");
  });

  it("describes unpaired file requests without an encryption overclaim", async () => {
    const request = await readFile("public/mobile/request.js", "utf8");
    expect(request).toContain("Files travel directly to the requesting PC");
    expect(request).not.toContain("Files are encrypted in transit");
  });

  it("supports recoverable renderer interactions without browser dialogs", async () => {
    const [app, mobile] = await Promise.all([
      readFile("src/App.tsx", "utf8"),
      readFile("public/mobile/mobile.js", "utf8")
    ]);

    expect(app).not.toContain("window.prompt(");
    expect(app).toContain("await onSend(content);");
    expect(app.indexOf("await onSend(content);")).toBeLessThan(app.indexOf('setContent("");'));
    expect(mobile).toContain('["completed", "cancelled", "failed"]');
  });
});
