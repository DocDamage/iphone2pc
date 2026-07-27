import { describe, expect, it } from "vitest";
import {
  appendAvailableTrackIds,
  clampNumber,
  createShufflePool,
  cycleRepeatMode,
  defaultVisualPreviewExpanded,
  deduplicateTrackIds,
  formatPlaybackTime,
  parsePersistedAudioPlayerState,
  reconcileQueueTrackIds,
  selectShuffledTrack,
  sequentialTrackId,
  visualPreviewToggleLabel
} from "./audio-player-core.js";

describe("audio player core", () => {
  it("formats finite playback positions without leaking invalid values", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(65.9)).toBe("1:05");
    expect(formatPlaybackTime(3_661)).toBe("1:01:01");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
    expect(clampNumber(Number.POSITIVE_INFINITY, 2, 8)).toBe(2);
  });

  it("cycles all repeat modes", () => {
    expect(cycleRepeatMode("off")).toBe("all");
    expect(cycleRepeatMode("all")).toBe("one");
    expect(cycleRepeatMode("one")).toBe("off");
  });

  it("labels visual preview disclosure controls explicitly", () => {
    expect(visualPreviewToggleLabel("video", true)).toBe("Hide video preview");
    expect(visualPreviewToggleLabel("video", false)).toBe("Show video preview");
    expect(visualPreviewToggleLabel("gif", true)).toBe("Hide GIF preview");
    expect(visualPreviewToggleLabel("gif", false)).toBe("Show GIF preview");
    expect(defaultVisualPreviewExpanded("video")).toBe(true);
    expect(defaultVisualPreviewExpanded("gif")).toBe(true);
    expect(defaultVisualPreviewExpanded("audio")).toBe(false);
  });

  it("keeps an explicit filtered queue exact during a larger catalog refresh", () => {
    const filteredQueue = Array.from({ length: 342 }, (_, index) => `doc-${index}`);
    const refreshedCatalog = [
      ...filteredQueue,
      ...Array.from({ length: 433 }, (_, index) => `other-${index}`)
    ];
    const reconciled = reconcileQueueTrackIds(filteredQueue, refreshedCatalog);
    expect(reconciled).toEqual(filteredQueue);
    expect(reconciled).toHaveLength(342);
  });

  it("removes missing and duplicate queue IDs without appending unrelated tracks", () => {
    expect(reconcileQueueTrackIds(["a", "a", "missing", "b"], ["a", "b", "c"]))
      .toEqual(["a", "b"]);
    expect(deduplicateTrackIds(["a", "", "a", "b"])).toEqual(["a", "b"]);
  });

  it("enqueue appends only requested, available IDs", () => {
    expect(appendAvailableTrackIds(["a"], ["b", "missing", "b"], ["a", "b", "c"]))
      .toEqual(["a", "b"]);
  });

  it("handles sequential boundaries and applies repeat-one only to natural endings", () => {
    const queue = ["a", "b", "c"];
    expect(sequentialTrackId(queue, "b", 1, "off")).toBe("c");
    expect(sequentialTrackId(queue, "c", 1, "off")).toBeNull();
    expect(sequentialTrackId(queue, "c", 1, "all")).toBe("a");
    expect(sequentialTrackId(queue, "b", 1, "one", true)).toBe("b");
    expect(sequentialTrackId(queue, "b", 1, "one", false)).toBe("c");
  });

  it("uses a shuffle bag without selecting the current track or repeating an item", () => {
    const queue = ["a", "b", "c"];
    const pool = createShufflePool(queue, "a");
    const first = selectShuffledTrack(queue, "a", pool, "off", () => 0);
    const second = selectShuffledTrack(queue, first.trackId, first.remainingPool, "off", () => 0);
    expect(first.trackId).toBe("b");
    expect(second.trackId).toBe("c");
    expect(second.remainingPool).toEqual([]);
    expect(selectShuffledTrack(queue, "c", [], "off", () => 0).trackId).toBeNull();
  });

  it("starts a new shuffle bag only for repeat-all", () => {
    expect(selectShuffledTrack(["a", "b"], "a", [], "all", () => 0))
      .toEqual({ trackId: "b", remainingPool: [] });
    expect(selectShuffledTrack(["a"], "a", [], "off").trackId).toBeNull();
  });

  it("validates persisted state and defaults malformed or absent fields safely", () => {
    const parsed = parsePersistedAudioPlayerState(JSON.stringify({
      version: 1,
      queueTrackIds: ["a", "a", 4],
      currentTrackId: "a",
      currentTime: -5,
      muted: true,
      shuffle: true,
      repeat: "one",
      playbackRate: 9
    }));
    expect(parsed.queueTrackIds).toEqual(["a"]);
    expect(parsed.currentTime).toBe(0);
    expect(parsed.volume).toBe(0.85);
    expect(parsed.playbackRate).toBe(1);
    expect(parsed.repeat).toBe("one");
    expect(parsePersistedAudioPlayerState("not-json").queueTrackIds).toEqual([]);
  });
});
