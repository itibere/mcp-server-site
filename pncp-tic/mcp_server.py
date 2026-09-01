#!/usr/bin/env python3
"""
Servidor MCP - expoe a consulta de contratos do PNCP como tools que o
Claude pode chamar diretamente no chat (via Claude Desktop).

Reaproveita a logica ja validada em pncp_monitor.py (janela de 365
dias, teste de conectividade, classificacao de vencimento).

INSTALACAO
    pip install mcp requests

USO
    Configurar no claude_desktop_config.json (ver instrucoes enviadas
    junto). Depois disso, basta perguntar ao Claude, por exemplo:
    "quais contratos da DPGU (CNPJ 00375114000116) estao vencendo nos
    proximos 12 meses, e quais provavelmente precisam de nova
    licitacao em vez de renovacao?"
"""

import sys
from pathlib import Path

# Garante que o Python encontra pncp_monitor.py mesmo que este
# servidor seja iniciado a partir de outra pasta pelo Claude Desktop.
sys.path.insert(0, str(Path(__file__).parent))

# A partir da versao 2.0.0 do SDK (lancada em 28/07/2026), FastMCP foi
# renomeado para MCPServer e movido de modulo. A API dos decorators
# (@mcp.tool()) continua a mesma, entao o try/except abaixo cobre as
# duas versoes sem precisar saber qual esta instalada.
try:
    from mcp.server.fastmcp import FastMCP  # SDK < 2.0.0
except ModuleNotFoundError:
    from mcp.server.mcpserver import MCPServer as FastMCP  # SDK >= 2.0.0

from pncp_monitor import (
    PncpError,
    _get,
    buscar_contratos_por_orgao,
    classificar_contratos_por_vencimento,
    estimar_volume,
    saude_pncp as _saude_pncp,
    testar_conectividade,
    validar_data_yyyymmdd,
)
from datetime import datetime, timedelta

import catalogo
import varredura

mcp = FastMCP("pncp-monitor")


@mcp.tool()
def contratos_vencendo(
    cnpj: str,
    meses_alerta: int = 12,
    anos_historico: int = 5,
    teto_legal_meses: int = 60,
    data_inicial: str = None,
    data_final: str = None,
) -> dict:
    """
    Busca contratos publicados no PNCP para um orgao e retorna os que
    vencem dentro da janela de alerta, ja classificados como
    "provavel renovacao" ou "provavel nova licitacao".

    Args:
        cnpj: CNPJ do orgao, com ou sem pontuacao (ex.: "00375114000116"
              para a DPGU/DPU).
        meses_alerta: janela de alerta em meses para considerar um
              contrato como "vencendo em breve" (padrao: 12).
        anos_historico: quantos anos para tras buscar contratos
              publicados (padrao: 5). Aumentar se o orgao tiver
              contratos de longa duracao publicados ha mais tempo.
        data_inicial / data_final: janela de PUBLICACAO explicita em
              yyyyMMdd. Se informadas, substituem anos_historico. Cada
              chamada varre no maximo ~1 ano; janelas maiores estouram o
              limite de 60s do cliente MCP, entao para cobrir 5 anos
              chame esta tool uma vez por ano e junte os resultados.
        teto_legal_meses: teto de referencia em meses usado na
              heuristica de classificacao (padrao: 60 = 5 anos, regra
              geral do art. 105 da Lei 14.133/2021 para servicos
              continuos). A classificacao e uma TRIAGEM, nao uma
              conclusao juridica - sempre validar no processo
              administrativo original antes de decisao comercial.

    Returns:
        dict com tres listas: "vencendo_em_breve" (todos), "provavel_renovacao"
        e "provavel_nova_licitacao", cada item com orgao, objeto do contrato,
        fornecedor, valor, datas de vigencia e dias restantes.
    """
    cnpj_limpo = "".join(ch for ch in cnpj if ch.isdigit())
    if len(cnpj_limpo) != 14:
        return {"erro": f"CNPJ invalido: '{cnpj}' tem {len(cnpj_limpo)} digitos, esperado 14."}

    try:
        hoje = datetime.now()
        if data_inicial or data_final:
            if not (data_inicial and data_final):
                return {"erro": "Informe data_inicial e data_final juntas, ou nenhuma das duas."}
            ini = validar_data_yyyymmdd(data_inicial, "data_inicial")
            fim = validar_data_yyyymmdd(data_final, "data_final")
            if fim < ini:
                return {"erro": "data_final e anterior a data_inicial."}
            inicio_busca, fim_busca = data_inicial, data_final
        else:
            inicio_busca = (hoje - timedelta(days=anos_historico * 365)).strftime("%Y%m%d")
            fim_busca = hoje.strftime("%Y%m%d")

        # O teste de conectividade gasta ate 30s do orcamento de 60s do
        # cliente MCP. Quando a janela e curta (1 ano = 1 chamada), a
        # propria consulta ja revela qualquer problema de rede, entao o
        # teste so vale a pena em varreduras longas.
        janela_dias = (
            datetime.strptime(fim_busca, "%Y%m%d") - datetime.strptime(inicio_busca, "%Y%m%d")
        ).days
        if janela_dias > 366:
            testar_conectividade()

        contratos = buscar_contratos_por_orgao(cnpj_limpo, inicio_busca, fim_busca)
        resultado = classificar_contratos_por_vencimento(
            contratos, meses_alerta=meses_alerta, meses_teto_legal=teto_legal_meses
        )
        resultado["total_contratos_publicados_no_periodo"] = len(contratos)
        return resultado

    except PncpError as e:
        return {"erro": str(e)}


@mcp.tool()
def contratacoes_publicadas(
    data_inicial: str,
    data_final: str,
    codigo_modalidade: int,
    cnpj: str = None,
    uf: str = None,
) -> dict:
    """
    Busca contratacoes (editais/compras) publicadas no PNCP num
    periodo, opcionalmente filtrando por orgao e/ou UF. Use isto para
    verificar se ja existe processo aberto para um objeto especifico.

    Args:
        data_inicial: data no formato yyyyMMdd (ex.: "20260101").
        data_final: data no formato yyyyMMdd. A janela nao pode
              ultrapassar 365 dias (limite da API).
        codigo_modalidade: codigo da modalidade de contratacao
              (obrigatorio pela API). Alguns valores comuns: 6 = Pregao,
              8 = Dispensa, 4 = Concorrencia. Para varrer todas as
              modalidades, chame esta tool varias vezes com codigos
              diferentes.
        cnpj: CNPJ do orgao para filtrar (opcional, so digitos).
        uf: sigla da UF para filtrar (opcional, ex.: "DF").

    Returns:
        dict com a lista de contratacoes encontradas e o total de
        registros.
    """
    try:
        inicio = validar_data_yyyymmdd(data_inicial, "data_inicial")
        fim = validar_data_yyyymmdd(data_final, "data_final")
    except PncpError as e:
        return {"erro": str(e)}

    if fim < inicio:
        return {"erro": "data_final e anterior a data_inicial."}
    if (fim - inicio).days > 365:
        return {
            "erro": "A janela nao pode ultrapassar 365 dias (limite da API "
                    f"do PNCP). Pedido: {(fim - inicio).days} dias."
        }

    params = {
        "dataInicial": data_inicial,
        "dataFinal": data_final,
        "codigoModalidadeContratacao": codigo_modalidade,
        "pagina": 1,
        "tamanhoPagina": 50,
    }
    if cnpj:
        params["cnpj"] = "".join(ch for ch in cnpj if ch.isdigit())
    if uf:
        params["uf"] = uf

    try:
        # max_retries=2 e timeout=20 mantem o pior caso em ~43s, dentro
        # do limite de 60s do cliente MCP.
        payload = _get(
            "/v1/contratacoes/publicacao", params, max_retries=2, timeout=20
        )
        if not payload:
            return {"total": 0, "contratacoes": []}
        lote = payload.get("data", []) if isinstance(payload, dict) else payload
        return {
            "total": payload.get("totalRegistros", len(lote)) if isinstance(payload, dict) else len(lote),
            "contratacoes": [
                {
                    "orgao": (c.get("orgaoEntidade") or {}).get("razaoSocial"),
                    "objeto": c.get("objetoCompra"),
                    "modalidade": c.get("modalidadeNome"),
                    "situacao": c.get("situacaoCompraNome"),
                    "dataAberturaProposta": c.get("dataAberturaProposta"),
                    "dataEncerramentoProposta": c.get("dataEncerramentoProposta"),
                    "valorEstimado": c.get("valorTotalEstimado"),
                    "numeroControlePNCP": c.get("numeroControlePNCP"),
                }
                for c in lote
            ],
        }
    except PncpError as e:
        return {"erro": str(e)}


@mcp.tool()
def saude_pncp() -> dict:
    """
    Diagnostico por camadas do PNCP: DNS, TCP/443 e uma consulta LEVE.

    Use ANTES de afirmar que o portal esta fora. Timeout numa consulta
    pesada nao prova indisponibilidade - so prova que aquela consulta nao
    voltou. Esta tool separa "o host esta inacessivel" de "o servico esta
    de pe mas a consulta e cara demais".
    """
    return _saude_pncp()


@mcp.tool()
def sondar_volume(
    data_inicial: str,
    data_final: str,
    cnpj: str = None,
    incluir_amostra: bool = False,
) -> dict:
    """
    Sonda quantos contratos o PNCP publicou numa janela, sem baixar tudo.
    Use ANTES de disparar uma varredura ampla, para dimensionar o
    trabalho: a API nao filtra por esfera nem por categoria, entao uma
    busca sem CNPJ obriga a baixar todos os contratos do pais na janela
    para so depois separar os federais e os de TIC.

    Args:
        data_inicial / data_final: janela em yyyyMMdd, no maximo 365 dias.
        cnpj: CNPJ do orgao (opcional). Sem ele, sonda o pais inteiro.
        incluir_amostra: se True, devolve tambem os campos brutos de ate
              3 contratos, util para inspecionar categoriaProcesso e
              orgaoEntidade.esferaId numa resposta real.

    Returns:
        dict com totalRegistros, totalPaginas e (opcionalmente) a amostra.
    """
    try:
        ini = validar_data_yyyymmdd(data_inicial, "data_inicial")
        fim = validar_data_yyyymmdd(data_final, "data_final")
    except PncpError as e:
        return {"erro": str(e)}

    if fim < ini:
        return {"erro": "data_final e anterior a data_inicial."}
    if (fim - ini).days > 365:
        return {"erro": f"Janela de {(fim - ini).days} dias excede o limite de 365 da API."}

    cnpj_limpo = "".join(ch for ch in cnpj if ch.isdigit()) if cnpj else None

    try:
        r = estimar_volume(data_inicial, data_final, cnpj_orgao=cnpj_limpo)
    except PncpError as e:
        return {"erro": str(e)}

    saida = {
        "janela": f"{data_inicial} a {data_final}",
        "dias": (fim - ini).days + 1,
        "totalRegistros": r["totalRegistros"],
        "totalPaginas": r["totalPaginas"],
    }
    if incluir_amostra:
        saida["amostra"] = r["amostra"][:3]
    return saida


@mcp.tool()
def catalogo_iniciar(ufs: list = None, meses: int = 12,
                     modalidades: list = None) -> dict:
    """
    Dispara em background a montagem do catalogo de orgaos que publicam
    no PNCP nas UFs pedidas. Retorna na hora; acompanhe com
    catalogo_status e leia o resultado com catalogo_listar.

    Necessario porque a API nao tem endpoint de orgaos: o catalogo e
    derivado das contratacoes publicadas, usando o filtro de UF que
    /v1/contratacoes/publicacao aceita server-side.

    Args:
        ufs: lista de siglas (padrao: ["DF", "SP"]).
        meses: quantos meses para tras varrer (padrao 12, teto 12 pelo
              limite de 365 dias da API). Janela curta demais perde
              orgao que publica pouco.
        modalidades: lista de codigos a varrer (ex.: [4, 6]). Sem isso,
              varre as 14. Uma rodada parcial NAO sobrescreve o catalogo:
              o resultado e mesclado no que ja existe, entao da para
              remendar uma modalidade furada sem refazer a hora inteira.
    """
    ufs = [u.strip().upper() for u in (ufs or ["DF", "SP"]) if u and u.strip()]
    if not ufs:
        return {"erro": "Informe ao menos uma UF."}
    if meses < 1 or meses > 12:
        return {"erro": "meses deve estar entre 1 e 12 (limite de 365 dias da API)."}
    if modalidades is not None:
        try:
            modalidades = [int(m) for m in modalidades]
        except (TypeError, ValueError):
            return {"erro": "modalidades deve ser lista de inteiros (ex.: [4, 6])."}
        invalidas = [m for m in modalidades if m not in catalogo.MODALIDADES]
        if invalidas:
            return {"erro": f"modalidades invalidas: {invalidas}. "
                            f"Validas: {catalogo.MODALIDADES}."}
        if not modalidades:
            return {"erro": "Informe ao menos uma modalidade."}
    return catalogo.iniciar(ufs, meses=meses, modalidades=modalidades)


@mcp.tool()
def catalogo_status() -> dict:
    """
    Progresso da varredura de catalogo disparada por catalogo_iniciar:
    etapa atual, passos concluidos, orgaos encontrados ate agora e
    eventuais erros por modalidade.
    """
    return catalogo.status()


@mcp.tool()
def catalogo_listar(
    uf: str = None,
    esfera: str = None,
    poder: str = None,
    min_contratacoes: int = 1,
) -> dict:
    """
    Le o catalogo ja montado e devolve os orgaos filtrados, com CNPJ
    pronto para usar nas demais tools.

    Args:
        uf: sigla para filtrar (ex.: "DF"). Compara com as UFs das
              unidades administrativas do orgao.
        esfera: "F" federal, "E" estadual, "M" municipal, "D" distrital.
        poder: "E" executivo, "L" legislativo, "J" judiciario.
        min_contratacoes: descarta orgao com menos contratacoes que isso
              na janela varrida - util para cortar cadastro inativo.
    """
    dados = catalogo.carregar()
    if dados is None:
        return {"erro": "Catalogo ainda nao foi montado. Rode catalogo_iniciar primeiro."}

    orgaos = dados["orgaos"]
    if uf:
        alvo = uf.strip().upper()
        orgaos = [o for o in orgaos if alvo in (o.get("ufs") or [])]
    if esfera:
        orgaos = [o for o in orgaos if o.get("esferaId") == esfera.strip().upper()]
    if poder:
        orgaos = [o for o in orgaos if o.get("poderId") == poder.strip().upper()]
    orgaos = [o for o in orgaos if o.get("contratacoes", 0) >= min_contratacoes]

    return {
        "geradoEm": dados.get("geradoEm"),
        "janela": dados.get("janela"),
        "filtros": {"uf": uf, "esfera": esfera, "poder": poder,
                    "min_contratacoes": min_contratacoes},
        "total": len(orgaos),
        "orgaos": [
            {
                "cnpj": o["cnpj"],
                "razaoSocial": o["razaoSocial"],
                "esfera": o["esfera"],
                "poder": o["poder"],
                "ufs": o["ufs"],
                "contratacoes": o["contratacoes"],
            }
            for o in orgaos
        ],
    }


@mcp.tool()
def varredura_tic_iniciar(
    cnpjs: list = None,
    uf: str = None,
    esfera: str = None,
    anos: int = 5,
    meses_alerta: int = 12,
    incluir_empenhos: bool = False,
    min_contratacoes: int = 1,
    max_por_orgao: int = 1,
    dias_por_fatia: int = 30,
) -> dict:
    """
    Dispara em background a busca de contratos de TIC vencendo, sobre
    varios orgaos. Retorna na hora; acompanhe com varredura_status e
    leia o resultado com varredura_resultado.

    Informe cnpjs OU (uf + esfera) para puxar a lista do catalogo.

    Args:
        cnpjs: lista de CNPJs a varrer. Se omitida, usa o catalogo.
        uf / esfera: filtro do catalogo (ex.: uf="DF", esfera="F").
        anos: anos de historico de PUBLICACAO (padrao 5). Contratos de
              TIC costumam ter vigencia longa, entao encurtar isso perde
              justamente os contratos grandes.
        meses_alerta: janela de vencimento (padrao 12).
        incluir_empenhos: por padrao False. Notas de empenho vencem em
              31/12 por serem do exercicio fiscal, nao por serem
              contratos acabando - incluir infla o resultado.
        min_contratacoes: ao usar o catalogo, ignora orgao com menos
              contratacoes que isso na janela catalogada.
        max_por_orgao: teto de achados de TIC por orgao nesta rodada.
              1 (padrao) e busca em LARGURA: cobre os 140 orgaos em
              poucas centenas de requisicoes, em vez de esgotar a
              Marinha antes de chegar no segundo orgao. Rodar de novo
              com 3, depois 10, aprofunda sem reler nada - o que ja foi
              lido fica no checkpoint. 0 = sem teto (exaustivo).
        dias_por_fatia: tamanho de cada consulta a /v1/contratos, em
              dias. 30 e o que torna orgao grande viavel; 365 era o
              tamanho que estourava timeout e 503.
    """
    if not cnpjs:
        dados = catalogo.carregar()
        if dados is None:
            return {"erro": "Sem lista de CNPJs e sem catalogo. Rode catalogo_iniciar ou passe cnpjs."}
        orgaos = dados["orgaos"]
        if uf:
            orgaos = [o for o in orgaos if uf.strip().upper() in (o.get("ufs") or [])]
        if esfera:
            orgaos = [o for o in orgaos if o.get("esferaId") == esfera.strip().upper()]
        orgaos = [o for o in orgaos if o.get("contratacoes", 0) >= min_contratacoes]
        cnpjs = [{"cnpj": o["cnpj"], "razaoSocial": o["razaoSocial"]} for o in orgaos]

    if not cnpjs:
        return {"erro": "Nenhum orgao selecionado com esses filtros."}
    if anos < 1 or anos > 10:
        return {"erro": "anos deve estar entre 1 e 10."}

    if dias_por_fatia < 1 or dias_por_fatia > 365:
        return {"erro": "dias_por_fatia deve estar entre 1 e 365."}

    return varredura.iniciar(
        cnpjs,
        anos=anos,
        meses_alerta=meses_alerta,
        incluir_empenhos=incluir_empenhos,
        max_por_orgao=max(0, max_por_orgao),
        dias_por_fatia=dias_por_fatia,
    )


@mcp.tool()
def varredura_cancelar() -> dict:
    """
    Interrompe a varredura de TIC em andamento no proximo ponto seguro,
    gravando o resultado parcial. Util quando se percebe no meio que os
    parametros estavam errados - sem isso, so reiniciando o app.
    """
    return varredura.cancelar()


@mcp.tool()
def varredura_status() -> dict:
    """Progresso da varredura de TIC: orgao atual, quantos ja foram, achados e erros."""
    d = varredura.status()
    d["checkpoint"] = varredura.progresso_checkpoint()
    return d


@mcp.tool()
def varredura_resultado(
    limite: int = 50,
    apenas_categoria_oficial: bool = False,
    valor_minimo: float = 0,
) -> dict:
    """
    Le o resultado da varredura de TIC ja concluida.

    Args:
        limite: quantos contratos retornar, do mais proximo do
              vencimento para o mais distante (padrao 50).
        apenas_categoria_oficial: se True, devolve so o que o proprio
              orgao classificou como categoria 3 (Informatica/TIC),
              descartando o que foi resgatado por palavra-chave. Mais
              auditavel, porem perde contrato mal classificado.
        valor_minimo: descarta contratos com valorGlobal abaixo disso.
    """
    dados = varredura.carregar()
    if dados is None:
        return {"erro": "Nenhuma varredura concluida. Rode varredura_tic_iniciar."}

    contratos = dados["contratos"]
    if apenas_categoria_oficial:
        contratos = [c for c in contratos if c.get("origemTIC") == "categoria_oficial"]
    if valor_minimo:
        contratos = [c for c in contratos if (c.get("valorGlobal") or 0) >= valor_minimo]

    por_origem = {}
    for c in contratos:
        por_origem[c.get("origemTIC") or "?"] = por_origem.get(c.get("origemTIC") or "?", 0) + 1

    return {
        "geradoEm": dados.get("geradoEm"),
        "janelaPublicacao": dados.get("janelaPublicacao"),
        "orgaosVarridos": dados.get("orgaosVarridos"),
        "totalNoFiltro": len(contratos),
        "porOrigem": por_origem,
        "valorTotal": round(sum((c.get("valorGlobal") or 0) for c in contratos), 2),
        "contratos": contratos[:limite],
    }


if __name__ == "__main__":
    mcp.run()
