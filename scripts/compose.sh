#!/usr/bin/env sh
# Executa o docker compose com o arquivo de ambiente correto.
#
# Uso:
#   scripts/compose.sh <ambiente> <stack> <comando do docker compose...>
#
# Exemplos:
#   scripts/compose.sh dev core up -d
#   scripts/compose.sh dev app up -d --build
#   scripts/compose.sh dev core config      # mostra o compose com as variáveis aplicadas
#   scripts/compose.sh prod core ps
#
# <ambiente>  nome do arquivo em config/ sem a extensão (dev -> config/dev.env)
# <stack>     core = Docker/docker-compose.yml | app = Docker/docker-compose-app.yml

set -eu

if [ "$#" -lt 3 ]; then
  sed -n '2,14p' "$0"
  exit 1
fi

ENVIRONMENT="$1"
STACK="$2"
shift 2

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/config/$ENVIRONMENT.env"

case "$STACK" in
  core) COMPOSE_FILE="$ROOT_DIR/Docker/docker-compose.yml" ;;
  app)  COMPOSE_FILE="$ROOT_DIR/Docker/docker-compose-app.yml" ;;
  *)    echo "Stack inválida: $STACK (use core ou app)" >&2; exit 1 ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo $ENV_FILE não encontrado." >&2
  echo "Crie a partir do exemplo: cp config/$ENVIRONMENT.env.example config/$ENVIRONMENT.env" >&2
  exit 1
fi

exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
