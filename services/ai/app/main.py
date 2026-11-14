"""ИИ-сервер «Клубной ОС»: расшифровка звонков и резюме для карточки клиента.
Работает внутри нашего контура: на сервере CRM на процессоре (deploy/docker-compose.yml, профиль ai)
или на отдельном GPU-сервере (deploy/ai). CRM обращается к нему по AI_URL с ключом AI_TOKEN."""

from __future__ import annotations

import hmac
import os
import tempfile
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from . import engines
from .prompts import PROMPT_VERSION

MAX_AUDIO = 60 * 1024 * 1024
app = FastAPI(title="Клубная ОС — ИИ-сервер", docs_url=None, redoc_url=None)
_lock = threading.Lock()
# Одна запись за раз: на процессоре параллельная расшифровка только делит ядра и замедляет каждую
_asr_busy = threading.Semaphore(1)


def _transcribe_one(asr, path: str, language: str) -> dict:
    with _asr_busy:
        return asr.transcribe(path, language)


def get_asr():
    with _lock:
        if getattr(app.state, "asr", None) is None:
            app.state.asr = engines.WhisperASR()
    return app.state.asr


def get_llm():
    with _lock:
        if getattr(app.state, "llm", None) is None:
            app.state.llm = engines.OpenAICompatLLM()
    return app.state.llm


def auth(authorization: str = Header(default="")) -> None:
    token = os.environ.get("AI_TOKEN", "")
    if not token:
        return  # ключ не задан — сервер доступен только во внутренней сети
    if not hmac.compare_digest(authorization.removeprefix("Bearer ").strip(), token):
        raise HTTPException(401, "Неверный ключ")


@app.get("/health")
def health():
    asr = getattr(app.state, "asr", None)
    llm = getattr(app.state, "llm", None)
    return {
        "ok": True,
        "asr": asr.engine if asr else f"whisper-{os.environ.get('ASR_MODEL', 'large-v3')} (загрузится при первом звонке)",
        "llm": llm.engine if llm else os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-32B-Instruct-AWQ"),
        "promptVersion": PROMPT_VERSION,
    }


@app.post("/v1/transcribe", dependencies=[Depends(auth)])
async def transcribe(file: UploadFile = File(...), language: str = Form("ru"), asr=Depends(get_asr)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "Запись больше 60 МБ")
    suffix = os.path.splitext(file.filename or "")[1][:6] or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(data)
        f.flush()
        try:
            t = await run_in_threadpool(_transcribe_one, asr, f.name, language)
        except Exception as e:  # битый файл, неизвестный формат
            raise HTTPException(422, f"Не удалось распознать запись: {e}") from e
    return {**t, "engine": asr.engine}


class SummarizeIn(BaseModel):
    transcript: dict
    context: dict = {}


@app.post("/v1/summarize", dependencies=[Depends(auth)])
def summarize(body: SummarizeIn, llm=Depends(get_llm)):
    try:
        return engines.summarize(llm, body.transcript, body.context)
    except (ValueError, KeyError) as e:  # модель вернула не тот формат
        raise HTTPException(502, f"Языковая модель вернула неверный ответ: {e}") from e


class EvaluateIn(BaseModel):
    transcript: dict | list | str
    checklist: list[dict]


@app.post("/v1/evaluate", dependencies=[Depends(auth)])
def evaluate(body: EvaluateIn, llm=Depends(get_llm)):
    try:
        return engines.evaluate(llm, body.transcript, body.checklist)
    except (ValueError, KeyError) as e:
        raise HTTPException(502, f"Языковая модель вернула неверный ответ: {e}") from e


class ConfigSuggestIn(BaseModel):
    text: str
    fields: list[dict]


@app.post("/v1/config-suggest", dependencies=[Depends(auth)])
def config_suggest(body: ConfigSuggestIn, llm=Depends(get_llm)):
    try:
        return engines.config_suggest(llm, body.text, body.fields)
    except (ValueError, KeyError) as e:
        raise HTTPException(502, f"Языковая модель вернула неверный ответ: {e}") from e
