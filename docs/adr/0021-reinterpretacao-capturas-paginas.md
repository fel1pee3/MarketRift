# ADR 0021: captura limitada e reinterpretação versionada de páginas

**Status:** implementado em 2026-09-26. Complementa as ADRs 0009 e 0010.

## Contexto e diagnóstico

A captura v1 do changelog da Vercel guardou texto normalizado, hash e JSON v2, mas não o HTML com hierarquia, datas e links. O extrator v2 também exigia verbos estreitos; “logs workflows” não correspondia. Na estrutura atual, a data aparece antes do `article`, fora dele. A observação atual da página sustenta o diagnóstico da regra, mas não reconstrói o HTML histórico. A resposta atual de `/pricing` declarou 1.235.205 bytes; o coletor anterior a rejeitaria pelo `Content-Length` acima de 1 MB antes de ler o corpo. A execução histórica guardou só o código `response_too_large`, portanto seu cabeçalho exato não pode ser comprovado retroativamente.

## Decisão

- A regra v3 exige contexto de changelog, título, data literal, link específico do mesmo host e frase de mudança de produto. A data pode estar no agrupamento imediatamente anterior ao cartão. São preservados trechos visíveis e `href` literais por campo. Links de `/docs/`, artigos editoriais, cartões sem data e conteúdo genérico permanecem não confirmados.
- O transporte lê no máximo 1 MB por resposta em blocos de até 64 KiB, sem aumentar o teto. Se a página ultrapassa o teto, a captura registra cobertura parcial e se o limite veio de `Content-Length` ou dos bytes recebidos. Campos visíveis em uma seção completa podem ser exibidos, mas a captura inteira nunca fica confirmada e não gera mudança de preço confirmada. `robots.txt` incompleto bloqueia a coleta. Validação de URL, DNS/IP, TLS, redirecionamentos, tipo de conteúdo, HTTP e `Retry-After` continuam obrigatórios.
- A migração 020 acrescenta HTML estrutural sanitizado de até 300 KB e `snapshot_interpretations`, ambos sob RLS. A migração preserva snapshot, hash, texto e JSON originais e registra a interpretação antiga como história. Um job `reinterpret-web-page.v1` contém apenas IDs e versão; o worker revalida tenant/fonte/snapshot, exige texto igual ao original e publica a v3 como interpretação ativa no mesmo snapshot. Falha de integridade bloqueia o job. Não se cria snapshot ou `page_change` por mudança apenas da regra.
- Uma captura antiga sem HTML não pode ser reavaliada diretamente. Se uma verificação posterior tem **mesmo texto normalizado e URL final**, o HTML estrutural posterior pode ser associado ao snapshot com `markup_observed_at` e base `later_same_text_capture` visíveis. Isso não o declara HTML histórico. Se o texto mudou, nasce um novo snapshot e o antigo permanece sem prova de link/data. Um snapshot novo pode ser reinterpretado usando seu HTML guardado.
- Visão de evidências e sinais lêem somente a interpretação ativa. Eventos históricos já gravados não são reescritos; a reconciliação de sinais segue os critérios anteriores de duas evidências confirmadas e revisão humana. Nenhuma aprovação é herdada por fato materialmente diferente.
- Um evento calculado **antes** da reinterpretação de qualquer uma de suas capturas deixa de ser elegível para indicador ou sinal estruturado; suas evidências históricas continuam guardadas. Eventos calculados depois usam as interpretações então ativas. A conclusão da reinterpretação cria uma pendência durável de reconciliação da fonte, sem executar coleta externa ou aprovar candidato.
- Fontes de página cadastradas pela API com `MARKETRIFT_TEST_MODE=1` recebem `access_environment='sandbox'`. O scheduler normal ignora essas fontes; o scheduler controlado de teste pode processá-las. Isso impede que um processo de desenvolvimento consuma no Redis normal uma execução de tenant temporário criada pelo E2E e tente acessar a URL de fixture na rede pública.

## Limites

O HTML é analisado sem JavaScript. O prefixo de uma página grande pode não conter o preço ou a entrada relevante. A regra pode deixar passar lançamentos com linguagem fora da taxonomia verbal ou datas em formatos diferentes; a revisão humana continua necessária. O HTML estrutural é sanitizado para reduzir armazenamento e nunca deve ser usado para afirmar conteúdo não preservado. Reinterpretação não é nova coleta e não demonstra que o site mudou.
