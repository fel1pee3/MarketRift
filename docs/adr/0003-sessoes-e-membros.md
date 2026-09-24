# ADR 0003: sessões de navegador e membros

**Status:** implementado para desenvolvimento local em 2026-09-23.

## Decisão

- A API emite um identificador opaco aleatório de 256 bits em cookie `HttpOnly`, `SameSite=Lax`, `Path=/` e sem `Domain`. Em produção usa `Secure` e o prefixo `__Host-`; em HTTP local usa um nome sem esse prefixo. A sessão é de navegador, não persistente por `Max-Age`, e expira no banco após 12 horas. O banco guarda somente SHA-256 do identificador. Logout revoga a sessão; login e troca de empresa geram novo identificador.
- A API aceita credenciais apenas do `WEB_ORIGIN` configurado e libera CORS com credenciais somente para essa origem. Todas as requisições de escrita exigem `Origin` exato. Requisições autenticadas de escrita também exigem `X-CSRF-Token`: o token é derivado por HMAC do identificador da sessão com `SESSION_SECRET` e entregue pelo endpoint de sessão. O frontend o mantém apenas em memória. `SameSite` é defesa adicional, não a única proteção CSRF.
- `GET /v1/auth/session` restaura a interface após recarga. Nenhum JWT ou identificador da sessão é entregue ao JavaScript. O segredo antigo `JWT_SECRET` ainda é aceito como configuração de transição; não há mais validação de JWT nas rotas. A interface apaga a chave antiga de `sessionStorage` ao iniciar.
- Cada operação resolve a sessão no banco, confirma a membership ativa e o papel via login runtime e transação com RLS, e usa esse tenant para consultas. Troca de empresa só ocorre após comprovar membership no destino; o `tenant_id` recebido não autoriza a operação por si.
- Convites são associados a email, papel e tenant, expiram em sete dias, são de uso único e ficam apenas como hash no banco. Owner pode convidar admin/analyst/viewer; admin pode convidar analyst/viewer. Um usuário novo aceita o convite no cadastro; um usuário existente o aceita autenticado. Não há envio automático por email nesta etapa: o criador vê o código uma vez para entrega por canal seguro.
- Owner pode alterar/remover membros, mas não o último owner. Admin só gerencia analyst/viewer. A revogação de membership elimina sessões daquele tenant por chave estrangeira. A migração 004 é aditiva e mantém os dados da primeira fatia.

## Limites

Recuperação de senha, envio de convites por email, proteção contra tentativas repetidas, 2FA, gestão de dispositivos e auditoria completa ainda faltam. A configuração de produção requer HTTPS e web/API no mesmo site para o cookie `SameSite=Lax`; hospedar em sites diferentes exigirá uma arquitetura de sessão específica. O script de migração 004 detecta a presença das tabelas, mas ainda não substitui um registro geral de versões de migração.

Referências de segurança: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) e [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
