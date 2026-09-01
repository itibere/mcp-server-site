# pncp-tic

Coleta e julgamento de contratos de TIC (esfera federal, UF DF) do PNCP
cuja vigência final cai numa janela alvo (padrão: 6 a 12 meses a partir de
hoje). Alimenta `projetos/pncp/vencendo/` neste mesmo repo.

## Pipeline atual (o que usar)

```
python coletar_via_search.py
python _preparar_lotes.py
# julgar cada julgamento_lotes/lote_NN.json (ver "Julgamento" abaixo)
python _consolidar_julgamento.py
python ../scripts/montar_vencendo.py resultado_tic_df_federal_julgado.json
git add ../projetos/pncp/vencendo/dados.json
git commit && git push
```

1. **`coletar_via_search.py`** — busca via `https://pncp.gov.br/api/search/`
   (o endpoint que alimenta a busca de "Contratos" no site do PNCP, não a
   API `/v1/contratos` documentada). Filtra `ufs`/`esferas`/`status`
   direto no servidor, sem precisar descobrir CNPJ de órgão primeiro —
   muito mais rápido que a abordagem antiga (ver "Legado" abaixo). Escreve
   `resultado_tic_df_federal.json`.
2. **`_preparar_lotes.py`** — corta os candidatos em `julgamento_lotes/lote_NN.json`
   (lotes de 45, só `numero_controle_pncp`/`orgao`/`objeto`).
3. **Julgamento** — o filtro de palavra-chave do passo 1 é full-text OR,
   gera falso positivo (ex: "curso sobre sistema de diárias" bate
   "sistema"). Cada `lote_NN.json` precisa ser julgado por um agente LLM
   (Claude), item a item, escrevendo `julgamento_NN.json` no formato
   `{"numero_controle_pncp", "veredito": "tic"|"nao_tic", "motivo"}`.
   Critério e exemplos calibrados: ver os `julgamento_NN.json` já commitados
   aqui como referência. Numa sessão de Claude Code, é só pedir: "julga os
   lotes em julgamento_lotes/ seguindo o padrão dos julgamento_NN.json
   existentes".
4. **`_consolidar_julgamento.py`** — junta os `julgamento_*.json` aos
   candidatos originais, separa aprovados/reprovados, escreve
   `resultado_tic_df_federal_julgado.json`.
5. **`../scripts/montar_vencendo.py`** (no repo do site, não aqui) —
   transforma o `*_julgado.json` no formato que `assets/vencendo.js`
   consome, escreve `projetos/pncp/vencendo/dados.json`. Commit + push
   nesse arquivo publica no site (GitHub Pages, deploy automático).

Rodar tudo de novo é barato (~1min de coleta; julgamento é o passo que
consome tempo/tokens, proporcional ao nº de candidatos no lote).

## Legado (não usar para novo trabalho sem avisar)

`catalogo.py` + `varredura.py` + `pncp_monitor.py` são uma linhagem
anterior, mesma ideia do dois-fases (descobrir órgãos publicando na UF via
`/v1/contratacoes/publicacao`, depois varrer `/v1/contratos` por CNPJ) —
abandonada por ser lenta e sujeita a rate-limit/instabilidade da API antes
de `coletar_via_search.py` ser descoberto. `varredura_tic.json` e
`catalogo_orgaos.json` são os últimos outputs dessa linhagem, mantidos só
como referência histórica.

## `mcp_server.py` — ferramenta separada

Não faz parte do pipeline batch acima. Expõe consulta de contratos por
CNPJ como MCP tool pro Claude Desktop (usa a lógica de `pncp_monitor.py`,
janela de 365 dias, classificação "provável renovação" vs "provável nova
licitação" — heurística de triagem, não conclusão jurídica). Configurar
via `claude_desktop_config.example.json` (ajustar os caminhos pra sua
máquina). `pip install mcp requests`.

## Requisitos

```
pip install -r requirements.txt
```
Só `requests`. Se usar uma venv, confirme que `requests` está instalado
nela — a venv original deste projeto ficou sem a dependência instalada em
algum momento; o global `python`/`pip` da máquina funcionava.
