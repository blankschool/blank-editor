FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server.ts"]
