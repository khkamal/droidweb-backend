# ─── DroidWeb Lightweight Dockerfile ────────────────────────────────────────
FROM budtmo/docker-android:emulator_13.0

USER root

# Install curl first, then Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
RUN mkdir -p /app/uploads

EXPOSE 3000

ENV PORT=3000
ENV ANDROID_VERSION=13.0
ENV ADB_PATH=adb
ENV AVD_NAME=Pixel_4_API_33

COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh
CMD ["/docker-start.sh"]
