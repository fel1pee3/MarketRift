# ADR 0011: GitHub Discussions públicas como fonte comunitária separada

**Status:** implementado em 2026-09-24.

## Decisão

- `github_discussions` e `github_discussion` são tipos próprios na migração 010. Dados antigos permanecem intactos. A chave `(tenant_id, source_id, external_key)` usa o Node ID estável da Discussion; uma edição atualiza o mesmo documento. A transação do worker usa o papel runtime com RLS e confirma tenant, produto, tipo e URL da fonte antes da coleta e antes da gravação.
- Owner/admin cadastram `owner/repo` ou URL HTTPS canônica do GitHub para um produto visível no tenant. Analyst pode pedir sincronização; viewer consulta. A associação ao produto é confirmada por SQL no contexto transacional do tenant. O cadastro é provisório: o worker GraphQL valida que o repositório é público e tem Discussions habilitadas na primeira coleta. Repositório privado, inacessível ou sem Discussions não gera documentos. O job BullMQ contém apenas IDs, versão e chave de idempotência.
- Apenas o worker lê `GITHUB_DISCUSSIONS_TOKEN` de `.env.worker.local`, ignorado pelo Git e carregado por `dev:worker`; o `.env` compartilhado não deve conter essa credencial. O endpoint de produção é fixo em `https://api.github.com/graphql`; substituição local só existe com `MARKETRIFT_TEST_MODE=1` e host loopback para E2E. O token não vai ao navegador, Redis, banco ou logs. Sem token, a execução fica `failed/configuration_pending` e pode ser solicitada novamente após configurar o worker.
- A consulta pede Node ID, número, URL, título, corpo, categoria, login público do autor quando disponível, datas e estado aberto/fechado. Não coleta email, perfil, comentários nem respostas. Corpo curto fica `insufficient`; categoria `Announcements` fica `announcement` sem supor feedback. As demais categorias ficam `not_assessed`, não classificadas como problema de cliente. Discussions são mostradas em seção própria; nenhuma é enviada automaticamente à OpenAI ou somada a reviews/Issues.
- A coleta é manual e limitada a três páginas, 50 itens e até 20 por chamada. Cursor GraphQL fica em `source_runs`. Uma janela incompleta pode continuar na próxima execução; após completada, a seguinte começa do topo ordenado por atualização e captura edições. Cursors em listas mutáveis não garantem cobertura histórica perfeita, por isso a interface expõe `scan_complete`. Retry local limitado cobre rede/5xx; rate limit usa `Retry-After` ou reset, inclusive quando GraphQL retorna erro com HTTP 200. 401/403 sem indicação de rate limit, repositório indisponível e payload inválido são falhas explícitas. Não há scraping.

## Evidência e limites

O E2E usa GraphQL local controlado e cobre cadastro, RBAC, paginação entre execuções, deduplicação, edição, proveniência, ausência de análise, tenant cruzado e leitura pela API. Testes determinísticos cobrem ausência de token, repositório privado, Discussions desabilitadas, resposta GraphQL com erro, rate limit, 5xx e URL inesperada. A migração é aditiva e foi aplicada ao banco local sem reset. Nenhuma chamada paga de IA foi feita.

Em uma verificação posterior, `GITHUB_DISCUSSIONS_TOKEN` estava presente tanto no processo Node que inicia `dev:worker` quanto no Python filho. O banco registrava três execuções de `vercel/next.js` como `failed/graphql_error`, zero itens. Uma consulta diagnóstica real devolveu HTTP 200 com um erro de schema: `isClosed` não existe em `Discussion`; o campo oficial é `closed`. A query e o modelo foram corrigidos, e outra consulta real, limitada a uma página e cinco itens, passou sem persistência em tenant. O tratamento agora distingue 401, 403, permissão, rate limit e query inválida por códigos seguros; o texto bruto da resposta não vai para logs nem banco. Isso confirma a chamada de leitura corrigida, mas a coleta real completa pela interface ainda requer nova execução pelo operador.

GitHub Discussions não verifica se o autor é cliente nem representa o mercado. Mesmo uma categoria chamada “Ideas” não confirma uma necessidade de compra. O próximo passo é selecionar uma fonte de reviews B2B cujo acesso, armazenamento e uso sejam permitidos, preservar proveniência e obter rótulos humanos cegos às previsões para medir a extração antes de gerar sinais ou alertas.

## Referências oficiais

- [GraphQL Discussions e campos](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
- [Autenticação GraphQL](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)
- [Paginação por cursor](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [Limites primários e secundários](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [Campos Repository](https://docs.github.com/en/graphql/reference/repos)
