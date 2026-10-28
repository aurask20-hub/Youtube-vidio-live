FROM python:3.11-slim

# Install ffmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1

# IMPORTANT: keep exactly 1 worker. The ffmpeg process lives in memory,
# so multiple workers would not be able to stop each other's stream.
# Threads keep Flask responsive while ffmpeg runs.
CMD gunicorn --workers 1 --threads 8 --timeout 0 --bind 0.0.0.0:${PORT:-10000} app:app
