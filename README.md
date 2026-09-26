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

## Navegação do painel atual

Com API e web iniciadas (`npm run dev:api` e `npm run dev:web` em terminais separados), entre em `http://localhost:3000`. O menu leva diretamente às áreas abaixo; você também pode abrir qualquer URL e atualizar a página. O navegador recupera a sessão por cookie `HttpOnly`. Se a sessão expirou, a URL aberta mostra o formulário de entrada e volta à mesma área após o login.

| URL | O que contém |
| --- | --- |
| `http://localhost:3000/` | Visão geral da empresa ativa: produtos, associações de fontes, cobertura, últimas execuções, candidatos e alertas internos recentes. |
| `http://localhost:3000/fontes` | Cadastro de produtos, GitHub Issues/Discussions, Steam, CSV B2B e legado, G2 condicionado ao acesso, páginas e importações. Os atalhos internos levam ao conector desejado. |
| `http://localhost:3000/evidencias` | Busca com filtros, indicadores descritivos, Discussions, documentos e análises com origem. |
| `http://localhost:3000/perguntas` | Estado da indexação e perguntas extrativas com citações; sintéticos continuam excluídos por padrão. |
| `http://localhost:3000/revisao` | Candidatos, aprovação/descartes por owner/admin, reconciliação e alertas lidos/não lidos. |
| `http://localhost:3000/avaliacao-busca` | Conjuntos e julgamentos humanos da recuperação, separados do resumo executivo. |
| `http://localhost:3000/conta` | Empresa ativa, troca de tenant, membros, convites e logout (também no cabeçalho). |

A visão geral **não** coleta dados, chama IA ou aprova sinais ao abrir. “Fontes associadas” conta vínculos cadastrados, não documentos distintos; uma mesma origem em dois produtos não duplica o total de evidências. Issues, Discussions, reviews e páginas conservam rótulos e limites próprios. `TESTE`, coleta parcial, direitos pendentes, interpretação não confirmada e erros aparecem explicitamente. A API mantém a validação de membership, RBAC, CSRF e RLS nas operações; a navegação não concede permissão adicional.

Para conferir com dados existentes: abra `/`, siga “Produtos e fontes”, use os atalhos para uma origem já cadastrada, depois abra `/evidencias` e aplique um filtro. Em `/revisao`, confira os candidatos e alertas existentes sem clicar em aprovação. Abra `/avaliacao-busca` para ver os conjuntos humanos sem mudar rótulos. Em `/conta`, troque de empresa se sua conta pertencer a duas; volte a `/` e confirme que produtos, fontes e sinais agora são os da nova empresa. Atualize `/evidencias` diretamente no navegador para conferir restauração da sessão. Um viewer pode consultar dados autorizados, mas não cadastrar fontes, rotular nem aprovar candidatos.

Esta alteração de navegação não cria migração nem modifica o banco. As verificações da entrega são `npm run lint`, `npm run build`, `npm test`, `npm run test:db` e `npm run test:e2e`; o E2E serve as URLs diretas e exercita RBAC, CSRF e isolamento de tenants com dados controlados. Ele não automatiza cliques de navegador; o roteiro acima cobre a verificação visual e por teclado.

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

De volta à raiz, `db:setup` está configurado para aplicar as dezesseis migrações em um **banco vazio** e criar logins distintos de runtime e provisionamento. Não o execute em um banco existente:

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

Abra `http://localhost:3000`. Crie uma empresa, entre em `/fontes`, cadastre produto próprio e concorrente e associe ao concorrente uma fonte com URL `https://example.invalid/reviews`. Em **Importar CSV** nessa mesma página, selecione a fonte; no campo **Arquivo CSV**, use o seletor de arquivos para escolher `fixtures/reviews.example.csv` dentro da pasta do projeto e clique em **Enviar avaliações**. Abrir o CSV no editor apenas mostra seu conteúdo; não o importa. As duas linhas do exemplo são sintéticas, com URLs `.invalid` que não levam a páginas reais e marcação `synthetic=true`. A lista de importações mostra o estado; `/evidencias#documentos` exibe texto, data e URL de origem. O FastAPI atual expõe também as rotas internas documentadas nos marcos posteriores.

Em `/conta`, **Membros e convites** permite ao owner criar convites para admin, analyst ou viewer; admin pode convidar analyst ou viewer. Copie o código exibido uma única vez e entregue à pessoa convidada por canal seguro. Quem já tem conta entra e usa **Aceitar convite recebido**; quem é novo cola o código no formulário **Criar conta** usando o mesmo email do convite. **Empresa ativa** nessa página permite trocar de tenant. A sessão é recuperada após recarregar a página e termina ao clicar em **Sair**. O frontend não recebe o identificador secreto do cookie; mantém apenas um token CSRF em memória.

### Análise de avaliações

Na importação CSV, o worker grava cada avaliação e publica um job `analyze-document.v1` com IDs e versão do extrator. Reviews Steam coletadas não entram automaticamente nessa fila; exigem a ação explícita descrita abaixo. Uma análise pode produzir vários problemas com categoria, sentimento negativo, gravidade, descrição e trecho literal da avaliação. A API mostra o estado e os problemas junto do documento; respostas malformadas ou trechos que não existam no texto original ficam em estado de falha e não aparecem como insights. Avaliações positivas podem resultar em zero problemas. O botão **Reenfileirar análise** de CSV aparece apenas quando a análise está pendente, indisponível ou falhou; análises concluídas não precisam ser reenfileiradas. Ao mudar modelo, prompt, schema ou taxonomia, aumente `EXTRACTOR_VERSION` em API e worker e reenfileire o documento para manter as versões anteriores auditáveis.

Sem chave de provedor, o padrão é `ANALYSIS_PROVIDER=disabled`: o fluxo registra `unavailable` e **não publica uma análise simulada**. Para usar OpenAI, configure somente no `.env` local `ANALYSIS_PROVIDER=openai`, `ANALYSIS_MODEL=gpt-5-nano` e `OPENAI_API_KEY` com sua chave; reinicie API e worker. Reenfileire apenas documentos pendentes, indisponíveis ou falhos; avaliações CSV novas são analisadas automaticamente, enquanto reviews Steam exigem seleção individual. A aplicação envia o texto da avaliação ao provedor escolhido, portanto use apenas dados cuja análise externa seja permitida. Em 2026-09-24, a chamada direta real foi verificada com quatro exemplos sintéticos. O fluxo completo também foi observado na interface para `demo-001` e `demo-002`: ambos ficaram `completed` com `model_id=gpt-5-nano` no banco. A integração usa `ChatOpenAI.with_structured_output` do LangChain e Pydantic, com validação literal adicional. O provedor controlado de teste só pode ser usado com `MARKETRIFT_TEST_MODE=1`; o E2E o ativa e a interface identifica seus resultados como teste, nunca como análise de IA.

A avaliação legada abaixo usa seis exemplos **sintéticos** com rótulos definidos no próprio repositório. Ela verifica a rotina de comparação por categoria e de validade de evidências; seus números não medem precisão em avaliações reais rotuladas por pessoas:

```powershell
npm run eval:analysis:test
```

Em 2026-09-24, o antigo comando de chamada direta ao OpenAI passou em quatro exemplos sintéticos: quatro respostas estruturadas, quatro trechos literais válidos e nenhum resultado malformado. Essa execução histórica confirma a integração, não mede precisão em avaliações reais. O script `eval:analysis:openai` agora aponta para o avaliador com orçamento e exige as opções explícitas descritas abaixo. A visão de evidências acrescenta contagens descritivas por categoria, tipo de review e período; não mistura dados sintéticos com reais nem afirma qualidade da extração em SaaS B2B.

### Avaliação reproduzível da qualidade

`evalsets/review-quality.synthetic.v1.json` contém seis casos criados para teste; `evalsets/real.template.json` continua vazio. Há uma amostra **privada** de reviews Steam reais; o operador informou ter rotulado três casos de Portal 2 para verificar a ferramenta, sem medir qualidade para SaaS B2B. O avaliador usa o mesmo `extract_review` do worker, não grava nas tabelas dos tenants e exporta somente IDs, rótulos, métricas, versões, tokens e custo estimado, sem texto, URLs ou trechos das avaliações.

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

Em banco vazio, `npm run db:setup` aplica as onze migrações. Depois, inicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em terminais separados. O FastAPI de health não participa da coleta.

### Primeiro conector de avaliações reais: Steam User Reviews

Este conector é um **piloto técnico para produtos publicados no Steam**. Não cobre SaaS B2B em geral nem representa a opinião de todos os usuários de um produto. Ele usa somente a [API JSON de User Reviews documentada pelo Steam](https://partner.steamgames.com/doc/store/getreviews), sem scraping. Antes de operar um serviço público/comercial com conteúdo coletado, revise as [condições aplicáveis do Steam](https://store.steampowered.com/subscriber_agreement/) e as condições de uso/retensão dos dados. A documentação técnica da API não é autorização genérica de redistribuição comercial.

Com `docker compose up -d` e API, web e worker ligados, faça uma coleta pequena na interface:

1. Em **Produtos**, cadastre o produto Steam ou um concorrente. Em **Avaliações de usuários do Steam**, selecione esse produto, digite o App ID `620` ou uma URL de produto como `https://store.steampowered.com/app/620/` e clique em **Adicionar fonte Steam**. Não cole URL de review individual ou de outro domínio.
2. Na fonte cadastrada, deixe **Páginas = 1** e **Reviews = 5**, clique em **Coletar reviews** e espere o estado `succeeded`. A interface informa recebidas, novas, atualizadas, ignoradas e páginas. `scan_complete=false` significa que a janela não foi percorrida até o fim por causa dos limites; aumente-os somente após avaliar o volume e as condições da fonte.
3. Em **Documentos**, procure o selo **Avaliação de usuário do Steam** e confira produto associado, texto, idioma, datas, App ID e recomendação positiva/negativa. `voted_up` é o voto de recomendação da plataforma; uma recomendação negativa não prova uma dor específica. O link abre a página de avaliações do produto, **não uma review individual**: a resposta documentada não oferece um permalink individual confiável sem recorrer a dados do autor.
4. Clique em **Coletar reviews** novamente. O ID externo estável evita duplicatas; reviews sem mudança não incrementam `novas` nem `atualizadas`. A coleta seguinte usa o filtro de atualizações com sobreposição de 24 horas. O conector não faz backfill histórico completo. Se o volume exceder o limite, a janela pode ficar incompleta; monitore `scan_complete` e ajuste o limite antes de interpretar cobertura.
5. Se quiser testar IA em **uma** review, clique em **Analisar esta review (1 item)** no documento escolhido. Isso pode enviar o texto ao provedor configurado e gerar custo; a coleta por si só não chama OpenAI. `owner`, `admin` e `analyst` podem solicitar coleta/análise; `viewer` apenas lê. A taxonomia atual foi criada para suporte, preço, cobrança, desempenho, usabilidade e funcionalidades de software. Pode não cobrir reclamações sobre gameplay/conteúdo; ausência de problema extraído não comprova ausência de problema no texto.

A API aceita somente App ID ou URL HTTPS de produto no host esperado, cria `sync-steam-reviews.v1` com IDs e valida fonte, produto e tenant no worker. O destino HTTP de produção é fixo; um servidor local substituto só é habilitado no E2E por `MARKETRIFT_TEST_MODE=1`. A fonte guarda `recommendationid`, texto original, idioma, criação/atualização e recomendação, sem SteamID, perfil ou histórico de jogos do autor. Mesmo App ID em dois produtos gera documentos associados a cada produto; não some esses relatos duas vezes numa futura comparação.

Em banco já existente com a migração 006 aplicada, preserve o volume e execute:

```powershell
npm run db:migrate:steam
```

O E2E usa um servidor Steam simulado local e o provedor controlado de IA; não cobra OpenAI. Uma consulta direta real ao App ID `620` recebeu duas reviews em uma página. Um smoke test adicional consultou e persistiu **uma** review real em um tenant temporário, verificou `synthetic=false` e removeu o tenant e o documento em seguida; nenhum desses textos ficou em tenants de produção. Esses testes verificam acesso e armazenamento, não qualidade da IA nem permissão comercial ampla.

Para medir extração em dados reais, primeiro confirme que pode obter, armazenar e enviar as reviews ao provedor escolhido. A amostra privada atual tem **30 reviews reais distintas do App ID 620**, com 15 recomendações positivas e 15 negativas; contém 14 textos curtos, 13 médios e três longos. Dez reviews distintas estavam nos documentos locais; a preparação consultou mais duas páginas recentes (40 respostas) e uma página com filtro negativo (20 respostas), sem IA. Um App ID associado a dois produtos de teste não gera duas entradas para o mesmo `recommendationid`. A amostra é uma seleção operacional, não representativa do mercado nem prova de que contém 15 problemas. **O operador informou ter rotulado três reviews de Portal 2 para verificar a ferramenta; isso não mede qualidade para SaaS B2B.** Os textos ficam em `evalsets/private/`, ignorado pelo Git.

Na raiz do projeto, os comandos de preparação e validação executados foram:

```powershell
npm run eval:steam -- sources
npm run eval:steam -- sample --app-id 620 --limit 30 --fetch-missing --max-pages 2
npm run eval:steam -- sample --app-id 620 --limit 30 --balance-negative --max-pages 1
npm run eval:steam -- validate
```

Para continuar a rotulagem, confira sua base de uso/envio dos textos e descreva-a com suas palavras. O comando mostra uma review por vez, permite problema, ausência de problema ou evidência insuficiente, múltiplas categorias, tema fora da taxonomia, gravidade quando sustentada e trecho literal. Cada rótulo é salvo; `q` interrompe e a próxima execução retoma. Uma recomendação negativa do Steam não é automaticamente uma reclamação.

```powershell
npm run eval:steam -- label --labeler human:felipe --rights-basis 'DESCREVA AQUI SUA BASE REAL DE USO E ENVIO' --max-items 3
npm run eval:steam -- validate
```

Depois dos três rótulos, confirme que pode enviar os textos ao provedor, consulte as taxas atuais do modelo e preencha os valores solicitados. O comando abaixo configura **um lote pago opcional de no máximo três exemplos**; o opt-in, os limites e a validação do relatório são cobertos por testes, mas **nenhuma chamada paga foi executada nesta entrega**. Se a reserva estimada ultrapassar USD 0,05, o avaliador interrompe antes da próxima chamada e marca `budget_skipped`.

```powershell
$inputRate = Read-Host 'USD por 1M tokens de entrada (preço atual verificado)'
$outputRate = Read-Host 'USD por 1M tokens de saida (preço atual verificado)'
npm run eval:quality -- --dataset evalsets/private/reviews-v1.json --provider openai --model gpt-5-nano --allow-paid --max-examples 3 --max-output-tokens 1024 --budget-usd 0.05 --input-usd-per-million $inputRate --output-usd-per-million $outputRate --output .tmp/quality-steam-3.json
Get-Content .tmp/quality-steam-3.json
```

No relatório, confira `run.api_calls_attempted`, `run.stopped`, tokens, `run.usage_based_estimated_cost_usd`, `metrics` e o estado de cada exemplo **antes de ampliar**. O JSON e o terminal separam erros de provedor, formato, evidência ausente/inventada, falsos positivos/negativos por categoria e casos fora da taxonomia; não exportam textos nem URLs. Compare o custo estimado à cobrança real do provedor. Consulte [o guia de avaliação](evalsets/README.md), [ADR 0007](docs/adr/0007-steam-user-reviews.md) e [ADR 0008](docs/adr/0008-amostra-e-rotulagem-steam.md) para interpretar os resultados.

### Monitoramento de páginas públicas de preços e changelogs

O cadastro é separado das fontes de reviews. `owner` e `admin` cadastram e pausam/reativam uma página vinculada a um produto; `owner`, `admin` e `analyst` podem pedir verificação manual; `viewer` consulta. A API confirma a empresa ativa em cada operação. Fontes novas começam com monitoração ativa e primeira verificação prevista para logo após o cadastro. Fontes já existentes antes da migração 009 permanecem pausadas até um `owner`/`admin` reativá-las: isso evita iniciar coleta retroativa sem decisão humana.

O agendador separado (`npm run dev:scheduler`) consulta o horário persistido em PostgreSQL a cada 15 segundos e publica jobs `check-web-page.v1` com apenas IDs, versão e chave de idempotência. Transação, lock no banco, índice de uma execução ativa por fonte e chave do job impedem concorrência e repetição mesmo com duas instâncias. Há limite global de seis verificações de páginas por minuto e intervalo mínimo de um minuto por fonte. Após reinício, o agendador retoma horários vencidos aos poucos e republica jobs pendentes antigos com o mesmo ID. Falha transitória usa espera progressiva de 5, 10, 20, 40 até 60 minutos e respeita `Retry-After`; bloqueios permanentes aguardam ao menos a periodicidade escolhida. Pausar impede novas verificações e cancela as agendadas ainda pendentes; uma verificação já em curso pode terminar.

Cada verificação consulta `robots.txt` e uma página HTML/texto pública; segue no máximo dois redirecionamentos no mesmo host e só usa HTTPS. URLs com credenciais, parâmetros, portas diferentes de 443, IPs ou destinos DNS internos são recusadas. Cada conexão usa o IP público validado e TLS do host original. Há limite de 1 MB de resposta, 30 mil caracteres relevantes e respeito a `crawl-delay` quando informado. Falhas como 403, 404, 429, CAPTCHA, página sem conteúdo ou `robots.txt` indisponível ficam no estado da execução; o sistema não contorna acesso nem inventa um snapshot.

**Capturada** significa apenas que havia conteúdo público legível. O tipo escolhido no formulário é intenção de monitoramento, não prova sobre a página. A interpretação v2 registra `confirmed`, `partial` ou `unconfirmed` com motivo. Changelog exige contexto explícito de release/changelog, título de alteração de produto e link específico da entrada; artigos editoriais de página inicial, como o caso observado na Capco, não viram notas de versão. O índice `https://www.postgresql.org/docs/release/` continua sem entradas estruturadas confirmadas quando não há evidência suficiente. Preço exige contexto de preço e campos explícitos de plano, valor, moeda e período. Uma porcentagem só aparece entre capturas confirmadas com mesmo plano, moeda, período e condições textuais explícitas e iguais. O worker ignora navegação, rodapé, scripts, banners comuns e espaços triviais; conteúdo relevante igual não cria outra versão.

As capturas anteriores à v2 foram preservadas sem alterar seu JSON ou hash. A API as marca `needs_review` e não publica suas antigas entradas estruturadas como confirmação; diferenças envolvendo uma interpretação antiga exigem revisão humana. Nova interpretação da página só entra em um novo snapshot quando o conteúdo relevante mudar. Não há IA nem envio de páginas à OpenAI neste fluxo. Veja [ADR 0010](docs/adr/0010-agendamento-e-interpretacao-paginas.md).

No banco **existente** desta instalação, a 008 já estava aplicada e a 009 foi aplicada nesta entrega. Não rode `db:setup` nem reaplique a 008. Em outro banco ainda com `001` a `008`, aplique apenas a 009 uma vez:

```powershell
npm run db:migrate:page-monitoring
```

Para rodar o fluxo, mantenha quatro terminais separados, um comando em cada:

```powershell
npm run dev:api
npm run dev:web
npm run dev:worker
npm run dev:scheduler
```

Para testar pela interface em `http://localhost:3000`:

1. Entre com uma conta `owner` ou `admin` e confirme que há um produto concorrente em **Produtos**.
2. Confirme que os quatro processos estão ligados. Em **Páginas de preços e changelogs**, escolha o produto, tipo **Changelog**, URL `https://www.postgresql.org/docs/release/` e periodicidade **Diária**; clique em **Adicionar página** somente se as condições da origem permitirem monitorá-la. Fonte nova aparece **ativa**, com próxima verificação prevista para agora. O agendador consulta horários a cada 15 segundos; a execução **automática** deve surgir após o próximo ciclo, podendo demorar mais se houver limite global, fila ou restrição da origem. Não é preciso esperar um dia pela primeira captura. Se a origem permitir a coleta, veja captura, hash e URL final. O índice pode continuar com interpretação **não confirmada**, motivo “nenhuma entrada de alteração de produto”, embora o HTTP tenha sucedido.
3. A periodicidade diária passa a contar após a execução. Para testar controles sem esperar um dia, clique em **Pausar monitoração**, confira **pausada** e “não agendada”, depois em **Reativar monitoração**. Se a última execução ocorreu há menos de um minuto, a próxima prevista respeitará esse intervalo; após ele, deve surgir nova execução automática. Conteúdo relevante igual mantém o mesmo número de versões.
4. Se clicar **Verificar agora** logo após uma execução, a interface deve mostrar uma mensagem compreensível com o horário local em que pode tentar novamente, em vez de apenas “HTTP 409”. Uma execução `succeeded` significa captura concluída; confira separadamente o estado e motivo da **interpretação**. Capturas antigas aparecem **precisa de revisão** e não mostram antigas entradas editoriais como notas confirmadas.
5. Para verificar papéis, um `analyst` da mesma empresa pode clicar **Verificar agora**, mas não cadastrar, pausar ou reativar; um `viewer` apenas consulta. Ao trocar para outra empresa, a fonte e suas capturas não devem aparecer. Para comprovar mudança real, duas instâncias do agendador, reinício e retry sem depender de um site de terceiros, execute o E2E local abaixo: ele controla o tempo apenas nos dados temporários do teste, sem reduzir intervalos de produção.

```powershell
npm run test:e2e
```

O E2E usa páginas locais simuladas para comprovar preço comparável, homepage editorial sem release, changelog explícito, deduplicação, dois agendadores, reinício, pausa/retomada, 503 com retry, RBAC e RLS. Ele não altera páginas reais nem faz chamada paga de IA. A consulta direta histórica à página PostgreSQL não gravou dados em tenant. Veja as ADRs [0009](docs/adr/0009-paginas-publicas.md) e [0010](docs/adr/0010-agendamento-e-interpretacao-paginas.md).

### GitHub Discussions públicas

Discussions são **conversas e feedback de uma comunidade**, não reviews de clientes verificados. Sua população é separada de CSV, Steam e Issues. O sistema não soma essas fontes em uma taxa de reclamação, não infere participação de mercado e não classifica Discussions com IA nesta entrega. A categoria, o título, o corpo original, o autor público quando disponível, as datas, o estado e o link ficam disponíveis para revisão humana. Um anúncio ou corpo curto recebe uma indicação de limitação; não vira “dor do cliente”. Comentários e respostas não são coletados.

O GitHub exige autenticação para [GraphQL Discussions](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions). Para teste local, crie uma credencial GitHub de leitura de repositórios públicos e coloque `GITHUB_DISCUSSIONS_TOKEN` **somente** em `.env.worker.local`, criado a partir de `.env.worker.example`. Esse arquivo é ignorado pelo Git e carregado apenas por `npm run dev:worker`; não coloque o token no `.env` compartilhado por API e web, nem na interface ou em jobs. A [documentação de autenticação GraphQL](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql) explica PAT e GitHub App; o guia específico de Discussions menciona `public_repo` para PAT clássico. Escolha o menor acesso adequado e revise as permissões da sua credencial. Reinicie `npm run dev:worker` após configurar. Sem token, a execução termina em `failed` com `configuration_pending`, sem simular documentos. Um token que também permita repositórios privados **não** libera sua coleta: o worker verifica `isPrivate` antes de gravar. O cadastro cria uma fonte ainda não validada; a primeira coleta confirma existência pública e `hasDiscussionsEnabled`.

O destino é fixo em `https://api.github.com/graphql`, com [paginação por cursor](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api) e consulta apenas dos campos necessários. Uma execução aceita 1–3 páginas e 1–50 itens, com até 20 itens por requisição. Se a janela ficar incompleta, a próxima execução continua pelo cursor salvo; após completá-la, a execução seguinte recomeça nos itens recentemente atualizados para capturar edições. Ordenação por atualização pode mudar enquanto se pagina: `scan_complete=false` não prova cobertura histórica total. A [documentação de limites GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) descreve limites primários por pontos e secundários; o conector respeita `Retry-After` e `x-ratelimit-reset`, limita retries transitórios e não usa scraping. Erros GraphQL com HTTP 200 também são tratados como falha. Não há chamada à OpenAI na coleta. Veja [ADR 0011](docs/adr/0011-github-discussions-publicas.md).

Se uma sincronização falhar, a interface separa `github_unauthorized` (credencial recusada), `github_forbidden` (HTTP 403), `github_permission_denied` (permissão insuficiente), `rate_limited` (aguardar o horário indicado), `graphql_query_invalid` (campo/argumento incompatível com o schema) e `graphql_error` (outro erro GraphQL). O banco guarda só o código, nunca a resposta completa ou o token. Em 2026-09-24, uma tentativa real com a query anterior retornou HTTP 200 e um erro de schema para `isClosed`; o campo correto da [Discussion](https://docs.github.com/en/graphql/reference/discussions) é `closed`. Após a correção, uma consulta direta de 1 página/5 itens a `vercel/next.js` retornou cinco Discussions, sem gravá-las nem enviar conteúdo à IA. O usuário depois confirmou pela interface uma execução `succeeded`, com cinco consultadas e cinco novas; `scan_complete=false` indica coleta parcial pelo cursor. As execuções antigas `graphql_error` permanecem no histórico.

Em banco existente com 009 aplicada, preserve o volume e execute o comando verificado:

```powershell
npm run db:migrate:github-discussions
```

Para testar na interface:

1. Inicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em terminais separados; mantenha PostgreSQL e Redis ativos. O scheduler de páginas não é necessário para uma coleta manual de Discussions.
2. Entre como `owner` ou `admin`, escolha um produto em **GitHub Discussions públicas**, informe `owner/repo` de um repositório público com Discussions habilitadas e clique em **Adicionar fonte Discussions**. Para um teste pequeno, `vercel/next.js` [exibia Discussions públicas](https://github.com/vercel/next.js/discussions) na consulta documental de 2026-09-24; escolha-o apenas se fizer sentido para seu produto de teste. Não use URL de Discussion individual. Uma fonte recém-criada mostra “repositório ainda não validado pelo worker”.
3. Clique em **Coletar Discussions** com **1 página e 5 itens**. O estado deve passar a `succeeded`; confira quantidade consultada, novas/atualizadas, data da última coleta e, na seção **Discussions públicas coletadas**, categoria, título, corpo, data, estado e link. Se aparecer `configuration_pending`, configure o token no worker e reinicie-o. Se aparecer `discussions_disabled` ou `repository_unavailable_or_private`, escolha outra origem pública adequada.
4. Clique novamente em **Coletar Discussions**. Itens já vistos devem ter `novas: 0`; uma Discussion editada pode aparecer em `atualizadas`. Se `scan_complete=false`, repita para continuar a janela pelo cursor. O usuário `analyst` pode solicitar coleta, `viewer` apenas ler; ao trocar de empresa, fontes e documentos da outra não devem aparecer.

O teste direto anterior confirmou cinco itens reais em memória; o teste posterior do usuário confirmou cinco itens persistidos pelo fluxo da interface. O E2E usa respostas GraphQL controladas e verifica API → BullMQ → worker → PostgreSQL → API sem chamar GitHub ou OpenAI.

### Visão de evidências e primeiros indicadores

Em `/evidencias`, a API pesquisa somente a **empresa ativa**. Os filtros aceitos são produto, tipo de fonte, datas de/até (dias UTC da publicação/criação; quando falta, da coleta), termo literal no título/texto, limite de 1–50 e deslocamento de 0–1000. A interface mostra horários no fuso do navegador, 20 itens por página e permite navegar até as primeiras 1.020 origens; refine os filtros para investigar o restante. Consultas ao banco usam a sessão, membership e transação com RLS; enviar um `product_id` de outra empresa não dá acesso a ela. A busca não chama IA nem envia conteúdo à OpenAI.

Cada total conta **origens distintas armazenadas** dentro do tipo: review CSV pela URL da avaliação mais chave externa; Steam por App ID e `recommendationid`; Issue/Discussion por repositório e ID externo; captura de página por URL final e hash do conteúdo. Se uma página voltar a um conteúdo antigo, esse conteúdo conta uma vez no agregado, embora as versões continuem no histórico detalhado. Repetir uma coleta não aumenta esse total. Se a mesma origem estiver ligada a mais de um produto, ela aparece uma vez no total geral e a interface avisa quantos produtos estão associados. Um filtro por produto pode mostrá-la em ambos os produtos: não some esses subtotais como se fossem amostras independentes. Cada tipo exibe sua própria contagem e intervalo observado. `scan_complete=false` no último sucesso de uma fonte é indicado como **cobertura parcial**, não como histórico completo.

Os **problemas extraídos de reviews** são descritivos, separados por CSV/Steam e por dados reais/sintéticos. `total_reviews` é o número de reviews distintas no produto/período; `analyzed_reviews` exige análise `completed` na versão ativa; `documents_without_analysis` é a diferença. Para dados reais, a saída do provedor controlado de teste não entra como análise válida. O numerador de uma categoria conta reviews distintas com ao menos um problema negativo e trecho literal presente no texto. O denominador é `analyzed_reviews` **daquele mesmo tipo e grupo**; uma review pode contribuir para várias categorias, mas só uma vez em cada uma. Sem análise, falha ou versão antiga não entram no denominador. O termo pesquisado filtra apenas a lista/contagens de evidências, não o denominador desses indicadores. Amostras abaixo de 30 recebem aviso e nenhuma proporção deve ser interpretada como tendência representativa. Os rótulos de IA ainda não têm qualidade medida em reviews SaaS B2B rotuladas por humanos.

**Mudanças confirmadas de página** são eventos com duas capturas v2+ confirmadas. Preço exige mesmo plano, moeda, período e condições explícitas, além de valor diferente; changelog exige entrada, evidência e link. Trechos anterior/novo e links das duas capturas ficam visíveis. Uma URL pode servir a página atual, por isso os trechos preservados são a evidência histórica; diferença só de texto, captura parcial/não confirmada ou legado `needs_review` não gera evento confirmado. Issues são atividade pública e Discussions são feedback comunitário; nenhuma das duas vira automaticamente reclamação ou review de cliente. Não há alerta, recomendação de campanha, taxa de mercado nem market share.

**Teste manual com os dados existentes, sem migração nem nova coleta:**

1. Mantenha PostgreSQL e Redis existentes ativos e reinicie `npm run dev:api` e `npm run dev:web` para carregar esta versão. Para **consultar** evidências, worker e scheduler não precisam estar ligados. Não execute `db:setup` ou as migrações 001–010 novamente.
2. Entre em `http://localhost:3000`, confirme a **Empresa ativa** e localize **Visão de evidências** logo abaixo. Sem filtros, confira as seis contagens separadas. Em **Fonte**, selecione **Discussion pública do GitHub** e clique **Aplicar filtros**. A coleta `vercel/next.js` relatada pelo usuário deve aparecer nessa empresa, com link e aviso de cobertura parcial enquanto a última execução bem-sucedida dessa fonte tiver `scan_complete=false`. O número pode mudar se outras coletas foram feitas depois; a tela conta IDs distintos persistidos, não a soma de execuções.
3. Selecione o produto associado, escolha um intervalo que inclua a data original das Discussions e procure uma palavra presente no título/texto de uma delas. Confira que só os itens correspondentes aparecem; apague o termo e aplique de novo. Use **Próxima/Anterior** se houver mais de 20 itens. Uma troca de empresa deve alterar os resultados para os dados da outra empresa, sem mostrar os da anterior.
4. Escolha **Review CSV** e confira que `fixtures/reviews.example.csv` aparece como **SINTÉTICO** e que seus problemas entram somente no grupo sintético. Escolha **Review Steam**; uma review sem análise válida deve elevar `sem análise`, não o denominador das categorias. Se o mesmo App ID estiver associado a dois produtos de teste, veja o aviso de associação ambígua; o total geral não deve dobrar por isso.
5. Se houver duas capturas confirmadas de uma página com mudança comparável, veja **Mudanças confirmadas de páginas** e compare trechos e URLs anterior/novo. Uma captura marcada `não confirmada` ou `precisa de revisão` pode aparecer na busca, mas não nessa lista. Sem duas capturas comparáveis, a lista vazia é o resultado esperado.

O histórico local contém duas execuções agendadas `invalid_test_host` para `www.capco.com` e `www.postgresql.org` em 2026-09-25 00:58 UTC. Esse código vem exclusivamente do transporte de teste do worker: com `MARKETRIFT_TEST_MODE=1` **e** `WEB_PAGE_TEST_BASE_URL` definido, ele aceita apenas `example.com` e recusa páginas reais antes da rede, sem criar captura. Uma invocação de diagnóstico com os mesmos arquivos de ambiente de `npm run dev:worker` encontrou modo de teste desativado e transporte de teste ausente; não foi possível identificar qual processo possuía essas variáveis no instante histórico, nem inspecionar retroativamente seu ambiente. Se o motivo reaparecer, pare o worker, remova as duas variáveis de teste do ambiente dele e inicie `npm run dev:worker` novamente. As execuções antigas e capturas foram preservadas. O E2E usa Redis DB 15 por padrão, separado do Redis de desenvolvimento. Veja [ADR 0012](docs/adr/0012-visao-de-evidencias-e-indicadores.md).

### Avaliações B2B autorizadas e G2 (piloto condicionado)

Esta entrega separa `b2b_review` (CSV com direitos **declarados**), `g2_review` (API de syndication), CSV legado/teste, Steam, Issues e Discussions. A declaração de um usuário é registrada com referência e horário, mas **não equivale à verificação jurídica de uma licença**. Dados históricos CSV não sintéticos receberam `unverified_legacy`; não foram promovidos silenciosamente a reviews B2B autorizadas. G2 sandbox ou transporte E2E tem `sandbox_test` e `synthetic=true`. A Visão de evidências separa tipos/estados e deduplica por origem. Nenhuma review B2B/G2 é enviada **automaticamente** à OpenAI. B2B agora aceita análise individual apenas sob as regras abaixo; G2 segue bloqueado.

**Documentação oficial consultada em 2026-09-24:** o [Developer Portal](https://documentation.g2.com/docs/developer-portal) documenta tokens, ambiente de teste e escopos como `products.reviews.read`, mas não afirma acesso livre a reviews de concorrentes. O [guia oficial de syndication](https://documentation.g2.com/partners/docs/get-started-with-g2-review-syndication) exige uma credencial específica fornecida pela G2, mapeamento do produto e documenta `GET https://data.g2.com/api/2018-01-01/syndication/reviews`, `filter[product_id]`, `page[size]`, `page[number]`, `is_public`, `published_at`, `user_updated_at`, URL e atribuição. A [documentação do MCP G2](https://documentation.g2.com/docs/g2-mcp-server) informa limite global de 100 requisições/s para a API subjacente; o conector usa somente até três páginas e 50 itens por execução e atende `Retry-After`. Os [Terms of Use](https://legal.g2.com/terms-of-use) exigem consentimento escrito expresso para certos usos automatizados, armazenamento e usos relacionados a modelos; a existência de uma chave ou de uma review pública não comprova esses direitos. **Não foi possível confirmar** pela documentação pública o host/contrato de sandbox do endpoint de syndication, direitos de armazenamento/retensão para esta conta, envio de texto à OpenAI, acesso a reviews de concorrentes, semântica de exclusões omitidas pela API ou uma forma segura de distinguir todo HTTP 403 entre escopo e autorização do produto. A referência interativa da API não ficou acessível neste ambiente. Revise o acordo particular com a G2 antes de habilitar produção.

O worker chama somente o endpoint oficial fixo; não faz scraping nem segue o `links.next`, que nos exemplos pode conter `api_token`. Em vez disso, salva apenas o número da próxima página; aceita `meta.page_count` documentado quando não houver `links`, e falha se a resposta não comprovar a paginação. Usa ID G2 estável e URL original G2, título, respostas textuais, publicação/atualização e nota; ignora o objeto `user` e outros metadados pessoais. Um item explicitamente retornado com `is_public=false` é removido com seus insights; **ausência de um item na paginação não prova exclusão**, portanto sincronização completa de remoções ainda depende de orientação da G2. A tela mostra cobertura parcial por cursor. Repetir uma página não duplica documentos. A conta G2 nunca foi conectada neste marco; o E2E usa respostas controladas, não reviews reais.

Em banco **já existente** com 001–010, aplique somente a migração incremental 011, uma vez (o comando detecta reaplicação). Ela preserva produtos, fontes, reviews e capturas anteriores:

```powershell
npm run db:migrate:b2b-reviews
```

Para testar **sem credencial G2** na interface:

1. Ligue PostgreSQL/Redis e reinicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker`. Entre como owner/admin.
2. Em **G2: integração condicionada ao acesso**, escolha um produto de teste, use um G2 Product ID de teste e a URL correspondente `https://www.g2.com/products/<slug>`, com ambiente **Teste / sandbox**. Clique **Cadastrar fonte G2** e depois **Testar coleta limitada**. A execução deve terminar `failed` com **credencial ausente**, 0 reviews; nenhuma review real aparece. Sem host oficial de sandbox confirmado, adicionar apenas uma credencial muda o erro para **endpoint de sandbox não confirmado**, não para sucesso.
3. Para testar a importação sem dados de terceiros, em **Avaliações B2B com permissão declarada** cadastre uma fonte com URL `https://example.invalid/b2b-reviews`, referência `Fixture sintético local`, marque **Fonte somente de teste** e a confirmação de armazenamento. Escolha essa fonte e envie `fixtures/b2b-reviews.synthetic.csv` pelo seletor de arquivo. A importação deve concluir com 1 linha, documento `b2b_review` marcado **SINTÉTICO**, inicialmente sem análise, e contagem separada na Visão de evidências. Reenvie o mesmo arquivo: deve continuar um documento. Uma linha `synthetic=false` nessa fonte é recusada. Viewer não cadastra nem importa; analyst pode importar em fonte já criada.

Para usar CSV **real autorizado**, obtenha as avaliações e direitos por meio legítimo; guarde o arquivo fora do repositório. Cadastre fonte de produção com URL HTTPS real da origem e referência localizável do contrato/licença que permita **armazenamento**. O CSV usa `external_key,source_url,published_at,body` e opcionalmente `language,rating,synthetic`; IDs e URLs de cada review precisam ser estáveis e reais, no mesmo host da fonte, sem credenciais, query ou fragmento, `synthetic=false` (ou coluna omitida). Hosts fictícios/reservados e G2 são recusados para linhas reais neste caminho. O sistema não atesta a validade do contrato; owner/admin responde pela declaração e usa **Revogar e apagar textos** se o direito expirar ou for retirado. Reimportar o mesmo `external_key` na mesma fonte não duplica. **Não use o CSV para contornar restrições do G2.** Separe uma amostra autorizada, rotule sem ver previsões e use o avaliador existente antes de inferir qualidade da IA.

Para uma futura coleta G2 de produção, obtenha da G2 uma credencial **específica de syndication**, acesso ao Product ID pretendido e autorização escrita que cubra armazenamento, atribuição, prazo e remoção. O owner registra referência e data de validade na fonte, visível na interface, e pode renová-la pelo mesmo formulário. Coloque a credencial somente em `.env.worker.local` como `G2_SYNDICATION_TOKEN` e, após revisar o acordo, `G2_PRODUCTION_ENABLED=1`; reinicie o worker. Esses valores nunca entram no navegador, job ou banco. Se o escopo ou produto não for concedido, a execução mostra 401/403/404 de forma distinta quando o HTTP permite; não há fallback por scraping. O envio a provedor de IA continua desabilitado mesmo com `external_ai_permitted` declarado, até haver decisão/implementação específica de consentimento e avaliação de custo. Não coloque o token em `.env` compartilhado nem nesta conversa.

### Análise individual B2B e avaliação privada

**Direitos separados.** A referência da autorização de **armazenamento** permite importar o CSV, mas não autoriza enviar o texto à OpenAI. Para uma fonte B2B de produção, owner/admin registra separadamente no formulário a referência verificável do direito de processamento externo, o provedor e a validade. Pode revogar só esse envio sem apagar documentos; a revogação total ainda apaga os textos. O MarketRift registra a declaração, mas não verifica sozinho os termos da fonte. `g2_review` permanece sem análise de IA, mesmo que sua fonte tenha uma declaração genérica de direitos. Uma review sintética de fonte de teste só pode usar o provedor **controlado**, cujo resultado é uma fixture, não IA nem métrica de clientes reais.

No banco existente, a migração **012** foi aplicada nesta sessão sem `db:setup`, preservando as reviews. Em outra instalação que já tenha 001–011, aplique apenas uma vez:

```powershell
npm run db:migrate:b2b-analysis
```

**Teste manual com a review sintética B2B já importada:**

1. Com PostgreSQL e Redis ativos, reinicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em três terminais. Não precisa ligar FastAPI nem scheduler. Entre na empresa que tem o produto **Teste 04**.
2. Role até **Documentos** e localize a `b2b_review` com selo **SINTÉTICO** e texto sobre a exportação de faturas. Antes do clique, veja **Análise não solicitada** e **Analisar esta review (TESTE controlado)**. Não registre direito de envio OpenAI nessa fonte sandbox.
3. Clique **Analisar esta review (TESTE controlado)** uma vez. Aguarde a atualização automática. Espere **Problemas extraídos**, categoria **Funcionalidades**, gravidade média e um trecho literal da review. O aviso **Resultado controlado de teste; não é uma análise feita por IA** deve aparecer. Se o texto da sua review for diferente da fixture `fixtures/b2b-reviews.synthetic.csv`, o teste controlado pode falhar com `NoControlledFixture`; nenhuma chamada paga ocorre.
4. Na **Visão de evidências**, filtre **Review B2B importada**. O item mostra a categoria, descrição e trecho de prova, com aviso de **TESTE**; a contagem continua em **1 sintética** para essa origem, com **1 analisada** no grupo sintético. A população real e G2 não aumentam. Atualize a página: o resultado persiste. Reimportar a mesma linha não cria novo documento nem nova análise.
5. Um `viewer` deve apenas consultar; `analyst` pode solicitar análise de teste, mas não registrar/revogar o direito de envio. Tentar pedir OpenAI para a review sintética deve ser recusado pela API. Não coloque chave ou texto no payload de jobs.

Para uma review **real** importada legitimamente, só prossiga após confirmar que os termos permitem tanto armazenamento quanto envio à OpenAI. Owner/admin registra referência específica e prazo futuro na fonte. Por padrão, `B2B_PAID_ANALYSIS_ENABLED=0`, portanto não há botão que dispare uma chamada paga só porque `OPENAI_API_KEY` existe. Para habilitar conscientemente, defina em `.env` local `B2B_PAID_ANALYSIS_ENABLED=1`, `B2B_INPUT_USD_PER_MILLION` e `B2B_OUTPUT_USD_PER_MILLION` com tarifas vigentes verificadas para `ANALYSIS_MODEL`, além da chave OpenAI; reinicie API e worker. O formulário exige confirmação por review, **1 item**, 128–512 tokens de saída e orçamento estimado de no máximo USD 0,05. O servidor verifica o direito e o custo antes de enfileirar; o worker verifica outra vez antes de chamar e antes de publicar. Há uma tentativa automática e limite de duas tentativas manuais por versão do extrator. **Este teto é uma estimativa operacional, não um limite garantido da fatura do provedor. Nesta entrega não fizemos chamada paga.**

A avaliação B2B usa o pipeline `extract_review` já existente. A ferramenta local prepara uma amostra em `evalsets/private/` (ignorado pelo Git), registra um rótulo humano por vez sem mostrar previsões e valida trechos literais. Os comandos **sources**, **sample** e **validate** abaixo foram executados nesta sessão com a única review sintética já importada; o resultado foi **1 sintética, 0 reais e 0 rótulos humanos B2B**:

```powershell
npm run eval:b2b -- sources
$tenantId = 'COLE_O_TENANT_ID_LISTADO'
$sourceId = 'COLE_O_SOURCE_ID_LISTADO'
npm run eval:b2b -- sample --tenant-id $tenantId --source-id $sourceId --synthetic --limit 1
npm run eval:b2b -- validate
```

O primeiro comando mostra IDs e contagens, sem textos. Para uma futura fonte real com direito vigente, escolha até 30 reviews distintas e **use caminhos privados diferentes** da amostra sintética já criada:

```powershell
npm run eval:b2b -- sample --tenant-id $tenantId --source-id $sourceId --limit 30 --output evalsets/private/b2b-real-sample-v1.json --progress evalsets/private/b2b-real-labels-v1.json
npm run eval:b2b -- label --sample evalsets/private/b2b-real-sample-v1.json --progress evalsets/private/b2b-real-labels-v1.json --dataset evalsets/private/b2b-real-reviews-v1.json --labeler human:seu-nome --rights-basis 'referência verificável da permissão de avaliação e envio' --max-items 3
npm run eval:b2b -- validate --sample evalsets/private/b2b-real-sample-v1.json --progress evalsets/private/b2b-real-labels-v1.json --dataset evalsets/private/b2b-real-reviews-v1.json
```

Esses três comandos para **dados reais ainda não foram executados** porque não há review B2B real autorizada. O arquivo privado guarda ID, URL, idioma, data, texto e estado. `label` apresenta uma review por vez e salva cada decisão; `q` interrompe e o mesmo comando retoma. Marque problema, categoria, gravidade apenas se sustentada e trecho literal; escolha **evidência insuficiente** quando apropriado. `validate` confere hashes e rótulos. Não copie o conjunto privado, textos, URLs ou capturas do terminal para o Git ou relatórios compartilháveis. Se o texto de uma review mudar, crie uma nova versão da amostra antes de rotular novamente.

Com **rótulos humanos reais** e autorização externa ainda válida, a avaliação paga começa com no máximo três itens, valores de taxa conferidos por você e autorização explícita. Este exemplo é um procedimento futuro, **não foi executado nesta sessão**:

```powershell
$inputRate = 'COLE_A_TAXA_VERIFICADA_POR_MILHAO_DE_TOKENS'
$outputRate = 'COLE_A_TAXA_VERIFICADA_POR_MILHAO_DE_TOKENS'
npm run eval:quality -- --dataset evalsets/private/b2b-real-reviews-v1.json --provider openai --model gpt-5-nano --allow-paid --max-examples 3 --max-output-tokens 512 --budget-usd 0.05 --input-usd-per-million $inputRate --output-usd-per-million $outputRate --output .tmp/quality-b2b-3.json
```

Leia primeiro o resumo no terminal e o JSON exportado: itens efetivamente pontuados, chamadas tentadas, tokens, custo estimado, bloqueios de direitos, erros de formato/evidência, falsos positivos/negativos e precisão/recall por categoria quando definidos. O relatório omite texto, URL e trecho; não o interprete como precisão B2B se os exemplos forem sintéticos, forem poucos ou não tiverem rótulos humanos. A avaliação revalida tenant/fonte/documento, texto idêntico e direito vigente sob RLS imediatamente antes de cada chamada. Veja [ADR 0014](docs/adr/0014-analise-e-avaliacao-b2b.md).

### Migrações

São **quinze migrações do mesmo banco PostgreSQL**, não bancos alternativos. `001_initial.sql` cria a base; `002_full_product.sql` acrescenta o domínio do produto completo; `003_first_slice.sql` acrescenta senha, fontes manuais e marcação sintética; `004_account_security.sql` acrescenta sessões revogáveis e convites; `005_review_analysis.sql` acrescenta análises versionadas e múltiplos problemas por avaliação; `006_github_issues.sql` acrescenta fonte, documentos e estado de coleta de Issues; `007_steam_reviews.sql` acrescenta fonte e metadados de reviews Steam; `008_web_pages.sql` acrescenta capturas de páginas; `009_page_monitoring.sql` acrescenta agendamento persistente e estado versionado da interpretação; `010_github_discussions.sql` acrescenta Discussions como tipo de fonte e documento independente; `011_b2b_review_rights.sql` acrescenta a separação B2B/G2, direitos e estado dos dados; `012_b2b_analysis_rights.sql` separa o direito de envio à IA e registra limites por operação; `013_evidence_chunks.sql` cria trechos pgvector locais; `014_retrieval_review.sql` cria conjuntos, julgamentos e relatórios com RLS; `015_retrieval_origin.sql` separa conjuntos públicos reais dos sintéticos de teste. `db:setup` aplica 001 a 015 somente em banco novo; ele **não** foi executado nesta sessão. Os comandos `db:migrate:*` aplicam as migrações incrementais em banco existente.

## Ordem de construção

Siga [03-plano-de-implementacao.md](docs/03-plano-de-implementacao.md) até todos os critérios de aceite do produto estarem satisfeitos. A primeira entrega vertical usa CSV para validar o caminho de dados; depois entram conectores contínuos, preço, lançamentos, sinais, alertas, recomendações, chat e operação SaaS. CSV é um degrau de engenharia, não o destino do projeto.

## Licença

O código, a documentação e as fixtures sintéticas deste repositório são disponibilizados sob a [Apache License 2.0](LICENSE). Ela permite uso, modificação e distribuição, inclusive comercial, nos termos da licença. Também permite hospedar uma versão modificada sem publicar essas modificações. Dependências de terceiros conservam suas próprias licenças. Veja [NOTICE](NOTICE) para a atribuição do projeto.

## Estado atual

Em 2026-09-25, `001` a `012` estavam aplicadas no PostgreSQL local com pgvector. A 012 foi aplicada de forma incremental, sem recriar o banco. Os logins de runtime e provisionamento não têm `SUPERUSER` nem `BYPASSRLS`. O E2E consulta a Visão de evidências em dois tenants, exercita G2 com respostas controladas e agora cobre análise B2B sintética controlada; ainda não automatiza cliques no navegador nem confirma acesso a conteúdo real G2. Veja [ADR 0012](docs/adr/0012-visao-de-evidencias-e-indicadores.md), [ADR 0013](docs/adr/0013-reviews-b2b-e-g2.md) e [ADR 0014](docs/adr/0014-analise-e-avaliacao-b2b.md). Os resultados de lint, build e testes desta entrega são registrados na resposta de encerramento.

Esta ainda é uma fatia do produto. Faltam recuperação de senha, entrega automática de convites, proteção contra tentativas repetidas, avaliação humana da interpretação em páginas reais autorizadas, conectores adicionais permitidos, sinais comparativos validados, alertas, recomendações, chat RAG completo e avaliado, billing e operação SaaS. O próximo marco é obter avaliações reais de clientes B2B por uma fonte com acesso e uso permitidos, preservar sua proveniência e rotular uma amostra humana sem ver previsões para medir a qualidade da IA antes de ampliar os indicadores.

### Perguntas com citações e índice pgvector (primeiro estágio)

O índice `evidence_chunks` da migração **013** usa vetores de 384 dimensões e RLS. Ele mantém tipo de fonte, produto, documento/captura, texto literal, hash, versão do conteúdo e do modelo. O PostgreSQL local usado nesta entrega tinha pgvector **0.8.5**; `npm run db:migrate:evidence-chunks` foi executado e aplicou **somente** a migração 013. Após a limpeza dos fixtures E2E, havia **0 trechos** no novo índice local: seus documentos antigos foram preservados e ainda precisam de indexação. Não execute `db:setup` para testar com seus dados. Jobs novos indexam fontes após ingestão concluída; para documentos antigos, use **Indexar fonte** na tela. Repetir não duplica trechos. Alterações e exclusões são reconciliadas; direitos e hashes são checados de novo na consulta. A revogação da fonte B2B apaga os documentos e trechos vinculados. A consulta usa distância cosseno exata do pgvector, filtros SQL e só então devolve trechos ao mecanismo extrativo.

**Cobertura atual:** Issues e Discussions públicas separadas; reviews B2B com direito de armazenamento declarado e vigente; CSV e B2B sintéticos apenas como TESTE; capturas de preço/changelog v2 confirmadas. G2 está fora mesmo no sandbox; Steam real e CSV legado real não verificado também ficam fora até confirmação dos direitos adequados. Sintéticos ficam fora da busca por padrão. A busca não soma essas fontes como uma população, não infere satisfação nem gera recomendação. O modo controlado (`EMBEDDING_PROVIDER=controlled`) testa a ligação técnica por hash lexical; **não é um modelo semântico avaliado**. A interface mostra modelo, custo externo USD 0, tempo medido por consulta, tipo/URL/data/trecho e aviso de associação ambígua. Sem evidência elegível, a resposta é “Não há evidência suficiente”. Não há chamada à OpenAI neste fluxo, mesmo quando a chave está no `.env`.

**Configuração para seu teste manual (quatro terminais):** em `.env` coloque `EMBEDDING_PROVIDER=controlled`, `EMBEDDING_INTERNAL_URL=http://127.0.0.1:8000` e `EMBEDDING_INTERNAL_TOKEN=` seguido de um valor aleatório privado de pelo menos 32 caracteres. O mesmo `.env` é lido pela API, pelo worker e pelo serviço FastAPI. `dev:worker` também pode ler `.env.worker.local`; mantenha o **mesmo** `EMBEDDING_PROVIDER` nos processos. Nunca envie o segredo ao navegador ou a esta conversa. Inicie PostgreSQL/Redis existentes, depois:

```powershell
npm run dev:intelligence-http
npm run dev:worker
npm run dev:api
npm run dev:web
```

O `npm run dev:intelligence-http` sobe em loopback na porta 8000 e exige o token interno para produzir vetores. Se não estiver disponível, a pergunta informa que o serviço local não está configurado; o índice previamente salvo permanece no banco. Não há download implícito de pesos.

**Teste manual com sua review B2B sintética já existente:** abra `http://localhost:3000`, entre na empresa que contém o produto **Teste 04** e procure **Perguntas sobre evidências**. Em **Preparar índice de uma fonte**, selecione a origem B2B de Teste 04 e clique **Indexar fonte**; espere alguns segundos com `dev:worker` ativo. Pergunte `funcionalidades` com **Incluir dados sintéticos só para TESTE** desmarcado: espere ausência de evidência, caso só haja essa review sintética. Marque a opção e pergunte por palavras literais da review, por exemplo `funcionalidades`; espere citação com trecho literal, data, link original, `SINTÉTICO / TESTE` e `controlled-hash-TESTE`. Se o texto não contiver essa palavra, use uma palavra que ele contenha. Filtre pelo produto Teste 04 e por `Review B2B`, confira que a citação permanece; selecione outro produto ou período posterior à data da review e confira resposta sem evidência. Desmarque sintéticos novamente para evitar interpretar esse fixture como dado real. Uma Discussion do GitHub pode ser indexada separadamente e aparecerá como feedback público, não como review de cliente.

**Estado histórico da primeira entrega:** o modelo semântico local ainda não havia sido instalado quando os testes controlled foram registrados. A instalação e a avaliação posteriores estão documentadas na seção seguinte. Pesos em `.models/` são ignorados pelo Git. Consulte [ADR 0015](docs/adr/0015-busca-vetorial-e-respostas-extrativas.md) para direitos, limites e fontes técnicas.

**Verificações executadas nesta entrega:** `npm test` (25), `npm run test:db` (114), E2E controlado (incluindo API → BullMQ → Python → pgvector → API, dois tenants, troca de empresa, edição/reindexação, origem compartilhada e revogação), `npm run lint`, `npm run build` e lint dos arquivos Python novos. As execuções controladas do fixture no E2E informaram **42–58 ms** de API local; são medições de teste, não uma promessa de latência em produção. Custo externo de IA: **USD 0**.

### Embeddings semânticos locais (revisão fixa)

Em 2026-09-25, o modelo público [`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42) foi baixado na revisão `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` e executado **localmente em CPU**. O modelo declara licença Apache-2.0, 50 idiomas e vetores de 384 dimensões. O comando abaixo baixa explicitamente só **9 arquivos**, incluindo `model.safetensors`, sem os pesos `.bin`, TensorFlow, ONNX ou OpenVINO alternativos. Dois arquivos alternativos de tokenizer foram dispensados após teste de carga local. O manifesto local registra revisão, tamanho e SHA-256. Foram 479.726.585 bytes de arquivos locais de modelo e manifesto; o ambiente virtual Python completo ficou com 1.154.134.329 bytes, incluindo as dependências anteriores. A máquina testada tem 16,5 GB de RAM física e cerca de 103 GB livres em disco; um processo de avaliação com modelo carregado apareceu com cerca de 972 MB de memória residente. As versões instaladas incluem Python 3.13.7, sentence-transformers 5.7.0 e PyTorch 2.14.0, sem CUDA disponível. FastAPI e worker carregam uma cópia cada quando o modo local está ativo, limitam PyTorch a duas threads por processo e não baixam pesos ao iniciar.

Na raiz do projeto, com o ambiente virtual existente, execute **uma vez**:

```powershell
Push-Location apps/intelligence
.\.venv\Scripts\python.exe -m pip install -e ".[embeddings]" --disable-pip-version-check --quiet
Pop-Location
npm run prepare:embeddings
```

Esse download só ocorre no comando explícito. Em `.env` **e** `.env.worker.local`, configure `EMBEDDING_PROVIDER=local` e `EMBEDDING_MODEL_PATH=apps/intelligence/.models/multilingual-minilm-l12-v2`; preserve `EMBEDDING_INTERNAL_TOKEN` idêntico e privado nos dois arquivos. `EMBEDDING_INTERNAL_URL` continua `http://127.0.0.1:8000`. Estes arquivos e `.models/` são ignorados pelo Git. Se a pasta, o manifesto, a revisão ou algum arquivo estiver ausente, o modo local falha claramente; ele não usa controlled-hash como substituto. Reinicie **FastAPI, worker, API e web** após a configuração/código novos. O serviço HTTP só começa a aceitar consultas depois do carregamento; a primeira carga pode demorar dezenas de segundos. Se a porta 8000 já estiver ocupada, encerre/reinicie o serviço antigo que a usa; a validação isolada desta entrega usou `INTELLIGENCE_HTTP_PORT=8010` sem encerrar aquele processo.

**Teste exato na interface com seus dados existentes:**

1. Com PostgreSQL e Redis existentes ativos, abra quatro terminais e inicie `npm run dev:intelligence-http`, `npm run dev:worker`, `npm run dev:api` e `npm run dev:web`. Aguarde o FastAPI informar que concluiu o startup. **Não** execute `db:setup` nem reaplique a migração 013.
2. Entre em `http://localhost:3000`, selecione a empresa do produto **Teste 04** e abra **Perguntas sobre evidências**. Em **Preparar índice de uma fonte**, escolha a fonte B2B sintética de Teste 04. O estado deve mostrar o nome e a revisão do MiniLM e, para essa fonte, **1/1 trechos indexados** se a indexação local da sessão ainda estiver no banco. Se aparecer “não indexada para o modelo ativo”, clique **Indexar/continuar fonte (até 16 trechos)** e aguarde a atualização; repita o clique enquanto estiver parcial. Vetores `controlled-hash-TESTE` antigos aparecem separados e não participam da busca local.
3. Selecione produto **Teste 04** e tipo **Review B2B**. Pergunte `Quais recursos do produto foram criticados?` com **Incluir dados sintéticos só para TESTE** marcado. Espere uma resposta **extrativa**, com trecho literal, URL de teste, data e marca `SINTÉTICO / TESTE`; o modelo deve ser `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` na revisão fixa. Na consulta local medida, a distância do melhor trecho foi **0,6237**; isso não mede precisão geral.
4. Desmarque **Incluir dados sintéticos só para TESTE** e repita a pergunta com os mesmos filtros. Se não houver outra review B2B real elegível, espere “Não há evidência suficiente”. Uma fonte com indexação parcial também pode causar ausência: confira o estado do índice antes de concluir algo sobre os dados.

O worker processa no máximo **16 trechos novos por job** e até três tentativas. Repetir a operação retoma apenas os trechos faltantes; conteúdo revogado ou alterado perde os vetores antigos. `index-status` aplica a sessão, membership e RLS e calcula cobertura por fonte usando a versão ativa. O índice controlled e o MiniLM têm ambos 384 dimensões, mas a consulta exige **nome e revisão exatos**, de modo que não há comparação entre os vetores. G2 bloqueado, Steam real e CSV real legado não entram no índice. O custo externo de IA deste fluxo é **USD 0**.

Para repetir o teste local direto já executado, sem frontend, use:

```powershell
npm run smoke:retrieval -- --product-name "Teste 04" --question "Quais recursos do produto foram criticados?"
npm run eval:retrieval -- --provider local --dataset evalsets/retrieval.synthetic.v1.json --k 3 --output .tmp/retrieval-local.json
```

O smoke test indexou **1 trecho** sintético da fonte existente com MiniLM, com **12.765 ms** para carga/indexação e **48 ms** para a consulta pgvector; confirmou citação literal, sem OpenAI. O avaliador mediu partida fria **87.820 ms** e quente **31 ms** em outro processo; não são SLAs. O conjunto de recuperação versionado tem **5 trechos e 6 perguntas sintéticas** (paráfrases em português/inglês, fonte semelhante errada e pergunta irrelevante). Em `k=3`, o modelo local obteve Recall@3 **1,0**, MRR@3 **1,0** e acertou **1/1** caso sem evidência; controlled obteve **0,4/0,4**, e busca literal **0,6/0,6**. Porém, entre os candidatos top-3 de perguntas respondíveis, o modelo local trouxe **9 itens não relevantes**; alto recall não equivale a citações todas corretas. Por cautela, a API responde com **somente o primeiro trecho** e a interface pede revisão humana da relevância. Essa decisão foi informada pelo próprio conjunto sintético de desenvolvimento; **não** é validação independente. A rotina divide, por pergunta respondível, trechos relevantes recuperados pelos trechos relevantes rotulados, e calcula MRR pela posição do primeiro acerto. Perguntas sem resposta esperada ficam fora dessas médias e entram em contagem separada. O limiar não foi calibrado nesse conjunto. Esses números **não** medem qualidade em reviews B2B reais; há **0 perguntas reais julgadas por humanos**.

Para futura avaliação humana autorizada, `npm run label:retrieval -- sample --tenant-id <id-da-empresa> --source-id <id-da-fonte> --limit 20 --output evalsets/private/retrieval-real.v1.json` exporta apenas trechos elegíveis da versão ativa para a pasta privada ignorada pelo Git. Em seguida, `npm run label:retrieval -- label --dataset evalsets/private/retrieval-real.v1.json` apresenta cada trecho e registra julgamentos `s/n` antes de mostrar qualquer previsão; Enter interrompe e o mesmo comando retoma sem perder os rótulos. Registre revisor e referência da permissão local. Só depois execute `npm run eval:retrieval -- --provider local --dataset evalsets/private/retrieval-real.v1.json --k 3 --output .tmp/retrieval-real-report.json`. O relatório exporta IDs, métricas, erros e tempos, sem textos ou URLs privados. Esses comandos de amostragem **não foram executados com conteúdo real nesta entrega**; a ferramenta e a retomada tiveram testes determinísticos. O próximo marco é obter reviews B2B reais com uso permitido, rotular perguntas/evidências sem ver previsões e medir recuperação em amostra independente.

**Verificação desta entrega:** `npm run lint`, `npm run build`, `npm test` (**27/27**), `npm run test:db` (**120/120**, incluindo reindexação retomada, duas empresas e revogação), E2E controlado API → BullMQ → worker → PostgreSQL → API, Ruff nos arquivos Python alterados, carga HTTP local autenticada com 384 dimensões e smoke pgvector real com o modelo local. O teste HTTP isolado usou a porta temporária 8010 porque a 8000 já estava ocupada por outro processo; não o encerrou. O segundo smoke da mesma fonte retornou `indexed=0` e `ready=1/1`, confirmando idempotência. Não houve chamada à OpenAI, commit, push, `db:setup` nem reaplicação da migração 013.

### Revisão humana da relevância em GitHub público

A área **Revisão humana da busca** permite formar um conjunto pequeno de **trechos** de Issues e Discussions públicas já coletadas, filtrado pela empresa ativa, produto e período. Ela não mistura reviews B2B, CSV, Steam ou G2. A origem continua distinguindo Issue de Discussion; nenhuma das duas confirma que o autor é cliente. Há limite de 30 trechos e 20 perguntas por conjunto. A seleção exige vetores do MiniLM local: em 2026-09-25, o banco de desenvolvimento continha **5 Discussions e 4 Issues**. A fonte de Discussions `vercel/next.js` começou com 0 vetores MiniLM e foi indexada localmente em três lotes de até 16 trechos: **16/34, 32/34, 34/34**, sem OpenAI. A coleta GitHub dessa fonte continua **parcial pelo cursor**; os 34 trechos cobrem somente as 5 Discussions salvas, não o histórico do repositório. Outras fontes podem ainda precisar de indexação.

As migrações incrementais `014_retrieval_review.sql` e `015_retrieval_origin.sql` criam tabelas próprias com RLS para conjuntos, trechos congelados, perguntas, julgamentos e relatórios. Elas foram aplicadas **uma vez** ao banco local existente, sem `db:setup`, preservando os dados anteriores. Em outro banco já migrado até 013, execute somente:

```powershell
npm run db:migrate:retrieval-review
```

O comando confere a presença das tabelas/coluna antes de aplicar 014/015. Não o substitua por `db:setup` em banco com dados. Para usar o MiniLM, mantenha a configuração local da seção anterior em `.env` e `.env.worker.local`, com o token interno privado, e reinicie FastAPI, worker, API e web. Nenhum texto é enviado à OpenAI.

**Passo a passo no navegador:**

1. Entre na empresa do produto **Teste 04**. Em **Perguntas sobre evidências**, selecione a fonte de Discussions `https://github.com/vercel/next.js` desse produto e confira **34/34 trechos** prontos para o MiniLM. Se o índice não aparecer, clique **Indexar/continuar fonte** e aguarde; cada job indexa no máximo 16 trechos. Outras fontes GitHub podem continuar sem índice local.
2. Desça até **Revisão humana da busca**. Crie um conjunto com produto **Teste 04** e limite pequeno, por exemplo 5 trechos. A seleção põe o primeiro trecho de cada documento antes dos trechos adicionais; confira a quantidade e o aviso de cobertura parcial. Se aparecer “Sem trechos públicos GitHub indexados”, volte ao passo 1.
3. Adicione uma pergunta em português ou inglês. Pesquise dentro do corpus, leia cada trecho, abra o link público e marque **Relevante** ou **Irrelevante**. Durante esta etapa a interface não mostra ranking, score ou resposta do MiniLM. Um item ainda não julgado permanece desconhecido. Para pergunta sem resposta, julgue os itens e clique **Marcar sem resposta no corpus**.
4. Verifique `julgamentos/total` e clique **Congelar versão**. Se restarem itens sem julgamento, confirme expressamente a cobertura incompleta; as métricas principais só usarão perguntas inteiramente julgadas. Para continuar a rotulagem depois do congelamento, use **Criar versão para continuar**.
5. Clique **Avaliar MiniLM, literal e controlled (USD 0)**. Confira Recall@3, Recall@5, MRR@5, candidatos ranqueados/eligíveis, perguntas sem resposta, erros por ID, versões do conjunto/índice/modelo/avaliador, latência e tipos/idiomas. Recall/MRR usam o ranking completo; o corte de score aparece separadamente no diagnóstico de abstenção, com IDs e motivo das exclusões. `controlled-hash-TESTE` é uma comparação técnica separada, não inteligência real. Se a origem for editada ou removida depois, o relatório antigo aparecerá como histórico de outra versão.

Owner, admin e analyst podem criar e julgar; viewer pode consultar, mas não rotular. A API confere membership a cada operação, exige CSRF nas mutações e aplica RLS. Texto público congelado e julgamentos ficam no banco do tenant; relatórios exibidos pela interface não incluem prompts privados em logs. Na criação da ferramenta havia **0 perguntas públicas reais julgadas**; depois, o usuário julgou **1 pergunta e 5 pares** na v2 pública. Essa amostra não mede qualidade em reviews B2B reais. Veja [ADR 0016](docs/adr/0016-avaliacao-humana-recuperacao-publica.md) para fórmulas, limites e versionamento.

**Correção do avaliador:** relatórios antigos sem `evaluator_version=frozen-ranking-v2` aparecem como **obsoletos** e continuam no histórico sem edição. Para atualizar o conjunto público real v2 já congelado, reinicie API, FastAPI e web após atualizar o código, entre na empresa ativa, abra **Revisão humana da busca**, selecione o conjunto **v2** e confira **5/5 julgamentos**. Clique **Avaliar MiniLM, literal e controlled (USD 0)** uma vez; o novo relatório deve indicar `frozen-ranking-v2`, `5/5` candidatos ranqueados por método e Recall@5 de 100% para os três métodos nesta pergunta. O MRR@5 depende da posição do único trecho relevante; confira a lista ordenada de IDs exibida para cada método. No diagnóstico separado, o controlled pode excluir o trecho relevante pelo corte de 0,15; isso não altera o Recall@5 do ranking. O relatório antigo permanece obsoleto. Nenhuma migração ou novo rótulo é necessária.

**Contrato da reavaliação:** a API e o FastAPI agora exigem `frozen-eval-contract-v2`. Antes de calcular, a API consulta o status interno e confere a versão do avaliador e do modelo. A resposta devolve o ID do conjunto, versão, hashes, IDs dos documentos e perguntas **na ordem recebida** e os IDs julgados/relevantes; a API compara esses campos antes de gravar. Um serviço ainda com código anterior mostra `409 AVALIADOR_LOCAL_DESATUALIZADO` e o campo divergente: pare e reinicie os processos `npm run dev:intelligence-http` e `npm run dev:api`, sem refazer a rotulagem. Um conjunto que mudou mostra `409 CONJUNTO_CONGELADO_DIVERGENTE` com o campo (`corpus_hash`, `judgment_hash`, `document_ids` ou `question_ids`); preserve a versão congelada e investigue a origem antes de criar outra versão. O teste E2E usa um conjunto sintético isolado, guarda um relatório de formato antigo e comprova que a reavaliação salva outro relatório vinculado à v2. Não use `db:setup` nem reaplique migrações para esta correção.

### Sinais verificáveis e alertas internos

A migração incremental `016_reviewable_signals.sql` cria candidatos revisáveis e leitura de alertas por usuário. Ela foi aplicada **uma vez** ao banco local existente com `npm run db:migrate:reviewable-signals`; o script detecta a tabela existente e só corrige uma eventual permissão de marcar alerta como não lido. Não rode `db:setup` no banco existente.

Em **Sinais para revisão**, owner/admin pode clicar **Atualizar candidatos a partir das evidências armazenadas** como recuperação operacional. Essa ação não coleta páginas, não consulta GitHub e não chama IA. A reconciliação também é disparada automaticamente após gravações elegíveis, conforme a seção seguinte. Ela gera:

- mudança do **preço listado** apenas com duas capturas v2 confirmadas, mesmo plano, moeda, período e condições explícitas, valores diferentes e citações presentes nas capturas;
- **nova entrada** de changelog apenas quando a entrada foi confirmada na segunda captura com título, link específico e trecho preservado. Artigo editorial, alteração de entrada existente, captura parcial ou legado em revisão não vira lançamento;
- atividade separada de Issues e Discussions **públicas armazenadas**, por repositório e tipo, com documentos distintos, período observado, exemplos e cobertura do último percurso. Cursor pendente aparece como coleta parcial. Uma mesma origem ligada a dois produtos conta uma vez.

Cada candidato tem versão da regra, IDs/URLs/hashes de evidência e estado `candidate`, `approved`, `discarded` ou `obsolete`. Repetir a atualização não duplica fatos. Se a origem mudar, sumir ou for desativada, a próxima atualização marca o sinal anterior como obsoleto e retira os trechos armazenados no candidato; aprovação anterior deixa de gerar alerta. Owner/admin aprova ou descarta com motivo; analyst examina; viewer vê apenas aprovados. **Alertas internos recentes** são aprovados nos últimos 30 dias, com lido/não lido individual. Nenhum email ou push é enviado. Sinais de fixtures são marcados **TESTE** e não entram na contagem real. Nenhuma review sintética, G2 sem direitos ou classificação de TESTE gera sinal real; tendências de reclamação B2B permanecem desativadas até haver amostra real elegível e qualidade medida.

Para testar com seus dados, após reiniciar `npm run dev:api` e `npm run dev:web`:

1. Entre como owner/admin na empresa que já tem Discussions públicas `vercel/next.js` coletadas e abra **Sinais para revisão**. Clique **Atualizar candidatos**. Deve aparecer uma atividade de Discussions com contagem, link de origem e aviso de cobertura parcial se o último percurso mantiver cursor. Isso descreve comunidade pública, não clientes. Pode haver também Issues, se já foram coletadas com sucesso. Antes da atualização, o banco local tinha **0 sinais persistidos**, reais e de TESTE.
2. Confira que a homepage editorial cadastrada como changelog, capturas `partial`/`unconfirmed` e a página de changelog legada `needs_review` **não** aparecem como novas entradas. Uma captura inicial isolada de preço também não cria mudança.
3. Em um candidato, escreva um motivo e clique **Aprovar**. O item passa aos alertas internos como **Não lido**. Marque **Lido** e depois **Não lido**; a escolha afeta só sua conta. Para testar descarte, use outro candidato e informe um motivo. Com uma conta viewer, candidatos não aprovados e botões de revisão não devem aparecer.
4. Após uma coleta elegível ou desativação, o scheduler reconcilia automaticamente. O botão **Atualizar candidatos** continua disponível se o scheduler estiver parado ou falhar. Um sinal sem suporte passa a **obsoleto** e sai dos alertas. Não apague capturas ou julgamentos humanos para testar isso.

Comandos verificados nesta entrega: `npm run db:migrate:reviewable-signals`, `npm run lint`, `npm run build`, `npm test`, `npm run test:db` e `node --env-file=.env scripts/e2e.mjs`. O E2E usa tenants e fontes simuladas **TESTE** e limpa seus dados; não mede a confiabilidade em concorrentes reais. A decisão técnica e os limites estão na [ADR 0017](docs/adr/0017-sinais-revisaveis-e-alertas-internos.md).

**Verificações desta entrega:** `npm run lint`, `npm run build`, `npm test` (**29/29**), `npm run test:db` (**125/125**), `npm run test:e2e` (passou com corpus controlado; o primeiro ensaio exigiu atualizar a contagem esperada de origens duplicadas), Ruff nos arquivos Python alterados e uma execução local do novo avaliador com **3 trechos e 2 perguntas sintéticas**. O E2E percorreu criação, julgamento, pergunta sem resposta, cobertura incompleta, congelamento, comparação controlled/literal, cópia de versão, dois tenants, origem duplicada, edição e remoção; os rótulos do fixture são TESTE. Nenhuma chamada paga nem pergunta pública real foi avaliada. Custo de API de IA: **USD 0**.

### Reconciliação automática dos sinais

A migração **017** adiciona uma pendência transacional por empresa e fonte e os gatilhos para coletas GitHub Issues/Discussions concluídas, documentos públicos editados/removidos, mudanças de página e fontes elegíveis desativadas ou reassociadas. Ela foi aplicada uma vez ao banco local existente com:

```powershell
npm run db:migrate:signal-reconciliation
```

O comando detecta a tabela e não reaplica a migração. A migração não cria pendências para dados anteriores, não altera candidatos/alertas existentes e não ativa monitoramento de páginas pausadas. Não use `db:setup` no banco existente.

Inicie o scheduler junto aos serviços que já usa:

```powershell
npm run dev:scheduler
```

No desenvolvimento, o comando da raiz delega ao workspace `@marketrift/api`, que executa o mesmo `src/page-scheduler-main.ts` com o `tsconfig.json` da API. Isso é necessário para que `tsx` transforme os decorators de parâmetros do NestJS no Windows. O processo continua reunindo o scheduler de páginas e o de sinais; `start:scheduler` continua usando o JavaScript compilado.

**Resultado observado ao corrigir o comando:** a pendência real de GitHub Issues foi drenada sem nova coleta. A execução já concluída antes desta correção havia registrado 1 Issue nova e 1 atualizada; o fato armazenado passou de 2 para 3 Issues distintas. Portanto, o sinal de Issues antes aprovado ficou `obsolete` e surgiu um candidato novo, ainda sem aprovação. Seu ID, chave, hash e registro de leitura históricos permanecem. O sinal de Discussions continuou `approved` e lido. Essa mudança de estado reflete evidência material nova, não uma aprovação transferida pelo scheduler. A interface deve mostrar a última reconciliação e zero pendências; owner/admin precisa revisar o novo candidato de Issues.

O scheduler publica apenas IDs, versão e revisão no BullMQ. Sua pendência fica no PostgreSQL se Redis falhar ou o processo reiniciar. O consumidor valida tenant, fonte e produto com RLS, serializa a reconciliação por empresa e usa as mesmas regras do botão manual. O painel **Sinais para revisão** mostra data da última conclusão, número de fontes pendentes e código da falha. Uma nova versão material cria candidato novo; um aprovado sem suporte fica obsoleto e desaparece dos alertas, sem mudar o estado de leitura histórico. Repetir uma coleta sem alteração não duplica candidato. A reconciliação não coleta fontes, não aprova candidatos e não envia mensagem externa. Veja [ADR 0018](docs/adr/0018-reconciliacao-automatica-dos-sinais.md).

**Teste na interface sem esperar mudança em terceiros:** mantenha PostgreSQL, Redis, `dev:api`, `dev:worker`, `dev:web` e `dev:scheduler` abertos. Entre na empresa com Issues/Discussions já coletadas e anote os dois sinais aprovados e quais alertas estão lidos. Na fonte GitHub pública existente, solicite uma coleta manual de **1 página e até 5 itens**; o teste não depende de a fonte publicar conteúdo novo. Espere a execução terminar e abra **Sinais para revisão**. Em até cerca de 15 segundos após a gravação, o painel deve mostrar uma data de reconciliação recente e zero pendências para essa fonte. Se os documentos não mudaram, os mesmos sinais aprovados permanecem, sem novo alerta e sem mudar lido/não lido. Se a fonte mudou de fato, o aprovado antigo pode ficar obsoleto e um candidato novo exige revisão humana. Em caso de falha, o painel mostra pendência/motivo e o scheduler tenta novamente; owner/admin pode usar **Atualizar candidatos** para recuperação. O E2E controlado (`node --env-file=.env scripts/e2e.mjs`) verifica edição, obsolescência e candidato novo sem depender de mudança em site real.

**Verificação desta entrega:** `npm run db:migrate:signal-reconciliation` aplicou 017 uma vez; `npm test` passou 39/39; `npm run test:db` passou 130/130; `npm run lint`, `npm run build` e `node --env-file=.env scripts/e2e.mjs` passaram. O E2E usou apenas tenants TESTE, duas instâncias do scheduler e respostas externas controladas. Os dois sinais públicos reais aprovados conservaram IDs, chaves, hashes e uma leitura por sinal. Custo externo de IA: USD 0. Não houve `db:setup`, commit ou push.
