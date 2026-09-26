# ADR 0019: navegação do painel por área

**Status:** implementado em 2026-09-26.

## Decisão

A página única foi dividida em sete URLs Next.js: `/`, `/fontes`, `/evidencias`, `/perguntas`, `/revisao`, `/avaliacao-busca` e `/conta`. As rotas usam o mesmo `WorkspaceApp`, que concentra recuperação de sessão por cookie, CSRF, chamadas existentes e limpeza do estado ao trocar de tenant. Respostas assíncronas antigas são descartadas usando usuário, tenant, papel e CSRF na identidade da sessão; o CSRF sozinho pode permanecer igual após trocar de empresa. Os painéis de evidências, perguntas, sinais e avaliação humana foram reutilizados. Os formulários de conectores, importação, análise individual, convites e membros permanecem com as mesmas regras de API e permissões. O menu marca a página atual, aceita teclado e mantém URLs compartilháveis; atalhos internos levam aos conectores e aos documentos.

A visão geral consulta apenas endpoints de leitura do tenant ativo. Ela mostra associações de fontes, não soma documentos de origens compartilhadas. Execuções parciais, último erro, direitos pendentes, interpretações não confirmadas e dados de TESTE aparecem com contexto. Candidatos e alertas continuam distintos de reviews, Issues, Discussions e capturas. Abrir uma URL não dispara coleta, chamada paga, aprovação ou reconciliação manual. O servidor continua responsável por membership, RBAC e RLS; esconder uma ação na interface não substitui essas verificações.

## Verificação e limites

O teste de componente cobre o registro de URLs, as unidades da visão geral, avisos de cobertura/direitos e ausência de dados de outro tenant em props separadas. O E2E verifica acesso direto a cada URL e mantém os cenários existentes de sessão, CSRF, papéis, troca de tenant e isolamento na API. Como um scheduler de desenvolvimento pode estar ativo durante o E2E, o teste marca suas fontes GitHub controladas como `sandbox`; a reconciliação lê essa marca do banco, mantendo esses sinais como TESTE independentemente de qual processo os consuma. Fontes GitHub cadastradas normalmente não recebem essa marca. A recuperação visual da sessão após atualizar e a navegação por teclado têm um roteiro manual no README. O E2E atual usa HTTP e dados controlados, não um navegador automatizado que execute cliques. Não houve migração nem alteração das políticas de retenção ou de direitos.
