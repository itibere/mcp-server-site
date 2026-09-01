#!/usr/bin/env python3
"""
Catalogo de orgaos do PNCP.

A API de consulta do PNCP nao expoe uma lista de orgaos. O unico jeito
de descobrir quais orgaos publicam num territorio e varrer as
contratacoes publicadas e coletar os orgaos distintos que aparecem.

Isso e viavel porque /v1/contratacoes/publicacao aceita o parametro
"uf" server-side - diferente de /v1/contratos, que so aceita cnpjOrgao.
Entao da para varrer apenas DF e SP em vez do pais inteiro.

O catalogo resultante e melhor que uma lista oficial externa para este
uso: um CNPJ que consta no SIORG mas nunca publicou no PNCP e inutil
numa busca sobre o PNCP. Aqui, todo orgao listado comprovadamente
publica - e o campo "contratacoes" mostra o quanto.
"""

import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from pncp_monitor import PncpError, _get, log

# A modalidade e obrigatoria em /v1/contratacoes/publicacao, e nao ha
# valor "todas". Para nao perder orgao que so usa uma modalidade
# incomum, varremos a faixa inteira de codigos. Codigos inexistentes
# apenas devolvem vazio.
MODALIDADES = list(range(1, 15))

# O PNCP devolveu 429 ("limite de requisicoes excedido") com 0.3s entre
# chamadas. Nao ha limite documentado nem cabecalho Retry-After, entao
# o ritmo abaixo foi calibrado na marra: lento o bastante para a
# varredura terminar, em vez de rapido e derrubada no meio.
PAUSA_PAGINA = 1.0
PAUSA_MODALIDADE = 2.0

# Cadencia adaptativa. Se o PNCP estiver rejeitando por ritmo - e o 429
# ja observado sugere que rejeita -, insistir na mesma pagina nao ajuda:
# o que ajuda e desacelerar a varredura inteira. O multiplicador sobe a
# cada pagina que falha e decai quando volta a responder, entao a
# varredura acha sozinha um ritmo que o servidor aceita.
# Desistir apos 3 paginas seguidas matava a modalidade ANTES de a
# cadencia adaptativa ter efeito - foi assim que as modalidades 6 e 7
# cairam. Com backoff exponencial cada pagina falhada ja custa ~75s de
# espera real, entao 5 falhas sao ~6min de paciencia, nao teimosia.
FALHAS_PARA_DESISTIR = 5
RITMO_MAXIMO = 8.0
RITMO_SUBIDA = 2.0    # dobra a pausa a cada falha
RITMO_DESCIDA = 0.75  # recupera devagar: 4 sucessos para desfazer 1 falha

ESFERAS = {"F": "Federal", "E": "Estadual", "M": "Municipal", "D": "Distrital"}
PODERES = {"E": "Executivo", "L": "Legislativo", "J": "Judiciario"}

CACHE = Path(__file__).parent / "catalogo_orgaos.json"

# Checkpoint. A varredura completa leva ~1h e antes so gravava no fim:
# qualquer reinicio do servidor MCP no minuto 59 zerava tudo. Aconteceu
# duas vezes. Agora cada modalidade concluida e persistida aqui, e uma
# nova execucao com a mesma assinatura (ufs/janela/modalidades) retoma
# de onde parou em vez de recomecar.
PARCIAL = Path(__file__).parent / "catalogo_parcial.json"


def _assinatura(ufs, data_inicial, data_final, modalidades):
    return {
        "ufs": list(ufs),
        "janela": f"{data_inicial} a {data_final}",
        "modalidades": list(modalidades),
    }


def _carregar_parcial(assinatura):
    """Devolve (orgaos, feitos, lidas) do checkpoint, se ele casar."""
    if not PARCIAL.exists():
        return {}, set(), 0, None
    try:
        d = json.loads(PARCIAL.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        log.warning("Checkpoint ilegivel (%s). Ignorando.", e)
        return {}, set(), 0, None
    if d.get("assinatura") != assinatura:
        log.info("Checkpoint de outra varredura. Ignorando.")
        return {}, set(), 0, None
    feitos = {tuple(par) for par in d.get("feitos", [])}
    etapa = d.get("etapa")
    if etapa:
        log.info(
            "Checkpoint: %d modalidades concluidas + %s/mod%s na pagina %s.",
            len(feitos), etapa.get("uf"), etapa.get("modalidade"),
            etapa.get("proxima_pagina"),
        )
    else:
        log.info("Checkpoint encontrado: %d etapas ja concluidas.", len(feitos))
    return d.get("orgaos", {}), feitos, d.get("contratacoes_lidas", 0), etapa


def _janela_do_checkpoint(ufs, modalidades):
    """
    Janela de um checkpoint aberto das mesmas ufs/modalidades.

    A janela sai de datetime.now(): retomar no dia seguinte geraria uma
    assinatura diferente e faria _carregar_parcial descartar o
    checkpoint inteiro - perdendo horas de varredura sem avisar. Entao,
    ao retomar, continuamos a janela original em vez de recalcular.
    """
    if not PARCIAL.exists():
        return None
    try:
        a = json.loads(PARCIAL.read_text(encoding="utf-8")).get("assinatura") or {}
    except (ValueError, OSError):
        return None
    if list(a.get("ufs") or []) != list(ufs):
        return None
    if list(a.get("modalidades") or []) != list(modalidades):
        return None
    return a.get("janela")


def _salvar_parcial(assinatura, orgaos, feitos, lidas, etapa=None):
    """
    etapa: {"uf":..,"modalidade":..,"proxima_pagina":N} da modalidade em
    andamento. Gravar so no fim de cada modalidade nao bastava: o pregao
    sozinho tem ~134 paginas e leva ~50min, entao uma queda no meio dele
    ainda custava a modalidade inteira. Agora cada pagina e um ponto de
    retomada.
    """
    tmp = PARCIAL.with_suffix(".tmp")
    payload = {
        "assinatura": assinatura,
        "salvoEm": datetime.now().isoformat(timespec="seconds"),
        "feitos": sorted([list(par) for par in feitos]),
        "etapa": etapa,
        "contratacoes_lidas": lidas,
        "orgaos": orgaos,
    }
    # grava em tmp e troca: queda no meio da escrita nao corrompe o
    # checkpoint anterior.
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PARCIAL)

# Estado do job em background. O cliente MCP corta chamadas em 60s, e
# uma varredura de 12 meses em duas UFs leva muito mais que isso, entao
# a varredura roda numa thread e o progresso e consultado a parte.
_JOB = {
    "status": "ocioso",
    "iniciado_em": None,
    "terminado_em": None,
    "etapa": None,
    "passos_feitos": 0,
    "passos_totais": 0,
    "orgaos_encontrados": 0,
    "contratacoes_lidas": 0,
    "erros": [],
}
_LOCK = threading.Lock()


def _registrar(orgaos, contratacao):
    """Acumula um orgao a partir de uma contratacao, sem duplicar."""
    oe = contratacao.get("orgaoEntidade") or {}
    uo = contratacao.get("unidadeOrgao") or {}
    cnpj = (oe.get("cnpj") or "").strip()
    if not cnpj:
        return

    rec = orgaos.get(cnpj)
    if rec is None:
        rec = {
            "cnpj": cnpj,
            "razaoSocial": oe.get("razaoSocial"),
            "esferaId": oe.get("esferaId"),
            "esfera": ESFERAS.get(oe.get("esferaId"), oe.get("esferaId")),
            "poderId": oe.get("poderId"),
            "poder": PODERES.get(oe.get("poderId"), oe.get("poderId")),
            "ufs": [],
            "municipios": [],
            "unidades": [],
            "contratacoes": 0,
        }
        orgaos[cnpj] = rec

    rec["contratacoes"] += 1
    for campo, valor in (
        ("ufs", uo.get("ufSigla")),
        ("municipios", uo.get("municipioNome")),
        ("unidades", uo.get("nomeUnidade")),
    ):
        if valor and valor not in rec[campo]:
            # Um orgao grande tem dezenas de unidades; guardar todas
            # incha o catalogo sem ajudar na decisao. 15 basta para
            # reconhecer o orgao.
            if len(rec[campo]) < 15:
                rec[campo].append(valor)


def _fatias_mensais(data_inicial, data_final):
    """
    Quebra a janela em fatias de ate 30 dias.

    Medido: modalidade 8 do DF em 360 dias devolve Read timed out; a MESMA
    modalidade em 25 dias devolve 200 com 510 registros na hora. O gargalo
    e o custo da consulta no banco do PNCP - janela larga com OFFSET alto
    estoura o timeout do gateway. Fatiar deixa cada consulta barata, com
    poucas paginas e offset pequeno.
    """
    ini = datetime.strptime(data_inicial, "%Y%m%d")
    fim = datetime.strptime(data_final, "%Y%m%d")
    fatias = []
    cursor = ini
    while cursor <= fim:
        proximo = min(cursor + timedelta(days=29), fim)
        fatias.append((cursor.strftime("%Y%m%d"), proximo.strftime("%Y%m%d")))
        cursor = proximo + timedelta(days=1)
    return fatias


def coletar_orgaos(ufs, data_inicial, data_final, modalidades=None, job=None):
    """
    Varre as contratacoes publicadas nas UFs pedidas e devolve o dict de
    orgaos distintos encontrados, indexado por CNPJ.

    A janela e percorrida em fatias mensais (ver _fatias_mensais): alem de
    caber no orcamento de consulta do PNCP, isso reduz o custo de uma
    falha - desistir de uma fatia perde um mes, nao a modalidade inteira.
    """
    modalidades = modalidades or MODALIDADES
    assinatura = _assinatura(ufs, data_inicial, data_final, modalidades)
    orgaos, feitos, lidas_antes, etapa_aberta = _carregar_parcial(assinatura)
    total_passos = len(ufs) * len(modalidades)
    passo = 0

    if job is not None and (feitos or etapa_aberta):
        with _LOCK:
            job["contratacoes_lidas"] = lidas_antes
            job["orgaos_encontrados"] = len(orgaos)
            job["retomado_de"] = len(feitos)

    def registrar_erro(msg):
        if job is not None:
            with _LOCK:
                job["erros"].append(msg)

    def checkpoint(uf, modalidade, fatia, prox_pagina):
        try:
            _salvar_parcial(
                assinatura, orgaos, feitos,
                job["contratacoes_lidas"] if job is not None else 0,
                etapa={
                    "uf": uf, "modalidade": modalidade,
                    "fatia": fatia, "proxima_pagina": prox_pagina,
                },
            )
        except OSError as e:
            log.warning("Falha ao gravar checkpoint: %s", e)

    for uf in ufs:
        for modalidade in modalidades:
            passo += 1
            if (uf, modalidade) in feitos:
                if job is not None:
                    with _LOCK:
                        job["passos_feitos"] = passo
                        job["passos_totais"] = total_passos
                continue
            if job is not None:
                with _LOCK:
                    job["etapa"] = f"{uf} / modalidade {modalidade}"
                    job["passos_feitos"] = passo
                    job["passos_totais"] = total_passos

            fatias = _fatias_mensais(data_inicial, data_final)
            fatia_ini, pagina_ini = 0, 1
            if (etapa_aberta
                    and etapa_aberta.get("uf") == uf
                    and etapa_aberta.get("modalidade") == modalidade):
                fatia_ini = int(etapa_aberta.get("fatia", 0))
                pagina_ini = int(etapa_aberta.get("proxima_pagina", 1))
                log.info("Retomando %s/mod%s fatia %d pagina %d.",
                         uf, modalidade, fatia_ini + 1, pagina_ini)
                etapa_aberta = None

            ritmo = 1.0
            # Trava: se NENHUMA fatia devolver pagina, a modalidade nao
            # pode ser carimbada como concluida. Sem isso, uma rodada numa
            # janela ruim marca a modalidade como feita e ela nunca mais e
            # tentada - foi assim que as modalidades 8 e 9 viraram buraco
            # permanente. Vazio de verdade e diferente de nao conseguiu ler.
            fatias_ok = 0
            fatias_tentadas = 0
            for idx in range(fatia_ini, len(fatias)):
                de, ate = fatias[idx]
                pagina = pagina_ini if idx == fatia_ini else 1
                falhas_seguidas = 0
                fatias_tentadas += 1
                leu_alguma = False

                while True:
                    params = {
                        "dataInicial": de,
                        "dataFinal": ate,
                        "codigoModalidadeContratacao": modalidade,
                        "uf": uf,
                        # /v1/contratacoes/publicacao rejeita 500 com
                        # "Tamanho de pagina invalido" (400). O teto aqui
                        # e 50, diferente de /v1/contratos, que aceita 500.
                        "tamanhoPagina": 50,
                        "pagina": pagina,
                    }
                    try:
                        # Em thread o teto de 60s do cliente MCP nao vale.
                        payload = _get("/v1/contratacoes/publicacao", params,
                                       max_retries=4, timeout=90)
                        falhas_seguidas = 0
                        ritmo = max(1.0, ritmo * RITMO_DESCIDA)
                    except PncpError as e:
                        falhas_seguidas += 1
                        ritmo = min(RITMO_MAXIMO, ritmo * RITMO_SUBIDA)
                        log.warning("%s/mod%s/fatia%d/pag%s falhou. Cadencia %.1fx.",
                                    uf, modalidade, idx + 1, pagina, ritmo)
                        registrar_erro(f"{uf}/mod{modalidade}/{de}-{ate}/pag{pagina}: {e}")
                        if falhas_seguidas >= FALHAS_PARA_DESISTIR:
                            registrar_erro(
                                f"{uf}/mod{modalidade}: desistindo da fatia "
                                f"{de}-{ate} apos {FALHAS_PARA_DESISTIR} paginas "
                                f"seguidas com falha (cobertura incompleta)."
                            )
                            break
                        pagina += 1
                        time.sleep(PAUSA_PAGINA * ritmo)
                        continue

                    if not payload:
                        # 204/sem conteudo: a API RESPONDEU que nao ha nada.
                        # Isso e cobertura valida, nao falha.
                        leu_alguma = True
                        break
                    lote = payload.get("data", []) if isinstance(payload, dict) else payload
                    if not lote:
                        leu_alguma = True
                        break

                    leu_alguma = True
                    for contratacao in lote:
                        _registrar(orgaos, contratacao)
                    if job is not None:
                        with _LOCK:
                            job["contratacoes_lidas"] += len(lote)
                            job["orgaos_encontrados"] = len(orgaos)

                    checkpoint(uf, modalidade, idx, pagina + 1)

                    if isinstance(payload, dict) and payload.get("paginasRestantes", 0) > 0:
                        pagina += 1
                        time.sleep(PAUSA_PAGINA * ritmo)
                    else:
                        break

                if leu_alguma:
                    fatias_ok += 1
                checkpoint(uf, modalidade, idx + 1, 1)

            if fatias_ok:
                feitos.add((uf, modalidade))
                if fatias_ok < fatias_tentadas:
                    registrar_erro(
                        f"{uf}/mod{modalidade}: concluida com cobertura parcial "
                        f"({fatias_ok} de {fatias_tentadas} fatias lidas)."
                    )
                checkpoint(uf, modalidade, 0, 1)
            else:
                # nenhuma fatia respondeu: NAO carimbar. Fica pendente para
                # a proxima tentativa, quando o PNCP estiver melhor.
                registrar_erro(
                    f"{uf}/mod{modalidade}: nenhuma das {fatias_tentadas} fatias "
                    f"respondeu - modalidade NAO marcada como concluida, "
                    f"sera tentada de novo."
                )
                log.warning("%s/mod%s: 0 de %d fatias lidas. Nao marcada.",
                            uf, modalidade, fatias_tentadas)
            time.sleep(PAUSA_MODALIDADE)

    return orgaos


def _mesclar(existentes, novos):
    """
    Funde o resultado de uma rodada parcial no catalogo ja existente.

    Sem isso, varrer so as modalidades 4 e 6 SOBRESCREVERIA o catalogo
    inteiro com o punhado de orgaos dessas duas - apagando o trabalho das
    outras doze. Orgao repetido fica com a maior contagem de
    contratacoes, e as listas de uf/municipio/unidade sao unidas.
    """
    saida = {c: dict(r) for c, r in existentes.items()}
    for cnpj, novo in novos.items():
        atual = saida.get(cnpj)
        if atual is None:
            saida[cnpj] = dict(novo)
            continue
        atual["contratacoes"] = max(
            atual.get("contratacoes", 0), novo.get("contratacoes", 0)
        )
        for campo in ("ufs", "municipios", "unidades"):
            juntos = list(atual.get(campo) or [])
            for v in (novo.get(campo) or []):
                if v not in juntos and len(juntos) < 15:
                    juntos.append(v)
            atual[campo] = juntos
        for campo in ("razaoSocial", "esferaId", "esfera", "poderId", "poder"):
            if not atual.get(campo) and novo.get(campo):
                atual[campo] = novo[campo]
    return saida


def _catalogo_existente():
    if not CACHE.exists():
        return {}
    try:
        d = json.loads(CACHE.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        log.warning("Catalogo existente ilegivel (%s). Sera substituido.", e)
        return {}
    return {o["cnpj"]: o for o in d.get("orgaos", []) if o.get("cnpj")}


def _worker(ufs, data_inicial, data_final, modalidades):
    try:
        orgaos = coletar_orgaos(ufs, data_inicial, data_final, modalidades, job=_JOB)

        # Antes o merge so valia para rodada de subconjunto de modalidades.
        # Mas uma rodada COMPLETA com janela mais curta (ex.: 6 meses em vez
        # de 12) tambem acha MENOS orgaos - e sobrescrever apagaria os que
        # so aparecem na janela longa. Agora o padrao e somar: destruir
        # catalogo tem de ser escolha explicita, nao efeito colateral.
        antes = _catalogo_existente()
        parcial = modalidades is not None and set(modalidades) != set(MODALIDADES)
        if antes:
            n_novos = len(orgaos)
            orgaos = _mesclar(antes, orgaos)
            log.info("Merge: %d existentes + %d da rodada -> %d orgaos.",
                     len(antes), n_novos, len(orgaos))

        payload = {
            "geradoEm": datetime.now().isoformat(timespec="seconds"),
            "janela": f"{data_inicial} a {data_final}",
            "ufs": ufs,
            "modalidades": sorted(modalidades or MODALIDADES),
            "parcialMesclada": bool(parcial),
            "mescladoComExistente": bool(antes),
            "totalOrgaos": len(orgaos),
            "orgaos": sorted(orgaos.values(), key=lambda o: -o.get("contratacoes", 0)),
        }
        CACHE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        PARCIAL.unlink(missing_ok=True)
        with _LOCK:
            _JOB["status"] = "concluido"
            _JOB["orgaos_encontrados"] = len(orgaos)
    except Exception as e:  # noqa: BLE001 - a thread nao pode morrer calada
        with _LOCK:
            _JOB["status"] = "erro"
            _JOB["erros"].append(f"fatal: {type(e).__name__}: {e}")
        log.exception("Varredura de catalogo falhou.")
    finally:
        with _LOCK:
            _JOB["terminado_em"] = datetime.now().isoformat(timespec="seconds")


def iniciar(ufs, meses=12, modalidades=None):
    """Dispara a varredura numa thread e retorna imediatamente."""
    with _LOCK:
        if _JOB["status"] == "rodando":
            return {"erro": "Ja existe uma varredura em andamento.", "job": dict(_JOB)}
        _JOB.update(
            status="rodando",
            iniciado_em=datetime.now().isoformat(timespec="seconds"),
            terminado_em=None,
            etapa="iniciando",
            passos_feitos=0,
            passos_totais=0,
            orgaos_encontrados=0,
            contratacoes_lidas=0,
            erros=[],
        )

    hoje = datetime.now()
    # A API rejeita janelas acima de 365 dias.
    dias = min(meses * 30, 364)
    data_inicial = (hoje - timedelta(days=dias)).strftime("%Y%m%d")
    data_final = hoje.strftime("%Y%m%d")

    janela_aberta = _janela_do_checkpoint(ufs, modalidades or MODALIDADES)
    if janela_aberta and janela_aberta != f"{data_inicial} a {data_final}":
        log.info("Checkpoint aberto em outra data: continuando a janela %s.", janela_aberta)
        data_inicial, _, data_final = janela_aberta.partition(" a ")
        data_inicial, data_final = data_inicial.strip(), data_final.strip()

    t = threading.Thread(
        target=_worker,
        args=(ufs, data_inicial, data_final, modalidades),
        daemon=True,
    )
    t.start()
    return {
        "status": "rodando",
        "ufs": ufs,
        "janela": f"{data_inicial} a {data_final}",
        "aviso": "Use catalogo_status para acompanhar. Pode levar varios minutos.",
    }


def status():
    with _LOCK:
        return dict(_JOB)


def carregar():
    if not CACHE.exists():
        return None
    return json.loads(CACHE.read_text(encoding="utf-8"))
