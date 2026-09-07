FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

ARG VITE_SUPABASE_FUNCTIONS_URL
ENV VITE_SUPABASE_FUNCTIONS_URL=${VITE_SUPABASE_FUNCTIONS_URL}

# Webhook do n8n que a tela /gerar chama (fluxo `gerar-conteudo`). O console fala com o n8n
# direto do navegador, então isto precisa entrar no bundle — é build arg, não variável de
# runtime. Sem ela, a tela mostra "Webhook não configurado" em vez de falhar silenciosamente.
ARG VITE_N8N_WEBHOOK_GERAR
ENV VITE_N8N_WEBHOOK_GERAR=${VITE_N8N_WEBHOOK_GERAR}

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

