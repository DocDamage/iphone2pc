import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import {
  Eye,
  EyeOff,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Music2,
  Pause,
  Play,
  PictureInPicture2,
  Repeat,
  Repeat1,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import {
  AUDIO_PLAYER_RATES,
  appendAvailableTrackIds,
  clampNumber,
  createShufflePool,
  cycleRepeatMode,
  defaultVisualPreviewExpanded,
  deduplicateTrackIds,
  formatPlaybackTime,
  isKeyboardShortcutTarget,
  parsePersistedAudioPlayerState,
  reconcileQueueTrackIds,
  selectShuffledTrack,
  sequentialTrackId,
  visualPreviewToggleLabel,
  type AudioPlayerStatus,
  type AudioRepeatMode,
  type PersistedAudioPlayerState
} from "./audio-player-core";
import "./audio-preview-player.css";

export type { AudioPlayerStatus, AudioRepeatMode } from "./audio-player-core";

export type MediaPreviewKind = "audio" | "video" | "gif";

export interface AudioPreviewTrack {
  id: string;
  title: string;
  /** Defaults to audio for compatibility with the music library. */
  kind?: MediaPreviewKind;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  artworkUrl?: string;
  /** Static thumbnail/poster. GIF playback uses this while animation is paused. */
  posterUrl?: string;
  /** A directly playable URL. Use resolveSource when the backend must mint one asynchronously. */
  sourceUrl?: string | null;
}

export interface ResolvedAudioSource {
  url: string;
  /** Called on track changes/unmount; useful when the resolver creates an object URL. */
  cleanup?: () => void;
}

export type AudioSourceResolution = string | ResolvedAudioSource | null;
export type AudioSourceResolver = (
  track: AudioPreviewTrack,
  signal: AbortSignal
) => AudioSourceResolution | Promise<AudioSourceResolution>;

export interface AudioPlayerSnapshot {
  status: AudioPlayerStatus;
  currentTrackId: string | null;
  queueTrackIds: readonly string[];
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: AudioRepeatMode;
  playbackRate: number;
  error: string | null;
}

export interface AudioPreviewPlayerHandle {
  /** Selects and plays a track. Calling this for the current track resumes; it does not restart. */
  playTrack: (trackId: string) => void;
  /** Toggles the current track, or selects and plays a different track. */
  toggleTrack: (trackId: string) => void;
  togglePlayback: () => void;
  enqueue: (trackIds: string | readonly string[]) => void;
  removeFromQueue: (trackId: string) => void;
  /** Replaces the persistent queue with this exact snapshot of track IDs. */
  replaceQueue: (trackIds: readonly string[], startTrackId?: string) => void;
  focus: () => void;
}

export type MediaPreviewTrack = AudioPreviewTrack;
export type MediaPreviewPlayerHandle = AudioPreviewPlayerHandle;

export interface AudioPreviewPlayerProps {
  /** The playable track catalog. Track IDs must be unique and stable. */
  tracks: readonly AudioPreviewTrack[];
  /** Changing this selects the track; set autoPlayRequestedTrack=false to select without playing. */
  requestedTrackId?: string | null;
  resolveSource?: AudioSourceResolver;
  /** Increment when a resolver should be retried even though the track ID did not change. */
  sourceRevision?: string | number;
  autoPlayRequestedTrack?: boolean;
  /** false disables restoration. The default key persists queue, position, and player preferences. */
  persistenceKey?: string | false;
  /** Default shortcuts work only while the player has focus. Global mode still ignores form controls. */
  globalKeyboardShortcuts?: boolean;
  keyboardShortcutsEnabled?: boolean;
  className?: string;
  emptyMessage?: string;
  onTrackChange?: (track: AudioPreviewTrack | null) => void;
  onQueueChange?: (queue: readonly AudioPreviewTrack[]) => void;
  onStateChange?: (snapshot: AudioPlayerSnapshot) => void;
  onError?: (message: string, track: AudioPreviewTrack | null) => void;
  renderTrackAction?: (track: AudioPreviewTrack, isCurrent: boolean) => ReactNode;
}

export type MediaPreviewPlayerProps = AudioPreviewPlayerProps;

interface ShortcutEvent {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

const DEFAULT_PERSISTENCE_KEY = "pocketdock:audio-preview-player:v1";
const PREVIOUS_RESTART_SECONDS = 3;
const SEEK_STEP_SECONDS = 5;
const MEDIA_SEEK_STEP_SECONDS = 10;

function readPersistedState(key: string | false) {
  if (key === false || typeof window === "undefined") return parsePersistedAudioPlayerState(null);
  try {
    return parsePersistedAudioPlayerState(window.localStorage.getItem(key));
  } catch {
    return parsePersistedAudioPlayerState(null);
  }
}

function normalizedSource(source: AudioSourceResolution): ResolvedAudioSource | null {
  if (typeof source === "string") return source.trim() ? { url: source } : null;
  if (!source || typeof source.url !== "string" || !source.url.trim()) return null;
  return source;
}

function playbackErrorMessage(media: HTMLMediaElement): string {
  switch (media.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was interrupted.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "Playback stopped because the media source could not be read.";
    case MediaError.MEDIA_ERR_DECODE:
      return "This media file could not be decoded by the built-in player.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This media format or codec is not supported by the built-in player.";
    default:
      return "This media item could not be played.";
  }
}

function repeatLabel(repeat: AudioRepeatMode): string {
  if (repeat === "one") return "Repeat one";
  if (repeat === "all") return "Repeat all";
  return "Repeat off";
}

function trackLabel(track: AudioPreviewTrack): string {
  return track.artist?.trim() ? `${track.title} by ${track.artist}` : track.title;
}

function trackKind(track: AudioPreviewTrack | null): MediaPreviewKind {
  return track?.kind ?? "audio";
}

export const AudioPreviewPlayer = forwardRef<AudioPreviewPlayerHandle, AudioPreviewPlayerProps>(
  function AudioPreviewPlayer(
    {
      tracks,
      requestedTrackId = null,
      resolveSource,
      sourceRevision = 0,
      autoPlayRequestedTrack = true,
      persistenceKey = DEFAULT_PERSISTENCE_KEY,
      globalKeyboardShortcuts = false,
      keyboardShortcutsEnabled = true,
      className,
      emptyMessage = "Choose a track to start previewing.",
      onTrackChange,
      onQueueChange,
      onStateChange,
      onError,
      renderTrackAction
    },
    forwardedRef
  ) {
    const restoredStateRef = useRef(readPersistedState(persistenceKey));
    const restoredState = restoredStateRef.current;
    const rootRef = useRef<HTMLElement>(null);
    const visualPreviewId = useId();
    const audioRef = useRef<HTMLMediaElement>(null);
    const videoExpandButtonRef = useRef<HTMLButtonElement>(null);
    const resolverRef = useRef(resolveSource);
    const loadGenerationRef = useRef(0);
    const sourceTrackIdRef = useRef<string | null>(null);
    const sourceCleanupRef = useRef<(() => void) | null>(null);
    const abortSourceRef = useRef<AbortController | null>(null);
    const playIntentRef = useRef(false);
    const currentKindRef = useRef<MediaPreviewKind>("audio");
    const resolvedGifUrlRef = useRef<string | null>(null);
    const currentTrackIdRef = useRef<string | null>(null);
    const shufflePoolRef = useRef<string[]>([]);
    const shuffleHistoryRef = useRef<string[]>([]);
    const queueWasHydratedRef = useRef(tracks.length > 0);
    const lastRequestedTrackIdRef = useRef<string | null>(null);
    const pendingResumeRef = useRef<{ trackId: string; time: number } | null>(
      restoredState.currentTrackId && restoredState.currentTime > 0
        ? { trackId: restoredState.currentTrackId, time: restoredState.currentTime }
        : null
    );
    const fullscreenWasActiveRef = useRef(false);
    const persistencePayloadRef = useRef<PersistedAudioPlayerState>(restoredState);

    const tracksById = useMemo(() => {
      const catalog = new Map<string, AudioPreviewTrack>();
      for (const track of tracks) {
        if (track.id && !catalog.has(track.id)) catalog.set(track.id, track);
      }
      return catalog;
    }, [tracks]);

    const availableTrackIds = useMemo(() => [...tracksById.keys()], [tracksById]);
    const preferredInitialTrackId =
      (requestedTrackId && tracksById.has(requestedTrackId) ? requestedTrackId : null) ??
      (restoredState.currentTrackId && tracksById.has(restoredState.currentTrackId)
        ? restoredState.currentTrackId
        : null);
    const initialKind = trackKind(preferredInitialTrackId ? tracksById.get(preferredInitialTrackId) ?? null : null);
    const initialQueueSeed = restoredState.queueTrackIds.length > 0
      ? reconcileQueueTrackIds(restoredState.queueTrackIds, availableTrackIds)
      : preferredInitialTrackId
        ? [preferredInitialTrackId]
        : [];
    const initialQueueIds = initialQueueSeed.filter((id) => trackKind(tracksById.get(id) ?? null) === initialKind);
    const initialCurrentTrackId =
      (preferredInitialTrackId && initialQueueIds.includes(preferredInitialTrackId) ? preferredInitialTrackId : null) ??
      initialQueueIds[0] ??
      null;
    const statusRef = useRef<AudioPlayerStatus>(initialCurrentTrackId ? "loading" : "idle");

    const [queueTrackIds, setQueueTrackIds] = useState<string[]>(initialQueueIds);
    const [currentTrackId, setCurrentTrackId] = useState<string | null>(initialCurrentTrackId);
    const [status, setStatus] = useState<AudioPlayerStatus>(initialCurrentTrackId ? "loading" : "idle");
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(restoredState.volume);
    const [muted, setMuted] = useState(restoredState.muted);
    const [shuffle, setShuffle] = useState(restoredState.shuffle);
    const [repeat, setRepeat] = useState<AudioRepeatMode>(restoredState.repeat);
    const [playbackRate, setPlaybackRate] = useState(restoredState.playbackRate);
    const [error, setError] = useState<string | null>(null);
    const [queueOpen, setQueueOpen] = useState(false);
    const [retryNonce, setRetryNonce] = useState(0);
    const [resolvedGifUrl, setResolvedGifUrl] = useState<string | null>(null);
    const [gifRestartNonce, setGifRestartNonce] = useState(0);
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
    const [isPictureInPicture, setIsPictureInPicture] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [visualPreviewExpanded, setVisualPreviewExpanded] = useState(false);

    const currentTrack = currentTrackId ? tracksById.get(currentTrackId) ?? null : null;
    const currentKind = trackKind(currentTrack);
    const queue = useMemo(
      () => queueTrackIds.flatMap((id) => {
        const track = tracksById.get(id);
        return track ? [track] : [];
      }),
      [queueTrackIds, tracksById]
    );
    const currentQueueIndex = currentTrackId ? queueTrackIds.indexOf(currentTrackId) : -1;

    currentTrackIdRef.current = currentTrackId;
    statusRef.current = status;
    currentKindRef.current = currentKind;
    resolvedGifUrlRef.current = resolvedGifUrl;
    resolverRef.current = resolveSource;

    const reportError = useCallback((message: string) => {
      setError(message);
      setStatus("error");
      setIsPlaying(false);
      playIntentRef.current = false;
    }, []);

    const cleanupSource = useCallback(() => {
      abortSourceRef.current?.abort();
      abortSourceRef.current = null;
      sourceTrackIdRef.current = null;
      resolvedGifUrlRef.current = null;
      setResolvedGifUrl(null);
      const cleanup = sourceCleanupRef.current;
      sourceCleanupRef.current = null;
      try {
        cleanup?.();
      } catch {
        // A consumer cleanup hook must never prevent the player from switching tracks.
      }
    }, []);

    const pausePlayback = useCallback(() => {
      playIntentRef.current = false;
      if (currentKindRef.current === "gif") {
        setGifRestartNonce((value) => value + 1);
      } else {
        audioRef.current?.pause();
      }
      setIsPlaying(false);
      setStatus((value) => value === "idle" || value === "unavailable" || value === "error" ? value : "paused");
    }, []);

    const playCurrent = useCallback(() => {
      const audio = audioRef.current;
      if (!currentTrackIdRef.current) return;
      playIntentRef.current = true;
      if (currentKindRef.current === "gif") {
        if (!resolvedGifUrlRef.current) {
          if (statusRef.current === "error" || statusRef.current === "unavailable") {
            setRetryNonce((value) => value + 1);
          } else {
            setStatus("loading");
          }
          return;
        }
        setGifRestartNonce((value) => value + 1);
        setError(null);
        setIsPlaying(true);
        setStatus("playing");
        return;
      }
      if (!audio || sourceTrackIdRef.current !== currentTrackIdRef.current || !audio.src) {
        if (statusRef.current === "error" || statusRef.current === "unavailable") setRetryNonce((value) => value + 1);
        else setStatus("loading");
        return;
      }
      const generation = loadGenerationRef.current;
      void audio.play().catch((reason: unknown) => {
        if (generation !== loadGenerationRef.current || !playIntentRef.current) return;
        const name = reason instanceof DOMException ? reason.name : "";
        if (name === "AbortError") return;
        playIntentRef.current = false;
        setIsPlaying(false);
        if (name === "NotAllowedError") {
          setStatus("paused");
          setError("Playback is ready. Press Play to allow audio.");
          return;
        }
        reportError(reason instanceof Error ? reason.message : "Playback could not start.");
      });
    }, [reportError]);

    const selectTrack = useCallback((trackId: string, shouldPlay: boolean, rememberHistory = true) => {
      if (!tracksById.has(trackId)) return;
      if (!queueTrackIds.includes(trackId)) {
        setQueueTrackIds([trackId]);
        shuffleHistoryRef.current = [];
        shufflePoolRef.current = [];
      }
      const previousTrackId = currentTrackIdRef.current;
      if (trackId === previousTrackId) {
        if (shouldPlay) playCurrent();
        return;
      }
      if (rememberHistory && previousTrackId) shuffleHistoryRef.current.push(previousTrackId);
      shufflePoolRef.current = shufflePoolRef.current.filter((id) => id !== trackId);
      pendingResumeRef.current = null;
      playIntentRef.current = shouldPlay;
      setError(null);
      setCurrentTime(0);
      setDuration(0);
      setBuffered(0);
      setStatus("loading");
      setCurrentTrackId(trackId);
    }, [playCurrent, queueTrackIds, tracksById]);

    const navigate = useCallback((direction: 1 | -1, ended = false) => {
      const audio = audioRef.current;
      const activeId = currentTrackIdRef.current;
      if (direction < 0 && !ended && audio && audio.currentTime > PREVIOUS_RESTART_SECONDS) {
        audio.currentTime = 0;
        setCurrentTime(0);
        return;
      }

      let nextTrackId: string | null = null;
      if (shuffle && direction < 0 && shuffleHistoryRef.current.length > 0) {
        nextTrackId = shuffleHistoryRef.current.pop() ?? null;
      } else if (shuffle && direction > 0) {
        if (ended && repeat === "one") {
          nextTrackId = activeId;
        } else {
          const selection = selectShuffledTrack(
            queueTrackIds,
            activeId,
            shufflePoolRef.current,
            repeat
          );
          nextTrackId = selection.trackId;
          shufflePoolRef.current = selection.remainingPool;
        }
      } else {
        nextTrackId = sequentialTrackId(queueTrackIds, activeId, direction, repeat, ended);
      }

      if (!nextTrackId) {
        playIntentRef.current = false;
        setIsPlaying(false);
        setStatus("paused");
        if (ended && audio) {
          audio.currentTime = 0;
          setCurrentTime(0);
        }
        return;
      }
      if (nextTrackId === activeId) {
        if (audio) audio.currentTime = 0;
        setCurrentTime(0);
        playCurrent();
        return;
      }
      selectTrack(nextTrackId, true, !ended || shuffle);
    }, [playCurrent, queueTrackIds, repeat, selectTrack, shuffle]);

    const togglePlayback = useCallback(() => {
      if (playIntentRef.current || isPlaying) pausePlayback();
      else playCurrent();
    }, [isPlaying, pausePlayback, playCurrent]);

    const toggleTrack = useCallback((trackId: string) => {
      if (trackId === currentTrackIdRef.current) togglePlayback();
      else selectTrack(trackId, true);
    }, [selectTrack, togglePlayback]);

    const seekTo = useCallback((nextTime: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const maximum = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      const clamped = clampNumber(nextTime, 0, maximum > 0 ? maximum : Number.MAX_SAFE_INTEGER);
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    }, [duration]);

    const changeVolume = useCallback((nextVolume: number) => {
      const clamped = clampNumber(nextVolume, 0, 1);
      setVolume(clamped);
      if (clamped > 0) setMuted(false);
    }, []);

    const togglePictureInPicture = useCallback(() => {
      const video = audioRef.current;
      if (!(video instanceof HTMLVideoElement) || typeof document === "undefined") return;
      void (async () => {
        try {
          if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
          else if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
            await video.requestPictureInPicture();
          }
        } catch (reason) {
          reportError(reason instanceof Error ? reason.message : "Picture-in-Picture could not be opened.");
        }
      })();
    }, [reportError]);

    const toggleFullscreen = useCallback(() => {
      const video = audioRef.current;
      if (!(video instanceof HTMLVideoElement) || typeof document === "undefined") return;
      void (async () => {
        try {
          if (document.fullscreenElement === video) await document.exitFullscreen();
          else if (typeof video.requestFullscreen === "function") await video.requestFullscreen();
        } catch (reason) {
          reportError(reason instanceof Error ? reason.message : "Fullscreen video could not be opened.");
        }
      })();
    }, [reportError]);

    const removeFromQueue = useCallback((trackId: string) => {
      setQueueTrackIds((currentQueue) => {
        if (!currentQueue.includes(trackId)) return currentQueue;
        const removedIndex = currentQueue.indexOf(trackId);
        const nextQueue = currentQueue.filter((id) => id !== trackId);
        if (currentTrackIdRef.current === trackId) {
          const replacement = nextQueue[Math.min(removedIndex, nextQueue.length - 1)] ?? null;
          playIntentRef.current = false;
          pendingResumeRef.current = null;
          setCurrentTrackId(replacement);
          setCurrentTime(0);
          setStatus(replacement ? "loading" : "idle");
        }
        return nextQueue;
      });
    }, []);

    const replaceQueue = useCallback((trackIds: readonly string[], startTrackId?: string) => {
      const validIds = deduplicateTrackIds(trackIds).filter((id) => tracksById.has(id));
      const contextTrackId = startTrackId && validIds.includes(startTrackId)
        ? startTrackId
        : currentTrackIdRef.current && validIds.includes(currentTrackIdRef.current)
          ? currentTrackIdRef.current
          : validIds[0];
      const contextKind = contextTrackId ? trackKind(tracksById.get(contextTrackId) ?? null) : null;
      const nextQueue = contextKind
        ? validIds.filter((id) => trackKind(tracksById.get(id) ?? null) === contextKind)
        : [];
      setQueueTrackIds(nextQueue);
      shuffleHistoryRef.current = [];
      shufflePoolRef.current = createShufflePool(nextQueue, startTrackId ?? currentTrackIdRef.current);
      const selectedId = startTrackId && nextQueue.includes(startTrackId)
        ? startTrackId
        : currentTrackIdRef.current && nextQueue.includes(currentTrackIdRef.current)
          ? currentTrackIdRef.current
          : nextQueue[0] ?? null;
      if (!selectedId) {
        pausePlayback();
        setCurrentTrackId(null);
        setStatus("idle");
      } else if (startTrackId) {
        // State has not adopted the replacement queue yet, so select directly.
        pendingResumeRef.current = null;
        playIntentRef.current = true;
        setCurrentTrackId(selectedId);
        setStatus("loading");
        if (selectedId === currentTrackIdRef.current) playCurrent();
      } else if (selectedId !== currentTrackIdRef.current) {
        playIntentRef.current = false;
        setCurrentTrackId(selectedId);
        setStatus("loading");
      }
    }, [pausePlayback, playCurrent, tracksById]);

    useImperativeHandle(forwardedRef, () => ({
      playTrack: (trackId) => selectTrack(trackId, true),
      toggleTrack,
      togglePlayback,
      enqueue: (trackIds) => {
        const requestedIds = typeof trackIds === "string" ? [trackIds] : [...trackIds];
        setQueueTrackIds((currentQueue) => {
          const activeKind = trackKind(tracksById.get(currentTrackIdRef.current ?? currentQueue[0] ?? "") ?? null);
          const availableRequestedIds = requestedIds.filter(
            (id) => tracksById.has(id) && trackKind(tracksById.get(id) ?? null) === activeKind
          );
          return appendAvailableTrackIds(currentQueue, availableRequestedIds, availableTrackIds);
        });
      },
      removeFromQueue,
      replaceQueue,
      focus: () => rootRef.current?.focus()
    }), [availableTrackIds, removeFromQueue, replaceQueue, selectTrack, togglePlayback, toggleTrack, tracksById]);

    // Reconcile library additions/removals without letting ordinary parent renders overwrite a
    // queue snapshot or re-add an item the listener deliberately removed.
    useEffect(() => {
      const nextCatalog = new Set(availableTrackIds);
      setQueueTrackIds((currentQueue) => {
        const baseQueue = !queueWasHydratedRef.current && restoredState.queueTrackIds.length > 0
          ? restoredState.queueTrackIds
          : currentQueue;
        const retained = baseQueue.filter((id) => nextCatalog.has(id));
        return retained;
      });
      if (availableTrackIds.length > 0) queueWasHydratedRef.current = true;
    }, [availableTrackIds, restoredState.queueTrackIds, tracksById]);

    useEffect(() => {
      if (queueTrackIds.length === 0) {
        if (currentTrackId !== null) setCurrentTrackId(null);
        setStatus("idle");
        return;
      }
      if (!currentTrackId || !queueTrackIds.includes(currentTrackId)) {
        const restoredId = restoredState.currentTrackId;
        setCurrentTrackId(restoredId && queueTrackIds.includes(restoredId) ? restoredId : queueTrackIds[0]);
        setStatus("loading");
      }
    }, [currentTrackId, queueTrackIds, restoredState.currentTrackId]);

    useEffect(() => {
      if (!requestedTrackId || !tracksById.has(requestedTrackId)) return;
      if (lastRequestedTrackIdRef.current === requestedTrackId) return;
      lastRequestedTrackIdRef.current = requestedTrackId;
      selectTrack(requestedTrackId, autoPlayRequestedTrack);
    }, [autoPlayRequestedTrack, queueTrackIds, requestedTrackId, selectTrack]);

    useEffect(() => {
      const audio = audioRef.current;
      const track = currentTrack;
      const generation = ++loadGenerationRef.current;
      cleanupSource();
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      setIsPlaying(false);
      setError(null);
      setCurrentTime(0);
      setDuration(track?.durationSeconds && track.durationSeconds > 0 ? track.durationSeconds : 0);
      setBuffered(0);
      if (!track) {
        setStatus("idle");
        return;
      }
      const kind = trackKind(track);
      if (kind !== "gif" && !audio) {
        reportError("The media player could not be initialized.");
        return;
      }

      setStatus("loading");
      const controller = new AbortController();
      abortSourceRef.current = controller;
      void (async () => {
        let resolution: AudioSourceResolution;
        try {
          resolution = resolverRef.current
            ? await resolverRef.current(track, controller.signal)
            : track.sourceUrl ?? null;
        } catch (reason) {
          if (controller.signal.aborted || generation !== loadGenerationRef.current) return;
          reportError(reason instanceof Error ? reason.message : "The preview source could not be loaded.");
          return;
        }
        const source = normalizedSource(resolution);
        if (controller.signal.aborted || generation !== loadGenerationRef.current) {
          try {
            source?.cleanup?.();
          } catch {
            // Ignore cleanup failures for a stale source.
          }
          return;
        }
        if (!source) {
          playIntentRef.current = false;
          setStatus("unavailable");
          setError("No playable preview is available for this track.");
          return;
        }

        sourceCleanupRef.current = source.cleanup ?? null;
        sourceTrackIdRef.current = track.id;
        if (kind === "gif") {
          resolvedGifUrlRef.current = source.url;
          setResolvedGifUrl(source.url);
          if (playIntentRef.current) {
            setGifRestartNonce((value) => value + 1);
            setIsPlaying(true);
            setStatus("playing");
          } else {
            setStatus("ready");
          }
        } else if (audio) {
          audio.src = source.url;
          audio.volume = volume;
          audio.muted = muted;
          audio.playbackRate = playbackRate;
          audio.load();
          if (playIntentRef.current) playCurrent();
        }
      })();

      return () => {
        if (generation === loadGenerationRef.current) {
          cleanupSource();
          if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
          }
        }
      };
      // volume/mute/rate are synchronized separately and must not reload the track.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cleanupSource, currentTrack?.id, currentTrack?.kind, currentTrack?.sourceUrl, playCurrent, reportError, retryNonce, sourceRevision]);

    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.volume = volume;
      audio.muted = muted;
    }, [muted, volume]);

    useEffect(() => {
      if (audioRef.current) audioRef.current.playbackRate = playbackRate;
    }, [playbackRate]);

    useEffect(() => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setPrefersReducedMotion(query.matches);
      update();
      query.addEventListener?.("change", update);
      return () => query.removeEventListener?.("change", update);
    }, []);

    useEffect(() => {
      if (typeof document === "undefined") return;
      const updateFullscreen = () => {
        const active = document.fullscreenElement === audioRef.current;
        setIsFullscreen(active);
        if (!active && fullscreenWasActiveRef.current) videoExpandButtonRef.current?.focus();
        fullscreenWasActiveRef.current = active;
      };
      document.addEventListener("fullscreenchange", updateFullscreen);
      return () => document.removeEventListener("fullscreenchange", updateFullscreen);
    }, []);

    useEffect(() => {
      if (currentKind === "video") return;
      setIsPictureInPicture(false);
      setIsFullscreen(false);
      if (typeof document !== "undefined" && document.pictureInPictureElement) {
        void document.exitPictureInPicture().catch(() => undefined);
      }
    }, [currentKind]);

    useEffect(() => {
      setVisualPreviewExpanded(defaultVisualPreviewExpanded(currentKind));
    }, [currentKind, currentTrackId]);

    useEffect(() => {
      const video = audioRef.current;
      if (currentKind !== "video" || !(video instanceof HTMLVideoElement)) return;
      const entered = () => setIsPictureInPicture(true);
      const left = () => setIsPictureInPicture(false);
      video.addEventListener("enterpictureinpicture", entered);
      video.addEventListener("leavepictureinpicture", left);
      return () => {
        video.removeEventListener("enterpictureinpicture", entered);
        video.removeEventListener("leavepictureinpicture", left);
      };
    }, [currentKind, currentTrackId]);

    useEffect(() => {
      shufflePoolRef.current = createShufflePool(queueTrackIds, currentTrackIdRef.current);
      if (!shuffle) shuffleHistoryRef.current = [];
    }, [queueTrackIds, shuffle]);

    useEffect(() => {
      onTrackChange?.(currentTrack);
    }, [currentTrack, onTrackChange]);

    useEffect(() => {
      onQueueChange?.(queue);
    }, [onQueueChange, queue]);

    const snapshot = useMemo<AudioPlayerSnapshot>(() => ({
      status,
      currentTrackId,
      queueTrackIds,
      isPlaying,
      currentTime,
      duration,
      buffered,
      volume,
      muted,
      shuffle,
      repeat,
      playbackRate,
      error
    }), [
      buffered,
      currentTime,
      currentTrackId,
      duration,
      error,
      isPlaying,
      muted,
      playbackRate,
      queueTrackIds,
      repeat,
      shuffle,
      status,
      volume
    ]);

    persistencePayloadRef.current = {
      version: 1,
      queueTrackIds,
      currentTrackId,
      currentTime: pendingResumeRef.current?.trackId === currentTrackId
        ? pendingResumeRef.current.time
        : currentTime,
      volume,
      muted,
      shuffle,
      repeat,
      playbackRate
    };

    useEffect(() => {
      onStateChange?.(snapshot);
    }, [onStateChange, snapshot]);

    useEffect(() => {
      if (error) onError?.(error, currentTrack);
    }, [currentTrack, error, onError]);

    useEffect(() => {
      if (persistenceKey === false || typeof window === "undefined") return;
      const timeout = window.setTimeout(() => {
        try {
          window.localStorage.setItem(persistenceKey, JSON.stringify(persistencePayloadRef.current));
        } catch {
          // Playback continues when storage is disabled, full, or unavailable.
        }
      }, 250);
      return () => window.clearTimeout(timeout);
    }, [
      currentTrackId,
      Math.floor(currentTime / 5),
      isPlaying,
      muted,
      persistenceKey,
      playbackRate,
      queueTrackIds,
      repeat,
      shuffle,
      volume
    ]);

    useEffect(() => {
      if (persistenceKey === false || typeof window === "undefined") return;
      const persistNow = () => {
        try {
          window.localStorage.setItem(persistenceKey, JSON.stringify(persistencePayloadRef.current));
        } catch {
          // Persistence is best-effort; never block app shutdown or player cleanup.
        }
      };
      window.addEventListener("beforeunload", persistNow);
      return () => {
        window.removeEventListener("beforeunload", persistNow);
        persistNow();
      };
    }, [persistenceKey]);

    const handleKeyboardShortcut = useCallback((event: ShortcutEvent) => {
      if (!keyboardShortcutsEnabled || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || isKeyboardShortcutTarget(event.target)) return;
      if (!currentTrackIdRef.current) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "spacebar") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "arrowleft") {
        if (currentKindRef.current === "gif") return;
        event.preventDefault();
        seekTo(currentTime - SEEK_STEP_SECONDS);
      } else if (key === "arrowright") {
        if (currentKindRef.current === "gif") return;
        event.preventDefault();
        seekTo(currentTime + SEEK_STEP_SECONDS);
      } else if (key === "arrowup") {
        if (currentKindRef.current === "gif") return;
        event.preventDefault();
        changeVolume(volume + 0.05);
      } else if (key === "arrowdown") {
        if (currentKindRef.current === "gif") return;
        event.preventDefault();
        changeVolume(volume - 0.05);
      } else if (key === "m") {
        if (currentKindRef.current === "gif") return;
        event.preventDefault();
        setMuted((value) => !value);
      } else if (key === "n") {
        event.preventDefault();
        navigate(1);
      } else if (key === "p") {
        event.preventDefault();
        navigate(-1);
      } else if (key === "s") {
        event.preventDefault();
        setShuffle((value) => !value);
      } else if (key === "r") {
        event.preventDefault();
        setRepeat((value) => cycleRepeatMode(value));
      }
    }, [changeVolume, currentTime, keyboardShortcutsEnabled, navigate, seekTo, togglePlayback, volume]);

    useEffect(() => {
      if (!globalKeyboardShortcuts || !keyboardShortcutsEnabled || typeof window === "undefined") return;
      const listener = (event: KeyboardEvent) => handleKeyboardShortcut(event);
      window.addEventListener("keydown", listener);
      return () => window.removeEventListener("keydown", listener);
    }, [globalKeyboardShortcuts, handleKeyboardShortcut, keyboardShortcutsEnabled]);

    useEffect(() => {
      if (!("mediaSession" in navigator)) return;
      const session = navigator.mediaSession;
      if (currentKind === "gif") {
        session.metadata = null;
        session.playbackState = "none";
        return;
      }
      if (currentTrack) {
        try {
          session.metadata = new MediaMetadata({
            title: currentTrack.title,
            artist: currentTrack.artist || "Unknown artist",
            album: currentTrack.album || "PocketDock",
            artwork: currentTrack.artworkUrl
              ? [{ src: currentTrack.artworkUrl }]
              : undefined
          });
        } catch {
          // Some Chromium builds expose Media Session without accepting metadata artwork.
        }
      } else {
        session.metadata = null;
      }

      const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
        play: () => playCurrent(),
        pause: () => pausePlayback(),
        previoustrack: () => navigate(-1),
        nexttrack: () => navigate(1),
        seekbackward: (details) => seekTo((audioRef.current?.currentTime ?? 0) - (details.seekOffset ?? MEDIA_SEEK_STEP_SECONDS)),
        seekforward: (details) => seekTo((audioRef.current?.currentTime ?? 0) + (details.seekOffset ?? MEDIA_SEEK_STEP_SECONDS)),
        seekto: (details) => {
          if (typeof details.seekTime === "number") seekTo(details.seekTime);
        },
        stop: () => {
          pausePlayback();
          seekTo(0);
        }
      };
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          session.setActionHandler(action as MediaSessionAction, handler ?? null);
        } catch {
          // Unsupported actions vary by Chromium/Windows version.
        }
      }
      return () => {
        for (const action of Object.keys(handlers)) {
          try {
            session.setActionHandler(action as MediaSessionAction, null);
          } catch {
            // Ignore unsupported action cleanup.
          }
        }
      };
    }, [currentKind, currentTrack, navigate, pausePlayback, playCurrent, seekTo]);

    useEffect(() => {
      if (!("mediaSession" in navigator)) return;
      try {
        if (currentKind === "gif") {
          navigator.mediaSession.playbackState = "none";
          return;
        }
        navigator.mediaSession.playbackState = isPlaying ? "playing" : currentTrack ? "paused" : "none";
        if (duration > 0 && Number.isFinite(duration)) {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate,
            position: clampNumber(currentTime, 0, Math.max(0, duration - 0.001))
          });
        }
      } catch {
        // Position state is best-effort and rejects transient invalid metadata.
      }
    }, [currentKind, currentTime, currentTrack, duration, isPlaying, playbackRate]);

    const updateBuffered = useCallback(() => {
      const audio = audioRef.current;
      if (!audio || audio.buffered.length === 0) {
        setBuffered(0);
        return;
      }
      let furthest = 0;
      for (let index = 0; index < audio.buffered.length; index += 1) {
        furthest = Math.max(furthest, audio.buffered.end(index));
      }
      setBuffered(furthest);
    }, []);

    const statusMessage = useMemo(() => {
      if (!currentTrack) return emptyMessage;
      if (status === "loading") return `Loading ${trackLabel(currentTrack)}.`;
      if (currentKind === "gif" && status === "playing") {
        return `Animating ${trackLabel(currentTrack)}. This image loops automatically.`;
      }
      if (currentKind === "gif" && (status === "paused" || status === "ready")) {
        return `${trackLabel(currentTrack)} is a paused animated image.`;
      }
      if (status === "playing") return `Playing ${trackLabel(currentTrack)}.`;
      if (status === "paused") return `Paused ${trackLabel(currentTrack)}.`;
      if (status === "unavailable" || status === "error") return error ?? `Unable to play ${trackLabel(currentTrack)}.`;
      return `${trackLabel(currentTrack)} is ready.`;
    }, [currentKind, currentTrack, emptyMessage, error, status]);

    const seekMaximum = duration > 0 ? duration : Math.max(currentTrack?.durationSeconds ?? 0, 1);
    const gifControlsDisabled = currentKind === "gif";
    const pictureInPictureSupported = currentKind === "video" && typeof document !== "undefined" &&
      document.pictureInPictureEnabled && audioRef.current instanceof HTMLVideoElement &&
      typeof audioRef.current.requestPictureInPicture === "function";
    const fullscreenSupported = currentKind === "video" && typeof document !== "undefined" &&
      audioRef.current instanceof HTMLVideoElement && typeof audioRef.current.requestFullscreen === "function";
    const visualPreviewLabel = currentKind === "video" || currentKind === "gif"
      ? visualPreviewToggleLabel(currentKind, visualPreviewExpanded)
      : null;
    const repeatIcon = repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />;
    const rootClassName = [
      "audio-preview-player",
      queueOpen ? "queue-open" : "",
      !visualPreviewExpanded && (currentKind === "video" || currentKind === "gif")
        ? "visual-preview-collapsed"
        : "",
      className ?? ""
    ]
      .filter(Boolean)
      .join(" ");

    const mediaElementProps: React.MediaHTMLAttributes<HTMLMediaElement> = {
      preload: "metadata",
      onLoadStart: () => {
        if (sourceTrackIdRef.current === currentTrackIdRef.current) setStatus("loading");
      },
      onLoadedMetadata: (event) => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        const media = event.currentTarget;
        const nextDuration = Number.isFinite(media.duration) && media.duration > 0
          ? media.duration
          : currentTrack?.durationSeconds ?? 0;
        setDuration(nextDuration);
        const pending = pendingResumeRef.current;
        if (pending && pending.trackId === currentTrackIdRef.current && pending.time > 0) {
          media.currentTime = clampNumber(pending.time, 0, nextDuration > 0 ? Math.max(0, nextDuration - 0.25) : pending.time);
          setCurrentTime(media.currentTime);
          pendingResumeRef.current = null;
        }
        setStatus(playIntentRef.current ? "loading" : "ready");
      },
      onDurationChange: (event) => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        const nextDuration = event.currentTarget.duration;
        if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
      },
      onCanPlay: () => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        setStatus(playIntentRef.current ? "loading" : "ready");
        if (playIntentRef.current) playCurrent();
      },
      onPlaying: () => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        playIntentRef.current = true;
        setError(null);
        setIsPlaying(true);
        setStatus("playing");
      },
      onPause: (event) => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current || event.currentTarget.ended) return;
        setIsPlaying(false);
        if (!playIntentRef.current) setStatus("paused");
      },
      onWaiting: () => {
        if (sourceTrackIdRef.current === currentTrackIdRef.current && playIntentRef.current) setStatus("loading");
      },
      onTimeUpdate: (event) => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        setCurrentTime(event.currentTarget.currentTime);
      },
      onProgress: updateBuffered,
      onEnded: () => {
        setIsPlaying(false);
        navigate(1, true);
      },
      onError: (event) => {
        if (sourceTrackIdRef.current !== currentTrackIdRef.current) return;
        reportError(playbackErrorMessage(event.currentTarget));
      }
    };

    return (
      <section
        ref={rootRef}
        className={rootClassName}
        aria-label="Media preview player"
        aria-keyshortcuts="Space ArrowLeft ArrowRight ArrowUp ArrowDown M N P S R"
        tabIndex={0}
        onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
          if (!globalKeyboardShortcuts) handleKeyboardShortcut(event);
        }}
      >
        {currentKind === "audio" && (
          <audio ref={(element) => { audioRef.current = element; }} {...mediaElementProps} />
        )}
        {currentKind === "video" && (
          <video
            id={visualPreviewId}
            ref={(element) => { audioRef.current = element; }}
            className="audio-player-video"
            poster={currentTrack?.posterUrl ?? currentTrack?.artworkUrl}
            playsInline
            controls={isFullscreen}
            aria-hidden={!visualPreviewExpanded}
            tabIndex={visualPreviewExpanded ? 0 : -1}
            {...mediaElementProps}
          />
        )}
        {currentKind === "gif" && (
          <div
            id={visualPreviewId}
            className="audio-player-gif"
            aria-label={`Animated image: ${currentTrack?.title ?? "preview"}`}
            aria-hidden={!visualPreviewExpanded}
          >
            {isPlaying && resolvedGifUrl ? (
              <img
                key={`${currentTrackId}:${gifRestartNonce}`}
                src={resolvedGifUrl}
                alt=""
                onLoad={() => {
                  setStatus("playing");
                  setError(null);
                }}
                onError={() => reportError("The animated image could not be displayed.")}
              />
            ) : currentTrack?.posterUrl || currentTrack?.artworkUrl ? (
              <img src={currentTrack.posterUrl ?? currentTrack.artworkUrl} alt="" />
            ) : (
              <div className="audio-player-gif-placeholder"><Music2 size={34} /><span>Animated GIF</span></div>
            )}
            {prefersReducedMotion && !isPlaying && <span className="audio-player-motion-note">Press Play to animate</span>}
          </div>
        )}

        <div className="audio-player-main">
          <div className="audio-player-artwork" aria-hidden="true">
            {currentTrack?.artworkUrl ? (
              <img src={currentTrack.artworkUrl} alt="" />
            ) : (
              <Music2 size={28} />
            )}
            {status === "loading" && <LoaderCircle className="audio-player-spinner" size={20} />}
          </div>

          <div className="audio-player-track-copy">
            <strong title={currentTrack?.title}>{currentTrack?.title || "Nothing queued"}</strong>
            <span title={currentTrack?.artist}>{currentTrack?.artist?.trim() || (currentTrack ? "Unknown artist" : emptyMessage)}</span>
            {currentTrack?.album && <small title={currentTrack.album}>{currentTrack.album}</small>}
          </div>

          <div className="audio-player-transport" aria-label="Playback controls">
            <button
              type="button"
              className={`audio-player-icon-button ${shuffle ? "active" : ""}`}
              aria-label={shuffle ? "Turn shuffle off" : "Turn shuffle on"}
              aria-pressed={shuffle}
              title="Shuffle (S)"
              disabled={queueTrackIds.length < 2}
              onClick={() => setShuffle((value) => !value)}
            >
              <Shuffle size={17} />
            </button>
            <button
              type="button"
              className="audio-player-icon-button"
              aria-label="Previous item"
              title="Previous (P)"
              disabled={!currentTrack}
              onClick={() => navigate(-1)}
            >
              <SkipBack size={19} />
            </button>
            <button
              type="button"
              className="audio-player-play-button"
              aria-label={currentKind === "gif"
                ? isPlaying ? "Stop animation" : "Play animation"
                : isPlaying || playIntentRef.current ? "Pause" : "Play"}
              title={currentKind === "gif" ? "Play or stop animation (Space)" : "Play or pause (Space)"}
              disabled={!currentTrack}
              onClick={togglePlayback}
            >
              {isPlaying || (status === "loading" && playIntentRef.current)
                ? <Pause size={21} fill="currentColor" />
                : <Play size={21} fill="currentColor" />}
            </button>
            <button
              type="button"
              className="audio-player-icon-button"
              aria-label="Next item"
              title="Next (N)"
              disabled={!currentTrack}
              onClick={() => navigate(1)}
            >
              <SkipForward size={19} />
            </button>
            <button
              type="button"
              className={`audio-player-icon-button ${repeat !== "off" ? "active" : ""}`}
              aria-label={`${repeatLabel(repeat)}; activate to change`}
              aria-pressed={repeat !== "off"}
              title={`${repeatLabel(repeat)} (R)`}
              disabled={!currentTrack}
              onClick={() => setRepeat((value) => cycleRepeatMode(value))}
            >
              {repeatIcon}
            </button>
          </div>

          <div className="audio-player-timeline">
            <output aria-label="Elapsed time">{formatPlaybackTime(currentTime)}</output>
            <div className="audio-player-seek-wrap" style={{ "--buffered": `${clampNumber(buffered / seekMaximum, 0, 1) * 100}%` } as React.CSSProperties}>
              <input
                type="range"
                min={0}
                max={seekMaximum}
                step={0.01}
                value={clampNumber(currentTime, 0, seekMaximum)}
                aria-label="Seek through track"
                aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
                disabled={!currentTrack || duration <= 0 || gifControlsDisabled}
                onChange={(event) => seekTo(Number(event.currentTarget.value))}
              />
            </div>
            <output aria-label="Total duration">{formatPlaybackTime(duration)}</output>
          </div>

          <div className="audio-player-secondary-controls">
            <button
              type="button"
              className="audio-player-icon-button"
              aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
              aria-pressed={muted}
              title="Mute (M)"
              disabled={gifControlsDisabled}
              onClick={() => setMuted((value) => !value)}
            >
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              className="audio-player-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Volume"
              aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`}
              disabled={gifControlsDisabled}
              onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            />
            <label className="audio-player-speed">
              <span className="sr-only">Playback speed</span>
              <select
                value={playbackRate}
                aria-label="Playback speed"
                disabled={gifControlsDisabled}
                onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
              >
                {AUDIO_PLAYER_RATES.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
            </label>
            {visualPreviewLabel && (
              <button
                type="button"
                className={`audio-player-preview-toggle ${visualPreviewExpanded ? "active" : ""}`}
                aria-label={visualPreviewLabel}
                aria-controls={visualPreviewId}
                aria-expanded={visualPreviewExpanded}
                title={visualPreviewLabel}
                onClick={() => setVisualPreviewExpanded((value) => !value)}
              >
                {visualPreviewExpanded ? <EyeOff size={17} /> : <Eye size={17} />}
                <span>{visualPreviewLabel}</span>
              </button>
            )}
            {currentKind === "video" && (
              <>
                <button
                  type="button"
                  className={`audio-player-icon-button ${isPictureInPicture ? "active" : ""}`}
                  aria-label={isPictureInPicture ? "Close Picture-in-Picture" : "Open Picture-in-Picture"}
                  aria-pressed={isPictureInPicture}
                  title="Picture-in-Picture"
                  disabled={!pictureInPictureSupported}
                  onClick={togglePictureInPicture}
                >
                  <PictureInPicture2 size={18} />
                </button>
                <button
                  ref={videoExpandButtonRef}
                  type="button"
                  className={`audio-player-icon-button ${isFullscreen ? "active" : ""}`}
                  aria-label={isFullscreen ? "Exit fullscreen" : "Open fullscreen"}
                  aria-pressed={isFullscreen}
                  title="Fullscreen video"
                  disabled={!fullscreenSupported || !visualPreviewExpanded}
                  onClick={toggleFullscreen}
                >
                  <Maximize2 size={18} />
                </button>
              </>
            )}
            <button
              type="button"
              className={`audio-player-queue-toggle ${queueOpen ? "active" : ""}`}
              aria-label={`${queueOpen ? "Hide" : "Show"} playback queue`}
              aria-expanded={queueOpen}
              title="Playback queue"
              onClick={() => setQueueOpen((value) => !value)}
            >
              <ListMusic size={18} />
              <span>{queueTrackIds.length.toLocaleString()}</span>
            </button>
          </div>
        </div>

        {(status === "error" || status === "unavailable") && currentTrack && (
          <div className="audio-player-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => {
              playIntentRef.current = true;
              setRetryNonce((value) => value + 1);
            }}>
              <RotateCcw size={15} /> Retry
            </button>
            <button type="button" onClick={() => navigate(1)}>
              Next item <SkipForward size={15} />
            </button>
          </div>
        )}

        <p className="audio-player-live-status sr-only" aria-live="polite" aria-atomic="true">
          {statusMessage}
        </p>

        {queueOpen && (
          <div className="audio-player-queue" role="region" aria-label="Playback queue">
            <header>
              <div>
                <strong>Playback queue</strong>
                <span>{queueTrackIds.length.toLocaleString()} item{queueTrackIds.length === 1 ? "" : "s"}</span>
              </div>
              <button
                type="button"
                className="audio-player-icon-button"
                aria-label="Close playback queue"
                onClick={() => setQueueOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            {queue.length === 0 ? (
              <p className="audio-player-empty-queue">The playback queue is empty.</p>
            ) : (
              <ol>
                {queue.map((track, index) => {
                  const isCurrent = track.id === currentTrackId;
                  return (
                    <li key={track.id} className={isCurrent ? "current" : ""} aria-current={isCurrent ? "true" : undefined}>
                      <button
                        type="button"
                        className="audio-player-queue-track"
                        aria-label={`${isCurrent && isPlaying ? "Pause" : "Play"} ${trackLabel(track)}`}
                        onClick={() => toggleTrack(track.id)}
                      >
                        <span className="audio-player-queue-index" aria-hidden="true">
                          {isCurrent && isPlaying ? <Pause size={14} fill="currentColor" /> : isCurrent ? <Play size={14} fill="currentColor" /> : index + 1}
                        </span>
                        <span>
                          <strong>{track.title}</strong>
                          <small>{track.artist?.trim() || "Unknown artist"}</small>
                        </span>
                        <time>{formatPlaybackTime(track.durationSeconds ?? 0)}</time>
                      </button>
                      {renderTrackAction?.(track, isCurrent)}
                      <button
                        type="button"
                        className="audio-player-remove-track"
                        aria-label={`Remove ${track.title} from the media queue`}
                        title="Remove from queue"
                        onClick={() => removeFromQueue(track.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}

        <span className="audio-player-position" aria-hidden="true">
          {currentQueueIndex >= 0 ? `${currentQueueIndex + 1} / ${queueTrackIds.length}` : "0 / 0"}
        </span>
      </section>
    );
  }
);

AudioPreviewPlayer.displayName = "AudioPreviewPlayer";

/** Generalized name for new integrations; AudioPreviewPlayer remains the compatibility export. */
export const MediaPreviewPlayer = AudioPreviewPlayer;
