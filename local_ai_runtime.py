"""Feature-detected local AI and optional stem-separation adapters."""

from __future__ import annotations

import importlib.util
import os
import platform
import subprocess
import sys
from pathlib import Path


class LocalAIRuntime:
    def __init__(self, model_root: str):
        self.model_root = os.path.abspath(model_root)
        os.makedirs(self.model_root, exist_ok=True)

    def status(self) -> dict:
        providers = []
        if importlib.util.find_spec("onnxruntime"):
            import onnxruntime
            providers = onnxruntime.get_available_providers()
        models = [str(path) for path in Path(self.model_root).glob("*.onnx")]
        return {
            "local_only": True, "python": platform.python_version(), "onnxruntime": bool(providers),
            "execution_providers": providers, "models": models,
            "windows_ml_candidate": sys.platform == "win32" and platform.release() in {"10", "11"},
            "demucs": importlib.util.find_spec("demucs") is not None,
            "signal_intelligence": True,
        }

    def separate_stems(self, source: str, output_root: str, mode: str = "four") -> dict:
        if not importlib.util.find_spec("demucs"):
            raise RuntimeError("The optional Demucs backend is not installed.")
        source = os.path.abspath(source)
        output_root = os.path.abspath(output_root)
        if not os.path.isfile(source):
            raise FileNotFoundError(source)
        os.makedirs(output_root, exist_ok=True)
        command = [sys.executable, "-m", "demucs", "--out", output_root]
        if mode == "vocals":
            command.extend(["--two-stems", "vocals"])
        elif mode != "four":
            raise ValueError("Stem mode must be four or vocals.")
        command.append(source)
        process = subprocess.run(command, capture_output=True, text=True, timeout=60 * 60)
        if process.returncode:
            raise RuntimeError((process.stderr or process.stdout or "Stem separation failed.")[-4000:])
        files = [str(path) for path in Path(output_root).rglob("*.wav")]
        return {"source": source, "output_root": output_root, "mode": mode, "files": files}
