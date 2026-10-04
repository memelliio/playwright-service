FROM oven/bun:latest
WORKDIR /app
COPY package.json .
RUN bun install
# Real Google Chrome, not the bundled Chromium. Patchright names this first in its own setup.
RUN bunx patchright install --with-deps chrome
# A virtual display, so the browser runs headed. This box has no screen of its own.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg libvulkan1 mesa-vulkan-drivers && rm -rf /var/lib/apt/lists/*
# The studio rack (Mel 2026-10-04: "the waves bundle plugins, like Pro Tools has - did you actually go get those?"). Open-source
# LV2 plugins that ffmpeg (built with lv2) runs headless on the timeline: -af lv2=p=<URI>. Each Waves job has its open part:
# auto-tune x42 fat1 · de-ess / vocal rider / comp / multiband / limiter LSP · L2-style maximizer ZaMaximX2 · air/exciter + tape Calf
# · reverb Dragonfly · noise Noise Repellent · drums DrumGizmo (renders a MIDI pattern). lilv-utils gives lv2ls to list what landed.
# One package at a time, so a name this Debian release lacks is named in the build log instead of failing the whole image.
RUN apt-get update && for p in lilv-utils lsp-plugins-lv2 x42-plugins zam-plugins calf-plugins dragonfly-reverb-lv2 noise-repellent drumgizmo tini; do       apt-get install -y --no-install-recommends "$p" || echo "STUDIO RACK: package not available here: $p";     done && rm -rf /var/lib/apt/lists/*
# Where the Chrome profile lives. Cookies survive here between runs - see CHROME_PROFILE_DIR.
RUN mkdir -p /var/lib/memelli-chrome/worker /var/lib/memelli-chrome/session /var/lib/memelli-chrome/recordings
COPY src ./src
# tini is PID 1 and reaps the dead Chrome children a walk leaves behind (423 zombies filled the 1000 process slots, 10-04).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "bun", "src/index.ts"]
