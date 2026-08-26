#!/usr/bin/env python3
"""
Coletor real — lê a API pública de consulta do PNCP e escreve
projetos/pncp/dados.json no mesmo contrato do gerador de exemplo.

    python3 scripts/coletar_pncp.py --dias 90 --uf DF

Pontos que já custaram tempo em produção e estão tratados aqui:

  * User-Agent de navegador é obrigatório. Sem ele o PNCP responde 504 ou
    estoura timeout, disfarçando bloqueio de cliente como portal fora do ar.
  * /v1/contratacoes/publicacao aceita no máximo 50 itens por página
    (diferente de /v1/contratos, que aceita 500). Não troque um pelo outro.
  * A janela de consulta não pode passar de 365 dias.
  * codigoModalidadeContratacao é obrigatório — varrer "todas" significa
    repetir a consulta por modalidade.

ATENÇÃO: este script ainda não foi validado contra a API ao vivo. Os nomes de
campo abaixo seguem o formato publicado pelo PNCP, mas a leitura é defensiva
(`_campo`) justamente porque a resposta varia entre registros. Rode uma vez com
--debug e confira a amostra antes de confiar no número.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from montar import montar  # noqa: E402

BASE = "https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao"
RAIZ = pathlib.Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "projetos" / "pncp" / "dados.json"

# Sem isto o PNCP bloqueia. Não é firula.
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

TAMANHO_PAGINA = 50          # teto deste endpoint
TIMEOUT = 120                # órgão grande devolve muita página
PAUSA = 0.4                  # gentileza com a API
TENTATIVAS = 3

MODALIDADES = {
    6: "Pregão Eletrônico",
    8: "Dispensa",
    9: "Inexigibilidade",
    4: "Concorrência Eletrônica",
}

# Categoria oficial de TIC no PNCP (categoria do processo).
CATEGORIA_TIC = 3

PALAVRAS_TIC = (
    "tic", "informática", "informatica", "tecnologia da informação",
    "tecnologia da informacao", "software", "hardware", "licença de uso",
    "licenca de uso", "servidor de rede", "switch", "roteador", "firewall",
    "storage", "datacenter", "data center", "nobreak", "computador",
    "notebook", "estação de trabalho", "estacao de trabalho", "microcomputador",
    "backup", "nuvem", "cloud", "banco de dados", "service desk",
    "central de serviços", "central de servicos", "suporte técnico",
    "suporte tecnico", "cabeamento estruturado", "telefonia ip", "voip",
    "antivírus", "antivirus", "cibersegurança", "ciberseguranca",
    "segurança da informação", "seguranca da informacao", "link de dados",
    "internet", "monitoramento de infraestrutura", "desenvolvimento de sistemas",
)


def _campo(d: dict, *caminhos, padrao=None):
    """Lê o primeiro caminho que existir. A resposta do PNCP não é uniforme."""
    for caminho in caminhos:
        atual = d
        for parte in caminho.split("."):
            if not isinstance(atual, dict) or parte not in atual:
                atual = None
                break
            atual = atual[parte]
        if atual not in (None, ""):
            return atual
    return padrao


def buscar(params: dict, debug: bool = False) -> dict:
    url = BASE + "?" + urllib.parse.urlencode(params)
    ultimo = None
    for tentativa in range(1, TENTATIVAS + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Accept-Language": "pt-BR,pt;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 204:                     # sem conteúdo nesta página
                return {"data": [], "totalPaginas": 0}
            ultimo = f"HTTP {e.code}"
        except Exception as e:                    # noqa: BLE001
            ultimo = f"{type(e).__name__}: {e}"
        if debug:
            print(f"  tentativa {tentativa}/{TENTATIVAS} falhou — {ultimo}", file=sys.stderr)
        time.sleep(2 * tentativa)
    raise RuntimeError(f"falha ao consultar o PNCP ({ultimo}) — url: {url}")


def link_pncp(numero_controle: str) -> str:
    """'CNPJ-1-000123/2026' -> URL do edital no portal."""
    try:
        cnpj, _, resto = numero_controle.split("-", 2)
        sequencial, ano = resto.split("/")
        return f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{int(sequencial)}"
    except Exception:  # noqa: BLE001
        return ""


def eh_tic(item: dict) -> str | None:
    """Devolve a origem da classificação ('categoria'/'palavra-chave') ou None."""
    categoria = _campo(item, "codigoCategoriaProcesso", "categoriaProcesso.id",
                       "categoriaProcesso")
    try:
        if int(categoria) == CATEGORIA_TIC:
            return "categoria"
    except (TypeError, ValueError):
        pass

    objeto = str(_campo(item, "objetoCompra", "objeto", padrao="")).lower()
    if any(p in objeto for p in PALAVRAS_TIC):
        return "palavra-chave"
    return None


def normalizar(item: dict, origem: str, nome_modalidade: str) -> dict:
    numero = str(_campo(item, "numeroControlePNCP", padrao=""))
    publicacao = str(_campo(item, "dataPublicacaoPncp", "dataInclusao", padrao=""))[:10]
    return {
        "data": publicacao,
        "orgao": _campo(item, "orgaoEntidade.razaoSocial",
                        "orgaoEntidade.razaosocial", padrao="(não informado)"),
        "cnpj": _campo(item, "orgaoEntidade.cnpj", padrao=""),
        "uf": _campo(item, "unidadeOrgao.ufSigla", "unidadeOrgao.uf", padrao=""),
        "objeto": _campo(item, "objetoCompra", "objeto", padrao=""),
        "modalidade": _campo(item, "modalidadeNome", padrao=nome_modalidade),
        "valor": float(_campo(item, "valorTotalEstimado", padrao=0) or 0),
        "link": link_pncp(numero),
        "origem": origem,
    }


def coletar(inicio: date, fim: date, uf: str | None, debug: bool) -> list[dict]:
    achados: list[dict] = []
    vistos: set[str] = set()

    for codigo, nome in MODALIDADES.items():
        pagina, total_paginas = 1, 1
        while pagina <= total_paginas:
            params = {
                "dataInicial": inicio.strftime("%Y%m%d"),
                "dataFinal": fim.strftime("%Y%m%d"),
                "codigoModalidadeContratacao": codigo,
                "pagina": pagina,
                "tamanhoPagina": TAMANHO_PAGINA,
            }
            if uf:
                params["uf"] = uf

            resposta = buscar(params, debug)
            itens = resposta.get("data") or []
            total_paginas = int(resposta.get("totalPaginas") or 0) or 1

            for item in itens:
                origem = eh_tic(item)
                if not origem:
                    continue
                registro = normalizar(item, origem, nome)
                chave = str(_campo(item, "numeroControlePNCP", padrao="")) or \
                    registro["data"] + registro["objeto"][:60]
                if chave in vistos or not registro["data"]:
                    continue
                vistos.add(chave)
                achados.append(registro)

            if debug:
                print(f"  {nome}: página {pagina}/{total_paginas} "
                      f"({len(itens)} itens, {len(achados)} TIC acumulados)", file=sys.stderr)

            pagina += 1
            time.sleep(PAUSA)

    return achados


def main() -> int:
    ap = argparse.ArgumentParser(description="Coleta contratações de TIC no PNCP.")
    ap.add_argument("--dias", type=int, default=90, help="tamanho da janela (máx. 365)")
    ap.add_argument("--uf", default="DF", help="sigla da UF ou 'todas'")
    ap.add_argument("--debug", action="store_true", help="log de paginação no stderr")
    args = ap.parse_args()

    if not 1 <= args.dias <= 365:
        print("erro: --dias deve ficar entre 1 e 365 (limite da API).", file=sys.stderr)
        return 2

    fim = date.today()
    inicio = fim - timedelta(days=args.dias)
    uf = None if args.uf.lower() == "todas" else args.uf.upper()

    print(f"coletando {inicio} → {fim}" + (f" (UF {uf})" if uf else " (todas as UFs)"))
    registros = coletar(inicio, fim, uf, args.debug)
    if not registros:
        print("nenhuma contratação de TIC encontrada — arquivo NÃO reescrito.", file=sys.stderr)
        return 1

    dados = montar(
        registros,
        cobertura={
            "inicio": inicio.isoformat(),
            "fim": fim.isoformat(),
            "ufs": [uf] if uf else ["todas"],
            "esfera": "todas as esferas",
            "modalidades": list(MODALIDADES.values()),
            "criterio_tic": "categoria oficial de TIC + resgate por palavra-chave no objeto",
            "fonte": "Portal Nacional de Contratações Públicas (dados abertos)",
        },
        gerado_em=datetime.now(timezone(timedelta(hours=-3))).isoformat(timespec="seconds"),
        exemplo=False,
    )

    SAIDA.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{SAIDA}: {len(dados['registros'])} contratações de TIC")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
