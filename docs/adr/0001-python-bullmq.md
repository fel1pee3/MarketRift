# ADR 0001: BullMQ no Node e no Python

**Status:** adotado na primeira fatia. O teste E2E TypeScript → BullMQ → Python passou em 2026-09-23.

**Contexto:** a API NestJS precisa publicar jobs sem bloquear requisicoes. A extracao e em Python. A documentacao oficial atual disponibiliza `bullmq` para Python com `Worker` assincrono.

**Decisao:** NestJS publica jobs em Redis/BullMQ e um processo Python dedicado os consome. FastAPI expõe apenas endpoints internos de consulta/saude; seu ciclo de vida nao substitui o worker de fila.

**Contrato:** JSON Schema v1 em packages/contracts, IDs em vez de payload grande, idempotencia no banco, erro observavel, retry limitado com backoff. Teste de integracao entre as linguagens e obrigatorio antes de depender dessa interoperabilidade em producao.

**Alternativa se o teste falhar:** worker BullMQ em Node chamando servico Python por HTTP interno autenticado, com timeout e idempotencia. Nao implementar dois consumidores em paralelo sem motivo.

Referencia: https://docs.bullmq.io/python/introduction
