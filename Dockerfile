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
# The Infinity instruments + the plugin host (Mel 2026-10-04: "the verb needs, the instruments - do it all").
# carla = the headless host that loads LV2/VST2/VST3/SF2/SFZ (and the DPF plugins ffmpeg cannot: Dragonfly reverb, ZAM);
# fluidsynth + General MIDI soundfonts (FluidR3 MIT, MuseScore General MIT) = piano, keys, bass, strings, pads, leads, drums
# from a MIDI pattern; ZynAddSubFX = synth pads/leads. Same one-at-a-time loop: a missing name is logged, never a failed image.
RUN apt-get update && for p in carla carla-lv2 fluidsynth fluid-soundfont-gm musescore-general-soundfont-small zynaddsubfx-lv2 setbfree; do       apt-get install -y --no-install-recommends "$p" || echo "INSTRUMENTS: package not available here: $p";     done && rm -rf /var/lib/apt/lists/*
# Infinity Stems (Mel 2026-10-04: "grab the weights ... run separately"): HTDemucs (MIT) in its own Python env, CPU torch,
# the htdemucs weights fetched at build time so a node never downloads mid-job. Tolerant like the rest: a failure is logged.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip libsndfile1 && rm -rf /var/lib/apt/lists/*     && (python3 -m venv /opt/demucs       && /opt/demucs/bin/pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu       && /opt/demucs/bin/pip install --no-cache-dir demucs soundfile       && /opt/demucs/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('htdemucs weights ready')"       || echo "STEMS: demucs install failed")
# Infinity Match (the real mastering stage, Mel 2026-10-04: "is the real mastering chain here?"): Matchering 2.0 (GPL-3, run as
# our service) masters a track to match a reference's RMS, frequency response, peak and stereo width. Same venv as Demucs.
RUN (/opt/demucs/bin/pip install --no-cache-dir matchering \
      && printf '#!/bin/sh\nexec /opt/demucs/bin/python -c "import sys, matchering as mg; mg.process(target=sys.argv[1], reference=sys.argv[2], results=[mg.pcm24(sys.argv[3])])" "$@"\n' > /usr/local/bin/infinity-match \
      && chmod +x /usr/local/bin/infinity-match && echo "matchering ready") || echo "MATCH: matchering install failed"
# Where the Chrome profile lives. Cookies survive here between runs - see CHROME_PROFILE_DIR.
RUN mkdir -p /var/lib/memelli-chrome/worker /var/lib/memelli-chrome/session /var/lib/memelli-chrome/recordings
COPY src ./src
# tini is PID 1 and reaps the dead Chrome children a walk leaves behind (423 zombies filled the 1000 process slots, 10-04).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "bun", "src/index.ts"]
