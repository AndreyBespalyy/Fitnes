"""Движки: распознавание речи (faster-whisper) и языковая модель (vLLM с OpenAI-совместимым API).
Оба работают на этом же сервере; записи и тексты наружу не уходят (ТЗ, раздел 6.3, правило 2)."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass

import httpx

from .prompts import PROMPT_VERSION, SCHEMA, SYSTEM, USER


@dataclass
class Segment:
    speaker: str | None
    start: float
    end: float
    text: str
    logprob: float | None = None


def _channels(path: str) -> int:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout.strip()
        return int(out or 1)
    except Exception:
        return 1


def _split_channel(path: str, ch: int, out: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-af", f"pan=mono|c0=c{ch}", "-ar", "16000", out], check=True, timeout=600)


class WhisperASR:
    """Записи АТС часто стерео: менеджер в одном канале, клиент в другом. Тогда каналы распознаются отдельно,
    и в расшифровке видно, кто говорит. Моно-запись распознаётся целиком, без разделения по говорящим."""

    def __init__(self) -> None:
        from faster_whisper import WhisperModel  # тяжёлый импорт: только на ИИ-сервере

        self.model_name = os.environ.get("ASR_MODEL", "large-v3")
        self.model = WhisperModel(
            self.model_name,
            device=os.environ.get("ASR_DEVICE", "auto"),
            compute_type=os.environ.get("ASR_COMPUTE", "float16"),
            download_root=os.environ.get("MODELS_DIR", "/models"),
        )
        self.manager_channel = int(os.environ.get("ASR_MANAGER_CHANNEL", "0"))

    @property
    def engine(self) -> str:
        return f"whisper-{self.model_name}"

    def _run(self, path: str, language: str, speaker: str | None) -> tuple[list[Segment], float]:
        segs, info = self.model.transcribe(path, language=language, vad_filter=True, beam_size=5)
        return [Segment(speaker, s.start, s.end, s.text.strip(), s.avg_logprob) for s in segs if s.text.strip()], info.duration

    def transcribe(self, path: str, language: str = "ru") -> dict:
        if _channels(path) >= 2:
            with tempfile.TemporaryDirectory() as d:
                parts: list[Segment] = []
                duration = 0.0
                for ch in (0, 1):
                    mono = os.path.join(d, f"ch{ch}.wav")
                    _split_channel(path, ch, mono)
                    who = "manager" if ch == self.manager_channel else "client"
                    s, duration = self._run(mono, language, who)
                    parts += s
                parts.sort(key=lambda s: s.start)
        else:
            parts, duration = self._run(path, language, None)
        return to_transcript(parts, duration, language)


def to_transcript(parts: list[Segment], duration: float, language: str) -> dict:
    names = {"manager": "Менеджер", "client": "Клиент"}
    lines, prev = [], None
    for s in parts:
        if s.speaker and s.speaker != prev:
            lines.append(f"{names.get(s.speaker, s.speaker)}: {s.text}")
        elif lines:
            lines[-1] += " " + s.text
        else:
            lines.append(s.text)
        prev = s.speaker
    lp = [s.logprob for s in parts if s.logprob is not None]
    return {
        "text": "\n".join(lines),
        "segments": [{"speaker": s.speaker, "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text} for s in parts],
        "language": language,
        "durationSec": round(duration, 1),
        # уверенность распознавания: средняя вероятность слов (0..1)
        "asrConfidence": round(math.exp(sum(lp) / len(lp)), 3) if lp else None,
    }


CARD = re.compile(r"\b(?:\d[ -]?){15,18}\d\b")


def mask(text: str) -> str:
    """Номера карт в модель не передаём даже внутри сервера (ТЗ 6.3, правило 1)"""
    return CARD.sub("[номер карты]", text)


class OpenAICompatLLM:
    """vLLM (или любой совместимый сервер внутри контура). Ответ ограничен JSON-схемой."""

    def __init__(self) -> None:
        self.url = os.environ.get("LLM_URL", "http://vllm:8000/v1").rstrip("/")
        self.model = os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-32B-Instruct-AWQ")
        self.key = os.environ.get("LLM_KEY", "local")
        self.client = httpx.Client(timeout=float(os.environ.get("LLM_TIMEOUT", "180")))

    @property
    def engine(self) -> str:
        return f"{self.model.split('/')[-1]}/{PROMPT_VERSION}"

    def health(self) -> bool:
        return self.client.get(f"{self.url}/models", headers={"authorization": f"Bearer {self.key}"}).status_code == 200

    def complete(self, system: str, user: str) -> dict:
        r = self.client.post(
            f"{self.url}/chat/completions",
            headers={"authorization": f"Bearer {self.key}"},
            json={
                "model": self.model,
                "temperature": 0.1,
                "max_tokens": 1200,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": {"type": "json_schema", "json_schema": {"name": "call_summary", "schema": SCHEMA}},
            },
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        return json.loads(content)


def summarize(llm, transcript: dict, ctx: dict) -> dict:
    text = mask(str(transcript.get("text", ""))).strip()
    if len(text.split()) < 12:
        return {"summary": None, "confidence": None, "engine": llm.engine, "reason": "Разговор слишком короткий"}
    user = USER.format(
        clubName=ctx.get("clubName") or "—", managerName=ctx.get("managerName") or "—", clientName=ctx.get("clientName") or "не указан",
        direction="входящий" if ctx.get("direction") == "in" else "исходящий", callTime=ctx.get("callTime") or "—",
        timezone=ctx.get("timezone") or "Europe/Moscow", transcript=text[:24000],
    )
    out = llm.complete(SYSTEM, user)
    if not out.get("sufficient") or not str(out.get("essence", "")).strip():
        return {"summary": None, "confidence": None, "engine": llm.engine, "reason": out.get("reason") or "Данных недостаточно"}
    conf = float(out.get("confidence") or 0)
    asr = transcript.get("asrConfidence")
    if isinstance(asr, (int, float)):
        conf = min(conf, float(asr))  # плохо распознанная запись не может дать уверенный итог
    summary = {k: out.get(k) for k in ("essence", "need", "objections", "agreements", "outcome", "nextStep")}
    return {"summary": summary, "confidence": round(max(0.0, min(1.0, conf)), 3), "engine": llm.engine}
