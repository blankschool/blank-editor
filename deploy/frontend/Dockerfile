# O contexto de build é uma pasta montada por deploy.sh com o `dist/` recém-buildado e o
# nginx.conf ao lado — não a raiz do repositório: o .dockerignore da raiz exclui `dist` (existe
# para a imagem da API), e buildar daqui de dentro copiaria uma pasta vazia.
FROM nginx:alpine
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
