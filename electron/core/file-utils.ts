import path from "node:path";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import type { ConflictPolicy } from "./types.js";

const WINDOWS_RESERVED = /[<>:"/\\|?*\u0000-\u001F]/g;
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFileName(input: string): string {
  const base = path.basename(input || "Untitled");
  let value = base
    .normalize("NFC")
    .replace(WINDOWS_RESERVED, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!value || value === "." || value === "..") value = "Untitled";
  if (WINDOWS_DEVICE_NAMES.test(value)) value = `_${value}`;
  return value.slice(0, 240);
}

export function sanitizeRelativeDirectory(input?: string): string {
  if (!input) return "";
  return input
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(sanitizeFileName)
    .join(path.sep);
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface ResolvedPathInsideRoot {
  root: string;
  target: string;
}

/**
 * Resolve a path against an existing approved root without following links below that root.
 * For a target that does not exist yet, the nearest existing ancestor is resolved and the
 * remaining path is appended to it.
 */
export async function resolvePathInsideRealRoot(
  approvedRoot: string,
  requestedPath: string
): Promise<ResolvedPathInsideRoot> {
  const lexicalRoot = path.resolve(approvedRoot);
  const lexicalTarget = path.resolve(requestedPath);
  if (!isPathInside(lexicalRoot, lexicalTarget)) {
    throw new Error("Unsafe path outside the approved root.");
  }

  const resolvedRoot = await realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (!relative) return { root: resolvedRoot, target: resolvedRoot };

  const segments = relative.split(path.sep).filter(Boolean);
  let lexicalCursor = lexicalRoot;
  let resolvedCursor = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    lexicalCursor = path.join(lexicalCursor, segments[index]);
    let info;
    try {
      info = await lstat(lexicalCursor);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const target = path.resolve(resolvedCursor, ...segments.slice(index));
      if (!isPathInside(resolvedRoot, target)) {
        throw new Error("Unsafe path outside the approved real root.");
      }
      return { root: resolvedRoot, target };
    }
    if (info.isSymbolicLink()) {
      throw new Error("Unsafe symbolic link or junction inside the approved root.");
    }
    resolvedCursor = await realpath(lexicalCursor);
    if (!isPathInside(resolvedRoot, resolvedCursor)) {
      throw new Error("Unsafe path outside the approved real root.");
    }
  }
  return { root: resolvedRoot, target: resolvedCursor };
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function uniqueFilePath(desiredPath: string): Promise<string> {
  if (!(await exists(desiredPath))) return desiredPath;
  const parsed = path.parse(desiredPath);
  for (let index = 2; index < 100_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not create a unique file name.");
}

export async function resolveDestinationPath(
  root: string,
  fileName: string,
  relativeDirectory: string | undefined,
  policy: ConflictPolicy
): Promise<{ finalPath: string; skipped: boolean }> {
  const safeDirectory = sanitizeRelativeDirectory(relativeDirectory);
  const lexicalDirectory = path.join(root, safeDirectory);
  const { root: realRoot, target: directory } = await resolvePathInsideRealRoot(
    root,
    lexicalDirectory
  );
  await ensureDirectory(directory);
  const { target: desired } = await resolvePathInsideRealRoot(
    realRoot,
    path.join(directory, sanitizeFileName(fileName))
  );

  if (!(await exists(desired))) return { finalPath: desired, skipped: false };
  if (policy === "skip") return { finalPath: desired, skipped: true };
  if (policy === "rename") {
    const candidate = await uniqueFilePath(desired);
    const { target: finalPath } = await resolvePathInsideRealRoot(realRoot, candidate);
    return { finalPath, skipped: false };
  }
  return { finalPath: desired, skipped: false };
}

export async function getFileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export function contentDispositionFileName(fileName: string): string {
  const safe = sanitizeFileName(fileName).replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
