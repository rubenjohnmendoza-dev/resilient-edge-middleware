FROM node:22-slim

ENV NODE_ENV=development \
    WRANGLER_SEND_METRICS=false

RUN npm install --global pnpm@11.25.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 8787 8788

CMD ["pnpm", "exec", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--local", "--show-interactive-dev-session=false"]
