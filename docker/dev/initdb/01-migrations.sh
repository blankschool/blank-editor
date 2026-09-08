#!/bin/bash
# Aplica supabase/migrations/ na ordem numérica, uma transação por arquivo.
#
# Roda uma vez só, na primeira criação do volume do Postgres (contrato do
# docker-entrypoint-initdb.d). Para reaplicar do zero: docker compose down -v.
#
# ON_ERROR_STOP=1 é o ponto todo: sem isso o psql segue após um erro e o banco sobe
# parcialmente migrado — que é pior do que não subir, porque falha depois, longe da causa.
set -euo pipefail

echo "==> aplicando migrations"
for arquivo in /migrations/*.sql; do
  echo "    $(basename "$arquivo")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --single-transaction -f "$arquivo"
done
echo "==> $(ls /migrations/*.sql | wc -l) migrations aplicadas"
