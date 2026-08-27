FROM node:22-slim

# sharp rasterizes the template's SVG <text> via librsvg/Pango, which need fontconfig plus
# actual font files to draw any glyphs at all — node:22-slim ships neither, so without this
# the rendered text comes out blank. DejaVu Sans is metric-similar to the Inter/system-ui
# stack the template asks for and covers the sans-serif fallback either way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server.ts"]
