"""
Monta o JSON que o dashboard consome.

Contrato de dados — o dashboard calcula todos os agregados no navegador a
partir de `registros`, para que os filtros da página fiquem sempre coerentes
com os gráficos. Aqui só normalizamos, ordenamos e declaramos a procedência.

Registro (dict), campos esperados:
    data        str    "AAAA-MM-DD"
    orgao       str
    cnpj        str    (só dígitos)
    uf          str
    objeto      str
    modalidade  str
    valor       float  (R$; 0 quando o órgão não informou valor estimado)
    link        str    (URL no PNCP; "" quando não houver)
    origem      str    "categoria" | "palavra-chave"

Saída:
    {exemplo, gerado_em, cobertura, registros}
"""

from __future__ import annotations

from typing import Any

# Teto de registros embarcados na página. Acima disso o arquivo fica pesado
# para o navegador; a coleta mais antiga é cortada e o corte é declarado.
MAX_REGISTROS = 3000

CAMPOS = ("data", "orgao", "cnpj", "uf", "objeto", "modalidade", "valor", "link", "origem")


def _normalizar(r: dict) -> dict[str, Any]:
    limpo = {campo: r.get(campo, "") for campo in CAMPOS}
    limpo["valor"] = round(float(r.get("valor") or 0), 2)
    limpo["objeto"] = " ".join(str(limpo["objeto"]).split())
    limpo["orgao"] = " ".join(str(limpo["orgao"]).split())
    return limpo


def montar(registros: list[dict], cobertura: dict, gerado_em: str,
           exemplo: bool = False) -> dict:
    limpos = [_normalizar(r) for r in registros if r.get("data")]
    limpos.sort(key=lambda r: r["data"], reverse=True)

    cortados = max(0, len(limpos) - MAX_REGISTROS)
    if cortados:
        limpos = limpos[:MAX_REGISTROS]

    cobertura = dict(cobertura)
    cobertura["registros_cortados"] = cortados

    return {
        "exemplo": exemplo,
        "gerado_em": gerado_em,
        "cobertura": cobertura,
        "registros": limpos,
    }
