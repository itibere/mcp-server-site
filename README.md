# itibere.tec.br

Site pessoal e vitrine de projetos. Estático, sem dependências externas,
publicado no GitHub Pages sob domínio próprio registrado no registro.br.

## Estrutura

```
index.html                       home — hub que separa os trabalhos
assets/style.css                 tokens e componentes compartilhados
assets/dashboard.css             componentes do painel
projetos/pncp/vencendo/          monitor de contratos de TIC vencendo (6-12 meses)
projetos/pncp/vencendo/dados.json dados que o painel lê (gerado, versionado)
pncp-tic/                        coletor + validador do pipeline atual (ver pncp-tic/README.md)
scripts/montar_vencendo.py       transforma o resultado julgado no contrato de dados do painel
CNAME                             domínio do GitHub Pages
```

## Como o painel se atualiza

O site não roda nada em servidor. O pipeline em `pncp-tic/` (coletor via
`/api/search/` do PNCP + julgamento de classificação TIC) roda localmente e
`scripts/montar_vencendo.py` escreve `projetos/pncp/vencendo/dados.json`;
o `git push` desse arquivo é o deploy. A página lê o JSON no navegador e
calcula os agregados ali mesmo, para que os filtros e os gráficos nunca
discordem entre si. Detalhes do pipeline em `pncp-tic/README.md`.

Consequência prática: nenhuma porta aberta, nenhum serviço exposto, nenhum
token em produção. O site continua no ar com o último dado coletado — e a
data da leitura fica visível na página.

## Rodando localmente

```bash
python3 -m http.server 8000          # http://localhost:8000
```

## Decisões que valem registro

**Gráficos escritos à mão em SVG.** Nenhuma biblioteca de charts: o painel
inteiro cabe em um arquivo de ~500 linhas, carrega sem CDN e não quebra quando
uma dependência muda de API. Cada gráfico tem tabela equivalente para leitura
sem cor.

**Procedência declarada na página.** Janela, escopo, critério de classificação
e data da leitura ficam visíveis. Número de contratação pública sem procedência
é número que ninguém pode usar.

**Classificação é triagem.** A separação entre renovação provável e nova
licitação é heurística apoiada no teto de 60 meses do art. 105 da Lei
14.133/2021 — serve para priorizar leitura, não como conclusão jurídica.

## Licença

Código sob licença MIT. Os dados são públicos, do Portal Nacional de
Contratações Públicas.
