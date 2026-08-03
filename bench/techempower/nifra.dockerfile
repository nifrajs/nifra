FROM oven/bun:1.3

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/server.ts"]
