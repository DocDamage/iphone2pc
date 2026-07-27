export type AudioRepeatMode = "off" | "all" | "one";

export type AudioPlayerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "unavailable"
  | "error";

export interface PersistedAudioPlayerState {
  version: 1;
  queueTrackIds: string[];
  currentTrackId: string | null;
  currentTime: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: AudioRepeatMode;
  playbackRate: number;
}

export interface ShuffleSelection {
  trackId: string | null;
  remainingPool: string[];
}

export const AUDIO_PLAYER_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type CollapsibleVisualKind = "video" | "gif";

export function defaultVisualPreviewExpanded(kind: "audio" | CollapsibleVisualKind): boolean {
  return kind === "video" || kind === "gif";
}

export function visualPreviewToggleLabel(
  kind: CollapsibleVisualKind,
  expanded: boolean
): string {
  const mediaName = kind === "gif" ? "GIF" : "video";
  return `${expanded ? "Hide" : "Show"} ${mediaName} preview`;
}

export function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function cycleRepeatMode(mode: AudioRepeatMode): AudioRepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}

export function deduplicateTrackIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Keeps an explicit queue order while removing duplicate or no-longer-available tracks. */
export function reconcileQueueTrackIds(
  savedIds: readonly string[],
  availableIds: readonly string[]
): string[] {
  const available = new Set(deduplicateTrackIds(availableIds));
  return deduplicateTrackIds(savedIds).filter((id) => available.has(id));
}

export function appendAvailableTrackIds(
  queueTrackIds: readonly string[],
  requestedTrackIds: readonly string[],
  availableIds: readonly string[]
): string[] {
  const available = new Set(availableIds);
  return deduplicateTrackIds([
    ...queueTrackIds,
    ...requestedTrackIds.filter((id) => available.has(id))
  ]);
}

export function sequentialTrackId(
  queueTrackIds: readonly string[],
  currentTrackId: string | null,
  direction: 1 | -1,
  repeat: AudioRepeatMode,
  ended = false
): string | null {
  if (queueTrackIds.length === 0) return null;
  const currentIndex = currentTrackId ? queueTrackIds.indexOf(currentTrackId) : -1;
  if (currentIndex < 0) return direction > 0 ? queueTrackIds[0] : queueTrackIds.at(-1) ?? null;
  if (ended && repeat === "one") return currentTrackId;

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < queueTrackIds.length) return queueTrackIds[nextIndex];
  if (repeat === "all") return direction > 0 ? queueTrackIds[0] : queueTrackIds.at(-1) ?? null;
  return null;
}

export function createShufflePool(
  queueTrackIds: readonly string[],
  currentTrackId: string | null
): string[] {
  return deduplicateTrackIds(queueTrackIds).filter((id) => id !== currentTrackId);
}

/** Selects without replacement. A repeat-all queue starts a fresh bag after every track plays. */
export function selectShuffledTrack(
  queueTrackIds: readonly string[],
  currentTrackId: string | null,
  remainingPool: readonly string[],
  repeat: AudioRepeatMode,
  random: () => number = Math.random
): ShuffleSelection {
  const queue = deduplicateTrackIds(queueTrackIds);
  if (queue.length === 0) return { trackId: null, remainingPool: [] };
  if (queue.length === 1) {
    return repeat === "all" || repeat === "one"
      ? { trackId: queue[0], remainingPool: [] }
      : { trackId: null, remainingPool: [] };
  }

  const available = new Set(queue);
  let pool = deduplicateTrackIds(remainingPool).filter(
    (id) => available.has(id) && id !== currentTrackId
  );
  if (pool.length === 0) {
    if (repeat !== "all") return { trackId: null, remainingPool: [] };
    pool = createShufflePool(queue, currentTrackId);
  }

  const index = Math.min(pool.length - 1, Math.floor(clampNumber(random(), 0, 0.999999999) * pool.length));
  const trackId = pool[index] ?? null;
  return {
    trackId,
    remainingPool: pool.filter((_, poolIndex) => poolIndex !== index)
  };
}

export function defaultPersistedAudioPlayerState(): PersistedAudioPlayerState {
  return {
    version: 1,
    queueTrackIds: [],
    currentTrackId: null,
    currentTime: 0,
    volume: 0.85,
    muted: false,
    shuffle: false,
    repeat: "off",
    playbackRate: 1
  };
}

export function parsePersistedAudioPlayerState(value: string | null): PersistedAudioPlayerState {
  const fallback = defaultPersistedAudioPlayerState();
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedAudioPlayerState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return fallback;
    const repeat: AudioRepeatMode =
      parsed.repeat === "all" || parsed.repeat === "one" ? parsed.repeat : "off";
    const playbackRate = AUDIO_PLAYER_RATES.includes(
      parsed.playbackRate as (typeof AUDIO_PLAYER_RATES)[number]
    )
      ? (parsed.playbackRate as number)
      : 1;
    return {
      version: 1,
      queueTrackIds: Array.isArray(parsed.queueTrackIds)
        ? deduplicateTrackIds(parsed.queueTrackIds.filter((id): id is string => typeof id === "string"))
        : [],
      currentTrackId: typeof parsed.currentTrackId === "string" ? parsed.currentTrackId : null,
      currentTime: typeof parsed.currentTime === "number"
        ? clampNumber(parsed.currentTime, 0, Number.MAX_SAFE_INTEGER)
        : fallback.currentTime,
      volume: typeof parsed.volume === "number"
        ? clampNumber(parsed.volume, 0, 1)
        : fallback.volume,
      muted: parsed.muted === true,
      shuffle: parsed.shuffle === true,
      repeat,
      playbackRate
    };
  } catch {
    return fallback;
  }
}

export function isKeyboardShortcutTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest("input, textarea, select, button, a[href], summary, [contenteditable], [role='slider'], [role='button'], [role='textbox'], [role='combobox'], [role='menuitem'], [role='option']")) {
    return true;
  }
  return false;
}
