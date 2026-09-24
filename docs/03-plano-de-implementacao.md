# Plano de construção do produto completo

Os marcos abaixo são uma ordem para entregar e testar o sistema sem perder o objetivo final. Uma primeira fatia funcional não encerra o projeto. A conclusão exige todos os critérios em [08-criterios-produto-completo.md](08-criterios-produto-completo.md).

## Marco 0 — fundação e domínio

Inicializar Git, infraestrutura local, migrações 001/002, contratos e CI básico. Entrevistar usuários do perfil inicial e escolher fontes com acesso permitido. Montar dados sintéticos e um conjunto pequeno de exemplos rotulados para avaliação. **Entrega:** repositório reproduzível e hipóteses documentadas.

## Marco 1 — SaaS e fatia vertical

Gerar Next.js, NestJS e serviço Python. Implementar autenticação, tenant, membership/RBAC, produto e concorrente, fontes, importação CSV, job BullMQ, normalização idempotente e painel de documentos. **Entrega:** web → API → fila → Python → Postgres → web, com dois tenants testados.

## Marco 2 — extração inteligente

Saída estruturada com Pydantic, versão de modelo/prompt, evidência literal, tratamento de falha e avaliação rotulada. Agregados SQL e dashboard de sentimentos/temas. **Entrega:** métricas de qualidade publicadas e cada classificação auditável.

## Marco 3 — conectores contínuos

Implementar um conector permitido de reviews, outro de preços e outro de release notes; cada um tem cursores, agendamento, limite de taxa, histórico e saúde. Retry e reconciliação de pendências. **Entrega:** execuções repetidas importam apenas novidades e falhas são visíveis.

## Marco 4 — detecção de sinais

Comparações entre janelas, mudanças de preços comparáveis, linha do tempo de releases e gaps entre queixas do concorrente e capacidades próprias verificadas. Scores explicáveis, evidências e alertas. **Entrega:** sinal tem cálculo reproduzível, documentos e limite da amostra.

## Marco 5 — recomendações e pesquisa

Criar recomendações estratégicas com status de revisão, alegações a verificar e histórico; chat com busca vetorial/textual e SQL para números, referências e insuficiência de evidência. **Entrega:** usuário investiga um sinal, revisa uma ação e faz perguntas sem afirmação inventada.

## Marco 6 — operação de produto

Assinatura e quotas, convites, auditoria, observabilidade, custos, proteção de dados, backups, CI/CD, deploy e demo pública com dados sintéticos. Exercitar incidentes e restauração. **Entrega:** checklist de produto completo aprovado.

## Primeira tarefa de implementação

Criar apps e implementar o Marco 1 em fatias pequenas: (a) autenticação/tenant, (b) produto/fonte, (c) importação/job, (d) worker/documento, (e) tela de resultado. Faça um teste A/B de isolamento e um teste de retry sem duplicata antes de adicionar LLM. Em paralelo, mantenha [00-escopo-completo.md](00-escopo-completo.md) como contrato do destino final.
