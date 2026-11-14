"""Проверка ИИ-сервера без GPU: движки подменяются заглушками. Запуск: python -m unittest discover -s tests"""

import os
import unittest

from fastapi.testclient import TestClient

from app import engines
from app.main import app
from app.wer import wer


class FakeASR:
    engine = "whisper-test"

    def transcribe(self, path, language):
        with open(path, "rb") as f:
            assert f.read(4) == b"RIFF"
        parts = [
            engines.Segment("manager", 0.0, 2.0, "Добрый день, фитнес-клуб Центр, Мария.", -0.1),
            engines.Segment("client", 2.1, 6.0, "Здравствуйте, хочу узнать про годовой абонемент, сколько стоит?", -0.2),
            engines.Segment("manager", 6.1, 9.0, "Годовой стоит сорок девять тысяч, приходите на пробную тренировку.", -0.1),
            engines.Segment("client", 9.1, 12.0, "Давайте в четверг вечером, дорого конечно.", -0.3),
        ]
        return engines.to_transcript(parts, 12.0, language)


class FakeLLM:
    engine = "test-llm/summary-v1"

    def __init__(self, answer):
        self.answer = answer
        self.seen = None

    def complete(self, system, user, *_):
        self.seen = user
        return self.answer


GOOD = {
    "sufficient": True, "reason": "", "essence": "Клиент спросил о годовом абонементе, записан на пробную тренировку.",
    "need": "Годовой абонемент, вечернее время", "objections": ["дорого"], "agreements": "Пробная тренировка в четверг вечером",
    "outcome": "interested", "nextStep": {"title": "Пробная тренировка", "kind": "meeting", "dueAt": "2026-11-12T19:00:00+03:00"},
    "confidence": 0.95,
}


class ServiceTest(unittest.TestCase):
    def setUp(self):
        os.environ["AI_TOKEN"] = "secret"
        app.state.asr = FakeASR()
        app.state.llm = FakeLLM(GOOD)
        self.c = TestClient(app)
        self.h = {"authorization": "Bearer secret"}

    def test_health_without_token(self):
        r = self.c.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["promptVersion"], "summary-v1")

    def test_auth_required(self):
        self.assertEqual(self.c.post("/v1/summarize", json={"transcript": {"text": "x"}}).status_code, 401)
        self.assertEqual(self.c.post("/v1/summarize", json={"transcript": {"text": "x"}}, headers={"authorization": "Bearer wrong"}).status_code, 401)

    def test_transcribe_speakers(self):
        wav = b"RIFF" + b"\0" * 4 + b"WAVEfmt " + b"\0" * 64
        r = self.c.post("/v1/transcribe", files={"file": ("call.wav", wav, "audio/wav")}, data={"language": "ru"}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        t = r.json()
        self.assertTrue(t["text"].startswith("Менеджер: Добрый день"))
        self.assertIn("\nКлиент: Здравствуйте", t["text"])
        self.assertEqual(t["segments"][1]["speaker"], "client")
        self.assertEqual(t["engine"], "whisper-test")
        self.assertTrue(0 < t["asrConfidence"] < 1)
        self.assertEqual(self.c.post("/v1/transcribe", files={"file": ("e.wav", b"", "audio/wav")}, headers=self.h).status_code, 400)

    def test_summarize(self):
        t = engines.to_transcript([engines.Segment("client", 0, 5, "Хочу годовой абонемент, но дорого, карта 4276 1234 5678 9012, давайте в четверг на пробную", -0.05)], 5, "ru")
        r = self.c.post("/v1/summarize", json={"transcript": t, "context": {"clubName": "Центр", "callTime": "вторник, 10 ноября 2026 г., 14:35", "timezone": "Europe/Moscow"}}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual(b["summary"]["nextStep"]["kind"], "meeting")
        self.assertLessEqual(b["confidence"], 0.952)  # не выше уверенности распознавания
        self.assertEqual(b["engine"], "test-llm/summary-v1")
        self.assertNotIn("4276", app.state.llm.seen)  # номер карты замаскирован
        self.assertIn("[номер карты]", app.state.llm.seen)
        self.assertIn("Центр", app.state.llm.seen)

    def test_insufficient(self):
        app.state.llm = FakeLLM({**GOOD, "sufficient": False, "reason": "Разговор не о клубе"})
        r = self.c.post("/v1/summarize", json={"transcript": {"text": " ".join(["слово"] * 20)}}, headers=self.h).json()
        self.assertIsNone(r["summary"])
        self.assertEqual(r["reason"], "Разговор не о клубе")
        short = self.c.post("/v1/summarize", json={"transcript": {"text": "Алло, перезвоню"}}, headers=self.h).json()
        self.assertIsNone(short["summary"])

    def test_bad_model_answer(self):
        class Broken(FakeLLM):
            def complete(self, s, u):
                raise ValueError("не JSON")
        app.state.llm = Broken({})
        r = self.c.post("/v1/summarize", json={"transcript": {"text": " ".join(["слово"] * 20)}}, headers=self.h)
        self.assertEqual(r.status_code, 502)

    def test_evaluate(self):
        app.state.llm = FakeLLM({"items": [
            {"id": "greet", "ok": True, "quote": "Добрый день, фитнес-клуб Центр"},
            {"id": "close", "ok": "да", "quote": ""},
            {"id": "lishniy", "ok": False, "quote": ""},
        ]})
        r = self.c.post("/v1/evaluate", json={
            "transcript": {"text": "Менеджер: Добрый день, фитнес-клуб Центр. Карта 4276 1234 5678 9012"},
            "checklist": [{"id": "greet", "text": "Поздоровался и назвал клуб"}, {"id": "close", "text": "Записал на визит"}],
        }, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        items = r.json()["items"]
        self.assertEqual([i["id"] for i in items], ["greet", "close"])  # чужие пункты отброшены
        self.assertIs(items[0]["ok"], True)
        self.assertIsNone(items[1]["ok"])  # не логическое значение -> «нельзя понять»
        self.assertNotIn("4276", app.state.llm.seen)
        self.assertEqual(self.c.post("/v1/evaluate", json={"transcript": {}, "checklist": []}).status_code, 401)

    def test_config_suggest(self):
        app.state.llm = FakeLLM({"changes": [
            {"path": "freeze.maxDays", "value": "30"}, {"path": "late.text", "value": "\"Напомнить\""},
            {"path": "chuzhaya", "value": "1"},
        ], "explanation": "Заморозка до 30 дней", "unknown": ["скидка на кофе"]})
        r = self.c.post("/v1/config-suggest", json={"text": "заморозка до 30 дней", "fields": [
            {"path": "freeze.maxDays", "label": "Дней заморозки", "type": "number", "value": 14},
            {"path": "late.text", "label": "Текст", "type": "string", "value": ""},
        ]}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual(b["changes"], [{"path": "freeze.maxDays", "value": 30}, {"path": "late.text", "value": "Напомнить"}])
        self.assertEqual(b["unknown"], ["скидка на кофе"])

    def test_wer(self):
        self.assertEqual(wer("я хочу абонемент", "я хочу абонемент"), 0)
        self.assertAlmostEqual(wer("я хочу годовой абонемент", "я хочу абонемент"), 0.25)
        self.assertEqual(wer("Ёлка", "елка"), 0)


if __name__ == "__main__":
    unittest.main()
