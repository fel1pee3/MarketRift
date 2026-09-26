# ADR 0018: reconciliação automática dos sinais observados

**Status:** implementado em 2026-09-26. Complementa a [ADR 0017](0017-sinais-revisaveis-e-alertas-internos.md).

## Decisão

A migração 017 cria `signal_reconcile_sources`, uma pendência durável por tenant e fonte, sem retroagir sobre os sinais existentes. Triggers incrementam a revisão na mesma transação que confirma uma execução de coleta, altera/remove documento GitHub, altera/remove evento de página ou desativa/muda a associação de uma fonte elegível. CSV, Steam, G2 e outras fontes que não alimentam as regras da ADR 0017 ficam fora. A migração não cria pendências para dados anteriores e não ativa fontes pausadas.

O processo `dev:scheduler` executa um dispatcher periódico e um consumidor BullMQ com concorrência local 1. O dispatcher lê a pendência confirmada, publica somente versão, IDs e revisão e deixa a linha intacta se Redis falhar. A próxima passagem recupera o trabalho; após reinício, a linha continua no PostgreSQL. Duas instâncias podem publicar o mesmo ID idempotente, mas BullMQ o deduplica. A reconciliação usa lock transacional por tenant, revalida fonte e produto dentro do contexto RLS e reaproveita exatamente as regras do botão manual. O botão continua disponível para owner/admin e, ao concluir, quita as pendências atuais da empresa. O consumidor registra um código de falha sem texto sensível e usa backoff limitado; o painel mostra pendências, falhas e data da última conclusão. Uma falha de banco impede atualizar o estado até o banco voltar; a pendência transacional permanece para recuperação.

No Windows, `tsx` iniciado da raiz não descobriu o `tsconfig.json` em `apps/api` e falhou ao transformar os decorators de parâmetros do controller importado pelo consumidor. O comando da raiz agora delega ao script `dev:scheduler` do workspace API. O ponto de entrada, o dispatcher e o consumidor permanecem os mesmos. Lint/build usavam `tsc -p apps/api/tsconfig.json` e o E2E executava `dist/`, por isso não reproduziam essa falha de desenvolvimento. Um smoke test inicia o ponto de entrada TypeScript no diretório correto sem tocar no banco real.

O fato material usa `fact_key` versionada. Nova edição de documento, alteração de cobertura parcial/completa, mudança confirmada de captura ou associação relevante cria outro candidato, deixando o anterior `obsolete` e fora dos alertas. Nenhuma aprovação é copiada. Execução repetida com os mesmos documentos não duplica candidato. Se uma fonte volta após ter deixado um fato obsoleto, uma nova chave de época cria outro candidato e preserva o antigo. Quando apenas o ID da última execução muda, a proveniência da versão atual é atualizada sem mudar a decisão humana. O histórico obsoleto retém ID/hash/decisão e remove o texto de evidência, de acordo com a política existente. Continua sem coleta extra, aprovação automática, IA ou envio externo.

## Limites

A reconciliação recalcula todos os fatos da empresa para manter a deduplicação entre fontes ligadas ao mesmo repositório. Os limites de 2.000 mudanças, 500 fontes e 5.000 documentos por origem permanecem; acima deles a pendência falha explicitamente para revisão operacional. `last_reconciled_at` informa a última fonte concluída, não a cobertura histórica de todas as fontes; fontes antigas sem nova gravação não recebem pendência automaticamente. O monitoramento periódico de páginas continua separado e só alcança fontes que já estão ativas para monitoramento.

O E2E usa tenants e fontes TESTE controlados, incluindo duas instâncias do dispatcher, edição de Discussion, atualização repetida e revogação de página. Não mede qualidade de reviews B2B nem abrangência de repositórios públicos. Nenhuma chamada OpenAI é feita.
