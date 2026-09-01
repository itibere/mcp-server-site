#!/usr/bin/env python3
"""
PNCP Monitor - coleta e classificacao de contratos de TIC proximos do
vencimento, via API publica de consulta do PNCP
(https://pncp.gov.br/api/consulta), sem necessidade de login/token.

USO RAPIDO
    python pncp_monitor.py --cnpj 00375114000116

Isso busca todos os contratos publicados nos ultimos 5 anos para o
orgao informado, filtra os que vencem nos proximos 12 meses e separa
"provavel renovacao" de "provavel nova licitacao".

Rode "python pncp_monitor.py --help" para ver todas as opcoes.

ATENCAO - o que este script NAO garante:
- Os nomes dos campos usados (dataVigenciaInicio, objetoContrato etc.)
  foram validados manualmente contra uma resposta real da API em
  agosto/2026. A API pode mudar; se o script comecar a falhar,
  confira o Swagger oficial:
  https://pncp.gov.br/api/consulta/swagger-ui/index.html
- A quantidade de aditivos/prorrogacoes ja usadas NAO e exposta de
  forma agregada pela API. A classificacao "provavel renovacao x
  provavel nova licitacao" e um indicador de TRIAGEM, nao uma
  conclusao juridica. Sempre validar contra o processo administrativo
  original do orgao antes de qualquer decisao comercial.

Regras gerais de referencia (ajustar conforme o objeto do contrato):
- Lei 14.133/2021, art. 105/106: servicos continuos, regra geral ate
  5 anos (60 meses), prorrogaveis; art. 107 permite ate 10 anos em
  hipoteses especificas (economia de escala, vantajosidade comprovada).
"""

import argparse
import logging
import re
import sys
import socket
import random
import time
import unicodedata
from datetime import datetime, timedelta

import requests

BASE_URL = "https://pncp.gov.br/api/consulta"
TIMEOUT = 30

# O WAF do PNCP derruba conexoes de clientes que nao parecem navegador:
# com o User-Agent padrao do requests ("python-requests/2.x") a resposta
# vem como RemoteDisconnected (conexao fechada sem resposta) ou 503
# intermitente, enquanto a mesma URL aberta no Chrome devolve JSON
# normalmente. Por isso todas as chamadas passam por esta Session com
# headers de navegador.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://pncp.gov.br/app/contratos",
    "Connection": "keep-alive",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def validar_data_yyyymmdd(valor, nome_campo):
    """
    Valida localmente uma data no formato yyyyMMdd. Sem isso, uma data
    malformada so era descoberta depois de 3 tentativas de rede - o que
    fazia a chamada pendurar por ~95s ate estourar o limite do cliente
    MCP, em vez de falhar na hora.
    """
    if not isinstance(valor, str) or len(valor) != 8 or not valor.isdigit():
        raise PncpError(
            f"{nome_campo} invalida: '{valor}'. Use o formato yyyyMMdd "
            "(ex.: 20260101)."
        )
    try:
        return datetime.strptime(valor, "%Y%m%d")
    except ValueError:
        raise PncpError(f"{nome_campo} invalida: '{valor}' nao e uma data real.")


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("pncp_monitor")


class PncpError(Exception):
    """Erro de comunicacao ou de dados vindo da API do PNCP."""


def testar_conectividade():
    """
    Faz uma chamada minima e conhecida (contratos de 1 dia, ano 2023)
    so para confirmar que a rede local alcanca a API antes de gastar
    tempo com a consulta de verdade. Levanta PncpError com uma
    mensagem clara se algo estiver bloqueando.
    """
    log.info("Testando conectividade com a API do PNCP...")
    try:
        resp = SESSION.get(
            f"{BASE_URL}/v1/contratos",
            params={"dataInicial": "20230102", "dataFinal": "20230102", "pagina": 1},
            timeout=TIMEOUT,
        )
    except requests.exceptions.ConnectionError as e:
        raise PncpError(
            "Nao foi possivel conectar a pncp.gov.br. Verifique sua internet, "
            "proxy corporativo ou firewall (a DPGU, por exemplo, pode ter regras "
            f"de rede que bloqueiam esse dominio). Detalhe tecnico: {e}"
        )
    except requests.exceptions.Timeout:
        raise PncpError(
            f"A API nao respondeu em {TIMEOUT}s. Ela pode estar instavel - "
            "tente de novo em alguns minutos."
        )

    if resp.status_code not in (200, 204):
        raise PncpError(
            f"API respondeu com status {resp.status_code} no teste de "
            f"conectividade. Corpo: {resp.text[:300]}"
        )
    log.info("Conectividade OK (status %s).", resp.status_code)


# 5xx do PNCP: pode ser sobrecarga real ou descarte deliberado de carga.
# Sem distinguir os dois, o comportamento seguro e o mesmo - recuar.
RETENTAVEIS = {500, 502, 503, 504}
ESPERA_MAXIMA = 45.0


def saude_pncp(timeout_http=15):
    """
    Diagnostico por camadas do PNCP. Existe porque "Read timed out" numa
    consulta pesada NAO e evidencia de portal fora do ar - so diz que
    aquela consulta nao voltou. Declarar indisponibilidade exige separar
    as camadas:

      dns   - o nome resolve?
      tcp   - a porta 443 aceita conexao?
      http  - uma consulta LEVE (1 dia, 1 registro) responde?

    dns/tcp falhando = fora ou rede local ruim.
    dns/tcp ok e http lento = servico de pe, consulta cara ou sobrecarga.
    """
    resultado = {"host": "pncp.gov.br", "dns": None, "tcp": None, "http": None}

    t0 = time.time()
    try:
        ip = socket.gethostbyname("pncp.gov.br")
        resultado["dns"] = {"ok": True, "ip": ip, "ms": int((time.time() - t0) * 1000)}
    except OSError as e:
        resultado["dns"] = {"ok": False, "erro": str(e)}
        resultado["veredito"] = "FORA: o nome nao resolve (DNS)."
        return resultado

    t0 = time.time()
    try:
        with socket.create_connection((ip, 443), timeout=8):
            resultado["tcp"] = {"ok": True, "ms": int((time.time() - t0) * 1000)}
    except OSError as e:
        resultado["tcp"] = {"ok": False, "erro": str(e)}
        resultado["veredito"] = "FORA: porta 443 nao aceita conexao."
        return resultado

    # consulta deliberadamente minima: 1 dia, 1 registro
    ontem = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
    params = {
        "dataInicial": ontem, "dataFinal": ontem,
        "codigoModalidadeContratacao": 6, "uf": "DF",
        # tamanhoPagina=1 era REJEITADO com 400 ("Tamanho de pagina
        # invalido"): a sonda dava veredito ruim com o servico no ar.
        "pagina": 1, "tamanhoPagina": 10,
    }
    t0 = time.time()
    try:
        r = SESSION.get(f"{BASE_URL}/v1/contratacoes/publicacao",
                        params=params, timeout=timeout_http)
        ms = int((time.time() - t0) * 1000)
        resultado["http"] = {"ok": r.status_code in (200, 204),
                             "status": r.status_code, "ms": ms}
        if r.status_code in (200, 204):
            resultado["veredito"] = (
                f"NO AR: consulta leve respondeu {r.status_code} em {ms}ms. "
                "Falha em consulta pesada e custo de query, nao indisponibilidade."
            )
        elif r.status_code in RETENTAVEIS:
            resultado["veredito"] = (
                f"DEGRADADO: ate a consulta leve devolveu {r.status_code}. "
                "Servidor de pe, mas rejeitando ou sobrecarregado."
            )
        elif r.status_code == 400:
            resultado["veredito"] = (
                f"SONDA INVALIDA: o servico respondeu 400 em {ms}ms. "
                "Isso PROVA que a API esta no ar - o erro esta nos "
                "parametros desta verificacao, nao no PNCP."
            )
        else:
            resultado["veredito"] = f"INESPERADO: status {r.status_code} em {ms}ms."
    except requests.exceptions.RequestException as e:
        resultado["http"] = {"ok": False, "erro": type(e).__name__,
                             "ms": int((time.time() - t0) * 1000)}
        resultado["veredito"] = (
            "DEGRADADO: DNS e TCP respondem, mas nem a consulta minima volta. "
            "O host esta acessivel; o servico de consulta nao."
        )
    return resultado


def _espera(tentativa, base):
    """
    Backoff exponencial com jitter, em segundos.

    Backoff linear de 1.5s somava ~9s antes de desistir de uma pagina -
    curto demais quando o servidor esta rejeitando por cadencia. O jitter
    evita que varias tentativas voltem sincronizadas no mesmo instante.
    """
    bruto = base * (2 ** (tentativa - 1))
    return min(ESPERA_MAXIMA, bruto) * (0.7 + random.random() * 0.6)


def _get(endpoint, params, max_retries=3, timeout=TIMEOUT):
    """
    GET com backoff simples e tratamento de 204 (sem resultados).

    O parametro timeout e exposto porque o cliente MCP corta a chamada
    em 60s: 3 tentativas de 30s mais os sleeps de backoff somavam ~95s,
    e a tool morria por timeout do cliente em vez de devolver o erro
    real. Chamadas vindas do servidor MCP usam um orcamento menor.
    """
    url = f"{BASE_URL}{endpoint}"
    ultimo_erro = None
    for tentativa in range(1, max_retries + 1):
        try:
            resp = SESSION.get(url, params=params, timeout=timeout)
        except requests.exceptions.RequestException as e:
            ultimo_erro = e
            espera = _espera(tentativa, base=5)
            log.warning("Tentativa %d/%d falhou (%s). Recuando %.1fs.", tentativa, max_retries, e, espera)
            time.sleep(espera)
            continue

        if resp.status_code == 204:
            return None
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (400, 422):
            raise PncpError(
                f"Parametros invalidos em {endpoint} (status {resp.status_code}): "
                f"{resp.text[:300]}"
            )
        if resp.status_code == 429:
            # Rate limit: o backoff normal e curto demais e so queima
            # tentativa. O PNCP nao manda Retry-After, entao esperamos um
            # degrau bem maior antes de insistir.
            espera = _espera(tentativa, base=10)
            log.warning(
                "Rate limit (429) em %s. Aguardando %.1fs antes da tentativa %d/%d.",
                endpoint, espera, tentativa + 1, max_retries,
            )
            ultimo_erro = "status 429 (limite de requisicoes excedido)"
            time.sleep(espera)
            continue

        ultimo_erro = f"status {resp.status_code}: {resp.text[:200]}"
        if resp.status_code in RETENTAVEIS:
            # 500/502/503/504 podem ser sobrecarga OU descarte deliberado
            # de carga. Nos dois casos insistir rapido piora: o backoff
            # aqui e exponencial, igual ao do 429.
            espera = _espera(tentativa, base=5)
            log.warning(
                "Tentativa %d/%d em %s: status %d. Recuando %.1fs.",
                tentativa, max_retries, endpoint, resp.status_code, espera,
            )
        else:
            espera = _espera(tentativa, base=1.5)
            log.warning("Tentativa %d/%d retornou erro (%s).", tentativa, max_retries, ultimo_erro)
        time.sleep(espera)

    raise PncpError(f"Falhou apos {max_retries} tentativas em {endpoint}. Ultimo erro: {ultimo_erro}")


def _fatias_de_periodo(data_inicial, data_final, dias=365, recente_primeiro=False):
    """
    Divide [data_inicial, data_final] (yyyyMMdd) em fatias de ate `dias`
    dias corridos, INCLUSIVE nas duas pontas.

    Duas razoes para fatiar:

    1. A API rejeita com 422 ("Periodo maior que 365 dias") qualquer
       consulta a /v1/contratos cuja janela ultrapasse 1 ano. Limite nao
       documentado no manual - so apareceu na mensagem de erro real.
    2. Janela de 1 ano num orgao grande e cara demais. Foi exatamente o
       tamanho de consulta que derrubou o catalogo por timeout e 503
       repetido. Uma fatia mensal responde em fracao do tempo e, quando
       falha, custa um mes de cobertura em vez de um ano inteiro.

    `recente_primeiro` inverte a ordem: comeca pelo periodo mais recente.
    Isso importa na busca em largura - contrato publicado ha pouco tem
    muito mais chance de continuar vigente e vencer dentro da janela de
    alerta, entao achar cedo permite parar cedo.
    """
    inicio = datetime.strptime(data_inicial, "%Y%m%d")
    fim = datetime.strptime(data_final, "%Y%m%d")
    if fim < inicio:
        return []
    dias = max(1, min(365, int(dias)))
    fatias = []
    cursor = inicio
    while cursor <= fim:
        fim_fatia = min(cursor + timedelta(days=dias - 1), fim)
        fatias.append((cursor.strftime("%Y%m%d"), fim_fatia.strftime("%Y%m%d")))
        cursor = fim_fatia + timedelta(days=1)
    if recente_primeiro:
        fatias.reverse()
    return fatias


def _janelas_de_ate_365_dias(data_inicial, data_final):
    """Compatibilidade: fatias de 1 ano, em ordem cronologica."""
    return _fatias_de_periodo(data_inicial, data_final, dias=365)


def buscar_contratos_por_orgao(
    cnpj_orgao,
    data_inicial,
    data_final,
    tamanho_pagina=200,
    timeout=TIMEOUT,
    max_retries=3,
    parar=None,
    dias_por_fatia=365,
    recente_primeiro=False,
    pular_fatias=None,
    ao_lote=None,
    ao_fatia=None,
    ao_erro=None,
    desistir_apos_falhas=None,
):
    """
    Consulta /v1/contratos por periodo de PUBLICACAO (nao de vigencia).
    Datas no formato yyyyMMdd. Para achar contratos de TIC de um orgao e
    preciso varrer o historico de publicacao, ja que a API nao filtra
    diretamente por "vigencia terminando em X".

    tamanho_pagina caiu de 500 para 200: orgaos grandes (Marinha,
    Exercito) estouravam o read timeout montando paginas de 500. Quem
    chama de dentro de uma thread de background deve passar timeout
    maior, ja que ali nao vale o limite de 60s do cliente MCP.

    parar: callable que, retornando True, interrompe no proximo ponto
        seguro - permite cancelar uma varredura longa sem matar o
        processo.

    Ganchos para busca incremental (todos opcionais):

    dias_por_fatia: tamanho de cada consulta. 365 mantem o
        comportamento antigo; 30 e o que torna a varredura viavel em
        orgao grande.
    recente_primeiro: comeca pelo periodo mais recente.
    pular_fatias: colecao de chaves "INI-FIM" ja lidas numa rodada
        anterior. E o que permite aprofundar sem repetir trabalho.
    ao_lote(lote) -> bool: chamado a cada pagina. Retornando True, a
        busca no orgao para ali (teto de achados atingido). Quando
        informado, a funcao NAO acumula os contratos em memoria - quem
        consome e o callback.
    ao_fatia(chave, lidos): chamado so quando a fatia foi lida ate o
        fim. Serve de checkpoint. Nao e chamado quando ao_lote mandou
        parar no meio, senao a rodada seguinte pularia um pedaco nunca
        lido.
    ao_erro(chave, excecao): chamado quando a fatia falha depois das
        retentativas. Se informado, a fatia e pulada e a busca segue
        para a proxima - uma falha custa um mes, nao o orgao inteiro.
        Sem ele, a excecao sobe (comportamento antigo).
    desistir_apos_falhas: apos N fatias CONSEGUIDAS falharem em sequencia
        (sucesso intercalado zera a contagem), desiste do orgao e devolve
        o que tiver - as fatias nao tentadas ficam de fora do checkpoint
        (ao_fatia nunca foi chamado nelas), entao uma rodada futura tenta
        de novo. Sem isso, um orgao consistentemente fora do ar (ex.:
        timeout sistematico) trava o orcamento de tempo da varredura
        inteira nas 60+ fatias dele, e nenhum outro orgao e alcancado.
    """
    contratos = []
    acumular = ao_lote is None
    pular = set(pular_fatias or ())
    falhas_seguidas = 0
    fatias = _fatias_de_periodo(
        data_inicial, data_final, dias=dias_por_fatia, recente_primeiro=recente_primeiro
    )
    log.info(
        "Periodo dividido em %d fatia(s) de ate %d dias (%d ja lidas).",
        len(fatias), dias_por_fatia, len(pular & {f"{a}-{b}" for a, b in fatias}),
    )

    for idx, (fatia_inicio, fatia_fim) in enumerate(fatias, start=1):
        chave = f"{fatia_inicio}-{fatia_fim}"
        if chave in pular:
            continue
        if parar is not None and parar():
            log.info("Busca interrompida a pedido.")
            return contratos

        log.info("Fatia %d/%d: %s a %s", idx, len(fatias), fatia_inicio, fatia_fim)
        pagina = 1
        lidos = 0
        completa = True
        try:
            while True:
                if parar is not None and parar():
                    return contratos
                params = {
                    "dataInicial": fatia_inicio,
                    "dataFinal": fatia_fim,
                    "pagina": pagina,
                    "tamanhoPagina": tamanho_pagina,
                }
                # cnpjOrgao e opcional na API: sem ele a consulta devolve
                # os contratos de todos os orgaos do pais na janela.
                if cnpj_orgao:
                    params["cnpjOrgao"] = cnpj_orgao
                payload = _get(
                    "/v1/contratos", params, max_retries=max_retries, timeout=timeout
                )
                if not payload:
                    break
                lote = payload.get("data", []) if isinstance(payload, dict) else payload
                if not lote:
                    break
                lidos += len(lote)
                if acumular:
                    contratos.extend(lote)
                if ao_lote is not None and ao_lote(lote):
                    # teto atingido no meio da fatia: nao marca checkpoint
                    return contratos
                if isinstance(payload, dict) and payload.get("paginasRestantes", 0) > 0:
                    pagina += 1
                    time.sleep(0.3)  # respeita rate limit nao documentado
                else:
                    break
        except PncpError as e:
            if ao_erro is None:
                raise
            completa = False
            log.warning("Fatia %s falhou, seguindo: %s", chave, e)
            ao_erro(chave, e)

        if completa:
            falhas_seguidas = 0
            if ao_fatia is not None:
                ao_fatia(chave, lidos)
        else:
            falhas_seguidas += 1
            if desistir_apos_falhas and falhas_seguidas >= desistir_apos_falhas:
                log.warning(
                    "Desistindo do orgao %s apos %d fatias seguidas com falha "
                    "(%d de %d fatias tentadas) - fica pendente pra proxima rodada.",
                    cnpj_orgao, falhas_seguidas, idx, len(fatias),
                )
                return contratos
        time.sleep(0.3)  # respiro entre fatias

    return contratos


CATEGORIA_TIC = 3  # "Informatica (TIC)" na tabela Categoria do Processo
TIPO_CONTRATO_EMPENHO = 7  # "Empenho" na tabela Tipo de Contrato

# Resgate por palavra-chave: muitos orgaos classificam contrato de TIC
# como "Compras" (2) ou "Servicos" (8). Confirmado numa amostra real da
# DPU, onde ate a compra de baterias para nobreak veio como categoria 2.
# Os padroes abaixo sao regex sobre o objeto ja sem acento e em
# maiusculas. Alguns termos exigem cuidado:
#   - SERVIDOR casaria com "servidores publicos" (pessoas), dai a
#     negativa explicita;
#   - REDE e SISTEMA sozinhos casariam com "rede eletrica" e "sistema de
#     combate a incendio", entao so entram acompanhados.
PADROES_TIC = [
    r"\bSOFTWARE",
    r"\bHARDWARE",
    r"\bLICEN[CS]A(S)?\s+DE\s+(USO|SOFTWARE)",
    r"\bLICENCIAMENTO\b",
    r"TECNOLOGIA\s+DA\s+INFORMACAO",
    r"\bTIC\b",
    r"\bDATA\s?CENTER\b",
    r"\bNOBREAK",
    r"\bCOMPUTADOR",
    r"\bMICROCOMPUTADOR",
    r"\bNOTEBOOK",
    r"\bDESKTOP",
    r"\bSERVIDOR(?!(ES|A|AS)?\s+PUBLIC)",
    r"\bSTORAGE\b",
    r"\bBACKUP\b",
    r"\bANTIVIRUS\b",
    r"\bFIREWALL\b",
    r"\bSWITCH(ES)?\b",
    r"\bROTEADOR",
    r"CABEAMENTO\s+ESTRUTURADO",
    r"LINK\s+DE\s+(INTERNET|DADOS|COMUNICACAO)",
    r"\bBANDA\s+LARGA\b",
    r"\bVOIP\b",
    r"\bTELEFONIA\b",
    r"COMPUTACAO\s+EM\s+NUVEM",
    r"\bNUVEM\b",
    r"\bCLOUD\b",
    r"BANCO\s+DE\s+DADOS",
    r"(DESENVOLVIMENTO|SUSTENTACAO|MANUTENCAO)\s+DE\s+(SISTEMA|SOFTWARE)",
    r"SISTEMA\s+(INFORMATIZADO|DE\s+INFORMACAO|DE\s+GESTAO)",
    r"OUTSOURCING\s+DE\s+IMPRESSAO",
    r"\bIMPRESSORA",
    r"\bSCANNER",
    r"\bINFORMATICA\b",
    r"SUPORTE\s+TECNICO\s+(EM|DE|PARA)\s+(TI|TIC|INFORMATICA|SISTEMA)",
    r"\bCFTV\b",
    r"VIDEOMONITORAMENTO",
]

_REGEX_TIC = [re.compile(p) for p in PADROES_TIC]


def _partes_controle(numero_controle):
    """
    Quebra um numeroControlePNCP em (cnpj, ano, sequencial).

    Formato: "00394502000144-1-010463/2025" = cnpj-tipo-sequencial/ano.
    O tipo distingue contratacao (1) de contrato (2). O PNCP nao devolve
    URL pronta - o unico campo de URL e urlCipi, que e de obras e vem
    nulo -, entao a unica forma de chegar na pagina e montar a partir
    deste identificador.
    """
    if not numero_controle:
        return None
    try:
        ident, _, ano = str(numero_controle).partition("/")
        cnpj, _tipo, sequencial = ident.split("-")
        if not (cnpj.isdigit() and ano.isdigit() and sequencial.isdigit()):
            return None
        # sequencial vem zero-padded ("010463"); a URL usa sem zeros
        return cnpj, ano, str(int(sequencial))
    except (ValueError, AttributeError):
        return None


def _link_contratacao(numero_controle_compra):
    """Pagina da contratacao no PNCP, onde ficam edital e anexos."""
    partes = _partes_controle(numero_controle_compra)
    if not partes:
        return None
    cnpj, ano, seq = partes
    return f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}"


def _link_contrato(numero_controle):
    """Pagina do contrato em si no PNCP."""
    partes = _partes_controle(numero_controle)
    if not partes:
        return None
    cnpj, ano, seq = partes
    return f"https://pncp.gov.br/app/contratos/{cnpj}/{ano}/{seq}"


def _sem_acento(texto):
    return "".join(
        c for c in unicodedata.normalize("NFD", texto or "")
        if unicodedata.category(c) != "Mn"
    ).upper()


def classificar_tic(contrato):
    """
    Decide se um contrato e de TIC e diz POR QUE. A origem importa: o
    que veio da categoria oficial do orgao e auditavel; o que veio de
    palavra-chave e palpite bem informado e merece conferencia manual.

    Retorna (eh_tic: bool, origem: str|None, evidencia: str|None).
    """
    categoria = (contrato.get("categoriaProcesso") or {}).get("id")
    if categoria == CATEGORIA_TIC:
        return True, "categoria_oficial", "categoriaProcesso=3 (Informatica/TIC)"

    objeto = _sem_acento(contrato.get("objetoContrato"))
    for regex in _REGEX_TIC:
        m = regex.search(objeto)
        if m:
            return True, "palavra_chave", m.group(0).strip()
    return False, None, None


def eh_nota_empenho(contrato):
    """
    Nota de empenho nao e contrato vencendo: e compra pontual que fecha
    junto com o exercicio fiscal (vigencia ate 31/12). Identificamos
    pelo campo estruturado tipoContrato.id == 7, e nao pelo texto do
    objeto - o texto so foi o disponivel antes de inspecionarmos uma
    resposta bruta da API.
    """
    if (contrato.get("tipoContrato") or {}).get("id") == TIPO_CONTRATO_EMPENHO:
        return True
    return _sem_acento(contrato.get("objetoContrato")).startswith("EMPENHO")


def estimar_volume(data_inicial, data_final, cnpj_orgao=None, timeout=20):
    """
    Le so o cabecalho de paginacao de /v1/contratos (totalRegistros /
    totalPaginas) pedindo a menor pagina possivel. Serve para dimensionar
    uma varredura ANTES de dispara-la: sem CNPJ, a consulta nacional pode
    devolver dezenas de milhares de registros por dia, e vale saber disso
    antes de baixar tudo.
    """
    params = {
        "dataInicial": data_inicial,
        "dataFinal": data_final,
        "pagina": 1,
        "tamanhoPagina": 10,
    }
    if cnpj_orgao:
        params["cnpjOrgao"] = cnpj_orgao

    payload = _get("/v1/contratos", params, max_retries=2, timeout=timeout)
    if not payload:
        return {"totalRegistros": 0, "totalPaginas": 0, "amostra": []}

    amostra = payload.get("data", []) if isinstance(payload, dict) else payload
    return {
        "totalRegistros": payload.get("totalRegistros") if isinstance(payload, dict) else len(amostra),
        "totalPaginas": payload.get("totalPaginas") if isinstance(payload, dict) else None,
        "amostra": amostra,
    }


def classificar_contratos_por_vencimento(contratos, meses_alerta=12, meses_teto_legal=60):
    """
    Recebe a lista bruta de contratos do PNCP e:
      - calcula dias ate o fim da vigencia
      - filtra os que vencem dentro da janela de alerta
      - aplica heuristica de "provavel renovacao" vs "provavel nova
        licitacao", comparando o tempo total decorrido desde o inicio
        da vigencia com um teto legal de referencia (padrao 60 meses -
        AJUSTAR conforme o objeto: licenciamento de software, servico
        de rede, outsourcing etc. podem ter teto diferente).
    """
    hoje = datetime.now()
    vencendo, provavel_renovacao, provavel_nova_licitacao = [], [], []

    for c in contratos:
        fim_str = c.get("dataVigenciaFim")
        inicio_str = c.get("dataVigenciaInicio")
        if not fim_str:
            continue

        try:
            fim = datetime.strptime(fim_str[:10], "%Y-%m-%d")
        except ValueError:
            continue

        dias_restantes = (fim - hoje).days
        if dias_restantes < 0 or dias_restantes > meses_alerta * 30:
            continue

        # O endpoint /v1/contratos devolve tambem notas de empenho, cujo
        # objeto comeca com "EMPENHO" e cuja vigencia termina no
        # encerramento do exercicio (31/12). Elas nao sao contratos que
        # vencem: sao compras pontuais que fecham com o ano fiscal.
        # Marcamos para que quem consome possa separar o ruido do sinal.
        objeto_bruto = " ".join((c.get("objetoContrato") or "").split())
        eh_empenho = eh_nota_empenho(c)
        tic, origem_tic, evidencia_tic = classificar_tic(c)
        oe = c.get("orgaoEntidade") or {}
        uo = c.get("unidadeOrgao") or {}

        item = {
            "orgao": oe.get("razaoSocial"),
            "cnpjOrgao": oe.get("cnpj"),
            "esferaId": oe.get("esferaId"),
            "poderId": oe.get("poderId"),
            "uf": uo.get("ufSigla"),
            "municipio": uo.get("municipioNome"),
            "categoriaProcesso": (c.get("categoriaProcesso") or {}).get("nome"),
            "tipoContrato": (c.get("tipoContrato") or {}).get("nome"),
            "ehTIC": tic,
            "origemTIC": origem_tic,
            "evidenciaTIC": evidencia_tic,
            # 300 caracteres cortavam o objeto no meio justamente onde
            # costuma estar o escopo tecnico. Quem le e pre-venda: precisa
            # do objeto inteiro para dimensionar proposta.
            "objeto": objeto_bruto,
            "ehNotaEmpenho": eh_empenho,
            "numeroContrato": c.get("numeroContratoEmpenho"),
            "numeroControlePNCP": c.get("numeroControlePNCP"),
            # numeroControlePNCP e o id do CONTRATO (tipo 2). Os documentos
            # (edital, termo de referencia) ficam na CONTRATACAO, cujo id
            # vem em numeroControlePncpCompra (tipo 1). Sem este campo nao
            # da para chegar aos documentos.
            "numeroControlePncpCompra": c.get("numeroControlePncpCompra"),
            "linkContratacao": _link_contratacao(c.get("numeroControlePncpCompra")),
            "linkContrato": _link_contrato(c.get("numeroControlePNCP")),
            # o orgao e abstrato; a unidade e o interlocutor real
            "unidade": uo.get("nomeUnidade"),
            "codigoUnidade": uo.get("codigoUnidade"),
            # NUP, para pedir vista do processo administrativo
            "processo": c.get("processo"),
            "fornecedor": c.get("nomeRazaoSocialFornecedor"),
            "cnpjFornecedor": c.get("niFornecedor"),
            "dataAssinatura": c.get("dataAssinatura"),
            "numeroParcelas": c.get("numeroParcelas"),
            "valorParcela": c.get("valorParcela"),
            "valorGlobal": c.get("valorGlobal"),
            "dataVigenciaInicio": inicio_str,
            "dataVigenciaFim": fim_str,
            "diasRestantes": dias_restantes,
        }
        vencendo.append(item)

        if inicio_str:
            try:
                inicio = datetime.strptime(inicio_str[:10], "%Y-%m-%d")
                meses_decorridos = (fim - inicio).days / 30
                if meses_decorridos < meses_teto_legal * 0.9:
                    provavel_renovacao.append(item)
                else:
                    provavel_nova_licitacao.append(item)
            except ValueError:
                provavel_nova_licitacao.append(item)
        else:
            provavel_nova_licitacao.append(item)

    return {
        "vencendo_em_breve": vencendo,
        "provavel_renovacao": provavel_renovacao,
        "provavel_nova_licitacao": provavel_nova_licitacao,
    }


def imprimir_resumo(resultado):
    total = len(resultado["vencendo_em_breve"])
    print(f"\n{'=' * 60}")
    print(f"Contratos vencendo nos proximos meses: {total}")
    print(f"  - Provavel renovacao:      {len(resultado['provavel_renovacao'])}")
    print(f"  - Provavel nova licitacao: {len(resultado['provavel_nova_licitacao'])}")
    print(f"{'=' * 60}\n")

    if total == 0:
        print("Nenhum contrato encontrado na janela pedida. Possiveis causas:")
        print("  - CNPJ errado (confira com pontuacao removida, 14 digitos)")
        print("  - Janela de datas nao cobre o historico do orgao")
        print("  - O orgao realmente nao tem contratos vencendo nesse periodo")
        return

    def _print_lista(titulo, lista):
        print(f"--- {titulo} ---")
        for item in sorted(lista, key=lambda x: x["diasRestantes"])[:20]:
            print(
                f"  [{item['diasRestantes']:>4}d] {item['dataVigenciaFim']} | "
                f"{item['fornecedor'] or '(sem fornecedor)'} | "
                f"{(item['objeto'] or '')[:80]}"
            )
        if len(lista) > 20:
            print(f"  ... e mais {len(lista) - 20} contrato(s)")
        print()

    _print_lista("PROVAVEL RENOVACAO", resultado["provavel_renovacao"])
    _print_lista("PROVAVEL NOVA LICITACAO", resultado["provavel_nova_licitacao"])


def main():
    parser = argparse.ArgumentParser(
        description="Monitor de contratos do PNCP proximos do vencimento."
    )
    parser.add_argument(
        "--cnpj", required=True,
        help="CNPJ do orgao, so digitos (ex.: 00375114000116 para a DPGU).",
    )
    parser.add_argument(
        "--anos-historico", type=int, default=5,
        help="Quantos anos para tras buscar contratos publicados (padrao: 5).",
    )
    parser.add_argument(
        "--meses-alerta", type=int, default=12,
        help="Janela de alerta em meses para 'vencendo em breve' (padrao: 12).",
    )
    parser.add_argument(
        "--teto-legal-meses", type=int, default=60,
        help="Teto legal de referencia em meses para a heuristica de "
             "renovacao (padrao: 60 = 5 anos, art. 105 da Lei 14.133/2021).",
    )
    parser.add_argument(
        "--pular-teste-conectividade", action="store_true",
        help="Pula o teste inicial de conectividade (nao recomendado).",
    )
    args = parser.parse_args()

    cnpj = "".join(ch for ch in args.cnpj if ch.isdigit())
    if len(cnpj) != 14:
        log.error("CNPJ invalido: '%s' tem %d digitos, esperado 14.", args.cnpj, len(cnpj))
        sys.exit(1)

    try:
        if not args.pular_teste_conectividade:
            testar_conectividade()

        hoje = datetime.now()
        inicio_busca = (hoje - timedelta(days=args.anos_historico * 365)).strftime("%Y%m%d")
        fim_busca = hoje.strftime("%Y%m%d")

        log.info("Buscando contratos do CNPJ %s entre %s e %s...", cnpj, inicio_busca, fim_busca)
        contratos = buscar_contratos_por_orgao(cnpj, inicio_busca, fim_busca)
        log.info("Total de contratos publicados encontrados: %d", len(contratos))

        resultado = classificar_contratos_por_vencimento(
            contratos,
            meses_alerta=args.meses_alerta,
            meses_teto_legal=args.teto_legal_meses,
        )
        imprimir_resumo(resultado)

    except PncpError as e:
        log.error("Erro ao consultar o PNCP: %s", e)
        sys.exit(1)
    except KeyboardInterrupt:
        log.info("Interrompido pelo usuario.")
        sys.exit(130)


if __name__ == "__main__":
    main()
