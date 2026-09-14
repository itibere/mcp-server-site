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
   `resultado_tic_df_federal.json`. Aceita `--uf`/`--esfera` pra outros
   escopos (ex: `--uf BA --esfera E`) e, opcionalmente, `--municipio "Nome"`
   pra recorte municipal dentro da UF (a API só filtra por `ufs`/`esferas`
   no servidor — `municipio_nome` vem no item bruto e o filtro é feito no
   cliente, após a coleta, então esfera `M` sem `--municipio` traz a UF
   inteira). Nomes de arquivo/pasta ganham sufixo do município (slug sem
   acento, ex: `resultado_tic_pa_municipal_belem.json`,
   `julgamento_lotes/m_pa_belem/`).
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
     suporte técnico, garantia, operação de servidores,
     datacenter (climatização de precisão, sala-cofre). Inclui
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
     servidor/storage/datacenter.
   - **B) Fornecimento de Hardware (Computadores/Monitores)** — *somente*
     aquisição de desktop, notebook, estação de trabalho, monitor.
     **Não inclui** switch, roteador, equipamento de rede, servidor novo,
     storage novo, equipamento multimídia (som/câmera/projetor),
     keypads/urnas eletrônicas.

   **Regra de backup (revisada 2026-09-14).** Solução/serviço de backup
   isolado **não** entra em A nem B — vira `nao_tic`. Backup só conta como
   TIC (categoria A) quando o mesmo objeto empacota backup **junto** com
   pelo menos um destes serviços: Service Desk, ITSM, Controle de ativos,
   ou Chatbot com IA. Backup sozinho, ou backup + qualquer outra coisa fora
   dessa lista, continua `nao_tic`.

   **Regra de appliance (revisada 2026-09-14).** Qualquer objeto que
   envolva appliance (de qualquer tipo — segurança, backup, storage, rede
   etc.) é sempre `nao_tic`, exclusão categórica que prevalece sobre
   qualquer outro critério acima — não entra em Serviços (A) nem em
   Hardware (B), mesmo se combinado com algo elegível.

   **Regra de storage (nova, 2026-09-14).** Storage/armazenamento saiu da
   lista base de A — sozinho (aquisição, manutenção ou suporte de storage,
   sem mais nada) é sempre `nao_tic`. Só conta como TIC (categoria A) se o
   mesmo objeto empacotar storage **junto** com pelo menos um destes:
   fornecimento de hardware (B — notebook, desktop, monitor, periféricos),
   ou fornecimento de técnico(s)/analista(s) dedicado(s) que atuam **de
   forma contínua** com a solução (posto de trabalho fixo/alocado, equipe
   residente operando o storage no dia a dia).

   **Distinção que importa aqui (não simplificar):** manutenção
   corretiva/preventiva, garantia, suporte técnico com atendimento sob
   demanda/acionamento, SLA de resposta a chamado — **não conta**, mesmo
   que inclua visita técnica presencial quando dá problema. Isso é
   sustentação reativa do *produto* (aciona quando quebra), não
   fornecimento de mão de obra. Só conta quando o objeto deixa claro que
   tem gente da contratada *atuando com* a solução continuamente (rotina
   operacional, não resposta a incidente). Na dúvida genuína entre os dois
   (texto ambíguo), julgar `nao_tic` sem gastar mais leitura em cima —
   mas isso não é desculpa pra perder caso óbvio: se o objeto lista
   hardware (B) junto com o storage, isso sozinho já garante `tic`
   independente da parte de mão de obra: **sempre conferir a lista de itens
   do objeto inteira antes de julgar por storage isolado** — não parar de
   ler no primeiro trecho que menciona storage.

   **Regra de impressoras (nova, 2026-09-14).** Impressora (compra ou
   locação) como objeto único, ou serviço de gestão de impressoras
   isolado, é sempre `nao_tic`. Só conta como TIC quando empacotado
   **junto** com fornecimento de hardware (B) e/ou serviços como Service
   Desk, ITSM, ou Controle de ativos.

   **Regra de nobreak (nova, 2026-09-14).** Manutenção, venda ou aluguel
   de nobreak como objeto único é sempre `nao_tic`. Só conta como TIC
   quando empacotado **junto** com fornecimento de hardware (B) ou
   serviços como Service Desk (N1/N2/N3), ITSM, ou sistema de controle de
   ativos.

   **Marca não determina categoria (nova, 2026-09-14).** A marca citada no
   objeto (HP, IBM, Canon, Dell, Lenovo etc.) não classifica sozinha —
   a mesma marca fabrica servidor, storage, notebook, impressora, nobreak
   etc. Sempre ler a descrição do modelo/equipamento pra aplicar a regra
   certa (ex.: "manutenção de equipamento marca HP" só cai na regra de
   impressora se o modelo citado for de impressora; se o modelo for
   servidor/storage/notebook HP, aplica-se o critério correspondente a
   esse tipo de equipamento, não o de impressora).

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
