# ADR 0002: primeira fatia vertical

**Status:** implementado para desenvolvimento local em 2026-09-23.

- Monorepo npm com dois workspaces TypeScript (`apps/api`, `apps/web`) e pacote Python instalável (`apps/intelligence`). O contrato JSON Schema em `packages/contracts` é validado por Ajv 2020 na API e jsonschema no worker.
- NestJS cria usuários e tenants com um login de provisionamento restrito. O login de runtime herda apenas `marketrift_runtime`; cada consulta de tenant usa `BEGIN` e `set_config('app.tenant_id', ..., true)`. JWT identifica usuário e tenant, mas cada requisição consulta membership e papel no banco.
- A importação manual grava até 100 linhas em `import_rows`, então publica um job BullMQ com IDs e chave estável. Python valida o contrato e confirma fonte e importação no banco. `documents` tem unicidade `(tenant_id, source_id, external_key)` e o worker usa `ON CONFLICT DO NOTHING`.
- A migração 003 acrescenta senha, `manual_review` e marcação de dado sintético. Fontes manuais são cadastro de proveniência, não conectores autorizados de coleta automática.
- A interface Next.js chama apenas a API. A sessão desta fatia fica em `sessionStorage`; cookies protegidos, convites, troca de tenant, recuperação de senha, retenção de dados e limites comerciais ainda serão implementados.
- O script `db:setup` foi desenhado para **banco vazio**. Depois de uma instalação com dados, futuras mudanças devem vir por novas migrações e um controle de versão de migrações.

O destino do produto permanece definido em `docs/00-escopo-completo.md` e `docs/08-criterios-produto-completo.md`.

As decisões de sessão e membros desta primeira fatia foram substituídas pela [ADR 0003](0003-sessoes-e-membros.md). Este registro permanece como histórico da implementação inicial.
