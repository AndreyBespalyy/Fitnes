# ИИ-сервер: распознавание речи на GPU (вариант без видеокарты — Dockerfile.cpu). Языковая модель — отдельный контейнер vLLM (deploy/ai/docker-compose.yml).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY app ./app
ENV MODELS_DIR=/models
EXPOSE 8100
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
