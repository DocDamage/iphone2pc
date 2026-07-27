import crypto from "node:crypto";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { ZipArchive } from "archiver";
import { ensureDirectory, sanitizeFileName, uniqueFilePath } from "./file-utils.js";
import { sha256File } from "./crypto-utils.js";
import { StateStore } from "./store.js";
import type { ProducerPackage } from "./types.js";
import { ArtworkService } from "./artwork-service.js";

interface PackageDetails {
  title: string;
  artist: string;
  bpm?: number;
  musicalKey?: string;
  notes: string;
  clientName?: string;
  licenseName?: string;
}

export class ProducerService {
  private readonly artwork = new ArtworkService();

  constructor(
    private readonly store: StateStore,
    private readonly registerFiles: (
      paths: string[],
      expiresMinutes: number
    ) => Promise<void>
  ) {}

  async create(
    filePaths: string[],
    details: PackageDetails,
    expiresMinutes = 0
  ): Promise<ProducerPackage> {
    if (!filePaths.length) throw new Error("Choose at least one beat, stem, or project file.");
    const title = sanitizeFileName(details.title.trim() || "Untitled Delivery");
    const outputDirectory = path.join(
      this.store.getSettings().destinationDirectory,
      "PocketDock Deliveries"
    );
    await ensureDirectory(outputDirectory);
    const destination = await uniqueFilePath(path.join(outputDirectory, `${title}.zip`));
    const manifestFiles: Array<{
      name: string;
      size: number;
      sha256: string;
      role: string;
      sourcePath?: string;
      bytes?: Buffer;
    }> = [];
    const usedNames = new Set<string>();

    for (const filePath of filePaths) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      const name = uniqueArchiveName(
        sanitizeFileName(path.basename(filePath)),
        usedNames
      );
      manifestFiles.push({
        name,
        size: info.size,
        sha256: await sha256File(filePath),
        role: inferRole(name),
        sourcePath: filePath
      });
    }
    if (!manifestFiles.length) throw new Error("The selected files are unavailable.");
    let artwork = ArtworkService.localArtwork(filePaths);
    if (!artwork) {
      try {
        const discovered = await this.artwork.discover(filePaths, details);
        if (discovered) {
          artwork = discovered.info;
          manifestFiles.push({
            name: path.basename(discovered.archiveName),
            size: discovered.bytes.length,
            sha256: crypto.createHash("sha256").update(discovered.bytes).digest("hex"),
            role: "artwork",
            bytes: discovered.bytes
          });
        }
      } catch {
        // Artwork discovery is best-effort and never blocks a verified delivery.
      }
    }

    const output = createWriteStream(destination, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const finished = new Promise<void>((resolve, reject) => {
      output.once("close", () => resolve());
      output.once("error", reject);
      archive.once("error", reject);
    });
    archive.pipe(output);
    for (const file of manifestFiles) {
      if (file.bytes) archive.append(file.bytes, { name: `Artwork/${file.name}` });
      else if (file.sourcePath) archive.file(file.sourcePath, { name: `Files/${file.name}` });
    }
    archive.append(
      JSON.stringify(
        {
          format: "PocketDock Producer Delivery",
          version: 1,
          title,
          artist: details.artist.trim(),
          bpm: details.bpm || null,
          musicalKey: details.musicalKey?.trim() || null,
          notes: details.notes.trim(),
          clientName: details.clientName?.trim() || null,
          licenseName: details.licenseName?.trim() || null,
          createdAt: new Date().toISOString(),
          artwork: artwork ?? null,
          files: manifestFiles.map(({ sourcePath: _sourcePath, bytes: _bytes, ...file }) => file)
        },
        null,
        2
      ),
      { name: "PocketDock-Delivery.json" }
    );
    try {
      await archive.finalize();
      await finished;
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    const info = await stat(destination);
    const item: ProducerPackage = {
      id: crypto.randomUUID(),
      title,
      artist: details.artist.trim(),
      bpm: details.bpm,
      musicalKey: details.musicalKey?.trim() || undefined,
      notes: details.notes.trim(),
      fileCount: manifestFiles.length,
      size: info.size,
      path: destination,
      createdAt: new Date().toISOString(),
      version:
        Math.max(
          0,
          ...this.store
            .getProducerPackages()
            .filter((entry) => entry.title === title)
            .map((entry) => entry.version ?? 1)
        ) + 1,
      clientName: details.clientName?.trim() || undefined,
      licenseName: details.licenseName?.trim() || undefined,
      approvalStatus: "draft",
      downloadCount: 0,
      artwork: artwork ?? {
        status: "not-found",
        source: "No confident artwork match",
        confidence: 0,
        requestedTitle: details.title.trim(),
        requestedArtist: details.artist.trim(),
        queryVariants: []
      },
      tracks: manifestFiles.map(({ sourcePath: _sourcePath, bytes: _bytes, ...file }) => ({
        name: file.name,
        role: file.role,
        size: file.size,
        sha256: file.sha256
      })),
      trackSources: Object.fromEntries(
        manifestFiles.flatMap((file) =>
          file.sourcePath ? [[file.sha256, file.sourcePath]] : []
        )
      )
    };
    await this.store.upsertProducerPackage(item);
    await this.registerFiles([destination], expiresMinutes);
    return item;
  }
}

function uniqueArchiveName(fileName: string, used: Set<string>): string {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${parsed.name} (${index})${parsed.ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function inferRole(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.includes("stem")) return "stem";
  if (name.includes("instrumental") || name.includes("beat")) return "instrumental";
  if (name.includes("master")) return "master";
  if (name.includes("art") || /\.(png|jpe?g|webp)$/.test(name)) return "artwork";
  if (/\.(mid|midi)$/.test(name)) return "midi";
  if (/\.(flp|als|logicx|rpp|ptx)$/.test(name)) return "project";
  return "file";
}
