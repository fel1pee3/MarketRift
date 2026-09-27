# ADR 0023: índices monitoráveis e conteúdo relacionado na descoberta

**Status:** implementado em 2026-09-27.

## Decisão

A descoberta classifica candidatos com a regra `v2`. Ela usa o caminho canônico da URL, o link de origem, o texto do link e o método de descoberta como **indícios**, sem afirmar que leu o destino. Um caminho que termina em `/pricing`, `/prices`, `/plan`, `/plans` ou `/precos` pode sugerir índice de preços. Um caminho que termina em `/changelog`, `/release-notes` ou `/releases` pode sugerir índice de lançamentos. Uma URL filha desses índices é `changelog_entry`: conteúdo relacionado, sem conector de página principal. Documentação e caminhos de blog/artigo têm precedência sobre palavras como “plan”, “pricing” e “release” no título. Um link com essas palavras e caminho sem estrutura de índice vira `product_mention`. URLs externas continuam ambíguas. Essa taxonomia de **candidatas** não muda tipos de documentos, capturas ou sinais já gravados.

A API confirma membership, papel owner/admin, tenant e identidade do concorrente antes de decidir. Mesmo se uma linha antiga ou uma chamada direta afirmar `pricing_page` para `/changelog/...`, o servidor recusa o cadastro como página de preços com `candidate_not_monitorable`. Somente índice oficial no mesmo domínio pode usar o cadastro existente de página; o `ON CONFLICT` reutiliza a fonte por tenant, produto, tipo e URL, sempre sem ativar monitoramento. A API também devolve `existing_source_id` ao listar candidatos, para a interface destacar “Fonte existente” e dispensar nova confirmação. Entradas individuais podem ser reconhecidas como conteúdo relacionado, mas ficam `access_unavailable`, sem fonte, coleta ou sinal automático.

## Migração e histórico

A migração incremental **022** adiciona `classification_version`, origem/método da primeira descoberta e histórico tenant-scoped com RLS `FORCE`. Um trigger guarda tipo, categoria, versão e estado anteriores quando a classificação muda. O backfill altera **somente** candidatas pendentes, não revisadas e sem fonte, cujo caminho é filho de `/changelog/` e cuja sugestão antiga era preço ou índice de changelog. Ele não toca decisões `confirmed`/`rejected`, capturas, fontes nem sinais. A primeira data (`first_seen_at`) e a URL candidata permanecem. Para linhas antigas, a origem inicial só pode ser recuperada até o que já estava armazenado antes de 022; versões anteriores do coletor podiam substituir `discovered_from_url` em repetição. Depois de 022, `first_discovered_from_url` e `first_discovery_method` ficam estáveis.

Em coletas novas, o worker escreve `classification_version=2`; uma repetição pode atualizar a sugestão de uma candidata **pendente** e o trigger registra a mudança. Para candidatas revisadas, classificação, versão da identidade, vínculo, decisão e indícios de origem não são sobrescritos por nova coleta. Se a identidade oficial mudou, a interface mantém a associação antiga visível como desatualizada; não transfere aprovação para uma nova identidade.

## Limites

Uma entrada de changelog citando planos pode indicar uma alteração comercial, mas não substitui a página principal de preços. A descoberta limitada não lê cada URL candidata e pode ter cobertura parcial por sitemap, homepage ou orçamento de requisições. Esta regra não identifica toda variante de URL de preço/release; nesses casos a pessoa revisa o link e cadastra uma fonte específica somente quando o conector e o acesso forem adequados. Não há Brave Search, OpenAI, coleta externa nem interpretação nova de capturas nesta entrega. A [ADR 0020](0020-descoberta-fontes-concorrente.md) continua descrevendo os limites e direitos da descoberta.
