# ADR 0031: trava operacional de restauração

**Status:** implementada e verificada somente no laboratório sintético em 2026-09-28. Liberação de backup real continua indisponível.

## Identidade e bloqueio inicial

O backup customizado contém apenas o banco da aplicação. O restaurador cria, no banco de controle `postgres` do **novo cluster**, `public.marketrift_restore_gate` com identidade do banco de destino, SHA-256 do arquivo e estado `quarantined`, **antes** de executar `pg_restore`. Esta tabela não vem do backup. Os papéis da aplicação ainda não têm login durante a restauração; após ela, os logins recebem credenciais novas, mas `CONNECT` no banco restaurado permanece revogado. O cluster do usuário e seu volume Docker não são alterados.

API consulta o controle antes de cada requisição: `/health` mostra somente `restoration_quarantine` com HTTP 503; qualquer outra rota recebe 503 sem consultar dados. Worker Python consulta antes de registrar consumidores BullMQ e antes de cada job. Scheduler consulta antes de iniciar e em cada ciclo; o consumidor de reconciliação de sinais também verifica por job. FastAPI local bloqueia suas rotas, inclusive análise e embeddings, enquanto o destino estiver em quarentena. Erro de acesso ao controle falha fechado. Um cluster antigo sem tabela de controle continua funcionando; quando `RESTORE_GATE_REQUIRED=1`, a ausência da tabela bloqueia. Essas verificações complementam a revogação de `CONNECT`; não substituem isolamento de rede, credenciais exclusivas e administração cuidadosa do cluster.

## Auditoria e liberação

`ops:restore:audit` verifica o manifesto e o arquivo com `pg_restore --list`, a identidade do destino, a sequência do diário, o esquema esperado, fontes B2B vencidas/revogadas, ausência de documentos e linhas brutas após exclusão, análises e trechos, relatórios de avaliação expurgados, jobs B2B pendentes incompatíveis e RLS por tenant. No laboratório, o script de exercício reaplica primeiro os três eventos sintéticos posteriores ao backup. A auditoria grava resumo, horário e identificador do operador no banco de controle, permanecendo `quarantined`; repetir a auditoria é seguro. `ops:restore:release` revalida arquivo, diário e dados, compara o resumo auditado e, na mesma transação, concede `CONNECT` aos logins e marca o controle como `released`. Cada decisão entra na tabela de eventos do controle, sem texto nem credenciais. Repetir a liberação retorna `already_released`, sem duplicar o evento.

O diário local passou à versão 2: eventos assinados têm sequência e assinatura anterior; uma cabeça assinada registra a posição final. Arquivo ausente, lacuna, alteração, cabeça ausente ou diretório indisponível bloqueiam auditoria/liberação. Isso detecta falhas no exercício, **não comprova completude de produção**: diário e cabeça podem ser perdidos ou revertidos juntos. O laboratório possui uma sequência esperada fora do backup durante sua própria execução. Não existe ainda uma âncora externa independente, durável e imutável no ambiente real. Por isso os comandos de auditoria/liberação aceitam somente bancos sintéticos `marketrift_backup_lab_*` cujos usuários, tenants e documentos tenham marcações de TESTE; uma tentativa para banco real é recusada. Nenhuma opção de configuração transforma diretório local em atestado externo.

## Resultado e limites

O exercício observou API e FastAPI retornando 503, worker e scheduler encerrando antes de consumir/agendar, e os quatro operando após auditoria e liberação. Liberação sem evento, sem diário ou com assinatura inválida foi recusada. Os logins não conectam ao banco da aplicação antes da liberação. O E2E habitual continua operando no banco existente sem tabela de controle. Nenhuma migração foi necessária.

Para produção faltam destino protegido e criptografado, diário externo imutável com âncora de continuidade independente, gestão de chaves, política de retenção, backups periódicos e ensaio de recuperação sob isolamento de rede. Um restore feito fora deste caminho controlado ou sobre o banco atual não recebe essa garantia. Não se deve usar as credenciais de superusuário na API, worker ou scheduler.
