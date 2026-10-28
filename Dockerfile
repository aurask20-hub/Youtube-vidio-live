FROM python:3.11-slim

# Install FFmpeg and FFprobe
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Keep Python logs visible in Render
ENV PYTHONUNBUFFERED=1

# Start Flask app using Gunicorn
CMD ["sh", "-c", "gunicorn --workers 1 --threads 8 --timeout 0 --bind 0.0.0.0:${PORT:-10000} app:app"]
