"""ИИ-сервер «Клубной ОС»: расшифровка звонков и резюме для карточки клиента.
Работает внутри контура клуба на GPU-сервере; CRM обращается к нему по AI_URL с ключом AI_TOKEN."""

from __future__ import annotations

import hmac
import os
import tempfile
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from . import engines
from .prompts import PROMPT_VERSION

MAX_AUDIO = 60 * 1024 * 1024
app = FastAPI(title="Клубная ОС — ИИ-сервер", docs_url=None, redoc_url=None)
_lock = threading.Lock()


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
            t = asr.transcribe(f.name, language)
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
