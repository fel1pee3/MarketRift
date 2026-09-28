# ADR 0029: monitoramento opt-in de GitHub Issues e Discussions

**Status:** implementado em 2026-09-28. Complementa as ADRs 0006, 0011 e 0018.

## Decisão

Fontes GitHub existentes e novas ficam pausadas por padrão. Owner/admin podem ativar uma fonte por vez em `/fontes`, com intervalo de 6 horas, um dia ou uma semana. Analyst mantém a coleta manual; viewer apenas lê o estado. Ativar a fonte constitui a decisão explícita de fazer requisições periódicas à API oficial. A primeira execução fica devida ao ativar, sujeita aos limites globais e da origem.

O scheduler já existente guarda o vencimento em `sources.next_check_at` e a execução em `source_runs`. A migração 028 acrescenta uma geração por fonte e por job, sem alterar o estado das fontes antigas. O trigger aumenta a geração ao mudar URL, produto, estado ou intervalo. Uma transação com advisory lock seleciona no máximo uma fonte por passagem; o índice de execução ativa impede colisão com coleta manual. O scheduler agenda no máximo duas execuções por minuto e uma por repositório a cada cinco minutos. Cada execução lê uma página e até cinco itens; o próximo ciclo retoma um cursor parcial. Falha ao publicar no Redis deixa a execução `pending`, recuperável após reinício e outra passagem. Jobs levam somente tenant, fonte, execução, versão e geração.

O worker revalida tenant, produto, fonte, URL, estado ativo e geração antes da rede, antes de cada requisição e antes de gravar. Pausar invalida execuções agendadas e impede que um job antigo grave o que buscou. Repetições usam IDs externos estáveis e não duplicam documentos; a reconciliação de sinais existente trata alterações de evidência sem transferir aprovação humana. Issues e Discussions continuam atividade pública, com cobertura parcial explícita, nunca reviews verificadas de clientes.

## Limites

O agendamento não ativa Steam, G2, Brave, páginas pausadas ou APIs pagas. A fonte pode ficar atrasada se scheduler, Redis, worker ou GitHub estiverem indisponíveis; o estado persistido permite recuperar sem afirmar cobertura completa. `Retry-After` e rate limit da origem permanecem no conector; não há scraping de HTML. O token de Discussions continua apenas no ambiente do worker. O E2E usa tenant, REST e GraphQL controlados, não a API real. O desvio de Issues para loopback existe somente com `MARKETRIFT_TEST_MODE=1` e uma URL `127.0.0.1` validada. A migração não enfileira coletas e não modifica fontes existentes.

Esta decisão cobre somente duas famílias de atividade pública. Fóruns, redes sociais, lojas de aplicativos, sites de reclamação e notícias exigem conectores, acesso, direitos de armazenamento/processamento e verificações próprios. Descobrir uma URL não implementa a coleta dessa fonte.
