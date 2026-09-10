FROM node:22-slim

# Chromium provides the same HTML/CSS text layout as the editor.

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY src ./src


ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server.ts"]
