# ИИ-сервер: расшифровка звонков и итоги разговоров

Два варианта запуска, код один и тот же (`services/ai`):

- **Без видеокарты, на сервере CRM (пилот, выбор Андрея 14.11.2026).** Бесплатно. Whisper large-v3-turbo и Qwen2.5-7B работают на процессоре сервера 144.31.107.204. Записи и тексты не уходят с сервера. Итог появляется через 5–15 минут после загрузки записи, а не сразу.
- **Отдельная машина с GPU** (1 видеокарта 48–80 ГБ, ТЗ 6.6): модель крупнее (Qwen2.5-32B), итоги точнее и быстрее. Понадобится, если качества 7B не хватит или клубов станет больше.

## Без видеокарты (пилот)

Контейнеры `ai` (расшифровка, Dockerfile.cpu) и `ai-llm` (llama.cpp с моделью Qwen2.5-7B-Instruct Q4_K_M) описаны в `deploy/docker-compose.yml` под профилем `ai`. Порт наружу не открыт: CRM ходит к ИИ внутри Docker по адресу `http://ai:8100`. У ИИ-контейнеров пониженный приоритет процессора: CRM всегда отвечает первой.

Нагрузка (оценка на 2 клуба, 6 ч разговоров в сутки): расшифровка 2–3 ч, итоги 2–3 ч работы процессора в сутки при 8 ядрах; памяти около 10 ГБ. Записи обрабатываются по одной, по очереди.

Включение (один раз, после того как обновление с этим кодом пришло на сервер):

```bash
cd /opt/fitnes/deploy
nproc && free -g
grep -q '^COMPOSE_PROFILES=' .env || echo 'COMPOSE_PROFILES=ai' >> .env
sed -i '/^AI_URL=/d;/^AI_TOKEN=/d' .env
echo 'AI_URL=http://ai:8100' >> .env
echo "AI_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose up -d --build
```

Первый запуск скачивает модели (около 6 ГБ: 4,7 ГБ языковая модель и 1,6 ГБ Whisper при первой записи). Ход загрузки: `docker compose logs -f ai-llm`. Проверка:

```bash
docker compose exec ai python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8100/health').read().decode())"
```

После этого во вкладке «Звонки» будет «ИИ-сервер подключён», и записи, которые ждали, уйдут в работу сами.

Настройки (строки в `deploy/.env`, необязательно):

- `AI_ASR_MODEL` — модель Whisper: `large-v3-turbo` (по умолчанию), `medium` или `small` — быстрее, но с ошибками чаще;
- `AI_LLM_REPO`, `AI_LLM_FILE` — другая модель GGUF с huggingface.co, например `bartowski/Qwen2.5-3B-Instruct-GGUF` и `Qwen2.5-3B-Instruct-Q4_K_M.gguf`, если процессор не успевает;
- `AI_ASR_THREADS` — сколько ядер отдать расшифровке (0 — решает сама);
- `ASR_MANAGER_CHANNEL` — в каком канале стереозаписи менеджер (0 или 1).

Выключение: убрать строки `COMPOSE_PROFILES=ai` и `AI_URL=...` из `deploy/.env`, затем `docker compose up -d --remove-orphans`.

## Отдельная машина с GPU

### Что внутри

- **Распознавание речи:** faster-whisper, модель large-v3, русский язык. Если запись АТС стерео (менеджер и клиент в разных каналах), каналы распознаются отдельно и в расшифровке видно, кто говорит. Какой канал у менеджера, задаёт `ASR_MANAGER_CHANNEL` (0 или 1).
- **Языковая модель:** vLLM с моделью Qwen2.5-32B-Instruct-AWQ (без видеокарты — llama.cpp с Qwen2.5-7B, см. выше) (хорошо пишет по-русски, помещается на одну видеокарту вместе с Whisper). Ответ ограничен JSON-схемой, промпт в `services/ai/app/prompts.py`, версия промпта пишется в каждое резюме.
- **Ничего не уходит наружу:** записи и расшифровки обрабатываются на этой машине. Номера карт маскируются до передачи в модель.

### Запуск

```bash
git clone git@github.com:AndreyBespalyy/Fitnes.git /opt/fitnes-ai && cd /opt/fitnes-ai
echo "AI_TOKEN=$(openssl rand -hex 24)" > deploy/ai/.env
docker compose -f deploy/ai/docker-compose.yml --env-file deploy/ai/.env up -d --build
curl http://localhost:8100/health
```

Первый запуск скачивает модели (около 25 ГБ), это 10–30 минут.

Порт 8100 открыть только для адреса сервера CRM:

```bash
ufw allow from 144.31.107.204 to any port 8100 proto tcp
```

### Подключение к CRM

В `/opt/fitnes/deploy/.env` на сервере CRM добавить две строки и перезапустить:

```
AI_URL=http://<адрес GPU-сервера>:8100
AI_TOKEN=<тот же ключ из deploy/ai/.env>
```

```bash
cd /opt/fitnes/deploy && docker compose up -d
```

Во вкладке «Звонки» появится «ИИ-сервер подключён», записи, которые ждали, уйдут в работу сами.

## Проверка качества

- **Резюме:** «Звонки» → «Качество ИИ». Цель шага 14 — не менее 80 % резюме без существенных правок на 50–100 реальных звонках. «Резюме в Excel» выгружает черновик ИИ и итог менеджера рядом.
- **Распознавание:** доля слов с ошибкой (WER), цель ≤ 15 %. Расшифровать 20–30 звонков вручную в txt и сравнить: `python -m app.wer эталоны/ расшифровки/`.

## Проверки кода

```bash
cd services/ai && pip install fastapi httpx python-multipart pydantic && python -m unittest discover -s tests
```
