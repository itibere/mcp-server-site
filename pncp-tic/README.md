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

   **Critério (revisado 2026-09-09 — bem mais restrito que "TIC" genérico).**
   `veredito: "tic"` **somente** se o objeto se enquadrar numa destas duas
   categorias:

   - **A) Serviços de Sustentação de Infraestrutura de TIC** — manutenção,
     suporte técnico, garantia, operação de servidores, storage/armazenamento,
     backup, datacenter (climatização de precisão, UPS, sala-cofre). Inclui
     "atendimento a usuários"/helpdesk/service desk quando empacotado
     *junto* com operação de infraestrutura no mesmo contrato (modelo
     oficial SISP, Portaria SGD/MGI 1.070/2023, trata os dois como um
     pacote único). **Não inclui**: aquisição *nova* de servidor/storage/
     equipamento de rede como bem (aquisição não é "sustentação" de algo
     já existente); conectividade/rede como serviço (link de internet,
     fibra, Wi-Fi corporativo); nuvem/cloud/IaaS/hospedagem/SaaS de
     qualquer tipo; firewall/NGFW/segurança de rede, workstation ou
     e-mail; certificados digitais (A3, SSL/TLS). Todos esses ficam fora
     do escopo mesmo sendo "infra" em sentido técnico amplo — o usuário
     restringiu deliberadamente a só o núcleo de sustentação de
     servidor/storage/backup/datacenter.
   - **B) Fornecimento de Hardware (Computadores/Monitores)** — *somente*
     aquisição de desktop, notebook, estação de trabalho, monitor.
     **Não inclui** switch, roteador, equipamento de rede, servidor novo,
     storage novo, equipamento multimídia (som/câmera/projetor),
     keypads/urnas eletrônicas.

   Tudo mais é `nao_tic`, incluindo desenvolvimento/evolução/sustentação
   de **sistemas de informação** (é desenvolvimento de software aplicativo,
   categoria diferente de sustentação de *infraestrutura*) e licenças de
   software/SaaS isoladas (Adobe, OpenAI, Microsoft 365, antivírus, ITSM/
   DCIM como produto isolado).

   Os `julgamento_NN.json` commitados neste repo já refletem esse critério
   (rejulgados em 2026-09-09). Se algum exemplo mais antigo aparecer
   classificando conectividade/nuvem/firewall/certificado/dev-de-sistema
   como `tic`, ele está desatualizado — não siga, aplique o critério acima.

   **Correção de calibração (2026-09-04, ainda válida):** CFTV / circuito
   fechado de TV, mesmo com componente IP/rede (ex: "solução CFTV-IP",
   "câmeras em rede"), **NÃO é TIC** pela classificação oficial de categoria
   do PNCP — é segurança patrimonial/vigilância eletrônica, categoria
   própria, mesmo rodando sobre infraestrutura de rede.
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
