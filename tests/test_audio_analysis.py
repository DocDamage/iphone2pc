import math
import struct
import wave

from audio_analysis import analyze_audio


def test_audio_analysis_returns_waveform_hash_and_signal_metadata(tmp_path):
    path = tmp_path / "tone.wav"
    sample_rate = 8000
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = [int(12000 * math.sin(2 * math.pi * 440 * index / sample_rate)) for index in range(sample_rate)]
        output.writeframes(b"".join(struct.pack("<h", sample) for sample in frames))

    result = analyze_audio(str(path), waveform_points=64)

    assert result["content_sha256"]
    assert result["acoustic_fingerprint"]
    assert result["sample_rate"] == sample_rate
    assert result["channels"] == 1
    assert 0.9 <= result["duration"] <= 1.1
    assert len(result["waveform"]) == 64
    assert all(0 <= value <= 1 for value in result["waveform"])
