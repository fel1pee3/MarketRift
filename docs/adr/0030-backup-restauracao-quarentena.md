# ADR 0030: backup e restauração em quarentena

**Status:** exercício local sintético verificado; operação de produção bloqueada por infraestrutura e política pendentes.

**Evolução:** a [ADR 0031](0031-trava-operacional-de-restauracao.md) substitui a descrição abaixo da quarentena apenas procedural por uma trava de processos e de conexão no destino restaurado. As limitações de armazenamento externo e retenção continuam válidas.

## Conteúdo e risco

Um `pg_dump` completo inclui tenants, usuários, hashes de senha, sessões, fontes, direitos, linhas brutas de importação, documentos B2B, análises, embeddings, rótulos, relatórios, jobs e auditoria. RLS não protege uma cópia acessada por superusuário: o arquivo deve ser tratado como dado de todas as empresas. O arquivo e a chave de verificação não devem ser publicados no Git, Redis, logs, serviço de nuvem ou compartilhamento sem autorização. `evalsets/private/` também pode conter texto privado e exige retenção e descarte próprios.

## Decisão implementada

`npm run ops:backup:lab` inicia dois PostgreSQL `pgvector/pgvector:pg16` efêmeros com credenciais aleatórias, portas aleatórias ligadas apenas a `127.0.0.1` e sem volumes. Aplica as migrações **somente na origem sintética**, cria dois tenants de teste, gera `pg_dump --format=custom`, SHA-256 e manifesto assinado com HMAC. Verifica hash, assinatura e lista interna de `pg_restore`; um arquivo corrompido é recusado. Restaura num segundo container, sem conectar API, worker ou scheduler. O relatório começa em `blocked_pending_deletions_and_expired_rights`. Antes de considerá-lo auditado, o exercício reaplica eventos de exclusão posteriores ao backup e a política de vencimento, confere esquema, remoção de documentos, linhas brutas, análises, trechos e resultados de avaliação, RLS entre tenants e rejeição de jobs antigos. O exercício encerra os dois containers; arquivos sintéticos ficam em `.tmp/backup-lab/`, ignorados pelo Git.

Para novas exclusões B2B, API e scheduler podem gravar antes da remoção um evento HMAC em `BACKUP_DELETION_JOURNAL_DIR` usando `BACKUP_DELETION_JOURNAL_KEY`. O evento contém IDs, data e, para review, HMAC do ID externo; **não contém texto**. Uma falha de escrita aborta a exclusão em vez de fingir que existe registro recuperável. O registro é conservador: uma transação de exclusão que volte atrás pode manter o evento; na restauração isso favorece apagar em excesso. O exercício valida assinatura e recusa alteração. Como as variáveis são opcionais, instalações atuais continuam operando, mas seus backups **não estão liberados para restauração de produção** por este mecanismo.

## Porta de quarentena e lacunas

Quarentena no exercício significa container isolado e credenciais nunca configuradas nos serviços da aplicação; o script não oferece URL de produção nem troca a conexão deles. Não existe ainda uma trava geral de startup da API/worker/scheduler para uma restauração operacional fora deste exercício. É proibido apontá-los a um banco restaurado sem auditoria independente e liberação explícita. Em produção, a porta precisa ser imposta por rede e controle de acesso, não apenas por procedimento escrito.

Um diário no mesmo host ou no mesmo backup pode desaparecer junto com o banco, ser revertido à mesma data antiga ou ter um arquivo removido sem que uma assinatura individual detecte a ausência. Antes de usar em produção, o operador deve escolher armazenamento **externo ao banco e aos backups, durável, com escrita imutável/append-only, acesso mínimo e replicação**, preservar a chave separadamente e registrar uma marca de sequência/cobertura verificável. Também precisa definir criptografia, destino, retenção por categoria/contrato, rotação de chaves, monitoramento de falhas, revisão de permissões e descarte seguro de backups e `evalsets/private/`. Sem isso, mesmo um manifesto íntegro não prova que uma review apagada depois do backup não reaparecerá.

Nenhuma migração foi necessária ou aplicada ao banco local. O exercício não copia o banco local nem faz chamadas externas pagas.
