"""
Monta projetos/pncp/vencendo/dados.json a partir do resultado bruto do
coletor de contratos de TIC vencendo (via /api/search/ do PNCP).

Contrato de dados de saida (o que assets/vencendo.js consome):
    {
      geradoEm, cobertura: {uf, esfera, criterioTIC, janelaVencimento, fonte},
      totais: {candidatosTIC, vencendoJanela, servicos},
      contratos: [{orgao, orgaoCnpj, venceEm, valor, objeto, servico,
                   modalidade, numeroControlePncp, link}]
    }

Uso:
    python scripts/montar_vencendo.py <caminho para resultado_tic_df_federal.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "projetos" / "pncp" / "vencendo" / "dados.json"


def montar(bruto: dict) -> dict:
    escopo = bruto.get("escopo", {})
    contratos = []
    for c in bruto.get("contratos", []):
        contratos.append({
            "orgao": c.get("orgao") or "(não informado)",
            "orgaoCnpj": c.get("orgao_cnpj") or "",
            "venceEm": c.get("vence_em") or "",
            "valor": round(float(c.get("valor_global") or 0), 2),
            "objeto": " ".join(str(c.get("objeto") or "").split()),
            "servico": bool(c.get("eh_servico_texto")),
            "modalidade": c.get("modalidade") or "",
            "numeroControlePncp": c.get("numero_controle_pncp") or "",
            "link": c.get("link") or "",
        })
    contratos.sort(key=lambda r: r["venceEm"])

    return {
        "geradoEm": bruto.get("geradoEm"),
        "cobertura": {
            "uf": escopo.get("uf"),
            "esfera": escopo.get("esfera"),
            "criterioTIC": escopo.get("criterioTIC"),
            "janelaVencimento": escopo.get("janelaVencimento"),
            "fonte": escopo.get("fonte"),
        },
        "totais": {
            "candidatosTIC": bruto.get("totalCandidatosTIC", 0),
            "vencendoJanela": bruto.get("totalVencendoJanela", len(contratos)),
            "servicos": bruto.get("totalServicos", sum(1 for c in contratos if c["servico"])),
        },
        "contratos": contratos,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("uso: python scripts/montar_vencendo.py <resultado_tic_df_federal.json>", file=sys.stderr)
        return 2
    origem = Path(sys.argv[1])
    bruto = json.loads(origem.read_text(encoding="utf-8"))
    dados = montar(bruto)
    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{SAIDA}: {len(dados['contratos'])} contratos de TIC vencendo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
