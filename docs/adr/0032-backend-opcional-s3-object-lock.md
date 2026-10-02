# ADR 0032: backend externo opcional para backup e diário

**Estado em 2026-10-02:** adaptador AWS S3 Object Lock implementado e testado somente com cliente controlado. Nenhum bucket, conta, papel, política, chave ou prazo de retenção foi criado ou escolhido. Nenhuma chamada S3/STS real foi feita. A liberação de restauração real continua proibida pelo código da ADR 0031.

## Decisão

`BACKUP_EXTERNAL_BACKEND` ausente mantém tudo desligado. O valor explícito `s3-object-lock` exige região AWS, duas identidades de bucket distintas (backup/diário e âncoras), prefixo, conta e principal esperados e uma data de retenção escolhida pelo operador. O SDK usa a cadeia de credenciais do processo; a API, o scheduler e os comandos operacionais devem executar com papéis separados conforme a operação. O token ou segredo não entra em job, banco ou log.

O adaptador usa `PutObject` com `If-None-Match: *`, SHA-256 e retenção **COMPLIANCE por versão**. Exige `VersionId`, relê a versão exata, confere SHA-256, listagem e `GetObjectRetention`. Backup e manifesto assinado são objetos distintos; os eventos de exclusão assinados ficam em um bucket, com uma âncora encadeada e assinada por evento no outro. O evento não contém texto. A revogação bloqueia a fonte no banco primeiro; a publicação externa ocorre **antes** de apagar texto B2B. Falha de publicação impede a transação de exclusão e deixa a fonte bloqueada com exclusão pendente/falha; uma tentativa posterior pode concluir a publicação idempotentemente. Um evento local conservador pode sobreviver a uma transação revertida. A auditoria futura deve tratar esse caso como exclusão, nunca recriar texto.

`ops:external:preflight` só lê STS/S3. Confere identidade esperada, versionamento, Object Lock, sequência, assinatura, hash, versão e retenção dos eventos/âncoras. Requer um checkpoint de sequência e SHA-256 da última âncora guardado **independentemente** do banco e do bucket de backup; um valor apenas no backup não comprova completude. A saída sempre permanece `blocked`: a revisão efetiva de IAM/bucket policy, gestão de chave de criptografia, durabilidade entre contas, retenção contratual e a liberação real exigem infraestrutura e ensaio próprios. O comando não concede acesso à restauração. O CLI de publicação exige também `BACKUP_S3_ALLOW_UPLOAD=1`; não é um agendador de backup.

## Limites e operação pendente

Object Lock protege uma **versão**, mas não impede nova versão ou delete marker; por isso o adaptador recusa múltiplas versões ou markers inesperados. COMPLIANCE impede apagar a versão antes da data, inclusive quando um direito B2B de exclusão exigir remoção mais cedo. Antes de usar dados reais, o operador precisa conciliar retenção de backup com contratos, definir eliminação posterior e testar recuperação de chave e acesso. A data de retenção não tem padrão no código. O formato de backup atual não implementa criptografia de ponta a ponta própria; a configuração de SSE/KMS e acesso ao KMS depende da infraestrutura. A API não consegue provar por uma leitura S3 que o papel não tem `DeleteObjectVersion`, `BypassGovernanceRetention` ou privilégios administrativos. Políticas IAM e de bucket devem ser auditadas fora do processo. Uma API compatível com S3 pode divergir da AWS e não é aceita como equivalente sem ensaio real das capacidades.

`ops:restore:audit` e `ops:restore:release` continuam aceitando somente bancos sintéticos `marketrift_backup_lab_*`. Não há flag que libere banco real. Não foi criada migração; o banco local permanece intacto.

## Documentação oficial consultada em 2026-10-02

- [Amazon S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html): retenção por versão e modos COMPLIANCE/GOVERNANCE.
- [Considerações do Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html): permissões, criptografia e delete markers.
- [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html): checksum, retenção por objeto e `VersionId`.
- [ListObjectVersions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html) e [GetObjectRetention](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectRetention.html): leitura de versões e retenção.
- [Ações IAM exigidas pelo S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html): `ListBucketVersions`, `GetObjectVersion`, `GetObjectRetention` e demais ações por operação.
- [Papéis IAM para aplicações](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-ec2.html): credenciais temporárias e separação por papel.
