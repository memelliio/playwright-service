FROM oven/bun:latest
WORKDIR /app
COPY package.json .
RUN bun install
# Real Google Chrome, not the bundled Chromium. Patchright names this first in its own setup.
RUN bunx patchright install --with-deps chrome
# A virtual display, so the browser runs headed. This box has no screen of its own.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*
# Where the Chrome profile lives. Cookies survive here between runs - see CHROME_PROFILE_DIR.
RUN mkdir -p /var/lib/memelli-chrome/worker /var/lib/memelli-chrome/session
COPY src ./src
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "bun", "src/index.ts"]
