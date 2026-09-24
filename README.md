# MarketRift

**Plataforma B2B de inteligência competitiva baseada em evidências.** Empresas acompanham seus produtos e concorrentes; o sistema coleta avaliações públicas, mudanças de preço e notas de versão, identifica sinais relevantes e propõe ações para revisão humana.

> Este repositório contém a **especificação do produto completo** e fatias funcionais de conta, portfólio, importação e análise versionada de avaliações. Os marcos de entrega são uma ordem de construção, não uma redução do objetivo final.

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

De volta à raiz, aplique as seis migrações em um banco vazio e crie logins distintos de runtime e provisionamento:

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

Para atualizar um banco que já tem a migração 004, aplique a migração de análise sem apagar os documentos:

```powershell
npm run db:migrate:analysis
```

O comando detecta se as tabelas da migração 004 já existem. Um `.env` antigo com `JWT_SECRET` continua aceito como segredo de transição; novas instalações usam `SESSION_SECRET`. A sessão anterior em `sessionStorage` deixa de valer: entre novamente após atualizar o código.

O E2E usa as portas 3210 (web) e 3211 (API), além do banco Redis local 15, para não disputar jobs com um worker de desenvolvimento em 3000/3001 e Redis 0. `E2E_REDIS_URL` permite escolher outro banco Redis para o teste. No navegador, use `http://localhost:3000`, igual ao `WEB_ORIGIN`; operações de escrita de outra origem são rejeitadas. Em produção, configure HTTPS, `WEB_ORIGIN` exato e um segredo aleatório: o cookie passa a usar `Secure` e o prefixo `__Host-`. Web e API devem estar no mesmo site para o cookie `SameSite=Lax` deste desenho.

O teste E2E inicia e encerra API, worker e web, verifica que a página é servida e usa chamadas HTTP à API; ainda não automatiza cliques no navegador. Em terminais separados, estes comandos de desenvolvimento também foram iniciados e verificados:

```powershell
npm run dev:api
npm run dev:web
npm run dev:worker
npm run dev:intelligence-http
```

O worker pode ficar sem novas mensagens no terminal enquanto espera jobs. O servidor FastAPI expõe somente `/health` nesta fase e não é necessário para o fluxo de importação. O Next.js grava o servidor de desenvolvimento em `apps/web/.next-dev` e o build de produção em `apps/web/.next`, para que os dois comandos não sobrescrevam os mesmos arquivos. Se o navegador avisar sobre hidratação e mostrar atributos como `bis_skin_checked`, `bis_register` ou `cz-shortcut-listen`, teste a página com as extensões desativadas: esses atributos são inseridos no HTML antes da hidratação do React.

Abra `http://localhost:3000`. Crie uma empresa, cadastre produto próprio e concorrente e associe ao concorrente uma fonte com URL `https://example.invalid/reviews`. Na seção **Importar CSV**, selecione essa fonte; no campo **Arquivo CSV**, use o seletor de arquivos para escolher `fixtures/reviews.example.csv` dentro da pasta do projeto e clique em **Enviar avaliações**. Abrir o CSV no editor apenas mostra seu conteúdo; não o importa. As duas linhas do exemplo são sintéticas, com URLs `.invalid` que não levam a páginas reais e marcação `synthetic=true`. A lista de importações mostra o estado; os documentos exibem texto, data e URL de origem. O FastAPI atual expõe apenas `/health` em `127.0.0.1:8000`.

Em **Membros e convites**, owner pode criar convites para admin, analyst ou viewer; admin pode convidar analyst ou viewer. Copie o código exibido uma única vez e entregue à pessoa convidada por canal seguro. Quem já tem conta entra e usa **Aceitar convite recebido**; quem é novo cola o código no formulário **Criar conta** usando o mesmo email do convite. Depois, **Empresa ativa** permite trocar de tenant. A sessão é recuperada após recarregar a página e termina ao clicar em **Sair**. O frontend não recebe o identificador secreto do cookie; mantém apenas um token CSRF em memória.

### Análise de avaliações

O worker grava cada avaliação e publica um job `analyze-document.v1` com IDs e versão do extrator. Uma análise pode produzir vários problemas com categoria, sentimento negativo, gravidade, descrição e trecho literal da avaliação. A API mostra o estado e os problemas junto do documento; respostas malformadas ou trechos que não existam no texto original ficam em estado de falha e não aparecem como insights. Avaliações positivas podem resultar em zero problemas. O botão **Reenfileirar análise** aparece apenas quando a análise está pendente, indisponível ou falhou; análises concluídas não precisam ser reenfileiradas. Ao mudar modelo, prompt, schema ou taxonomia, aumente `EXTRACTOR_VERSION` em API e worker e reenfileire o documento para manter as versões anteriores auditáveis.

Sem chave de provedor, o padrão é `ANALYSIS_PROVIDER=disabled`: o fluxo registra `unavailable` e **não publica uma análise simulada**. Para usar OpenAI, configure somente no `.env` local `ANALYSIS_PROVIDER=openai`, `ANALYSIS_MODEL=gpt-5-nano` e `OPENAI_API_KEY` com sua chave; reinicie API e worker. Reenfileire apenas documentos pendentes, indisponíveis ou falhos; documentos novos são analisados automaticamente. A aplicação envia o texto da avaliação ao provedor escolhido, portanto use apenas dados cuja análise externa seja permitida. Em 2026-09-24, a chamada direta real foi verificada com quatro exemplos sintéticos. O fluxo completo também foi observado na interface para `demo-001` e `demo-002`: ambos ficaram `completed` com `model_id=gpt-5-nano` no banco. A integração usa `ChatOpenAI.with_structured_output` do LangChain e Pydantic, com validação literal adicional. O provedor controlado de teste só pode ser usado com `MARKETRIFT_TEST_MODE=1`; o E2E o ativa e a interface identifica seus resultados como teste, nunca como análise de IA.

A avaliação legada abaixo usa seis exemplos **sintéticos** com rótulos definidos no próprio repositório. Ela verifica a rotina de comparação por categoria e de validade de evidências; seus números não medem precisão em avaliações reais rotuladas por pessoas:

```powershell
npm run eval:analysis:test
```

Em 2026-09-24, o antigo comando de chamada direta ao OpenAI passou em quatro exemplos sintéticos: quatro respostas estruturadas, quatro trechos literais válidos e nenhum resultado malformado. Essa execução histórica confirma a integração, não mede precisão em avaliações reais. O script `eval:analysis:openai` agora aponta para o avaliador com orçamento e exige as opções explícitas descritas abaixo. Não há estatísticas agregadas de reclamações no painel nesta etapa; dados sintéticos seguem identificados e não entram em qualquer métrica de dados reais.

### Avaliação reproduzível da qualidade

`evalsets/review-quality.synthetic.v1.json` contém seis casos criados para teste; `evalsets/real.template.json` está vazio porque ainda não há avaliações reais autorizadas e rotuladas por pessoas neste repositório. O avaliador usa o mesmo `extract_review` do worker, não grava nas tabelas dos tenants e exporta somente IDs, rótulos, métricas, versões, tokens e custo estimado, sem texto, URLs ou trechos das avaliações.

```powershell
npm run eval:quality -- --dataset evalsets/review-quality.synthetic.v1.json --max-examples 6 --output .tmp/quality-synthetic.json
```

O padrão é o provedor controlado e custa **USD 0** em API. Para rodar em textos reais, primeiro obtenha permissão de uso/envio ao provedor e rótulos humanos. Depois informe `--provider openai --model`, `--allow-paid`, `--max-examples`, `--budget-usd` e taxas de entrada/saída verificadas por você. O comando limita a saída, desliga retries e compara uma reserva estimada de tokens ao orçamento antes de cada chamada; a reserva não substitui a fatura do provedor. Veja [o guia de rotulagem e execução](evalsets/README.md) e [ADR 0005](docs/adr/0005-avaliacao-qualidade-extracao.md). Resultados perfeitos no conjunto sintético demonstram que o avaliador funciona, não que a IA seja confiável em dados reais.

### Primeira fonte real: Issues públicas do GitHub

Cadastre um produto ou concorrente e, na seção **Issues públicos do GitHub**, informe `owner/repo` ou `https://github.com/owner/repo`. Apenas repositórios públicos na API oficial são aceitos. `owner` e `admin` cadastram fontes; `owner`, `admin` e `analyst` podem pedir coleta manual. O formulário sugere **até 20 Issues em duas páginas**; os limites absolutos da API são 1–50 itens e 1–3 páginas por execução. O worker deve estar ligado. A interface atualiza estado, novas/atualizadas, páginas, Pull Requests ignorados, última coleta e links para as Issues. Em erro de rate limit, aguarde o horário exibido antes de tentar novamente.

O job `sync-github-issues.v1` contém somente IDs, versão e chave de idempotência; não transporta conteúdo nem credencial. O worker consulta `api.github.com`, descarta Pull Requests, conserva título, corpo, URL, repositório, datas e estado, e atualiza Issues alteradas sem duplicar por tenant/fonte/ID externo. A primeira coleta limitada pega itens recentes; não constitui cópia histórica completa. As execuções seguintes consultam atualizações a partir do cursor da última execução bem-sucedida com um minuto de sobreposição. O limite público não autenticado é compartilhado por IP; não há token GitHub configurado nesta etapa. A coleta não chama OpenAI e seu custo de API de IA é **USD 0**.

**Uma Issue pública não é avaliação de cliente.** Ela pode ser bug, pedido de funcionalidade ou discussão de mantenedores. Não a trate como reclamação comprovada nem como amostra representativa do mercado. O extrator atual foi projetado para reviews; Issues ficam disponíveis para revisão humana, sem classificação, insight automático ou estatística de avaliações. Para testar localmente, use um repositório público apropriado e faça uma coleta curta; confira que o link abre a Issue, que uma segunda coleta não duplica documentos e que uma edição na origem atualiza o mesmo documento. Para medir qualidade depois, selecione manualmente uma amostra diversa com URLs e datas, rotule categorias e trechos **antes de ver previsões**, crie um conjunto versionado específico para Issues e use um extrator/avaliador próprio. O avaliador de reviews em `evalsets/` não mede a qualidade em Issues nem em reviews reais por si só. Veja [ADR 0006](docs/adr/0006-github-issues-publicas.md).

Em banco existente, preserve o volume e aplique a migração aditiva:

```powershell
npm run db:migrate:github
```

Em banco vazio, `npm run db:setup` aplica as seis migrações. Depois, inicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em terminais separados. O FastAPI de health não participa da coleta.

### Migrações

São **seis migrações do mesmo banco PostgreSQL**, não bancos alternativos. `001_initial.sql` cria a base; `002_full_product.sql` acrescenta o domínio do produto completo; `003_first_slice.sql` acrescenta senha, fontes manuais e marcação sintética; `004_account_security.sql` acrescenta sessões revogáveis e convites; `005_review_analysis.sql` acrescenta análises versionadas e múltiplos problemas por avaliação; `006_github_issues.sql` acrescenta fonte, documentos e estado de coleta de Issues. `db:setup` aplica 001 a 006 em banco novo e cria os logins limitados. `db:migrate:account`, `db:migrate:analysis` e `db:migrate:github` aplicam somente a migração respectiva sobre um banco existente.

## Ordem de construção

Siga [03-plano-de-implementacao.md](docs/03-plano-de-implementacao.md) até todos os critérios de aceite do produto estarem satisfeitos. A primeira entrega vertical usa CSV para validar o caminho de dados; depois entram conectores contínuos, preço, lançamentos, sinais, alertas, recomendações, chat e operação SaaS. CSV é um degrau de engenharia, não o destino do projeto.

## Licença

O código, a documentação e as fixtures sintéticas deste repositório são disponibilizados sob a [Apache License 2.0](LICENSE). Ela permite uso, modificação e distribuição, inclusive comercial, nos termos da licença. Também permite hospedar uma versão modificada sem publicar essas modificações. Dependências de terceiros conservam suas próprias licenças. Veja [NOTICE](NOTICE) para a atribuição do projeto.

## Estado atual

Em 2026-09-24, `001` a `006` foram aplicadas em PostgreSQL 16 com pgvector. Os logins de runtime e provisionamento não têm `SUPERUSER` nem `BYPASSRLS`. Os testes de banco cobrem RLS, deduplicação, múltiplos problemas, ausência de reclamação, falha do provedor, mudança de versão, repetição e atualização de Issues. O E2E de serviços passou anteriormente no caminho API → BullMQ → Python → PostgreSQL → API com provedor controlado de teste, além de verificar que a página web é servida. A avaliação de qualidade com provedor controlado pontuou os seis casos sintéticos sem chamada paga; veja [ADR 0004](docs/adr/0004-analise-de-avaliacoes.md), [ADR 0005](docs/adr/0005-avaliacao-qualidade-extracao.md) e [ADR 0006](docs/adr/0006-github-issues-publicas.md) para decisões e limites. Os resultados atuais de lint, build e testes são registrados na resposta de encerramento.

Esta ainda é uma fatia do produto. Faltam recuperação de senha, entrega automática de convites, proteção contra tentativas repetidas, conectores contínuos autorizados, avaliação da extração em dados reais rotulados por pessoas, sinais, alertas, recomendações, chat RAG, billing e operação SaaS. O próximo marco é rotular e medir a qualidade em uma amostra legítima de Issues públicas com contrato próprio; depois, conectar uma fonte permitida de **avaliações de clientes** e medir também a qualidade nesses dados antes de usar insights em tendências.
