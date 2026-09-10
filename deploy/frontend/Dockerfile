# Contexto de build é a RAIZ do repositório, não esta pasta: o `dist/` que o nginx serve é
# gerado por `npm run build` lá em cima, e a config precisa ser versionada junto com ele.
#
#   docker build -f deploy/frontend/Dockerfile -t blank-editor-frontend:<sha> .
FROM nginx:alpine
COPY dist /usr/share/nginx/html
COPY deploy/frontend/nginx.conf /etc/nginx/conf.d/default.conf
