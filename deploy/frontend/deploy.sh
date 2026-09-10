#!/usr/bin/env bash
# Publica o frontend em blank-editor.ickanz.easypanel.host.
#
# Rode NO VPS, de dentro do clone do repositório (/root/blank-editor):
#
#     ssh painel-vps 'cd /root/blank-editor && deploy/frontend/deploy.sh'
#
# O frontend não é EasyPanel: é um serviço Docker Swarm avulso (`blank-editor-frontend`),
# roteado por /etc/easypanel/traefik/config/blank-editor-domain.yaml, com a imagem taggeada
# pelo commit. A API é outra coisa — o serviço EasyPanel `sites_blank-editor-api-v2`, que
# buildá do mesmo repositório (path /server) e tem autoDeploy desligado.
set -euo pipefail
cd "$(dirname "$0")/../.."

git pull --ff-only
npm ci
npm run build

sha=$(git rev-parse --short HEAD)
imagem="blank-editor-frontend:${sha}"
docker build -f deploy/frontend/Dockerfile -t "$imagem" .

# Valida a config ANTES de trocar o serviço, na rede onde os upstreams resolvem: um
# `proxy_pass` para host inexistente derruba o nginx no boot, e o Swarm só descobre isso
# tirando o container antigo do ar. Foi assim que um deploy virou indisponibilidade.
docker run --rm --network easypanel --entrypoint nginx "$imagem" -t

docker service update --image "$imagem" --quiet blank-editor-frontend
docker service ps blank-editor-frontend --format "{{.Image}} | {{.CurrentState}} | {{.Error}}" | head -3

# Volta para a imagem anterior, se precisar:
#   docker service update --image blank-editor-frontend:<sha-anterior> blank-editor-frontend
