"""
Monta projetos/pncp/vencendo/dados_<esfera>_<uf>.json a partir do resultado
bruto do coletor de contratos de TIC vencendo (via /api/search/ do PNCP), e
atualiza o manifesto projetos/pncp/vencendo/escopos.json (lista de escopos
esfera+UF disponiveis, consumida por assets/vencendo.js pra montar as abas).

Contrato de dados de saida por escopo (o que assets/vencendo.js consome):
    {
      geradoEm, cobertura: {uf, esfera, criterioTIC, janelaVencimento,
                             mesesJanelaInicio, mesesJanelaFim, fonte},
      totais: {candidatosTIC, vencendoJanela, servicos},
      julgamentoAgente: {total_antes, aprovados, reprovados, exemplosReprovados},
      contratos: [{orgao, orgaoCnpj, venceEm, valor, objeto, servico,
                   numeroControlePncp, link}]
    }

Contrato do manifesto escopos.json:
    {"escopos": [{esferaCode, esferaNome, uf, ufNome, arquivo, geradoEm}, ...]}

Fonte esperada: o arquivo *_julgado.json produzido por _consolidar_julgamento.py
(ja passou pelo agente julgador) - nao o resultado bruto do coletor. contratos
aqui SO tem os aprovados; o quadro do agente julgador na pagina le
julgamentoAgente.exemplosReprovados para mostrar o que foi descartado, sem
misturar esse campo nas linhas de contrato.

Uso:
    python scripts/montar_vencendo.py <caminho para resultado_tic_<uf>_<esfera>_julgado.json>
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PASTA_VENCENDO = RAIZ / "projetos" / "pncp" / "vencendo"
MANIFESTO = PASTA_VENCENDO / "escopos.json"

ESFERA_NOME_PARA_CODE = {"Federal": "F", "Estadual": "E", "Municipal": "M", "Distrital": "D"}

UF_NOMES = {
    "DF": "Distrito Federal",
    "BA": "Bahia",
    "RS": "Rio Grande do Sul",
    "PA": "Pará",
}


def slug(nome: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode("ascii")
    return "_".join(sem_acento.lower().split())


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
            "numeroControlePncp": c.get("numero_controle_pncp") or "",
            "link": c.get("link") or "",
        })
    contratos.sort(key=lambda r: r["venceEm"])

    return {
        "geradoEm": bruto.get("geradoEm"),
        "cobertura": {
            "uf": escopo.get("uf"),
            "esfera": escopo.get("esfera"),
            "municipio": escopo.get("municipio"),
            "criterioTIC": escopo.get("criterioTIC"),
            "janelaVencimento": escopo.get("janelaVencimento"),
            "mesesJanelaInicio": escopo.get("mesesJanelaInicio"),
            "mesesJanelaFim": escopo.get("mesesJanelaFim"),
            "fonte": escopo.get("fonte"),
        },
        "totais": {
            "candidatosTIC": bruto.get("totalCandidatosTIC", 0),
            "vencendoJanela": bruto.get("totalVencendoJanela", len(contratos)),
            "servicos": bruto.get("totalServicos", sum(1 for c in contratos if c["servico"])),
        },
        "julgamentoAgente": bruto.get("julgamentoAgente"),
        "contratos": contratos,
    }


def atualizar_manifesto(esfera_code: str, esfera_nome: str, uf: str, municipio: str | None, arquivo: str, gerado_em: str | None) -> None:
    if MANIFESTO.exists():
        manifesto = json.loads(MANIFESTO.read_text(encoding="utf-8"))
    else:
        manifesto = {"escopos": []}

    entrada = {
        "esferaCode": esfera_code,
        "esferaNome": esfera_nome,
        "uf": uf,
        "ufNome": UF_NOMES.get(uf, uf),
        "municipio": municipio,
        "arquivo": arquivo,
        "geradoEm": gerado_em,
    }

    escopos = manifesto.setdefault("escopos", [])
    for i, e in enumerate(escopos):
        if e.get("esferaCode") == esfera_code and e.get("uf") == uf and (e.get("municipio") or None) == (municipio or None):
            escopos[i] = entrada
            break
    else:
        escopos.append(entrada)

    MANIFESTO.write_text(json.dumps(manifesto, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{MANIFESTO}: {len(escopos)} escopo(s)")


def main() -> int:
    if len(sys.argv) != 2:
        print("uso: python scripts/montar_vencendo.py <resultado_tic_<uf>_<esfera>_julgado.json>", file=sys.stderr)
        return 2
    origem = Path(sys.argv[1])
    bruto = json.loads(origem.read_text(encoding="utf-8"))
    dados = montar(bruto)

    escopo = bruto.get("escopo", {})
    uf = (escopo.get("uf") or "").upper()
    esfera_nome = escopo.get("esfera") or "Federal"
    esfera_code = ESFERA_NOME_PARA_CODE.get(esfera_nome, "F")
    municipio = escopo.get("municipio")
    sufixo_municipio = f"_{slug(municipio)}" if municipio else ""

    nome_arquivo = f"dados_{esfera_code.lower()}_{uf.lower()}{sufixo_municipio}.json"
    saida = PASTA_VENCENDO / nome_arquivo

    PASTA_VENCENDO.mkdir(parents=True, exist_ok=True)
    saida.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{saida}: {len(dados['contratos'])} contratos de TIC vencendo")

    atualizar_manifesto(esfera_code, esfera_nome, uf, municipio, nome_arquivo, dados.get("geradoEm"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
