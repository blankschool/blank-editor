FROM node:22-slim

# O texto do SVG é rasterizado pelo @resvg/resvg-js com `loadSystemFonts: false`: as fontes vêm
# do registry (Doc.fonts -> storage -> cache em /tmp), não do sistema. Por isso não há mais
# fontconfig nem pacote de fontes aqui — nada instalado na imagem influencia o desenho, que é
# justamente a propriedade que se quer. O binário nativo do resvg vem por optionalDependencies
# do npm, então não acrescente --no-optional ao install abaixo.

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src


ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server.ts"]
