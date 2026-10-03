# ADR 0034: captura manual de uma página pública indicada

**Status:** implementado em 2026-10-02. Complementa as ADRs 0009, 0023 e 0033.

## Decisão

Uma candidata de descoberta ou uma entrada já persistida de feed pode indicar uma URL pública. A indicação não contém o texto do destino. Owner/admin escolhem uma indicação na empresa ativa e confirmam produto, origem e domínio. A API obtém a URL das tabelas sob RLS, recusa candidatas rejeitadas ou de identidade antiga e recusa fontes de avaliações sujeitas a conector e direitos próprios. Links externos continuam sendo associações humanas, sem promoção automática a fonte oficial. URL já cadastrada como índice de preços ou changelog não vira uma segunda fonte da mesma página.

O cadastro cria `sources.source_type='public_page'` com `monitoring_enabled=false` e `next_check_at=NULL`. A tabela `public_page_origins` preserva a indicação e quem confirmou, com RLS e FKs tenant-scoped. A migração 032 não ativa fontes existentes; a 033 mantém o registro mesmo se o revisor deixar a equipe, sem impedir remoção de membership. Abrir a interface ou cadastrar não faz requisição externa. Só o clique **Capturar esta URL agora (1 página)** cria `source_runs.run_kind='web_page'` e job `check-web-page.v1` com IDs; o scheduler existente pode recuperar o job pendente se Redis falhar, mas não agenda verificações periódicas de `public_page`.

O worker reaproveita o transporte das páginas: HTTPS sem parâmetros/credenciais, DNS com IP global fixado, TLS com hostname original, redirecionamentos no mesmo host, `robots.txt`, resposta HTML/texto, prazo de 8 segundos por recurso e no máximo 1 MB lido por resposta. Login, bloqueio, 429/503 e `Retry-After` geram estado de falha ou espera; não há navegador, JavaScript, scraping de área protegida nem visita aos links da página. Antes de gravar, o worker revalida tenant, produto, URL, tipo, fonte habilitada e execução. Capturas parciais ficam marcadas. Uma captura guarda URL original/final, título e trecho literal limitados, data de observação, hash e versão. A data de publicação só é atribuída à página quando um elemento `<time>` dela oferece texto ou atributo literal; a data do feed é apenas proveniência da indicação. O corpo normalizado persistido para este tipo é limitado a 1.500 caracteres. Não guardamos o HTML estrutural para reinterpretação neste tipo.

Na regra v4 de páginas individuais, um artigo ou área principal precisa ter prosa suficiente; navegação, botão “Skip to content”, rodapé e repetição são excluídos. Sem prosa, a interpretação é `insufficient_main_content` e o trecho não é publicado como evidência útil. O hash de novas capturas depende do conteúdo observado e não da versão da regra. A versão 1 real de `vcr-login-github-action` guardou somente “Skip to content” (15 caracteres), hash e título, sem HTML estrutural. Ela permanece histórica; a interface agora a sinaliza como insuficiente. A nova regra não prova que o HTML da v1 continha o artigo e não cria evento de mudança a partir dela. Uma futura captura, se solicitada pelo operador, será outra observação e indicará que a comparação com a v1 é indeterminada.

Uma consulta diagnóstica após a correção fez exatamente duas requisições à Vercel (robots e página), recebeu HTML completo de aproximadamente 521 mil caracteres e encontrou o título em `<title>`, mas nenhuma prosa principal que satisfizesse a regra. Não há trecho de artigo nem data de publicação comprovados pela resposta acessível ao coletor. Essa consulta não criou nova versão no banco; a fonte continuou pausada. A aplicação deve manter esse resultado como insuficiente até haver conteúdo principal verificável, sem usar o texto do feed como se tivesse vindo da página.

`public_page` significa **página pública observada**. O extrator não cria planos, entradas de changelog, reviews, insights, mudanças confirmadas, sinais ou alertas a partir dela. Repetição idêntica não cria versão; alteração cria outra captura histórica, sem recomendação. `/evidencias` e sua linha do tempo apresentam esse tipo separado dos demais, com link para a URL atual e aviso de que ela pode ter mudado. A data declarada pela origem não é confundida com a data da captura; texto sem ano não recebe um ano inventado. Uma indicação ainda não capturada não aparece como evidência.

## Verificação e limites

### Complemento: observação opcional do DOM renderizado (regra v5)

Em 2026-10-03, uma única inspeção controlada em navegador da página pública
`https://vercel.com/changelog/vcr-login-github-action` mostrou um elemento `article`
visível com 2.085 caracteres após JavaScript, apesar de o HTML direto não conter
prosa principal aproveitável pela regra v4. O trecho observado começa por
“You can now push container images from GitHub Actions to Vercel Container Registry
(VCR) without storing long-lived registry credentials.” Isso é uma observação
diagnóstica posterior à captura v1, não uma reinterpretação da v1 e não prova
que o mesmo DOM existia em 02/10/2026. A inspeção tentou 74 subrequisições,
bloqueou 41 pelos limites/host, e recebeu cerca de 650 KB. Não foi salvo dump
do HTML ou screenshot.

Owner/admin podem pedir **Capturar DOM renderizado agora (1 página)** apenas para
uma fonte individual já cadastrada. É um modo explícito no `source_runs`, não uma
mudança do coletor periódico. A API cria o mesmo job com IDs; o worker confere
tenant/produto/fonte/run e chama o serviço interno `renderer`. Esse serviço não
recebe credenciais de banco, Redis, OpenAI nem sessão do usuário; usa token local
próprio e um Chromium headless em container separado. Antes do navegador, aplica
o transporte estático existente para DNS público, IP fixado, TLS, robots, tamanho,
tipo de conteúdo e redirecionamento no mesmo host. No navegador, bloqueia
websockets, downloads e requisições fora do host; limita 35 tentativas de requisição,
1 MB por recurso, 6 MB total, 8 s para navegação, 3 s para renderização e 22 s
para a operação. O container tem um worker, 768 MB de memória, 128 processos,
sistema de arquivos somente leitura, usuário sem privilégios e diretório temporário
limitado. Requisições de subrecursos bloqueadas deixam a cobertura parcial.
Redirecionamento do documento para outra URL exige uma nova revisão e é recusado.

A regra v5 exige título e pelo menos 100 caracteres de prosa visível com frases
num `article` ou `main`. Remove linhas de navegação evidentes e repetições.
Sem isso, o run falha com `insufficient_main_content` e não publica snapshot.
Persistem apenas título, trecho até 1.500 caracteres, hash do texto observado,
URL final, horário da nova observação, versão da regra, método `rendered_dom` e
estado de cobertura. A data de publicação só vem de `<time>` dentro da região
escolhida, com o texto/atributo literal; a data do feed não é herdada. Se houver
nova observação, o banco pode criar uma nova versão do snapshot, mas não cria
`page_changes` para páginas individuais: diferença de método/regra ou texto
observado depois não é afirmação de que o site mudou entre as datas.

O modelo de segurança usa roteamento e pinagem do navegador, não oferece uma
garantia de isolamento de rede equivalente a firewall externo. Para operação
em produção, o serviço deve ficar em segmento de rede com política de saída
permitindo apenas os destinos públicos aprovados. A captura pública não concede
direitos de reprodução ou análise por IA. Referências: [Playwright: rede e
interceptação](https://playwright.dev/python/docs/network), [instalação apenas do
Chromium headless](https://playwright.dev/python/docs/browsers) e
[isolamento de navegadores em Docker](https://playwright.dev/python/docs/docker).

Testes determinísticos cobrem URL insegura, DNS/redirect, robots, HTTP, trecho literal, tipo sem interpretação e captura parcial. O teste de banco verifica fonte pausada, repetição, versão alterada, ausência de `page_changes` e RLS entre dois tenants. O E2E usa tenant e servidor controlados: revisão de entrada de feed/candidata, cadastro sem rede, job manual, BullMQ, worker, snapshot, evidências e linha do tempo, além de RBAC/CSRF. Ele não prova que uma origem real permitirá o acesso. A captura de texto público ainda depende da política aplicável à origem; o operador deve revisar direitos e retenção antes de usar dados em produção. Não há coleta de toda a web nem inferência de opinião de clientes B2B.
