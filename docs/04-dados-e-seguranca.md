# Banco, isolamento e por que existe o schema SQL

Um schema e o contrato de persistencia: define o que pode ser gravado, quais dados se relacionam e o que o banco recusa. `db/migrations/001_initial.sql` cria as entidades fundamentais; `002_full_product.sql` amplia o modelo para coleta continua, sinais, recomendacoes, alertas, chat, uso e auditoria; `003_first_slice.sql` acrescenta login por senha, fonte manual e marcacao de dados sinteticos; `004_account_security.sql` acrescenta sessoes revogaveis e convites; `005_review_analysis.sql` acrescenta analises versionadas e multiplos problemas por documento. Migracoes sao versionadas com o codigo e aplicadas em ordem em cada ambiente.

## Exemplos concretos

- `tenants` representa empresas clientes; `memberships` liga usuarios a empresas com papel.
- `products` inclui o produto proprio e concorrentes; `sources` liga uma URL a um produto do mesmo tenant.
- `documents` guarda o texto original, URL, data e chave externa; `document_analyses` guarda estado, modelo e versoes; `insights` guarda problemas com trecho literal validado.
- `imports` e `import_rows` guardam estado e entradas de um CSV pequeno ate o worker processar; o Redis recebe somente IDs.
- `document_embeddings` guarda vetor **alem do texto**, para encontrar documentos semanticamente proximos. O vetor nao substitui fonte nem permite calcular contagens exatas.
- `price_observations` e uma serie temporal de precos observados. Mudanca percentual depende de mesmo plano, moeda e periodo comparaveis.
- `subscriptions` guarda o estado atual de assinatura, mas o MVP pode deixar billing desabilitado.
- `source_runs`/`source_snapshots` registram execucoes, cursores e capturas; `release_events` registra lancamentos.
- `market_signals` e `signal_evidence` ligam deteccoes aos dados; `recommendations` e `alerts` tornam a hipotese revisavel.
- `chat_threads`/`chat_messages`/`chat_citations`, `usage_daily` e `audit_events` sustentam pesquisa, limites e rastreabilidade.

## Isolamento

A coluna tenant_id acompanha produtos, fontes, documentos, insights, vetores e precos. Chaves estrangeiras (tenant_id, id) impedem ligar uma fonte de A a um produto de B. RLS restringe linhas visiveis e gravaveis ao contexto da transacao. A API resolve a sessao revogavel, confirma membership e papel antes de definir app.tenant_id; o worker revalida fonte e tenant. O login de runtime nao pode ser superuser, BYPASSRLS nem dono das tabelas.

O parametro customizado app.tenant_id e um contexto de aplicacao, nao autenticacao criptografica. Nao exponha SQL arbitrario ao cliente; use consultas parametrizadas. Em conexoes reaproveitadas, defina o contexto em cada transacao e encerre-a; nao use SET de sessao persistente. Teste rotas, jobs, joins e buscas com dois tenants.

## Busca vetorial

A migracao escolhe vector(1536) como placeholder de um modelo a definir. Se o modelo escolhido usar outra dimensao, altere a migracao **antes de haver dados** ou crie uma nova tabela/migracao. Filtre por tenant e model_id. Comece com busca exata e indice btree em (tenant_id, model_id). Meça volume e latencia antes de introduzir HNSW ou particionamento.

## Ajustes antes de producao

As migracoes 001 a 005 foram aplicadas em PostgreSQL 16 com pgvector no ambiente local em 2026-09-24; testes com dois tenants exerceram RLS em leitura e escrita. A implementacao ainda tera de escolher modelo de embedding, politicas de retencao, armazenamento de capturas e provedor de assinatura. Depois de uma instalacao publica, mudancas devem entrar por novas migracoes. Revisar URLs externas, retencao de texto, licencas/termos da fonte e dados pessoais antes de ativar coleta automatica ou analise externa.
