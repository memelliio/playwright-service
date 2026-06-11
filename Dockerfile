FROM oven/bun:latest
WORKDIR /app
COPY package.json .
RUN bun install
RUN bunx playwright install --with-deps chromium
COPY src ./src
CMD ["bun", "src/index.ts"]
