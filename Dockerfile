FROM node:24.22.1-alpine AS dependencies
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.22.1-alpine
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=10001:10001 dist ./dist
COPY package.json ./
USER 10001:10001
EXPOSE 4200
CMD ["node", "dist/server.js"]
