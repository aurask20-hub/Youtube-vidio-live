FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js index.html ./
ENV NODE_ENV=production HOST=0.0.0.0 STORAGE_DIR=/data
CMD ["node", "server.js"]
