#!/usr/bin/env bash
# Atualiza os dados e publica. Rode na máquina de casa.
#   ./scripts/publicar.sh            -> coleta real
#   ./scripts/publicar.sh --exemplo  -> regenera os dados sintéticos
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

if [[ "${1:-}" == "--exemplo" ]]; then
  python3 scripts/gerar_exemplo.py
else
  python3 scripts/coletar_pncp.py "${@}"
fi

if git diff --quiet -- projetos/pncp/dados.json; then
  echo "nada mudou nos dados — nada a publicar."
  exit 0
fi

git add projetos/pncp/dados.json
git commit -m "dados: atualização de $(date +%Y-%m-%d)"
git push
echo "publicado. o GitHub Pages leva cerca de um minuto para refletir."
