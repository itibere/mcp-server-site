#!/usr/bin/env python3
"""
Coletor via /api/search/ (Elasticsearch por tras do site do PNCP) - muito
mais rapido e confiavel que /v1/contratos:
  - filtra de verdade por uf/esfera no servidor
  - full-text OR real via `q=`
  - devolve data_fim_vigencia direto no registro, sem escanear historico

Escopo: contratos de TIC (palavra-chave no objeto), esfera federal, UF DF,
vencendo nos proximos N meses, com componente de servico no objeto (texto).
"""
import argparse
import json
import sys
import time
import unicodedata
from datetime import date, timedelta
from pathlib import Path

import requests

ESFERAS = {"F": "Federal", "E": "Estadual", "M": "Municipal", "D": "Distrital"}

BASE = "https://pncp.gov.br/api/search/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

PALAVRAS_TIC = (
    # Lista original (27 termos). "tic" sozinho tinha sido removido por medo
    # de bater como substring dentro de "logistico"/"artistico"/"participacao"
    # - mas o teste real mostrou que a API faz casamento por TOKEN (palavra
    # inteira), nao substring: tirar "tic" NAO mudou o total de candidatos,
    # provando que o falso positivo vinha de outro termo (frase sem aspas
    # virando palavra solta), nao de "tic". Re-adicionado - "TIC" e sigla
    # real e comum em objeto de contrato brasileiro ("aquisicao de bens de
    # TIC", "servicos de TIC"), com casamento seguro agora que tudo vai
    # entre aspas (frase exata, nao token solto).
    "tic", "informatica", "tecnologia da informacao", "software", "hardware",
    "licenca de uso", "servidor de rede", "switch", "roteador", "firewall",
    "storage", "datacenter", "nobreak", "notebook", "backup", "nuvem", "cloud",
    "banco de dados", "service desk", "suporte tecnico", "cabeamento estruturado",
    "telefonia ip", "voip", "antivirus", "ciberseguranca", "seguranca da informacao",
    "link de dados", "desenvolvimento de sistemas",

    # Adicionados apos revisao de cobertura (2026-08-28): termos comuns em
    # objeto de contrato de TIC que a lista original nao pegava. Evitados de
    # proposito: siglas curtas ambiguas ("IA", "BI", "TI" sozinho) que
    # colidem com palavras comuns em portugues, e termos genericos demais
    # ("sistema", "rede", "dados", "digital", "plataforma" sozinhos) que já
    # se provaram fonte de falso positivo quando soltos.
    "aplicativo", "plataforma digital", "inteligencia artificial",
    "automacao de processos", "business intelligence",
    "gestao eletronica de documentos", "blockchain", "criptografia",
    "certificacao digital", "assinatura digital", "computador",
    "microcomputador", "estacao de trabalho", "monitoramento de infraestrutura",
    "internet", "wi-fi", "rede sem fio", "videoconferencia", "biometria",
    "reconhecimento facial", "digitalizacao de documentos", "data center",
    "solucao de ti", "transformacao digital", "internet das coisas",
    "aprendizado de maquina", "big data",
)

UF = "DF"
ESFERA = "F"
# Janela de 6 a 12 meses a partir de hoje - nao 0 a 6. Um contrato vencendo
# amanha nao da tempo de preparar nada; o interessante estrategicamente e o
# que vence daqui a 6-12 meses, quando ainda da pra montar documentacao e
# se posicionar pra proxima licitacao do orgao antes do prazo apertar.
MESES_JANELA_INICIO = 6
MESES_JANELA_FIM = 12
TAM_PAGINA = 1000


def buscar_pagina(q, pagina, session, tentativas=4):
    params = {
        "tipos_documento": "contrato",
        "status": "todos",
        "ufs": UF,
        "esferas": ESFERA,
        "q": q,
        "pagina": pagina,
        "tam_pagina": TAM_PAGINA,
    }
    ultimo = None
    for t in range(1, tentativas + 1):
        try:
            r = session.get(BASE, params=params, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=60)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            ultimo = e
            print(f"  tentativa {t}/{tentativas} falhou ({e}); recuando {3*t}s", file=sys.stderr)
            time.sleep(3 * t)
    raise ultimo


def eh_servico(objeto: str) -> bool:
    return "serviç" in (objeto or "").lower() or "servico" in (objeto or "").lower()


def slug(nome: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode("ascii")
    return "_".join(sem_acento.lower().split())


def main():
    global UF, ESFERA

    parser = argparse.ArgumentParser(description="Coleta candidatos TIC via /api/search/ do PNCP.")
    parser.add_argument("--uf", default="DF", help="sigla da UF (default: DF)")
    parser.add_argument("--esfera", default="F", choices=sorted(ESFERAS), help="F/E/M/D (default: F, Federal)")
    parser.add_argument("--municipio", default=None, help="filtra so este municipio (nome exato, ex: Belem) - so faz sentido com --esfera M")
    args = parser.parse_args()
    UF = args.uf.upper()
    ESFERA = args.esfera.upper()
    municipio = args.municipio
    esfera_nome = ESFERAS[ESFERA]
    sufixo_municipio = f"_{slug(municipio)}" if municipio else ""
    out_json = Path(__file__).parent / f"resultado_tic_{UF.lower()}_{esfera_nome.lower()}{sufixo_municipio}.json"

    # Cada termo entre aspas: sem isso, uma frase de varias palavras (ex.:
    # "desenvolvimento de sistemas") vira palavras soltas ORadas entre si no
    # parser da busca - "sistema" sozinho bate em QUALQUER contrato que
    # mencione qualquer tipo de sistema, gerando falso positivo massivo
    # (foi assim que "participacao em curso sobre SISTEMA de diarias" entrou).
    q = " OR ".join(f'"{p}"' for p in PALAVRAS_TIC)
    hoje = date.today()
    janela_inicio = hoje + timedelta(days=MESES_JANELA_INICIO * 30)
    janela_fim = hoje + timedelta(days=MESES_JANELA_FIM * 30)

    session = requests.Session()
    todos = []
    pagina = 1
    total = None

    while True:
        payload = buscar_pagina(q, pagina, session)
        if total is None:
            total = payload.get("total", 0)
            print(f"total de candidatos TIC ({UF}, {esfera_nome.lower()}): {total}")
        itens = payload.get("items", [])
        if not itens:
            break
        todos.extend(itens)
        print(f"pagina {pagina}: +{len(itens)} (acumulado {len(todos)}/{total})")
        if len(todos) >= total:
            break
        pagina += 1
        time.sleep(0.3)

    print(f"\ntotal bruto coletado: {len(todos)}")

    if municipio:
        alvo_slug = slug(municipio)
        antes = len(todos)
        todos = [it for it in todos if slug(it.get("municipio_nome") or "") == alvo_slug]
        total = len(todos)
        print(f"filtrado para municipio '{municipio}': {len(todos)} de {antes} (UF inteira)")

    vencendo = []
    for it in todos:
        vig = it.get("data_fim_vigencia")
        if not vig:
            continue
        try:
            v = date.fromisoformat(vig[:10])
        except ValueError:
            continue
        if not (janela_inicio <= v <= janela_fim):
            continue
        if it.get("cancelado"):
            continue
        vencendo.append(it)

    servicos = [it for it in vencendo if eh_servico(it.get("description", ""))]

    print(f"vencendo entre {MESES_JANELA_INICIO} e {MESES_JANELA_FIM} meses: {len(vencendo)}")
    print(f"  dos quais classificados como servico (texto): {len(servicos)}")

    def linha(it):
        return {
            "orgao": it.get("orgao_nome"),
            "orgao_cnpj": it.get("orgao_cnpj"),
            "vence_em": it.get("data_fim_vigencia"),
            "valor_global": it.get("valor_global"),
            "objeto": (it.get("description") or "").strip(),
            "eh_servico_texto": eh_servico(it.get("description", "")),
            "modalidade": it.get("modalidade_licitacao_nome"),
            "numero_controle_pncp": it.get("numero_controle_pncp"),
            "link": "https://pncp.gov.br/app" + it.get("item_url", ""),
        }

    resultado = {
        "geradoEm": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "escopo": {
            "uf": UF, "esfera": esfera_nome, "municipio": municipio, "criterioTIC": "palavra-chave no objeto (busca full-text OR)",
            "mesesJanelaInicio": MESES_JANELA_INICIO, "mesesJanelaFim": MESES_JANELA_FIM,
            "janelaVencimento": f"{janela_inicio.isoformat()} a {janela_fim.isoformat()}",
            "fonte": "https://pncp.gov.br/api/search/",
        },
        "totalCandidatosTIC": total,
        "totalVencendoJanela": len(vencendo),
        "totalServicos": len(servicos),
        "contratos": [linha(it) for it in sorted(vencendo, key=lambda x: x.get("data_fim_vigencia") or "")],
    }
    out_json.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\ngravado em {out_json}")


if __name__ == "__main__":
    main()
