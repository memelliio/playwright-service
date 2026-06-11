FROM oven/bun:latest
WORKDIR /app
COPY package.json .
RUN bun install
COPY src ./src
CMD ["bun", "src/index.ts"]
