import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const matrixPath = await firstAccessible([
  path.join(projectRoot, "docs", "HARDWARE_TEST_MATRIX.md"),
  path.join(
    projectRoot,
    "..",
    "Documentation",
    "docs",
    "HARDWARE_TEST_MATRIX.md"
  )
]);

const required = [
  "scripts/windows/Find-IPhoneDevices.ps1",
  "scripts/windows/IPhoneShellHelpers.ps1",
  "scripts/windows/Import-IPhonePhotos.ps1",
  "scripts/windows/Open-AppleDevices.ps1",
  "scripts/windows/Test-PocketDockHardware.ps1",
  "electron/core/usb-service.ts",
  "electron/core/network.ts",
  "electron/core/transfer-service.ts",
  "ios/PocketDock/DiscoveryService.swift",
  "ios/PocketDock/BackgroundTransferSession.swift",
  "ios/PocketDock/QRScannerView.swift",
  "ios/PocketDock/TransferJournal.swift"
];

await Promise.all(
  required.map((file) => access(path.join(projectRoot, file)))
);

const usb = await readFile(
  path.join(projectRoot, "electron/core/usb-service.ts"),
  "utf8"
);
const discovery = await readFile(
  path.join(projectRoot, "ios/PocketDock/DiscoveryService.swift"),
  "utf8"
);
const transfer = await readFile(
  path.join(projectRoot, "ios/PocketDock/TransferJournal.swift"),
  "utf8"
);
const iosInfo = await readFile(
  path.join(projectRoot, "ios/PocketDock/Info.plist"),
  "utf8"
);
const matrix = await readFile(matrixPath, "utf8");

for (const expectation of [
  "Camera Roll access",
  "Unlock the iPhone",
  "Import-IPhonePhotos.ps1",
  "diagnosticCode"
]) {
  if (!usb.includes(expectation)) throw new Error(`USB boundary is missing: ${expectation}`);
}
for (const expectation of ["UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace"]) {
  if (!iosInfo.includes(expectation)) {
    throw new Error(`iOS USB document-sharing key is missing: ${expectation}`);
  }
}
for (const expectation of ["NWBrowser", "NWConnection", "remoteEndpoint", "_pocketdock._tcp"]) {
  if (!discovery.includes(expectation)) throw new Error(`Discovery check missing: ${expectation}`);
}
for (const expectation of ["applicationSupportDirectory", "Transfer Queue", "completeFileProtection"]) {
  if (!transfer.includes(expectation)) throw new Error(`Transfer recovery check missing: ${expectation}`);
}
for (const caseId of [
  "HW-LAN-01",
  "HW-QR-CHROME-01",
  "HW-USB-LAUNCH-01",
  "HW-USB-DELAY-01",
  "HW-USB-NO-DCIM-01",
  "HW-USB-DCIM-01",
  "HW-USB-FLAT-01",
  "HW-RESUME-01",
  "HW-BACKGROUND-01",
  "HW-IPAD-01",
  "HW-RELAY-01"
]) {
  if (!matrix.includes(caseId)) throw new Error(`Hardware matrix is missing ${caseId}`);
}

process.stdout.write(
  JSON.stringify(
    {
      structuralReadiness: "pass",
      automatedSuites: "run npm test and npm run verify:ios",
      physicalHardwareExecution: "not-run-in-this-environment",
      manualMatrix: path.relative(projectRoot, matrixPath).replaceAll("\\", "/"),
      windowsProbe: "scripts/windows/Test-PocketDockHardware.ps1",
      usbBoundary:
        "Automated USB is Camera Roll-only (classic DCIM or flattened dated buckets); Apple Devices provides separately labeled manual app-document staging"
    },
    null,
    2
  ) + "\n"
);

async function firstAccessible(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  throw new Error(
    `Hardware test matrix was not found. Checked: ${candidates.join(", ")}`
  );
}
