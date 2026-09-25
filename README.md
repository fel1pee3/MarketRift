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

De volta à raiz, aplique as dez migrações em um banco vazio e crie logins distintos de runtime e provisionamento:

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

Na importação CSV, o worker grava cada avaliação e publica um job `analyze-document.v1` com IDs e versão do extrator. Reviews Steam coletadas não entram automaticamente nessa fila; exigem a ação explícita descrita abaixo. Uma análise pode produzir vários problemas com categoria, sentimento negativo, gravidade, descrição e trecho literal da avaliação. A API mostra o estado e os problemas junto do documento; respostas malformadas ou trechos que não existam no texto original ficam em estado de falha e não aparecem como insights. Avaliações positivas podem resultar em zero problemas. O botão **Reenfileirar análise** de CSV aparece apenas quando a análise está pendente, indisponível ou falhou; análises concluídas não precisam ser reenfileiradas. Ao mudar modelo, prompt, schema ou taxonomia, aumente `EXTRACTOR_VERSION` em API e worker e reenfileire o documento para manter as versões anteriores auditáveis.

Sem chave de provedor, o padrão é `ANALYSIS_PROVIDER=disabled`: o fluxo registra `unavailable` e **não publica uma análise simulada**. Para usar OpenAI, configure somente no `.env` local `ANALYSIS_PROVIDER=openai`, `ANALYSIS_MODEL=gpt-5-nano` e `OPENAI_API_KEY` com sua chave; reinicie API e worker. Reenfileire apenas documentos pendentes, indisponíveis ou falhos; avaliações CSV novas são analisadas automaticamente, enquanto reviews Steam exigem seleção individual. A aplicação envia o texto da avaliação ao provedor escolhido, portanto use apenas dados cuja análise externa seja permitida. Em 2026-09-24, a chamada direta real foi verificada com quatro exemplos sintéticos. O fluxo completo também foi observado na interface para `demo-001` e `demo-002`: ambos ficaram `completed` com `model_id=gpt-5-nano` no banco. A integração usa `ChatOpenAI.with_structured_output` do LangChain e Pydantic, com validação literal adicional. O provedor controlado de teste só pode ser usado com `MARKETRIFT_TEST_MODE=1`; o E2E o ativa e a interface identifica seus resultados como teste, nunca como análise de IA.

A avaliação legada abaixo usa seis exemplos **sintéticos** com rótulos definidos no próprio repositório. Ela verifica a rotina de comparação por categoria e de validade de evidências; seus números não medem precisão em avaliações reais rotuladas por pessoas:

```powershell
npm run eval:analysis:test
```

Em 2026-09-24, o antigo comando de chamada direta ao OpenAI passou em quatro exemplos sintéticos: quatro respostas estruturadas, quatro trechos literais válidos e nenhum resultado malformado. Essa execução histórica confirma a integração, não mede precisão em avaliações reais. O script `eval:analysis:openai` agora aponta para o avaliador com orçamento e exige as opções explícitas descritas abaixo. Não há estatísticas agregadas de reclamações no painel nesta etapa; dados sintéticos seguem identificados e não entram em qualquer métrica de dados reais.

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

Em banco vazio, `npm run db:setup` aplica as dez migrações. Depois, inicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em terminais separados. O FastAPI de health não participa da coleta.

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

Se uma sincronização falhar, a interface separa `github_unauthorized` (credencial recusada), `github_forbidden` (HTTP 403), `github_permission_denied` (permissão insuficiente), `rate_limited` (aguardar o horário indicado), `graphql_query_invalid` (campo/argumento incompatível com o schema) e `graphql_error` (outro erro GraphQL). O banco guarda só o código, nunca a resposta completa ou o token. Em 2026-09-24, uma tentativa real com a query anterior retornou HTTP 200 e um erro de schema para `isClosed`; o campo correto da [Discussion](https://docs.github.com/en/graphql/reference/discussions) é `closed`. Após a correção, uma consulta direta de 1 página/5 itens a `vercel/next.js` retornou cinco Discussions, sem gravá-las nem enviar conteúdo à IA. As execuções antigas `graphql_error` permanecem no histórico; reinicie o worker e solicite uma nova coleta para verificar o fluxo pela interface.

Em banco existente com 009 aplicada, preserve o volume e execute o comando verificado:

```powershell
npm run db:migrate:github-discussions
```

Para testar na interface:

1. Inicie `npm run dev:api`, `npm run dev:web` e `npm run dev:worker` em terminais separados; mantenha PostgreSQL e Redis ativos. O scheduler de páginas não é necessário para uma coleta manual de Discussions.
2. Entre como `owner` ou `admin`, escolha um produto em **GitHub Discussions públicas**, informe `owner/repo` de um repositório público com Discussions habilitadas e clique em **Adicionar fonte Discussions**. Para um teste pequeno, `vercel/next.js` [exibia Discussions públicas](https://github.com/vercel/next.js/discussions) na consulta documental de 2026-09-24; escolha-o apenas se fizer sentido para seu produto de teste. Não use URL de Discussion individual. Uma fonte recém-criada mostra “repositório ainda não validado pelo worker”.
3. Clique em **Coletar Discussions** com **1 página e 5 itens**. O estado deve passar a `succeeded`; confira quantidade consultada, novas/atualizadas, data da última coleta e, na seção **Discussions públicas coletadas**, categoria, título, corpo, data, estado e link. Se aparecer `configuration_pending`, configure o token no worker e reinicie-o. Se aparecer `discussions_disabled` ou `repository_unavailable_or_private`, escolha outra origem pública adequada.
4. Clique novamente em **Coletar Discussions**. Itens já vistos devem ter `novas: 0`; uma Discussion editada pode aparecer em `atualizadas`. Se `scan_complete=false`, repita para continuar a janela pelo cursor. O usuário `analyst` pode solicitar coleta, `viewer` apenas ler; ao trocar de empresa, fontes e documentos da outra não devem aparecer.

O teste direto posterior confirmou cinco itens reais em memória, sem gravação no tenant. O E2E usa respostas GraphQL controladas e verifica API → BullMQ → worker → PostgreSQL → API sem chamar GitHub ou OpenAI.

### Migrações

São **dez migrações do mesmo banco PostgreSQL**, não bancos alternativos. `001_initial.sql` cria a base; `002_full_product.sql` acrescenta o domínio do produto completo; `003_first_slice.sql` acrescenta senha, fontes manuais e marcação sintética; `004_account_security.sql` acrescenta sessões revogáveis e convites; `005_review_analysis.sql` acrescenta análises versionadas e múltiplos problemas por avaliação; `006_github_issues.sql` acrescenta fonte, documentos e estado de coleta de Issues; `007_steam_reviews.sql` acrescenta fonte e metadados de reviews Steam; `008_web_pages.sql` acrescenta capturas de páginas; `009_page_monitoring.sql` acrescenta agendamento persistente e estado versionado da interpretação; `010_github_discussions.sql` acrescenta Discussions como tipo de fonte e documento independente. `db:setup` aplica 001 a 010 somente em banco novo. Os comandos `db:migrate:*` aplicam somente a migração respectiva em banco existente, na ordem.

## Ordem de construção

Siga [03-plano-de-implementacao.md](docs/03-plano-de-implementacao.md) até todos os critérios de aceite do produto estarem satisfeitos. A primeira entrega vertical usa CSV para validar o caminho de dados; depois entram conectores contínuos, preço, lançamentos, sinais, alertas, recomendações, chat e operação SaaS. CSV é um degrau de engenharia, não o destino do projeto.

## Licença

O código, a documentação e as fixtures sintéticas deste repositório são disponibilizados sob a [Apache License 2.0](LICENSE). Ela permite uso, modificação e distribuição, inclusive comercial, nos termos da licença. Também permite hospedar uma versão modificada sem publicar essas modificações. Dependências de terceiros conservam suas próprias licenças. Veja [NOTICE](NOTICE) para a atribuição do projeto.

## Estado atual

Em 2026-09-24, `001` a `010` estavam aplicadas no PostgreSQL local com pgvector. Os logins de runtime e provisionamento não têm `SUPERUSER` nem `BYPASSRLS`. Os testes de banco cobrem RLS, deduplicação, múltiplos problemas, falha do provedor, mudança de versão, Issues, reviews Steam, capturas, backoff de páginas e Discussions. O E2E usa API → agendador → BullMQ → Python → PostgreSQL → API com páginas, Steam e GraphQL simulados, além de verificar que a web é servida; ainda não automatiza cliques no navegador. Veja [ADR 0010](docs/adr/0010-agendamento-e-interpretacao-paginas.md) e [ADR 0011](docs/adr/0011-github-discussions-publicas.md). Os resultados de lint, build e testes desta entrega são registrados na resposta de encerramento.

Esta ainda é uma fatia do produto. Faltam recuperação de senha, entrega automática de convites, proteção contra tentativas repetidas, avaliação humana da interpretação em páginas reais autorizadas, conectores adicionais permitidos, sinais, alertas, recomendações, chat RAG, billing e operação SaaS. O próximo marco é selecionar páginas de preço e release notes de um segmento B2B com acesso permitido, rotular mudanças observadas e medir falsos positivos/negativos antes de gerar alertas.
