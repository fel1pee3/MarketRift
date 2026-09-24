# MarketRift

**Plataforma B2B de inteligência competitiva baseada em evidências.** Empresas acompanham seus produtos e concorrentes; o sistema coleta avaliações públicas, mudanças de preço e notas de versão, identifica sinais relevantes e propõe ações para revisão humana.

> Este repositório contém a **especificação do produto completo** e a primeira fatia funcional: conta, portfólio, fonte manual, CSV, fila, worker e documentos. Os marcos de entrega são uma ordem de construção, não uma redução do objetivo final.

## O produto completo

Uma empresa cadastra seu produto, até três concorrentes iniciais e os temas que quer acompanhar. Conectores permitidos monitoram fontes selecionadas. O pipeline preserva o texto e sua origem, extrai problemas e mudanças, mede tendências comparáveis e destaca oportunidades com evidências. O painel apresenta gráficos, alertas e recomendações revisáveis. Um chat responde perguntas com referências e declara quando faltam dados.

Exemplo: “O plano mensal do concorrente B passou de R$ 100 para R$ 115 na mesma moeda e periodicidade. Na última janela, 19 de 80 avaliações mencionaram suporte demorado, versus 8 de 75 na janela anterior. Confira as fontes. Ação proposta: validar nosso tempo real de resposta e avaliar campanha destacando esse diferencial.” O sistema **não** afirma ter provado ganho de market share ou causalidade.

## Capacidades previstas

| Área | Entrega final |
| --- | --- |
| SaaS | Onboarding, organizações, usuários, RBAC, isolamento multi-tenant, assinatura e limites |
| Monitoramento | Cadastro de concorrentes e fontes; conectores de avaliações, preços e release notes; execução agendada e incremental |
| Processamento | Deduplicação, proveniência, extração estruturada, embeddings, versões de modelos e avaliação de qualidade |
| Inteligência | Tendências, detecção de picos, mudanças comparáveis, lacunas frente ao produto próprio, pontuação explicável |
| Ação | Alertas e planos de ação com evidências, revisão humana e histórico |
| Pesquisa | Dashboard com filtros e chat RAG que cita textos, datas e links; métricas exatas vêm de SQL |
| Operação | Retry, observabilidade, testes de isolamento, custos por fonte/modelo, documentação e implantação |

O escopo completo está em [00-escopo-completo.md](docs/00-escopo-completo.md); a definição objetiva de “pronto” está em [08-criterios-produto-completo.md](docs/08-criterios-produto-completo.md).

## Arquitetura

| Serviço | Tecnologia | Responsabilidade |
| --- | --- | --- |
| Interface | Next.js, React, TypeScript | Configuração, painel, alertas, revisão e chat |
| API | NestJS, TypeScript | Auth, RBAC, tenants, assinatura, API pública e orquestração |
| Fila | Redis, BullMQ | Jobs de coleta e análise com retry e agendamento |
| Inteligência | Python, BullMQ Python, FastAPI, Pydantic | Conectores, extração, sinais, embeddings e RAG |
| Dados | PostgreSQL, pgvector | Dados relacionais, séries de observações e busca vetorial |
| Arquivos | Armazenamento de objetos a configurar | Capturas brutas e rastreabilidade, com retenção definida |

Veja [02-arquitetura.md](docs/02-arquitetura.md), [05-sinais-e-decisoes.md](docs/05-sinais-e-decisoes.md) e [07-interfaces-e-contratos.md](docs/07-interfaces-e-contratos.md).

## Estrutura

```text
MarketRift/
├── apps/web/                 # aplicação Next.js
├── apps/api/                 # API NestJS
├── apps/intelligence/        # worker BullMQ Python e FastAPI interno
├── packages/contracts/      # schemas de jobs e respostas
├── db/migrations/            # banco inicial e expansão do produto
├── fixtures/                 # exemplos sintéticos identificados
├── docs/                     # escopo, arquitetura, decisões, plano e aceite
├── compose.yaml              # Postgres e Redis locais
└── .env.example
```

## Desenvolvimento local

Com Docker Desktop, Node.js 22 e Python 3.13, execute na raiz em PowerShell. Estes comandos foram executados nesta sessão. O banco deve estar vazio para `db:setup`.

```powershell
Copy-Item .env.example .env
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$jwtKey = [BitConverter]::ToString($bytes).Replace('-','')
(Get-Content .env) -replace '^JWT_SECRET=.*$', "JWT_SECRET=$jwtKey" | Set-Content .env
docker compose up -d
npm install
python -m venv apps/intelligence/.venv
```

Se 5433 ou 6380 já estiverem ocupadas, altere `POSTGRES_HOST_PORT`/`REDIS_HOST_PORT` e as URLs correspondentes no `.env` antes de subir os contêineres. Nesta sessão, usei 5543 e 6381. O Compose sobe PostgreSQL com pgvector e Redis; `.env` é ignorado pelo Git.

Na pasta `apps/intelligence`, instale o pacote Python:

```powershell
.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

De volta à raiz, aplique as três migrações e crie logins distintos de runtime e provisionamento:

```powershell
npm run db:setup
npm run lint
npm run build
npm run test
npm run test:db
npm run test:e2e
```

O teste E2E inicia e encerra API, worker e web. Em terminais separados, estes comandos de desenvolvimento também foram iniciados e verificados:

```powershell
npm run dev:api
npm run dev:web
npm run dev:worker
npm run dev:intelligence-http
```

Abra `http://localhost:3000`. Crie uma empresa, cadastre produto próprio e concorrente, associe uma fonte manual ao concorrente e envie `fixtures/reviews.example.csv`. As duas linhas do exemplo são sintéticas, com URLs `.invalid` e marcação `synthetic=true`. A lista de importações mostra o estado; os documentos exibem texto, data e URL de origem. O FastAPI atual expõe apenas `/health` em `127.0.0.1:8000`.

### Migrações

São **três migrações do mesmo banco PostgreSQL**, não bancos alternativos. `001_initial.sql` cria a base; `002_full_product.sql` acrescenta o domínio do produto completo; `003_first_slice.sql` acrescenta autenticação por senha, fontes manuais e marcação de dados sintéticos. `db:setup` aplica 001, 002 e 003 em banco novo e cria os logins limitados. Futuras mudanças devem usar novas migrações.

## Ordem de construção

Siga [03-plano-de-implementacao.md](docs/03-plano-de-implementacao.md) até todos os critérios de aceite do produto estarem satisfeitos. A primeira entrega vertical usa CSV para validar o caminho de dados; depois entram conectores contínuos, preço, lançamentos, sinais, alertas, recomendações, chat e operação SaaS. CSV é um degrau de engenharia, não o destino do projeto.

## Estado atual

Em 2026-09-23, `001`, `002` e `003` foram aplicadas em PostgreSQL 16 com pgvector. Os logins de runtime e provisionamento não têm `SUPERUSER` nem `BYPASSRLS`. `npm run test:db` passou com dois tenants, RLS e repetição de jobs; `npm run test:e2e` passou no caminho web → API → BullMQ → Python → PostgreSQL → API. `npm run lint`, `npm run build`, `npm run test` e o lint/testes Python passaram. Veja [ADR 0002](docs/adr/0002-primeira-fatia.md) para decisões e limites.

Esta é a primeira fatia. Ainda faltam convites, troca de tenant, recuperação de senha, conectores contínuos autorizados, extração avaliada por IA, sinais, alertas, recomendações, chat RAG, billing e operação SaaS. O próximo passo é implementar tratamento de contas e sessão mais completo e iniciar um conector contínuo somente após confirmar as condições de acesso da fonte.
