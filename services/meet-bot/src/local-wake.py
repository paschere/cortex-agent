#!/usr/bin/env python3
"""Offline Cortex wake-word recognizer. Stdout is protocol-only; no transcripts."""

import json
import os
import sys
import tempfile

from vosk import KaldiRecognizer, Model, SetLogLevel


def emit(event: str) -> None:
    sys.stdout.write(json.dumps({"type": event}) + "\n")
    sys.stdout.flush()


def recognizer_with_verified_vocabulary(model: Model) -> KaldiRecognizer:
    # Vosk only reports an unknown grammar word through native stderr. Capture
    # that diagnostic so an incompatible model cannot silently become [unk].
    original_stderr = os.dup(2)
    with tempfile.TemporaryFile() as captured:
        try:
            os.dup2(captured.fileno(), 2)
            SetLogLevel(0)
            recognizer = KaldiRecognizer(model, 16000, '["cortex", "[unk]"]')
        finally:
            SetLogLevel(-1)
            os.dup2(original_stderr, 2)
            os.close(original_stderr)
        captured.seek(0)
        diagnostics = captured.read().decode("utf-8", errors="replace")
    if "Ignoring word missing in vocabulary: 'cortex'" in diagnostics:
        raise RuntimeError("wake model does not contain required vocabulary word 'cortex'")
    return recognizer


def has_wake(result: str) -> bool:
    try:
        payload = json.loads(result)
    except json.JSONDecodeError:
        return False
    text = payload.get("partial", payload.get("text", ""))
    return "cortex" in str(text).lower().split()


def main() -> int:
    model_path = sys.argv[1] if len(sys.argv) > 1 else "/opt/cortex-wake-model"
    if not os.path.isdir(model_path):
        raise RuntimeError(f"wake model directory not found: {model_path}")
    SetLogLevel(-1)
    model = Model(model_path)
    recognizer = recognizer_with_verified_vocabulary(model)
    emit("ready")

    wake_sent = False
    while True:
        audio = sys.stdin.buffer.read(4000)
        if not audio:
            return 0
        complete = recognizer.AcceptWaveform(audio)
        result = recognizer.Result() if complete else recognizer.PartialResult()
        heard = has_wake(result)
        if heard and not wake_sent:
            emit("wake")
            wake_sent = True
        if complete:
            wake_sent = False


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"local wake detector failed: {error}", file=sys.stderr)
        raise SystemExit(1)
