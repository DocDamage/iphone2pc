import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("public/mobile/index.html", "utf8");
const css = readFileSync("public/mobile/mobile.css", "utf8");
const browser = readFileSync("public/mobile/mobile.js", "utf8");
const rootView = readFileSync("ios/PocketDock/RootView.swift", "utf8");
const scanner = readFileSync("ios/PocketDock/QRScannerView.swift", "utf8");

describe("Apple-native iPhone experience", () => {
  it("uses an accessible bottom tab bar with labelled panels", () => {
    expect(html).toContain('class="tab-switcher" role="tablist"');
    expect(html).toContain('aria-controls="send-panel"');
    expect(html).toContain('aria-labelledby="clipboard-tab"');
  });

  it("uses semantic platform colors, safe areas, dark mode, and reduced motion", () => {
    expect(css).toContain("--system-background");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/button\s*\{[\s\S]*min-height:\s*44px/);
  });

  it("opens native file sharing and reacts to iPhone network changes", () => {
    expect(browser).toContain("navigator.canShare({ files: [sharedFile] })");
    expect(browser).toContain("await navigator.share({");
    expect(browser).toContain('window.addEventListener("offline", updateNetworkState)');
    expect(browser).toContain("sessionStorage.setItem(TAB_KEY, tab)");
  });

  it("uses system SwiftUI navigation, feedback, and automatic QR pairing", () => {
    expect(rootView).toContain("TabView(selection: $selectedTab)");
    expect(rootView).toContain(".listStyle(.insetGrouped)");
    expect(rootView).toContain(".sensoryFeedback(.success");
    expect(rootView).toContain("if pin.count == 6");
    expect(rootView).toContain("await pairSelectedComputer()");
  });

  it("provides a camera-permission recovery state and rotation-safe scanner", () => {
    expect(scanner).toContain("Camera Access Needed");
    expect(scanner).toContain("UIApplication.openSettingsURLString");
    expect(scanner).toContain("override func viewDidLayoutSubviews()");
    expect(scanner).toContain("preview?.frame = view.bounds");
  });
});
