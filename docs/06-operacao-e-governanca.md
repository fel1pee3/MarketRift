# Operacao, confiabilidade e dados

## Coleta

Adaptadores por fonte expoem `fetch_since(cursor)`, transformacao e identificador externo. Cada fonte documenta politica de acesso, limite, paginação, tratamento de erros e retencao. O agendamento BullMQ produz jobs; o Python os consome. Capturas brutas podem ir para armazenamento de objetos; banco recebe hash e referencia. Nao guardar segredos em jobs ou logs.

## Falhas e consistencia

Job pequeno com IDs e versao. Retry exponencial para falha transitoria com limite; falha permanente vai a estado diagnosticavel. Upsert por tenant/fonte/chave externa. A publicacao da fila pode falhar apos o commit da importacao: rotina de reconciliacao reencaminha registros pendentes pelo mesmo idempotency_key. Rastrear inicio/fim/cursor/contagens por execucao. Evitar duas coletas simultaneas da mesma fonte.

## Seguranca

Sessao revogavel em cookie HttpOnly, protecao CSRF e membership validadas pela API; workers conferem tenant e source_id no banco. RLS, chaves compostas, roles sem BYPASSRLS, segredos fora do repositorio, conexoes internas autenticadas. Testes entre tenants em leitura, escrita, joins, chat, jobs, alertas e exportacao. Credenciais de fontes, quando houver, ficam em cofre de segredos com referencia no banco.

## Privacidade e proveniencia

Avaliacoes podem conter dados pessoais. Definir minimizacao, mascaramento exibido, politica de retencao e exclusao, controle de acesso e tratamento conforme as obrigacoes aplicaveis antes de operar com dados reais. Registrar origem, horario, versao da extracao e abrangencia. Etiquetar fixtures sinteticas.

## Observabilidade e qualidade

Metricas: lag da fila, falhas por fonte, duplicatas, duracao de jobs, custo de LLM/embedding, sucesso de conectores, tempo de resposta por endpoint, porcentagem de insights com fonte e taxa de aprovacao humana. Logs estruturados com IDs sem texto integral. CI: lint, unitarios de calculos, integracao TS/Python/BullMQ, migracoes e testes de isolamento. Deploy com rollback e migracao compativel.
