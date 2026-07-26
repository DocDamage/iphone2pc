"""Private, on-device audio analysis for recovered beats."""

from __future__ import annotations

import hashlib
import math
import os
from typing import Any

import librosa
import numpy as np
import soundfile as sf


CHUNK_SIZE = 1024 * 1024
NOTE_NAMES = ("C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B")
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _waveform(y: np.ndarray, points: int) -> list[float]:
    points = max(16, min(int(points), 2048))
    if y.size == 0:
        return [0.0] * points
    chunks = np.array_split(np.abs(y), points)
    peaks = np.array([float(np.max(chunk)) if chunk.size else 0.0 for chunk in chunks])
    maximum = float(peaks.max()) if peaks.size else 0.0
    if maximum > 0:
        peaks /= maximum
    return [round(float(value), 4) for value in peaks]


def _detect_key(chroma: np.ndarray) -> tuple[str | None, float]:
    if chroma.size == 0:
        return None, 0.0
    vector = np.mean(chroma, axis=1)
    if float(np.max(vector)) <= 1e-9:
        return None, 0.0
    vector = (vector - vector.mean()) / (vector.std() or 1.0)
    candidates: list[tuple[float, str]] = []
    for tonic, note in enumerate(NOTE_NAMES):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            normalized = (np.roll(profile, tonic) - profile.mean()) / profile.std()
            candidates.append((float(np.dot(vector, normalized) / len(vector)), f"{note} {mode}"))
    candidates.sort(reverse=True)
    best_score, best_name = candidates[0]
    second_score = candidates[1][0]
    confidence = max(0.0, min(1.0, (best_score - second_score + 0.1) / 0.5))
    return best_name, round(confidence, 3)


def _fingerprint(chroma: np.ndarray, onset: np.ndarray) -> str:
    # Summaries of normalized chroma and onset shape group acoustically identical
    # exports even when container tags or filenames differ.
    features: list[np.ndarray] = []
    if chroma.size:
        windows = np.array_split(chroma, min(32, max(1, chroma.shape[1])), axis=1)
        chroma_summary = np.concatenate([np.mean(window, axis=1) for window in windows])
        maximum = float(np.max(np.abs(chroma_summary))) or 1.0
        features.append(np.round(chroma_summary / maximum * 31).astype(np.int8))
    if onset.size:
        onset_windows = np.array_split(onset, min(32, max(1, onset.size)))
        onset_summary = np.array([np.mean(window) for window in onset_windows])
        maximum = float(np.max(np.abs(onset_summary))) or 1.0
        features.append(np.round(onset_summary / maximum * 31).astype(np.int8))
    payload = b"".join(feature.tobytes() for feature in features) or b"silence"
    return hashlib.sha256(payload).hexdigest()


def analyze_audio(path: str, waveform_points: int = 256, max_analysis_seconds: float = 15 * 60) -> dict[str, Any]:
    """Measure an audio file locally; no network services or source edits are used."""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    info = sf.info(path)
    duration = float(info.duration or 0)
    y, sample_rate = librosa.load(path, sr=22050, mono=True, duration=max_analysis_seconds)
    onset = librosa.onset.onset_strength(y=y, sr=sample_rate)
    tempo, _beats = librosa.beat.beat_track(onset_envelope=onset, sr=sample_rate)
    tempo_value = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 0.0
    chroma = librosa.feature.chroma_cqt(y=y, sr=sample_rate) if y.size else np.empty((12, 0))
    musical_key, key_confidence = _detect_key(chroma)
    rms = float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))) if y.size else 0.0
    loudness = 20 * math.log10(max(rms, 1e-12))
    size = os.path.getsize(path)
    return {
        "content_sha256": _sha256(path),
        "acoustic_fingerprint": _fingerprint(chroma, onset),
        "duration": round(duration, 3),
        "bpm": round(tempo_value, 2) if tempo_value > 0 else None,
        "key": musical_key,
        "key_confidence": key_confidence,
        "loudness": round(loudness, 2),
        "sample_rate": int(info.samplerate),
        "channels": int(info.channels),
        "bit_depth": str(info.subtype or "unknown"),
        "bitrate_kbps": round(size * 8 / duration / 1000) if duration > 0 else None,
        "waveform": _waveform(y, waveform_points),
        "analyzed_seconds": round(min(duration, max_analysis_seconds), 3),
        "analysis_scope": "full" if duration <= max_analysis_seconds else "first 15 minutes",
    }
