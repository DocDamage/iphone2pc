import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandRoot = await findBrandRoot([
  path.join(sourceRoot, "branding", "PocketDock_Branding_Pack"),
  path.join(sourceRoot, "Branding", "PocketDock_Branding_Pack"),
  path.join(sourceRoot, "..", "Branding", "PocketDock_Branding_Pack")
]);
const source = await readFile(
  path.join(
    brandRoot,
    "04_app_icon_sizes",
    "framed",
    "pocketdock_framed_1024x1024.png"
  )
);
const buildRoot = path.join(sourceRoot, "build");
const iosIconRoot = path.join(
  sourceRoot,
  "ios",
  "PocketDock",
  "Assets.xcassets",
  "AppIcon.appiconset"
);
const mobileRoot = path.join(sourceRoot, "public", "mobile");
await mkdir(path.join(buildRoot, "icons"), { recursive: true });
await mkdir(iosIconRoot, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const paths = [];
for (const size of sizes) {
  const destination = path.join(buildRoot, "icons", `${size}.png`);
  await sharp(source).resize(size, size).png().toFile(destination);
  paths.push(destination);
}

await sharp(source).resize(512, 512).png().toFile(path.join(buildRoot, "icon.png"));
await sharp(source)
  .resize(180, 180)
  .png()
  .toFile(path.join(mobileRoot, "apple-touch-icon.png"));
await sharp(source)
  .resize(192, 192)
  .png()
  .toFile(path.join(mobileRoot, "pocketdock-icon-192.png"));
await sharp(source)
  .resize(512, 512)
  .png()
  .toFile(path.join(mobileRoot, "pocketdock-icon-512.png"));
await sharp(source)
  .flatten({ background: "#082744" })
  .resize(1024, 1024)
  .png()
  .toFile(path.join(iosIconRoot, "AppIcon-1024.png"));
await writeFile(path.join(buildRoot, "icon.ico"), await pngToIco(paths));

async function findBrandRoot(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    `PocketDock branding pack not found. Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join("\n")}`
  );
}
