# ─── DroidWeb Lightweight Dockerfile ────────────────────────────────────────
# Uses Budtmo/docker-android — a pre-built optimized Android image (~2.5 GB)
# Fits within Railway free tier 4 GB limit
# ─────────────────────────────────────────────────────────────────────────────

FROM budtmo/docker-android:emulator_13.0

USER root

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 3000

# Environment
ENV PORT=3000
ENV ANDROID_VERSION=13.0
ENV EMULATOR_PATH=/opt/android/sdk/emulator/emulator
ENV ADB_PATH=/opt/android/sdk/platform-tools/adb
ENV AVD_NAME=Pixel_4_API_33

# Start both Android + Node
COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh
CMD ["/docker-start.sh"]
