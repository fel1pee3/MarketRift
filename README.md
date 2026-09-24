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
(Get-Content .env) -replace '^SESSION_SECRET=.*$', "SESSION_SECRET=$jwtKey" | Set-Content .env
docker compose up -d
npm install
python -m venv apps/intelligence/.venv
```

Se 5433 ou 6380 já estiverem ocupadas, altere `POSTGRES_HOST_PORT`/`REDIS_HOST_PORT` e as URLs correspondentes no `.env` antes de subir os contêineres. Nesta sessão, usei 5543 e 6381. O Compose sobe PostgreSQL com pgvector e Redis; `.env` é ignorado pelo Git.

Na pasta `apps/intelligence`, instale o pacote Python:

```powershell
.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

De volta à raiz, aplique as quatro migrações em um banco vazio e crie logins distintos de runtime e provisionamento:

```powershell
npm run db:setup
npm run lint
npm run build
npm run test
npm run test:db
npm run test:e2e
```

Se você já usava o banco da primeira fatia, preserve o volume e aplique somente a migração aditiva da conta:

```powershell
npm run db:migrate:account
```

O comando detecta se as tabelas da migração 004 já existem. Um `.env` antigo com `JWT_SECRET` continua aceito como segredo de transição; novas instalações usam `SESSION_SECRET`. A sessão anterior em `sessionStorage` deixa de valer: entre novamente após atualizar o código.

O E2E usa as portas 3210 (web) e 3211 (API) para não interromper os servidores de desenvolvimento em 3000/3001. No navegador, use `http://localhost:3000`, igual ao `WEB_ORIGIN`; operações de escrita de outra origem são rejeitadas. Em produção, configure HTTPS, `WEB_ORIGIN` exato e um segredo aleatório: o cookie passa a usar `Secure` e o prefixo `__Host-`. Web e API devem estar no mesmo site para o cookie `SameSite=Lax` deste desenho.

O teste E2E inicia e encerra API, worker e web. Em terminais separados, estes comandos de desenvolvimento também foram iniciados e verificados:

```powershell
npm run dev:api
npm run dev:web
npm run dev:worker
npm run dev:intelligence-http
```

O worker pode ficar sem novas mensagens no terminal enquanto espera jobs. O servidor FastAPI expõe somente `/health` nesta fase e não é necessário para o fluxo de importação. O Next.js grava o servidor de desenvolvimento em `apps/web/.next-dev` e o build de produção em `apps/web/.next`, para que os dois comandos não sobrescrevam os mesmos arquivos. Se o navegador avisar sobre hidratação e mostrar atributos como `bis_skin_checked`, `bis_register` ou `cz-shortcut-listen`, teste a página com as extensões desativadas: esses atributos são inseridos no HTML antes da hidratação do React.

Abra `http://localhost:3000`. Crie uma empresa, cadastre produto próprio e concorrente e associe ao concorrente uma fonte com URL `https://example.invalid/reviews`. Na seção **Importar CSV**, selecione essa fonte; no campo **Arquivo CSV**, use o seletor de arquivos para escolher `fixtures/reviews.example.csv` dentro da pasta do projeto e clique em **Enviar avaliações**. Abrir o CSV no editor apenas mostra seu conteúdo; não o importa. As duas linhas do exemplo são sintéticas, com URLs `.invalid` que não levam a páginas reais e marcação `synthetic=true`. A lista de importações mostra o estado; os documentos exibem texto, data e URL de origem. O FastAPI atual expõe apenas `/health` em `127.0.0.1:8000`.

Em **Membros e convites**, owner pode criar convites para admin, analyst ou viewer; admin pode convidar analyst ou viewer. Copie o código exibido uma única vez e entregue à pessoa convidada por canal seguro. Quem já tem conta entra e usa **Aceitar convite recebido**; quem é novo cola o código no formulário **Criar conta** usando o mesmo email do convite. Depois, **Empresa ativa** permite trocar de tenant. A sessão é recuperada após recarregar a página e termina ao clicar em **Sair**. O frontend não recebe o identificador secreto do cookie; mantém apenas um token CSRF em memória.

### Migrações

São **quatro migrações do mesmo banco PostgreSQL**, não bancos alternativos. `001_initial.sql` cria a base; `002_full_product.sql` acrescenta o domínio do produto completo; `003_first_slice.sql` acrescenta senha, fontes manuais e marcação sintética; `004_account_security.sql` acrescenta sessões revogáveis e convites. `db:setup` aplica 001 a 004 em banco novo e cria os logins limitados. `db:migrate:account` aplica 004 sobre o banco existente sem recriá-lo.

## Ordem de construção

Siga [03-plano-de-implementacao.md](docs/03-plano-de-implementacao.md) até todos os critérios de aceite do produto estarem satisfeitos. A primeira entrega vertical usa CSV para validar o caminho de dados; depois entram conectores contínuos, preço, lançamentos, sinais, alertas, recomendações, chat e operação SaaS. CSV é um degrau de engenharia, não o destino do projeto.

## Licença

O código, a documentação e as fixtures sintéticas deste repositório são disponibilizados sob a [Apache License 2.0](LICENSE). Ela permite uso, modificação e distribuição, inclusive comercial, nos termos da licença. Também permite hospedar uma versão modificada sem publicar essas modificações. Dependências de terceiros conservam suas próprias licenças. Veja [NOTICE](NOTICE) para a atribuição do projeto.

## Estado atual

Em 2026-09-23, `001` a `004` foram aplicadas em PostgreSQL 16 com pgvector. Os logins de runtime e provisionamento não têm `SUPERUSER` nem `BYPASSRLS`. `npm run test:db` passou com dois tenants, RLS e repetição de jobs; `npm run test:e2e` passou no caminho web → API → BullMQ → Python → PostgreSQL → API e cobriu sessão, CSRF, convites, papéis, troca de tenant e deduplicação. `npm run lint`, `npm run build`, `npm run test` e os testes Python passaram. Veja [ADR 0002](docs/adr/0002-primeira-fatia.md) e [ADR 0003](docs/adr/0003-sessoes-e-membros.md) para decisões e limites.

Esta ainda é uma fatia do produto. Faltam recuperação de senha, entrega automática de convites, proteção contra tentativas repetidas, conectores contínuos autorizados, extração avaliada por IA, sinais, alertas, recomendações, chat RAG, billing e operação SaaS. O próximo passo concreto é a extração de avaliações com IA, usando saída estruturada, evidência literal, versionamento e um conjunto de avaliação rotulado antes de exibir análises no painel.
