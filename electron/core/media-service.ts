import path from "node:path";
import { open, stat } from "node:fs/promises";
import { nativeImage } from "electron";
import type {
  MediaPreview,
  MusicFileMetadata,
  TransferRecord
} from "./types.js";
import {
  detectMediaKind,
  isPlayableMediaKind,
  playableMediaContentType,
  type PlayableMediaKind
} from "./media-kind.js";

export interface TransferPlaybackSource {
  filePath: string;
  contentType: string;
  kind: PlayableMediaKind;
}

function inferredMusicMetadata(fileName: string): MusicFileMetadata {
  const bpm = fileName.match(/(?:^|[\s_-])(\d{2,3})\s*bpm(?:[\s_.-]|$)/i);
  const musicalKey = fileName.match(
    /(?:^|[\s_-])([A-G](?:#|b)?(?:m|maj|min)?)(?:[\s_.-]|$)/i
  );
  return {
    bpm: bpm ? Number(bpm[1]) : undefined,
    musicalKey: musicalKey?.[1]
  };
}

async function readWavPreview(
  filePath: string,
  fileName: string
): Promise<{ waveform: number[]; music: MusicFileMetadata }> {
  const info = await stat(filePath);
  const handle = await open(filePath, "r");
  const headerLength = Math.min(info.size, 2 * 1024 * 1024);
  const buffer = Buffer.alloc(headerLength);
  try {
    await handle.read(buffer, 0, buffer.length, 0);
  } finally {
    await handle.close();
  }
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return { waveform: [], music: inferredMusicMetadata(fileName) };
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let byteRate = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && contentOffset + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(contentOffset + 2);
      sampleRate = buffer.readUInt32LE(contentOffset + 4);
      byteRate = buffer.readUInt32LE(contentOffset + 8);
      bitDepth = buffer.readUInt16LE(contentOffset + 14);
    }
    if (chunkId === "data") {
      dataOffset = contentOffset;
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - contentOffset));
      break;
    }
    offset = contentOffset + chunkSize + (chunkSize % 2);
  }

  const points = 120;
  const waveform: number[] = [];
  const bytesPerSample = Math.max(1, Math.ceil(bitDepth / 8));
  const frameSize = Math.max(bytesPerSample, bytesPerSample * Math.max(1, channels));
  const frames = Math.floor(dataSize / frameSize);
  for (let point = 0; point < points && frames > 0; point += 1) {
    const frameStart = Math.floor((point / points) * frames);
    const frameEnd = Math.max(frameStart + 1, Math.floor(((point + 1) / points) * frames));
    let peak = 0;
    const stride = Math.max(1, Math.floor((frameEnd - frameStart) / 256));
    for (let frame = frameStart; frame < frameEnd; frame += stride) {
      const sampleOffset = dataOffset + frame * frameSize;
      if (sampleOffset + bytesPerSample > buffer.length) break;
      let normalized = 0;
      if (bitDepth === 8) normalized = Math.abs(buffer.readUInt8(sampleOffset) - 128) / 128;
      else if (bitDepth === 16) normalized = Math.abs(buffer.readInt16LE(sampleOffset)) / 32_768;
      else if (bitDepth === 24) normalized = Math.abs(buffer.readIntLE(sampleOffset, 3)) / 8_388_608;
      else if (bitDepth === 32) normalized = Math.abs(buffer.readInt32LE(sampleOffset)) / 2_147_483_648;
      peak = Math.max(peak, normalized);
    }
    waveform.push(Math.min(1, peak));
  }
  return {
    waveform,
    music: {
      ...inferredMusicMetadata(fileName),
      durationSeconds: byteRate > 0 ? (info.size - dataOffset) / byteRate : undefined,
      sampleRate: sampleRate || undefined,
      bitDepth: bitDepth || undefined,
      channels: channels || undefined
    }
  };
}

export class MediaService {
  playbackSource(record: TransferRecord): TransferPlaybackSource | null {
    if (record.status !== "completed" || !record.savedPath) return null;
    const kind = detectMediaKind(record.fileName, record.mimeType);
    if (!isPlayableMediaKind(kind)) return null;
    const contentType = playableMediaContentType(record.fileName, record.mimeType);
    return contentType ? { filePath: record.savedPath, contentType, kind } : null;
  }

  async preview(record: TransferRecord): Promise<MediaPreview | null> {
    if (!record.savedPath) return null;
    const info = await stat(record.savedPath).catch(() => null);
    if (!info?.isFile()) return null;
    const kind = detectMediaKind(record.fileName, record.mimeType);
    const preview: MediaPreview = { transferId: record.id, kind };
    if (kind === "image" || kind === "video" || kind === "gif" || kind === "document") {
      try {
        const thumbnail = await nativeImage.createThumbnailFromPath(record.savedPath, {
          width: 640,
          height: 420
        });
        if (!thumbnail.isEmpty()) preview.dataUrl = thumbnail.toDataURL();
      } catch {
        // Windows does not provide thumbnails for every codec or document type.
      }
    }
    if (kind === "audio") {
      const extension = path.extname(record.fileName).toLowerCase();
      if (extension === ".wav") {
        const wav = await readWavPreview(record.savedPath, record.fileName);
        preview.waveform = wav.waveform;
        preview.music = wav.music;
      } else {
        preview.music = inferredMusicMetadata(record.fileName);
      }
    }
    return preview;
  }
}
