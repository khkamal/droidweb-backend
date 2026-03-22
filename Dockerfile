# ─── DroidWeb Backend Dockerfile ───────────────────────────────────────────
# Runs Android emulator (Android-x86 via QEMU) + Node.js backend
# Deploy to: Railway, Render, Fly.io (any free Docker host)
# ─────────────────────────────────────────────────────────────────────────────

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator"
ENV AVD_NAME=droidweb_avd
ENV ANDROID_VERSION=13.0
ENV PORT=3000

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk-headless \
    qemu-kvm \
    libvirt-daemon \
    curl wget unzip \
    aapt \
    adb \
    xvfb \
    libgl1-mesa-glx \
    libpulse0 \
    nodejs npm \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Android SDK Command Line Tools ──────────────────────────────────────────
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip \
      -O /tmp/cmdtools.zip && \
    unzip -q /tmp/cmdtools.zip -d /tmp/cmdtools && \
    mv /tmp/cmdtools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm /tmp/cmdtools.zip

# ── Accept licenses & install SDK packages ───────────────────────────────────
RUN yes | sdkmanager --licenses && \
    sdkmanager \
      "platform-tools" \
      "emulator" \
      "system-images;android-33;google_apis;x86_64" \
      "platforms;android-33"

# ── Create AVD ───────────────────────────────────────────────────────────────
RUN echo "no" | avdmanager create avd \
    -n ${AVD_NAME} \
    -k "system-images;android-33;google_apis;x86_64" \
    --device "pixel_4" \
    --force

# Configure AVD for headless operation
RUN mkdir -p /root/.android/avd/${AVD_NAME}.avd && \
    echo "hw.ramSize=2048\nhw.cpu.ncore=2\nhw.gpu.enabled=no\nhw.camera.back=none\nhw.camera.front=none\nhw.audioInput=no\nhw.audioOutput=no\nshow.kernel.messages=no" \
    >> /root/.android/avd/${AVD_NAME}.avd/config.ini

# ── Node.js app ───────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/

# Uploads directory
RUN mkdir -p /app/uploads

# ── Start script ─────────────────────────────────────────────────────────────
COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh

EXPOSE ${PORT}

CMD ["/docker-start.sh"]
