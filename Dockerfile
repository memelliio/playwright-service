FROM oven/bun:latest
WORKDIR /app
COPY package.json .
RUN bun install
RUN bunx patchright install --with-deps chromium
COPY src ./src
CMD ["bun", "src/index.ts"]
