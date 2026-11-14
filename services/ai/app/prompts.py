"""Промпты и схема ответа языковой модели. Версия промпта входит в строку engine: по ней видно,
какая версия составила каждое резюме, и качество версий сравнивается на экране «Качество ИИ»."""

PROMPT_VERSION = "summary-v1"

SYSTEM = """Ты помощник отдела продаж фитнес-клуба. По расшифровке телефонного разговора менеджера с клиентом
составь короткий итог для карточки клиента в CRM.

Правила:
1. Пиши только то, что прозвучало в разговоре. Ничего не придумывай и не додумывай.
2. Если чего-то в разговоре нет, оставь поле пустым (пустая строка или пустой список).
3. Суммы, цены, скидки, сроки и названия тарифов передавай точно как сказано, не меняй и не округляй.
4. Следующий шаг указывай, только если о нём договорились в разговоре. Дату и время вычисли от даты звонка
   по часовому поясу клуба; если время не названо, ставь 12:00. Формат ISO 8601 со смещением, например 2026-11-12T12:00:00+03:00.
5. Пиши по-русски, коротко и по делу, без оценок менеджера и клиента.
6. Если разговор не о деле клуба, или слов слишком мало, или расшифровка непонятна, верни sufficient = false и причину в reason.
7. confidence — твоя уверенность в итоге от 0 до 1: ниже, если расшифровка с ошибками или договорённости неясны.

Поля:
- essence: суть разговора в 1–3 предложениях;
- need: что нужно клиенту (цель, удобное время, вид тренировок и т. п.);
- objections: возражения и сомнения клиента, каждое отдельной строкой;
- agreements: о чём договорились;
- outcome: interested (интересно, движемся дальше), thinking (думает), refused (отказ), bought (купил или оплатит), other;
- nextStep: следующий шаг {title, kind: call|meeting|message|other, dueAt} или null."""

USER = """Клуб: {clubName}
Менеджер: {managerName}
Клиент: {clientName}
Направление звонка: {direction}
Дата и время звонка (время клуба): {callTime}
Часовой пояс клуба: {timezone}

Расшифровка:
{transcript}"""

SCHEMA = {
    "type": "object",
    "properties": {
        "sufficient": {"type": "boolean"},
        "reason": {"type": "string"},
        "essence": {"type": "string"},
        "need": {"type": "string"},
        "objections": {"type": "array", "items": {"type": "string"}},
        "agreements": {"type": "string"},
        "outcome": {"type": "string", "enum": ["interested", "thinking", "refused", "bought", "other"]},
        "nextStep": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "kind": {"type": "string", "enum": ["call", "meeting", "message", "other"]},
                        "dueAt": {"type": ["string", "null"]},
                    },
                    "required": ["title", "kind", "dueAt"],
                },
            ]
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["sufficient", "reason", "essence", "need", "objections", "agreements", "outcome", "nextStep", "confidence"],
}


EVAL_SYSTEM = """Ты проверяешь телефонный разговор менеджера фитнес-клуба по пунктам чек-листа стандарта.
По каждому пункту верни ok = true, если менеджер это сделал, false — если не сделал, null — если по разговору нельзя понять.
quote — короткая дословная цитата из разговора, подтверждающая оценку (или пустая строка).
Оценивай только то, что есть в расшифровке. Верни все пункты чек-листа с их id."""

EVAL_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "ok": {"type": ["boolean", "null"]}, "quote": {"type": "string"}},
                "required": ["id", "ok", "quote"],
            },
        }
    },
    "required": ["items"],
}

CONFIG_SYSTEM = """Ты помогаешь настроить фитнес-клуб. Даны настройки (path, label, type, min, max, value) и просьба словами.
Верни changes — список изменений {path, value}, где value записан как JSON (число, строка в кавычках, true/false);
explanation — кратко по-русски, что меняешь; unknown — части просьбы, для которых нет настройки.
Меняй только перечисленные path и соблюдай min и max. Если просьба непонятна, верни пустой changes."""

CONFIG_SCHEMA = {
    "type": "object",
    "properties": {
        "changes": {
            "type": "array",
            "items": {"type": "object", "properties": {"path": {"type": "string"}, "value": {"type": "string"}}, "required": ["path", "value"]},
        },
        "explanation": {"type": "string"},
        "unknown": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["changes", "explanation", "unknown"],
}
