# Interfaces, eventos e contratos

## Modulos API NestJS

Auth/Memberships, Tenants/Subscriptions, Products/Competitors, Sources/CollectionRuns, Imports/Documents, Insights/Signals, Prices/Releases, Recommendations/Alerts, Questions/Chat e Audit/Usage. Guards validam tenant e papel antes da camada de servico. Endpoints paginados, filtros por periodo e identificadores opacos.

## Rotas principais planejadas

| Area | Rotas representativas |
| --- | --- |
| Conta | POST /v1/tenants, POST /v1/memberships/invitations, GET /v1/me |
| Portfolio | POST/GET /v1/products, POST/GET /v1/topics |
| Fontes | POST/GET /v1/sources, POST /v1/sources/:id/run, GET /v1/sources/:id/runs |
| Importacao | POST /v1/imports/reviews, GET /v1/imports/:id |
| Inteligencia | GET /v1/insights/summary, GET /v1/signals, GET /v1/signals/:id/evidence |
| Mudancas | GET /v1/prices/history, GET /v1/releases |
| Acao | GET /v1/alerts, PATCH /v1/alerts/:id, GET/PATCH /v1/recommendations/:id |
| Pesquisa | POST /v1/questions, GET /v1/chat/threads/:id |
| Conta comercial | GET /v1/subscription, GET /v1/usage |

## Eventos de fila

`collect-source.v1`: tenant_id, source_id, run_id, idempotency_key.
`ingest-review.v1`: tenant_id, source_id, import_id, idempotency_key (JSON Schema ja incluido).
`analyze-document.v1`: tenant_id, document_id, extractor_version, idempotency_key.
`detect-signals.v1`: tenant_id, product_id, window_start/end, detector_version.
`build-recommendation.v1`: tenant_id, signal_id, generator_version.

Todos possuem version, UUIDs, tamanho maximo, schema JSON compartilhado e um teste de contrato entre produtor TypeScript e worker Python. Nenhum job inclui JWT, chave de API ou texto completo. Contratos ainda nao criados alem do primeiro devem ser implementados junto dos modulos correspondentes.

## Servico FastAPI interno

`POST /internal/questions/answer` recebe tenant validado, pergunta e limites; devolve answer, citations, data_window, insufficient_evidence. `POST /internal/documents/extract` pode apoiar reprocessamento sincrono controlado, mas o fluxo volumoso passa pela fila. Autenticacao servico-a-servico, timeout, tracing e validacao do tenant no banco sao obrigatorios.

## Interface web

Telas: onboarding, portfolio/concorrentes, fontes e saude da coleta, dashboard de temas e comparacao, cronologia de preco e lancamentos, feed de sinais/alertas, detalhe com evidencias, revisao de recomendacoes, chat, membros/assinatura/uso. Estados vazios e falhas devem explicar cobertura e proximos passos.
