import path from "node:path";
import { parseFile } from "music-metadata";
import sharp from "sharp";
import type { ProducerArtwork } from "./types.js";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wma"
]);
const MAX_REMOTE_ART_BYTES = 15 * 1024 * 1024;

interface SearchSeed {
  title: string;
  artist: string;
  source: string;
}

interface MusicBrainzReleaseGroup {
  id: string;
  title: string;
  score?: number;
  "primary-type"?: string;
  "first-release-date"?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
}

interface ArtworkResult {
  bytes: Buffer;
  archiveName: string;
  info: ProducerArtwork;
}

export class ArtworkService {
  async discover(
    filePaths: string[],
    requested: { title: string; artist: string }
  ): Promise<ArtworkResult | null> {
    const audioFiles = filePaths
      .filter((filePath) => AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .slice(0, 6);
    const seeds: SearchSeed[] = [
      { title: requested.title, artist: requested.artist, source: "delivery details" }
    ];

    for (const filePath of audioFiles) {
      try {
        const metadata = await parseFile(filePath, {
          duration: false,
          skipCovers: false
        });
        const picture = metadata.common.picture?.find((item) => item.data.length > 0);
        if (picture) {
          const bytes = await normalizeArtwork(Buffer.from(picture.data));
          return {
            bytes,
            archiveName: "Artwork/Cover.jpg",
            info: {
              status: "embedded",
              source: "Embedded audio artwork",
              confidence: 1,
              requestedTitle: requested.title.trim(),
              requestedArtist: requested.artist.trim(),
              matchedTitle: metadata.common.album || metadata.common.title || requested.title,
              matchedArtist: metadata.common.albumartist || metadata.common.artist || requested.artist,
              queryVariants: []
            }
          };
        }
        const title = metadata.common.album || metadata.common.title;
        const artist = metadata.common.albumartist || metadata.common.artist;
        if (title) {
          seeds.push({
            title,
            artist: artist || requested.artist,
            source: `audio tags in ${path.basename(filePath)}`
          });
        }
      } catch {
        // A corrupt or unsupported audio file should not block the delivery.
      }
      seeds.push({
        title: titleFromFileName(filePath),
        artist: requested.artist,
        source: `filename ${path.basename(filePath)}`
      });
    }

    const variants = uniqueSeeds(
      seeds.flatMap((seed) => expandSeed(seed))
    ).slice(0, 5);
    const checkedQueries: string[] = [];
    let best:
      | { release: MusicBrainzReleaseGroup; confidence: number; seed: SearchSeed }
      | undefined;

    for (const seed of variants) {
      checkedQueries.push(
        seed.artist ? `${seed.artist} — ${seed.title}` : seed.title
      );
      const results = await this.searchReleaseGroups(seed);
      for (const release of results) {
        const confidence = scoreRelease(seed, release);
        if (!best || confidence > best.confidence) {
          best = { release, confidence, seed };
        }
      }
      if ((best?.confidence ?? 0) >= 0.9) break;
      await delay(1_100);
    }

    if (!best || best.confidence < 0.58) return null;
    const remote = await fetchCover(best.release.id);
    if (!remote) return null;
    const bytes = await normalizeArtwork(remote);
    return {
      bytes,
      archiveName: "Artwork/Cover.jpg",
      info: {
        status: best.confidence >= 0.78 ? "matched" : "review",
        source: "MusicBrainz + Cover Art Archive",
        confidence: round(best.confidence),
        requestedTitle: requested.title.trim(),
        requestedArtist: requested.artist.trim(),
        matchedTitle: best.release.title,
        matchedArtist: artistCredit(best.release),
        releaseGroupId: best.release.id,
        queryVariants: checkedQueries,
        matchReason: `Best fuzzy match from ${best.seed.source}`
      }
    };
  }

  static localArtwork(filePaths: string[]): ProducerArtwork | undefined {
    const selected = filePaths.find((filePath) =>
      /\.(avif|bmp|gif|jpe?g|png|tiff?|webp)$/i.test(filePath)
    );
    if (!selected) return undefined;
    return {
      status: "provided",
      source: "Selected artwork file",
      confidence: 1,
      requestedTitle: "",
      requestedArtist: "",
      matchedTitle: path.basename(selected),
      queryVariants: []
    };
  }

  private async searchReleaseGroups(seed: SearchSeed): Promise<MusicBrainzReleaseGroup[]> {
    const tokens = [seed.title, seed.artist].filter(Boolean).join(" ");
    if (!tokens.trim()) return [];
    const url = new URL("https://musicbrainz.org/ws/2/release-group/");
    url.searchParams.set("query", tokens);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "12");
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PocketDock/3.0.0 (desktop music delivery artwork matcher)"
        },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) return [];
      const body = await response.json() as { "release-groups"?: MusicBrainzReleaseGroup[] };
      return body["release-groups"] ?? [];
    } catch {
      return [];
    }
  }
}

export function normalizeMusicName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(featuring|feat(?:uring)?|ft)\.?\b/gi, " feat ")
    .replace(/\b(prod(?:uced)?\s+by)\b.*$/gi, "")
    .replace(
      /\b(official|audio|video|lyrics?|visualizer|remaster(?:ed)?|radio edit|clean|explicit|version|delivery)\b/gi,
      " "
    )
    .replace(/[\[\]()[\]{}'"`’‘“”.,:;!?_/\\|+\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function similarity(left: string, right: string): number {
  const a = normalizeMusicName(left);
  const b = normalizeMusicName(right);
  if (!a || !b) return a === b ? 1 : 0;
  if (a === b) return 1;
  const distance = damerauLevenshtein(a, b);
  const characterScore = 1 - distance / Math.max(a.length, b.length);
  const leftTokens = new Set(a.split(" "));
  const rightTokens = new Set(b.split(" "));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = shared / new Set([...leftTokens, ...rightTokens]).size;
  return Math.max(0, characterScore * 0.72 + tokenScore * 0.28);
}

function expandSeed(seed: SearchSeed): SearchSeed[] {
  const title = cleanTitle(seed.title);
  const withoutFeature = title.replace(/\s+(?:feat|featuring|ft)\.?\s+.+$/i, "").trim();
  const variants: SearchSeed[] = [
    { ...seed, title },
    { ...seed, title: withoutFeature }
  ];
  const split = title.split(/\s[-–—]\s/).map((item) => item.trim()).filter(Boolean);
  if (split.length === 2) {
    variants.push({ title: split[1], artist: seed.artist || split[0], source: `${seed.source}, swapped title order` });
    variants.push({ title: split[0], artist: seed.artist || split[1], source: `${seed.source}, alternate title order` });
  }
  return variants.filter((item) => item.title);
}

function cleanTitle(value: string): string {
  return value
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\s*\d{1,3}[\s._-]+/, "")
    .replace(/\s*\((?:official|audio|video|lyrics?|visualizer|remaster(?:ed)?|clean|explicit)[^)]*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromFileName(filePath: string): string {
  return cleanTitle(path.basename(filePath));
}

function uniqueSeeds(seeds: SearchSeed[]): SearchSeed[] {
  const seen = new Set<string>();
  return seeds.filter((seed) => {
    const key = `${normalizeMusicName(seed.artist)}|${normalizeMusicName(seed.title)}`;
    if (!seed.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreRelease(seed: SearchSeed, release: MusicBrainzReleaseGroup): number {
  const titleScore = similarity(seed.title, release.title);
  const releaseArtist = artistCredit(release);
  const artistScore = seed.artist ? similarity(seed.artist, releaseArtist) : 0.72;
  const providerScore = Math.max(0, Math.min(1, (release.score ?? 0) / 100));
  const typeBoost = ["Album", "Single", "EP"].includes(release["primary-type"] ?? "") ? 0.025 : 0;
  return Math.min(1, titleScore * 0.56 + artistScore * 0.32 + providerScore * 0.12 + typeBoost);
}

function artistCredit(release: MusicBrainzReleaseGroup): string {
  return (release["artist-credit"] ?? [])
    .map((credit) => credit.name || credit.artist?.name || "")
    .filter(Boolean)
    .join(" & ");
}

async function fetchCover(releaseGroupId: string): Promise<Buffer | null> {
  for (const size of ["1200", "500"]) {
    try {
      const response = await fetch(
        `https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupId)}/front-${size}`,
        { signal: AbortSignal.timeout(12_000), redirect: "follow" }
      );
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (!contentType.startsWith("image/") || contentLength > MAX_REMOTE_ART_BYTES) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_REMOTE_ART_BYTES) continue;
      return bytes;
    } catch {
      // Try the next safe Cover Art Archive size.
    }
  }
  return null;
}

async function normalizeArtwork(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize({
      width: 1_600,
      height: 1_600,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function damerauLevenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0)
  );
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }
  return matrix[left.length][right.length];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
