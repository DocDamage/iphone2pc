import crypto from "node:crypto";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { ZipArchive } from "archiver";

const sourceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const completePackageDirectory = path.resolve(sourceDirectory, "..");
const { version } = JSON.parse(
  await readFile(path.join(sourceDirectory, "package.json"), "utf8")
);
const architecture = "x64";
const releaseDirectory = path.join(sourceDirectory, "release");
const packageName = `PocketDock-${version}-Complete-Package`;
const stagingDirectory = path.join(releaseDirectory, packageName);
const zipPath = path.join(releaseDirectory, `${packageName}.zip`);
const windowsArtifactName = `PocketDock-${version}-${architecture}-Portable.exe`;
const windowsExecutable = await findRequiredFile(
  [
    path.join(releaseDirectory, windowsArtifactName),
    path.join(completePackageDirectory, "Windows", windowsArtifactName)
  ],
  `Portable Windows artifact not found. Run "npm run package:portable" from ${sourceDirectory}.`
);
const documentationDirectory = await findRequiredDirectory(
  [
    sourceDirectory,
    path.join(sourceDirectory, "Documentation"),
    path.join(completePackageDirectory, "Documentation")
  ],
  ["README.md", "RELEASE_NOTES.md", "HANDOFF.md", "docs"],
  "PocketDock documentation"
);
const brandingDirectory = await findRequiredDirectory(
  [
    path.join(sourceDirectory, "branding", "PocketDock_Branding_Pack"),
    path.join(sourceDirectory, "Branding", "PocketDock_Branding_Pack"),
    path.join(
      completePackageDirectory,
      "Branding",
      "PocketDock_Branding_Pack"
    )
  ],
  ["README.txt", "04_app_icon_sizes"],
  "PocketDock branding pack"
);

await rm(stagingDirectory, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(path.join(stagingDirectory, "Windows"), { recursive: true });
await mkdir(path.join(stagingDirectory, "Source"), { recursive: true });
await mkdir(path.join(stagingDirectory, "Documentation"), { recursive: true });
await mkdir(path.join(stagingDirectory, "Branding"), { recursive: true });

await cp(
  windowsExecutable,
  path.join(stagingDirectory, "Windows", path.basename(windowsExecutable))
);

for (const entry of [
  ".github",
  "build",
  "dist",
  "dist-electron",
  "electron",
  "ios",
  "public",
  "relay",
  "scripts",
  "src",
  "vendor"
]) {
  await cp(
    path.join(sourceDirectory, entry),
    path.join(stagingDirectory, "Source", entry),
    {
      recursive: true,
      filter: (source) =>
        !path.relative(sourceDirectory, source).split(path.sep).some((part) =>
          ["node_modules", ".git", ".agents", ".codex"].includes(part)
        )
    }
  );
}

for (const file of [
  ".gitignore",
  "BUILD_WINDOWS_INSTALLER.bat",
  "index.html",
  "package.json",
  "package-lock.json",
  "START_DEVELOPMENT.bat",
  "tsconfig.json",
  "vitest.config.ts",
  "vite.config.ts"
]) {
  await cp(
    path.join(sourceDirectory, file),
    path.join(stagingDirectory, "Source", file)
  );
}

for (const file of [
  "README.md",
  "RELEASE_NOTES.md",
  "HANDOFF.md"
]) {
  await cp(
    path.join(documentationDirectory, file),
    path.join(stagingDirectory, "Documentation", file)
  );
}
await cp(
  path.join(documentationDirectory, "docs"),
  path.join(stagingDirectory, "Documentation", "docs"),
  { recursive: true }
);
await cp(
  brandingDirectory,
  path.join(stagingDirectory, "Branding", "PocketDock_Branding_Pack"),
  { recursive: true }
);

const executableHash = await sha256File(windowsExecutable);
const executableSize = (await stat(windowsExecutable)).size;
const brandingCount = await countFiles(brandingDirectory);
const generatedAt = new Date().toISOString();
const manifest = {
  product: "PocketDock",
  version,
  generatedAt,
  windows: {
    artifact: `Windows/${windowsArtifactName}`,
    architecture,
    type: "portable",
    portable: true,
    publisherSignature: "not checked by package:complete",
    size: executableSize,
    sha256: executableHash
  },
  source: {
    desktop: true,
    iosApp: true,
    iosShareExtension: true,
    iosFileProvider: true,
    iosWidgetsAndLiveActivities: true,
    privateRelay: true,
    compiledRenderer: true,
    compiledElectronMain: true
  },
  verification: {
    packageAssembly: "pass",
    automatedChecks: "not run by package:complete",
    recommendedCommands: [
      "npm run verify",
      "npm run verify:ios",
      "npm run verify:hardware",
      "npm run verify:relay",
      "npm --prefix relay test",
      "npm run verify:build-tools"
    ],
    physicalHardwareExecution: "required separately before public release"
  },
  brandingFiles: brandingCount,
  intentionalExclusions: [
    "Google Drive OAuth",
    "Dropbox OAuth",
    "OneDrive OAuth",
    "publisher signing certificates",
    "Apple provisioning credentials"
  ]
};
await writeFile(
  path.join(stagingDirectory, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);
await writeFile(
  path.join(stagingDirectory, "START_HERE.txt"),
  [
    `POCKETDOCK ${version}`,
    "",
    "Windows:",
    `  Run Windows/${windowsArtifactName} on Windows 10 or 11 x64.`,
    "  This is the portable build; it does not install PocketDock.",
    "  package:complete does not check publisher signatures, so verify signing before distribution.",
    "",
    "Source:",
    "  Source contains desktop, mobile web, native iOS, File Provider, Share Extension, relay,",
    "  build scripts, tests, compiled renderer/main output, icons, and dependency locks.",
    "",
    "Branding:",
    `  Branding contains all ${brandingCount} supplied PocketDock branding-pack files.`,
    "",
    "Documentation:",
    "  Start with Documentation/README.md and Documentation/docs/USER_GUIDE.md.",
    "",
    "Cloud boundary:",
    "  No built-in Google Drive, Dropbox, or OneDrive OAuth is included."
  ].join("\n"),
  "utf8"
);
await writeFile(
  path.join(stagingDirectory, "VERIFICATION.txt"),
  [
    `Generated: ${generatedAt}`,
    "Complete-package assembly: PASS",
    `Windows x64 portable artifact found: ${windowsArtifactName}`,
    `Windows executable SHA-256: ${executableHash}`,
    "",
    "package:complete does not run or claim results for automated verification.",
    "Run and record these checks separately from the Source directory:",
    "- npm run verify",
    "- npm run verify:ios",
    "- npm run verify:hardware",
    "- npm run verify:relay",
    "- npm --prefix relay test",
    "- npm run verify:build-tools",
    "",
    "Required before public release:",
    "- Verify Windows artifacts are signed with the publisher certificate.",
    "- Compile/sign all iOS targets in current Xcode with the publisher Apple team.",
    "- Execute Documentation/docs/HARDWARE_TEST_MATRIX.md on clean Windows 10/11, iPhone, and iPad."
  ].join("\n"),
  "utf8"
);

await createZip(stagingDirectory, zipPath, packageName);
const zipHash = await sha256File(zipPath);
process.stdout.write(
  `${zipPath}\nSHA-256 ${zipHash}\n`
);

async function findRequiredFile(candidates, missingMessage) {
  for (const candidate of candidates) {
    if (await isPathType(candidate, "file")) {
      return candidate;
    }
  }

  throw new Error(
    `${missingMessage}\nChecked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join("\n")}`
  );
}

async function findRequiredDirectory(candidates, requiredEntries, label) {
  for (const candidate of candidates) {
    if (!(await isPathType(candidate, "directory"))) {
      continue;
    }

    const hasRequiredEntries = await Promise.all(
      requiredEntries.map((entry) =>
        isPathType(path.join(candidate, entry), "any")
      )
    );
    if (hasRequiredEntries.every(Boolean)) {
      return candidate;
    }
  }

  throw new Error(
    `${label} not found. Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join("\n")}`
  );
}

async function isPathType(candidate, expectedType) {
  try {
    const candidateStat = await stat(candidate);
    return expectedType === "any" ||
      (expectedType === "file" && candidateStat.isFile()) ||
      (expectedType === "directory" && candidateStat.isDirectory());
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createZip(source, destination, rootName) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(source, rootName);
    void archive.finalize();
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", resolve);
    input.once("error", reject);
  });
  return hash.digest("hex");
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += entry.isDirectory()
      ? await countFiles(path.join(directory, entry.name))
      : 1;
  }
  return count;
}
