FROM node:22-slim

# poppler-utils: pdfimages/pdftocairo/pdfinfo (extração de camadas de imagem).
# python3 + venv: fontTools/PyMuPDF/brotli não têm equivalente prático em JS — ver
# scripts/canva-pdf-fonts.py. Isto fica isolado neste serviço de propósito: o server principal
# do Blank Editor (server/Dockerfile) continua enxuto, sem Python nenhum.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils python3 python3-venv && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/canva-import-venv && \
    /opt/canva-import-venv/bin/pip install --no-cache-dir fonttools pymupdf brotli

ENV CANVA_IMPORT_PYTHON=/opt/canva-import-venv/bin/python3

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8791

CMD ["node", "--experimental-strip-types", "src/server.ts"]
