import os
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    os.environ.get("IDRIVEPULSE_E2E") != "1",
    reason="Set IDRIVEPULSE_E2E=1 while the local app server is running.",
)

ROOT = Path(__file__).resolve().parents[2]
SCREENSHOTS = ROOT / "docs" / "screenshots"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def open_app(playwright, viewport):
    assert CHROME.exists()
    browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True)
    page = browser.new_page(viewport=viewport, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:8765", wait_until="domcontentloaded")
    page.locator("#homeHeroTitle").wait_for(state="visible")
    return browser, page, errors


def sanitize_public_screenshot(page):
    page.locator("#statusText").evaluate("node => node.textContent = 'iPhone — Connected (USB_AFC)'")
    page.locator("#homeHeroTitle").evaluate("node => node.textContent = 'Your iPhone is connected. Let’s get your files back.'")
    page.locator("#storageGaugeText").evaluate("node => node.textContent = '86 / 256 GB'")
    page.locator(".activity-copy").evaluate_all(
        """nodes => nodes.forEach(node => {
            if (node.textContent.includes('CABLE BENCHMARK')) {
                node.textContent = 'CABLE BENCHMARK · baseline recorded';
            }
        })"""
    )


def test_desktop_workspace_navigation_and_recovery_fabric():
    from playwright.sync_api import expect, sync_playwright

    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser, page, errors = open_app(playwright, {"width": 1500, "height": 1000})
        expect(page.locator(".brand-text strong")).to_have_text("iDrivePulse")
        expect(page.locator("#statusText")).to_contain_text("Connected", timeout=30_000)
        expect(page.locator("#homeHeroTitle")).to_contain_text("connected")
        expect(page.get_by_text("Recover in three clear steps", exact=True)).to_be_visible()
        expect(page.locator("#homeCableScore")).not_to_have_text("—")
        sanitize_public_screenshot(page)
        page.screenshot(path=str(SCREENSHOTS / "dashboard.png"), full_page=True)

        page.keyboard.press("Control+k")
        expect(page.locator("#commandPalette")).to_be_visible()
        page.locator("#commandInput").fill("Recovery Fabric")
        with page.expect_response(lambda response: "/api/fabric/status" in response.url and response.status == 200):
            page.keyboard.press("Enter")
        expect(page.get_by_text("Beat DNA search", exact=True)).to_be_visible()
        expect(page.locator("#fabricMetrics")).to_contain_text("native-cm-notification")
        sanitize_public_screenshot(page)
        page.screenshot(path=str(SCREENSHOTS / "recovery-fabric.png"), full_page=True)

        page.get_by_role("tab", name="Recover beats").click()
        expect(page.get_by_text("Recover beats from your iPhone", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Scan iPhone")).to_be_visible()
        page.get_by_role("tab", name="Recovery queue").click()
        expect(page.get_by_text("Recovery queue & intelligence", exact=True)).to_be_visible()
        page.get_by_role("tab", name="Device & safety").click()
        expect(page.get_by_text("Device health, drivers & safety", exact=True)).to_be_visible()

        original_theme = page.locator("body").get_attribute("data-theme")
        page.locator("#themeToggle").click()
        expect(page.locator("body")).not_to_have_attribute("data-theme", original_theme)
        browser.close()
    assert errors == []


def test_mobile_drawer_and_primary_workflows():
    from playwright.sync_api import expect, sync_playwright

    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser, page, errors = open_app(playwright, {"width": 390, "height": 844})
        expect(page.locator("#sidebarToggle")).to_be_visible()
        expect(page.locator("#homePrimaryAction")).to_be_visible()
        page.locator("#sidebarToggle").click()
        expect(page.locator("body")).to_have_class("sidebar-open")
        page.get_by_role("tab", name="Browse iPhone").click()
        expect(page.get_by_text("Browse visible iPhone storage", exact=True)).to_be_visible()
        expect(page.locator("body")).not_to_have_class("sidebar-open")
        page.screenshot(path=str(SCREENSHOTS / "mobile-files.png"), full_page=True)
        browser.close()
    assert errors == []
