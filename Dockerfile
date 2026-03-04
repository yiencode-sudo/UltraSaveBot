FROM node:18-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PYTHONUNBUFFERED=1 \
    VENV_PATH=/opt/yt-dlp-venv

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv "$VENV_PATH" \
    && "$VENV_PATH/bin/pip" install --no-cache-dir --upgrade pip yt-dlp \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="$VENV_PATH/bin:$PATH"

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p /app/downloads \
    && chown -R node:node /app

USER node

CMD ["npm", "start"]
