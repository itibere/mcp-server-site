#!/usr/bin/env python3
"""
Varredura de contratos de TIC vencendo, sobre uma lista de CNPJs.

Por que em background: /v1/contratos so filtra por cnpjOrgao, e cada
orgao exige varias chamadas para cobrir o historico de publicacao. Uma
lista de 140 orgaos esta ordens de grandeza acima do limite de 60s por
chamada do cliente MCP.

ESTRATEGIA - largura antes de profundidade
------------------------------------------
A primeira versao varria orgao por orgao em janelas de 1 ano, ate o
fim do historico. Resultado pratico: depois de 16 minutos, 1 de 140
orgaos e ZERO contratos lidos. Janela de 1 ano num orgao grande e o
mesmo tamanho de consulta que ja tinha derrubado o catalogo por
timeout e 503.

Agora:

1. O periodo e fatiado em blocos curtos (padrao 30 dias), do mais
   RECENTE para o mais antigo. Publicacao recente tem muito mais
   chance de gerar contrato ainda vigente vencendo na janela de
   alerta.
2. Cada orgao para assim que atinge `max_por_orgao` achados de TIC.
   Com teto 1, os 140 orgaos sao cobertos em poucas centenas de
   requisicoes em vez de milhares - o painel sai do zero rapido.
3. O que ja foi lido fica em varredura_parcial.json. A rodada
   seguinte sobe o teto (1 -> 3 -> 10) e retoma de onde parou, sem
   reler fatia nenhuma. E isso que torna o aprofundamento incremental
   barato.
4. Fatia que falha depois das retentativas e pulada e anotada, nao
   derruba o orgao. Antes, um 503 na Marinha custava a Marinha
   inteira.

O checkpoint e gravado a cada orgao concluido: queda do servidor MCP
no meio do caminho custa um orgao, nao a varredura.
"""

import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from pncp_monitor import (
    PncpError,
    buscar_contratos_por_orgao,
    classificar_contratos_por_vencimento,
    log,
)

PASTA = Path(__file__).parent
CACHE = PASTA / "varredura_tic.json"
PARCIAL = PASTA / "varredura_parcial.json"

# O PNCP devolve 429 sob rajada. Uma pausa entre orgaos evita derrubar
# a varredura inteira por excesso de velocidade.
PAUSA_ORGAO = 1.5

# Rodando numa thread, o limite de 60s do cliente MCP nao se aplica -
# mas folga demais tambem custa. Com 120s e 4 retentativas, UMA fatia
# recusada gastava ate 10 minutos antes de desistir; num dia em que o
# PNCP devolve 500 intermitente, isso sozinho derruba a vazao de 15
# fatias/min para 1. Como a fatia que falha e anotada e relida na
# rodada seguinte, falhar rapido custa menos que insistir devagar.
TIMEOUT_ORGAO = 45
RETENTATIVAS_FATIA = 2
TAMANHO_PAGINA = 200
DIAS_POR_FATIA = 30
# Desiste do orgao apos N fatias seguidas com falha, em vez de insistir nas
# 60+ fatias do historico inteiro. Um orgao com timeout sistematico (ex.:
# Exercito) travava a varredura inteira nele e nunca chegava no orgao 2.
FALHAS_SEGUIDAS_PARA_DESISTIR_ORGAO = 3

_JOB = {
    "status": "ocioso",
    "iniciado_em": None,
    "terminado_em": None,
    "orgao_atual": None,
    "orgaos_feitos": 0,
    "orgaos_totais": 0,
    "contratos_lidos": 0,
    "achados_tic": 0,
    "max_por_orgao": None,
    "orgaos_no_teto": 0,
    "fatias_lidas": 0,
    "fatias_falhas": 0,
    "erros": [],
    "cancelar": False,
}
_LOCK = threading.Lock()


def cancelar():
    """Pede o encerramento da varredura no proximo ponto seguro."""
    with _LOCK:
        if _JOB["status"] != "rodando":
            return {"aviso": f"Nada rodando (status atual: {_JOB['status']})."}
        _JOB["cancelar"] = True
    return {"ok": "Cancelamento pedido. O resultado parcial sera gravado."}


# --------------------------------------------------------------- checkpoint

def _assinatura(anos, incluir_empenhos, dias_por_fatia):
    """
    Identidade do trabalho acumulado. `meses_alerta` e `max_por_orgao`
    de proposito NAO entram: mudar a janela de alerta ou o teto de
    achados nao invalida as fatias ja lidas - e justamente o caso de
    aprofundar sem jogar fora o que ja custou requisicao.
    """
    return f"anos={anos}|empenhos={bool(incluir_empenhos)}|fatia={dias_por_fatia}"


def _carregar_parcial(assinatura):
    if not PARCIAL.exists():
        return {"assinatura": assinatura, "orgaos": {}, "contratos": {}}
    try:
        d = json.loads(PARCIAL.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        log.warning("Checkpoint da varredura ilegivel (%s); comecando limpo.", e)
        return {"assinatura": assinatura, "orgaos": {}, "contratos": {}}
    if d.get("assinatura") != assinatura:
        log.info("Checkpoint e de outro escopo (%s); comecando limpo.", d.get("assinatura"))
        return {"assinatura": assinatura, "orgaos": {}, "contratos": {}}
    d.setdefault("orgaos", {})
    d.setdefault("contratos", {})
    return d


def _salvar_parcial(estado):
    tmp = PARCIAL.with_suffix(".tmp")
    tmp.write_text(json.dumps(estado, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PARCIAL)


def _chave_contrato(item):
    return (
        item.get("numeroControlePNCP")
        or f"{item.get('cnpjOrgao', '')}|{item.get('numeroContrato', '')}|{item.get('objeto', '')[:60]}"
    )


# --------------------------------------------------------------- worker

def _worker(cnpjs, anos, meses_alerta, incluir_empenhos, teto_legal_meses,
            max_por_orgao, dias_por_fatia):
    hoje = datetime.now()
    inicio = (hoje - timedelta(days=anos * 365)).strftime("%Y%m%d")
    fim = hoje.strftime("%Y%m%d")

    assinatura = _assinatura(anos, incluir_empenhos, dias_por_fatia)
    estado = _carregar_parcial(assinatura)
    estado["assinatura"] = assinatura

    def achados_do(cnpj):
        return [c for c in estado["contratos"].values() if c.get("_cnpjOrgao") == cnpj]

    try:
        for idx, entrada in enumerate(cnpjs, start=1):
            if _JOB.get("cancelar"):
                with _LOCK:
                    _JOB["erros"].append(
                        f"Cancelado pelo usuario apos {idx - 1} de {len(cnpjs)} orgaos."
                    )
                break

            # Aceita "12345678000199" ou {"cnpj":..., "razaoSocial":...}
            if isinstance(entrada, dict):
                cnpj = "".join(ch for ch in (entrada.get("cnpj") or "") if ch.isdigit())
                rotulo = entrada.get("razaoSocial") or cnpj
            else:
                cnpj = "".join(ch for ch in str(entrada) if ch.isdigit())
                rotulo = cnpj

            with _LOCK:
                _JOB["orgao_atual"] = rotulo
                _JOB["orgaos_feitos"] = idx - 1
                _JOB["orgaos_totais"] = len(cnpjs)

            if len(cnpj) != 14:
                with _LOCK:
                    _JOB["erros"].append(f"{rotulo}: CNPJ com {len(cnpj)} digitos, ignorado.")
                continue

            reg = estado["orgaos"].setdefault(cnpj, {"nome": rotulo, "fatias": [], "falhas": []})
            reg["nome"] = rotulo
            ja_lidas = set(reg["fatias"])

            # Ja bateu o teto numa rodada anterior? Nada a fazer aqui.
            if max_por_orgao and len(achados_do(cnpj)) >= max_por_orgao:
                with _LOCK:
                    _JOB["orgaos_feitos"] = idx
                    _JOB["orgaos_no_teto"] += 1
                continue

            novos = {"n": 0}

            def ao_lote(lote, _cnpj=cnpj, _rotulo=rotulo, _reg=reg, _novos=novos):
                res = classificar_contratos_por_vencimento(
                    lote, meses_alerta=meses_alerta, meses_teto_legal=teto_legal_meses
                )
                for item in res["vencendo_em_breve"]:
                    if not item.get("ehTIC"):
                        continue
                    if item.get("ehNotaEmpenho") and not incluir_empenhos:
                        continue
                    item["_cnpjOrgao"] = _cnpj
                    item["_orgaoNome"] = _rotulo
                    estado["contratos"][_chave_contrato(item)] = item
                with _LOCK:
                    _JOB["contratos_lidos"] += len(lote)
                    _JOB["achados_tic"] = len(estado["contratos"])
                # o teto conta achados do orgao, nao do lote
                return bool(max_por_orgao) and len(achados_do(_cnpj)) >= max_por_orgao

            def ao_fatia(chave, lidos, _reg=reg):
                _reg["fatias"].append(chave)
                with _LOCK:
                    _JOB["fatias_lidas"] += 1

            def ao_erro(chave, exc, _reg=reg, _rotulo=rotulo):
                _reg["falhas"].append(chave)
                with _LOCK:
                    _JOB["fatias_falhas"] += 1
                    if len(_JOB["erros"]) < 200:
                        _JOB["erros"].append(f"{_rotulo} [{chave}]: {exc}")

            try:
                buscar_contratos_por_orgao(
                    cnpj,
                    inicio,
                    fim,
                    tamanho_pagina=TAMANHO_PAGINA,
                    timeout=TIMEOUT_ORGAO,
                    max_retries=RETENTATIVAS_FATIA,
                    parar=lambda: _JOB.get("cancelar", False),
                    dias_por_fatia=dias_por_fatia,
                    recente_primeiro=True,
                    pular_fatias=ja_lidas,
                    ao_lote=ao_lote,
                    ao_fatia=ao_fatia,
                    ao_erro=ao_erro,
                    desistir_apos_falhas=FALHAS_SEGUIDAS_PARA_DESISTIR_ORGAO,
                )
            except PncpError as e:
                with _LOCK:
                    _JOB["erros"].append(f"{rotulo}: {e}")

            # checkpoint por orgao: queda aqui custa um orgao, nao a varredura
            _salvar_parcial(estado)
            _gravar_resultado(estado, meses_alerta, incluir_empenhos,
                              inicio, fim, len(cnpjs), max_por_orgao)

            with _LOCK:
                _JOB["orgaos_feitos"] = idx
                if max_por_orgao and len(achados_do(cnpj)) >= max_por_orgao:
                    _JOB["orgaos_no_teto"] += 1

            time.sleep(PAUSA_ORGAO)

        _salvar_parcial(estado)
        _gravar_resultado(estado, meses_alerta, incluir_empenhos,
                          inicio, fim, len(cnpjs), max_por_orgao)
        with _LOCK:
            _JOB["status"] = "concluido"
    except Exception as e:  # noqa: BLE001
        try:
            _salvar_parcial(estado)
        except Exception:  # noqa: BLE001
            pass
        with _LOCK:
            _JOB["status"] = "erro"
            _JOB["erros"].append(f"fatal: {type(e).__name__}: {e}")
        log.exception("Varredura de TIC falhou.")
    finally:
        with _LOCK:
            _JOB["terminado_em"] = datetime.now().isoformat(timespec="seconds")


def _gravar_resultado(estado, meses_alerta, incluir_empenhos, inicio, fim,
                      orgaos, max_por_orgao):
    # O checkpoint e descartado quando o escopo muda (outro `anos`, outra
    # `dias_por_fatia`). Se a gravacao saisse so dele, essa troca apagaria
    # contratos que ja custaram requisicao. O arquivo de resultado e
    # cumulativo por numeroControlePNCP: rodada nova acrescenta e atualiza,
    # nunca encolhe.
    juntos = {}
    if CACHE.exists():
        try:
            for c in json.loads(CACHE.read_text(encoding="utf-8")).get("contratos", []):
                juntos[_chave_contrato(c)] = c
        except (ValueError, OSError) as e:
            log.warning("Resultado anterior ilegivel (%s); gravando so o desta rodada.", e)
    juntos.update(estado["contratos"])
    achados = sorted(juntos.values(), key=lambda x: x.get("diasRestantes", 99999))
    CACHE.write_text(
        json.dumps(
            {
                "geradoEm": datetime.now().isoformat(timespec="seconds"),
                "janelaPublicacao": f"{inicio} a {fim}",
                "mesesAlerta": meses_alerta,
                "incluiEmpenhos": incluir_empenhos,
                "maxPorOrgao": max_por_orgao,
                "orgaosVarridos": orgaos,
                "acumulado": True,
                "orgaosComAchado": len({c.get("_cnpjOrgao") for c in achados}),
                "total": len(achados),
                "contratos": achados,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def iniciar(cnpjs, anos=5, meses_alerta=12, incluir_empenhos=False,
            teto_legal_meses=60, max_por_orgao=1, dias_por_fatia=DIAS_POR_FATIA):
    with _LOCK:
        if _JOB["status"] == "rodando":
            return {"erro": "Ja existe uma varredura em andamento.", "job": dict(_JOB)}
        _JOB.update(
            status="rodando",
            iniciado_em=datetime.now().isoformat(timespec="seconds"),
            terminado_em=None,
            orgao_atual=None,
            orgaos_feitos=0,
            orgaos_totais=len(cnpjs),
            contratos_lidos=0,
            achados_tic=0,
            max_por_orgao=max_por_orgao,
            orgaos_no_teto=0,
            fatias_lidas=0,
            fatias_falhas=0,
            erros=[],
            cancelar=False,
        )

    t = threading.Thread(
        target=_worker,
        args=(cnpjs, anos, meses_alerta, incluir_empenhos, teto_legal_meses,
              max_por_orgao, dias_por_fatia),
        daemon=True,
    )
    t.start()
    fatias = max(1, (anos * 365) // max(1, dias_por_fatia))
    return {
        "status": "rodando",
        "orgaos": len(cnpjs),
        "anosHistorico": anos,
        "maxPorOrgao": max_por_orgao,
        "diasPorFatia": dias_por_fatia,
        "aviso": (
            f"Busca em largura: cada orgao para em {max_por_orgao} achado(s) de TIC. "
            f"Teto de {fatias} fatias por orgao, das mais recentes para as antigas; "
            "o que ja foi lido fica no checkpoint e nao e relido na proxima rodada. "
            "Acompanhe com varredura_status."
        ),
    }


def status():
    with _LOCK:
        return dict(_JOB)


def carregar():
    if not CACHE.exists():
        return None
    return json.loads(CACHE.read_text(encoding="utf-8"))


def progresso_checkpoint():
    """Quanto ja foi lido, para decidir o proximo teto."""
    if not PARCIAL.exists():
        return {"existe": False}
    d = json.loads(PARCIAL.read_text(encoding="utf-8"))
    orgaos = d.get("orgaos", {})
    return {
        "existe": True,
        "assinatura": d.get("assinatura"),
        "orgaosTocados": len(orgaos),
        "fatiasLidas": sum(len(o.get("fatias", [])) for o in orgaos.values()),
        "fatiasComFalha": sum(len(o.get("falhas", [])) for o in orgaos.values()),
        "contratos": len(d.get("contratos", {})),
    }
