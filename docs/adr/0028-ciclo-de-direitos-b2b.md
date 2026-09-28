# ADR 0028 — Validade e retenção de fontes B2B

Estado: implementado em 27/09/2026.

## Decisão

Uma fonte CSV B2B de produção exige referência da autorização de armazenamento, data de validade futura e uma política declarada por fonte: `retain_after_expiry` ou `delete_on_expiry`. A declaração é um registro operacional feito por owner/admin, não uma verificação jurídica do contrato. Fontes antigas recebem `unspecified`; seus textos ficam bloqueados após o vencimento e não são apagados automaticamente sem uma política registrada. A autorização para OpenAI continua separada.

Ao vencer, leitura, importação, análise, indexação e avaliação real são bloqueadas pelos direitos vigentes. Com `delete_on_expiry`, o registro da fonte é a pendência durável: o scheduler já existente a verifica a cada ciclo. A exclusão ocorre em uma transação de tenant sob bloqueio da fonte; a mesma linha é bloqueada pelos jobs de importação, análise e indexação. O worker de importação também compara a geração dos direitos gravada na importação com a geração atual, de modo que um job antigo não recrie texto após revogação, apagamento ou renovação. A análise revalida direitos antes da chamada externa e antes de publicar o resultado.

A exclusão remove linhas CSV brutas, documentos, análises, insights, trechos e embeddings, além de itens, rótulos e relatórios dos conjuntos B2B que usavam a fonte. O conjunto fica `purged`, recebe título neutro e conserva apenas metadados mínimos de auditoria. A transação registra contagens, motivo e horário sem guardar texto; falhas revertem a transação inteira, guardam um código seguro e são retomadas com backoff ou por **Retomar exclusão**. Uma renovação só é aceita depois de concluir um apagamento exigido pela política anterior e não recupera texto apagado. Revogação explícita desativa a fonte e exige apagamento, qualquer que seja a política de vencimento.

## Limites

Uma fonte vencida com `retain_after_expiry` mantém texto retido e bloqueado até decisão de renovação ou revogação; isso só deve ser escolhido se o contrato permitir. A política não substitui análise jurídica de retenção, backups e exclusões exigidas pelo provedor. Arquivos privados exportados anteriormente pelo CLI para `evalsets/private/` ficam fora do banco e exigem gestão de retenção no armazenamento onde foram criados; a exclusão do servidor não pode atestar cópias arbitrárias feitas por operadores. Não trate o resultado de avaliações sintéticas como medida de qualidade em clientes B2B reais.

## Operação

Aplicar `026_b2b_rights_lifecycle.sql` e `027_b2b_rights_scheduler_grant.sql`, nessa ordem, em banco já migrado até 025. A segunda migração dá ao papel de provisionamento leitura apenas das colunas de agendamento B2B; a exclusão usa o papel runtime com RLS e tenant explícito. Reiniciar API, worker e scheduler. Em `/fontes#b2b`, owner/admin registram ou renovam validade e política, acompanham o estado e consultam **Ver histórico de direitos**. O scheduler precisa permanecer ativo; a interface mostra pendência ou falha até a transação de exclusão concluir. **Revogar e apagar textos** continua disponível para owner e **Retomar exclusão** para owner/admin quando houver pendência ou falha.
