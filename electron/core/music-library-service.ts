import crypto from "node:crypto";
import path from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
import { parseFile } from "music-metadata";
import type { MusicLibraryItem } from "./types.js";

export const DEFAULT_MUSIC_LIBRARY_POLL_INTERVAL_MS = 20_000;

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".amr",
  ".ape",
  ".flac",
  ".m4a",
  ".m4b",
  ".mp2",
  ".mp3",
  ".mpc",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wave",
  ".wma",
  ".wv"
]);

export interface MusicFileMetadata {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  durationSeconds?: number;
  trackNumber?: number;
  year?: number;
  format?: string;
}

export type MusicMetadataReader = (filePath: string) => Promise<MusicFileMetadata>;
export type MusicLibraryChangeHandler = (items: MusicLibraryItem[]) => void;

export interface MusicLibraryRoot {
  directory: string;
  source: MusicLibraryItem["source"];
  /** User-selected roots are required and should report when they disappear. */
  required?: boolean;
}

export interface MusicLibraryServiceOptions {
  pollIntervalMs?: number;
  metadataReader?: MusicMetadataReader;
  metadataConcurrency?: number;
}

interface DiscoveredFile {
  fullPath: string;
  identityKey: string;
  relativePath: string;
  relativeFolder: string;
  source: MusicLibraryItem["source"];
  size: number;
  modifiedAt: string;
  fingerprint: string;
}

interface MetadataCacheEntry {
  fingerprint: string;
  item: MusicLibraryItem;
}

interface ScanResult {
  items: MusicLibraryItem[];
  pathsById: Map<string, string>;
  metadataCache: Map<string, MetadataCacheEntry>;
  warnings: string[];
}

interface RefreshOperation {
  generation: number;
  promise: Promise<MusicLibraryItem[]>;
  trailingRequested: boolean;
  trailingStarted: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function cloneItem(item: MusicLibraryItem): MusicLibraryItem {
  return { ...item };
}

function normalizeItems(items: readonly MusicLibraryItem[]): MusicLibraryItem[] {
  return items
    .map(cloneItem)
    .sort((left, right) => {
      const artist = left.artist.localeCompare(right.artist, undefined, { sensitivity: "base" });
      if (artist) return artist;
      const album = left.album.localeCompare(right.album, undefined, { sensitivity: "base" });
      if (album) return album;
      const leftTrack = left.trackNumber ?? Number.MAX_SAFE_INTEGER;
      const rightTrack = right.trackNumber ?? Number.MAX_SAFE_INTEGER;
      if (leftTrack !== rightTrack) return leftTrack - rightTrack;
      const title = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      return title || left.id.localeCompare(right.id);
    });
}

function stableId(source: string, relativePath: string): string {
  const normalized = `${source}\0${relativePath}`
    .split(path.sep)
    .join("/")
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : fallback;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function unrefTimer(timer: TimerHandle): void {
  (timer as TimerHandle & { unref?: () => void }).unref?.();
}

async function readMetadata(filePath: string): Promise<MusicFileMetadata> {
  const metadata = await parseFile(filePath, {
    duration: true,
    skipCovers: true
  });
  return {
    title: metadata.common.title,
    artist: metadata.common.artist,
    albumArtist: metadata.common.albumartist,
    album: metadata.common.album,
    durationSeconds: metadata.format.duration,
    trackNumber: metadata.common.track.no ?? undefined,
    year: metadata.common.year,
    format: metadata.format.container
  };
}

export class MusicLibraryService {
  private readonly roots: MusicLibraryRoot[];
  private readonly pollIntervalMs: number;
  private readonly metadataReader: MusicMetadataReader;
  private readonly metadataConcurrency: number;
  private items: MusicLibraryItem[] = [];
  private signature = "[]";
  private pathsById = new Map<string, string>();
  private metadataCache = new Map<string, MetadataCacheEntry>();
  private timer: TimerHandle | null = null;
  private inFlight: RefreshOperation | null = null;
  private running = false;
  private generation = 0;

  constructor(
    musicRoots: readonly MusicLibraryRoot[],
    private readonly onChange: MusicLibraryChangeHandler,
    options: MusicLibraryServiceOptions = {}
  ) {
    this.roots = musicRoots.map((root) => ({
      directory: path.resolve(root.directory),
      source: root.source,
      required: root.required
    }));
    const requestedInterval = options.pollIntervalMs ?? DEFAULT_MUSIC_LIBRARY_POLL_INTERVAL_MS;
    this.pollIntervalMs = Number.isFinite(requestedInterval) && requestedInterval > 0
      ? requestedInterval
      : 0;
    this.metadataReader = options.metadataReader ?? readMetadata;
    const requestedConcurrency = options.metadataConcurrency ?? 6;
    this.metadataConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(16, Math.trunc(requestedConcurrency)))
      : 6;
  }

  async start(): Promise<MusicLibraryItem[]> {
    this.stop();
    this.running = true;
    const generation = this.generation;
    const items = await this.refresh();
    if (this.isCurrent(generation)) this.schedulePoll(generation);
    return items;
  }

  async refresh(): Promise<MusicLibraryItem[]> {
    if (!this.running) return this.getItems();
    if (this.inFlight) {
      // Coalesce any number of notifications during the first scan into exactly one
      // trailing scan. This catches a file committed after discovery without allowing
      // a notification storm to create an unbounded scan chain.
      if (!this.inFlight.trailingStarted) this.inFlight.trailingRequested = true;
      return this.inFlight.promise;
    }

    const generation = this.generation;
    const operation: RefreshOperation = {
      generation,
      promise: Promise.resolve([]),
      trailingRequested: false,
      trailingStarted: false
    };
    const scanOnce = async (): Promise<void> => {
      try {
        const result = await this.scan();
        if (this.isCurrent(generation)) this.replace(result);
      } catch {
        // A transient filesystem or metadata failure must not erase the last good index.
      }
    };
    operation.promise = (async (): Promise<MusicLibraryItem[]> => {
      await scanOnce();
      if (operation.trailingRequested && this.isCurrent(generation)) {
        operation.trailingStarted = true;
        operation.trailingRequested = false;
        await scanOnce();
      }
      return this.getItems();
    })();

    this.inFlight = operation;
    try {
      return await operation.promise;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  /** Manual refresh path: preserve the last good index, but surface scan failure to the caller. */
  async refreshOrThrow(): Promise<MusicLibraryItem[]> {
    if (!this.running) throw new Error("The music library scanner is not running.");
    const generation = this.generation;
    const result = await this.scan();
    if (this.isCurrent(generation)) this.replace(result);
    if (result.warnings.length) throw new Error(result.warnings.join(" "));
    return this.getItems();
  }

  getItems(): MusicLibraryItem[] {
    return this.items.map(cloneItem);
  }

  getFilePath(id: string): string | null {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    return this.pathsById.get(id) ?? null;
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = null;
  }

  private async scan(): Promise<ScanResult> {
    const discovery = await this.discoverFiles();
    const { files } = discovery;
    const items = new Array<MusicLibraryItem>(files.length);
    const pathsById = new Map<string, string>();
    const metadataCache = new Map<string, MetadataCacheEntry>();
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        const file = files[index]!;
        const cached = this.metadataCache.get(file.fullPath);
        let item: MusicLibraryItem;
        if (cached?.fingerprint === file.fingerprint) {
          item = cloneItem(cached.item);
        } else {
          item = await this.createItem(file);
        }
        items[index] = item;
        pathsById.set(item.id, file.fullPath);
        metadataCache.set(file.fullPath, {
          fingerprint: file.fingerprint,
          item: cloneItem(item)
        });
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(this.metadataConcurrency, files.length) },
        () => worker()
      )
    );
    return {
      items: normalizeItems(items),
      pathsById,
      metadataCache,
      warnings: discovery.warnings
    };
  }

  private async discoverFiles(): Promise<{ files: DiscoveredFile[]; warnings: string[] }> {
    const discovered: DiscoveredFile[] = [];
    const warnings: string[] = [];
    const seenRoots = new Set<string>();
    const seenFiles = new Set<string>();

    for (const configuredRoot of this.roots) {
      let root: string;
      try {
        root = await realpath(configuredRoot.directory);
      } catch (error) {
        if (isMissingError(error) && !configuredRoot.required) continue;
        warnings.push(`Music folder unavailable: ${configuredRoot.directory}.`);
        continue;
      }
      const rootKey = root.toLocaleLowerCase("en-US");
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);

      let rootInfo;
      try {
        rootInfo = await lstat(root);
      } catch {
        warnings.push(`Music folder could not be inspected: ${configuredRoot.directory}.`);
        continue;
      }
      if (!rootInfo.isDirectory()) {
        if (configuredRoot.required) {
          warnings.push(`Music folder is not a directory: ${configuredRoot.directory}.`);
        }
        continue;
      }
      const directories = [root];
      while (directories.length) {
        const directory = directories.pop()!;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (directory === root && !isMissingError(error)) {
            warnings.push(`Music folder could not be read: ${configuredRoot.directory}.`);
          }
          continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const candidatePath = path.join(directory, entry.name);
          let info;
          try {
            info = await lstat(candidatePath);
          } catch {
            continue;
          }
          // On Windows, directory junctions are reported as symbolic links by lstat.
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            directories.push(candidatePath);
            continue;
          }
          if (!info.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            continue;
          }
          let fullPath: string;
          try {
            fullPath = await realpath(candidatePath);
          } catch {
            continue;
          }
          const fileKey = fullPath.toLocaleLowerCase("en-US");
          if (seenFiles.has(fileKey)) continue;
          seenFiles.add(fileKey);

          const relativePath = path.relative(root, fullPath);
          const folder = path.dirname(relativePath);
          discovered.push({
            fullPath,
            identityKey: `${rootKey}\0${relativePath}`,
            relativePath,
            relativeFolder: folder === "." ? "" : folder.split(path.sep).join("/"),
            source: configuredRoot.source,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            fingerprint: `${info.size}:${info.mtimeMs}`
          });
        }
      }
    }
    const files = discovered.sort((left, right) => {
      const source = left.source.localeCompare(right.source);
      return source || left.relativePath.localeCompare(right.relativePath);
    });
    return { files, warnings };
  }

  private async createItem(file: DiscoveredFile): Promise<MusicLibraryItem> {
    const fileName = path.basename(file.fullPath);
    const fallbackTitle = path.basename(fileName, path.extname(fileName));
    let metadata: MusicFileMetadata = {};
    try {
      metadata = await this.metadataReader(file.fullPath);
    } catch {
      // Corrupt and tagless files still belong in the library with filename fallbacks.
    }
    const duration = positiveNumber(metadata.durationSeconds);
    const extension = path.extname(fileName).slice(1).toUpperCase();
    return {
      id: stableId(file.source, file.identityKey),
      fileName,
      title: cleanText(metadata.title, fallbackTitle),
      artist: cleanText(metadata.artist ?? metadata.albumArtist, "Unknown Artist"),
      album: cleanText(metadata.album, "Unknown Album"),
      durationSeconds: duration === undefined ? undefined : Math.round(duration * 1_000) / 1_000,
      trackNumber: positiveInteger(metadata.trackNumber),
      year: positiveInteger(metadata.year),
      format: cleanText(metadata.format, extension).toUpperCase(),
      size: file.size,
      modifiedAt: file.modifiedAt,
      source: file.source,
      relativeFolder: file.relativeFolder
    };
  }

  private replace(result: ScanResult): void {
    const signature = JSON.stringify(result.items);
    this.pathsById = result.pathsById;
    this.metadataCache = result.metadataCache;
    if (signature === this.signature) return;

    this.items = result.items;
    this.signature = signature;
    try {
      this.onChange(this.getItems());
    } catch {
      // UI listeners cannot be allowed to stop local library monitoring.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private schedulePoll(generation: number): void {
    if (!this.pollIntervalMs || !this.isCurrent(generation)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isCurrent(generation)) return;
      void this.refresh()
        .catch(() => undefined)
        .finally(() => {
          if (this.isCurrent(generation)) this.schedulePoll(generation);
        });
    }, this.pollIntervalMs);
    unrefTimer(this.timer);
  }
}
