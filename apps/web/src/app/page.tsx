'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
type Tenant = { tenant_id: string; name: string; role: Role };
type Session = { user_id: string; email: string; display_name: string; tenant_id: string; role: Role; tenants: Tenant[]; csrf_token: string };
type Member = { user_id: string; email: string; display_name: string; role: Role };
type Product = { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type Source = { id: string; product_id: string; source_type: string; url: string; last_checked_at: string | null };
type SourceRun = { id: string; source_id: string; status: string; documents_seen: number; documents_new: number; documents_updated: number; pages_fetched: number; pull_requests_skipped: number; error_code: string | null; retry_after_at: string | null; started_at: string; finished_at: string | null };
type Import = { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null };
type Issue = { category: string; sentiment: string; severity: string; description: string; evidence_quote: string };
type Document = { id: string; source_id: string; document_type: 'review' | 'github_issue'; external_key: string; source_url: string; body: string; source_title: string | null; source_body: string | null; source_state: string | null; source_repository: string | null; source_created_at: string | null; source_updated_at: string | null; published_at: string | null; synthetic: boolean; analysis_status: string | null; analysis_model: string | null; analysis_error: string | null; issues: Issue[] };
const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const categoryNames: Record<string, string> = {
  support: 'Suporte', price: 'Preço', billing: 'Cobrança', performance: 'Desempenho',
  usability: 'Usabilidade', features: 'Funcionalidades',
};
const severityNames: Record<string, string> = { low: 'baixa', medium: 'média', high: 'alta' };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function isExampleAddress(value: string): boolean {
  try { return new URL(value).hostname.endsWith('.invalid'); }
  catch { return false; }
}

async function api<T>(path: string, session: Session | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (session && init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-CSRF-Token', session.csrf_token);
  const response = await fetch(`${base}/v1/${path}`, { ...init, headers, credentials: 'include', cache: 'no-store' });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new ApiError(Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? 'Falha na API', response.status);
  return body as T;
}

function formValues(event: FormEvent<HTMLFormElement>): FormData {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const sessionKey = useRef<string | null>(null);
  sessionKey.current = session?.csrf_token ?? null;
  const [loadingSession, setLoadingSession] = useState(true);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [inviteInput, setInviteInput] = useState('');
  const [issuedInvite, setIssuedInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceRuns, setSourceRuns] = useState<SourceRun[]>([]);
  const [imports, setImports] = useState<Import[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const refresh = useCallback(async (current: Session) => {
    const [nextProducts, nextSources, nextRuns, nextImports, nextDocuments, nextMembers] = await Promise.all([
      api<Product[]>('products', current), api<Source[]>('sources', current),
      api<SourceRun[]>('source-runs', current),
      api<Import[]>('imports', current), api<Document[]>('documents', current),
      api<Member[]>('members', current),
    ]);
    if (sessionKey.current !== current.csrf_token) return;
    setProducts(nextProducts); setSources(nextSources); setSourceRuns(nextRuns); setImports(nextImports);
    setDocuments(nextDocuments); setMembers(nextMembers);
  }, []);

  useEffect(() => {
    sessionStorage.removeItem('marketrift-session');
    void api<Session>('auth/session', null)
      .then(next => setSession(next))
      .catch(() => setSession(null))
      .finally(() => setLoadingSession(false));
  }, []);
  useEffect(() => {
    if (!session) return;
    const report = (err: unknown) => {
      if (sessionKey.current !== session.csrf_token) return;
      if (err instanceof ApiError && err.status === 401) {
        sessionKey.current = null; clearTenantData(); setSession(null);
      } else setError(String(err));
    };
    void refresh(session).catch(report);
    const timer = setInterval(() => void refresh(session).catch(report), 3000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError('');
    try { await action(); }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        sessionKey.current = null; clearTenantData(); setSession(null);
      } else setError(err instanceof Error ? err.message : String(err));
    }
    finally { setBusy(false); }
  }
  function clearTenantData(): void {
    setProducts([]); setSources([]); setSourceRuns([]); setImports([]); setDocuments([]); setMembers([]); setIssuedInvite('');
  }
  async function switchTo(current: Session, tenantId: string): Promise<void> {
    const next = await api<Session>('auth/switch-tenant', current, {
      method: 'POST', body: JSON.stringify({ tenant_id: tenantId }),
    });
    sessionKey.current = next.csrf_token;
    clearTenantData(); setSession(next);
    await refresh(next);
  }

  const canManage = session?.role === 'owner' || session?.role === 'admin';
  const activeTenant = session?.tenants.find(tenant => tenant.tenant_id === session.tenant_id);

  return <main>
    <header>
      <div><span className="eyebrow">INTELIGÊNCIA COMPETITIVA</span><h1>MarketRift</h1>
        <p>Portfólio, avaliações com origem e problemas extraídos com evidências.</p></div>
      {session && <button className="ghost" disabled={busy} onClick={() => void run(async () => {
        await api('auth/logout', session, { method: 'POST' });
        sessionKey.current = null; clearTenantData(); setSession(null);
      })}>Sair</button>}
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {loadingSession ? <p>Verificando sessão...</p> : !session ?
      <section className="card auth">
        <div className="tabs"><button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Criar conta</button>
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Entrar</button></div>
        <form onSubmit={event => void run(async () => {
          const data = formValues(event);
          const payload = mode === 'register' ? {
            email: data.get('email'), password: data.get('password'), display_name: data.get('display_name'),
            company_name: data.get('company_name') || undefined, invitation_token: data.get('invitation_token') || undefined,
          } : { email: data.get('email'), password: data.get('password') };
          const next = await api<Session>(`auth/${mode}`, null, { method: 'POST', body: JSON.stringify(payload) });
          sessionKey.current = next.csrf_token; setSession(next);
        })}>
          {mode === 'register' && <><label>Seu nome<input name="display_name" required /></label>
            <label>Empresa (obrigatória sem convite)<input name="company_name" required={!inviteInput} /></label>
            <label>Código de convite (opcional)<input name="invitation_token" value={inviteInput} onChange={event => setInviteInput(event.target.value.trim())} /></label></>}
          <label>Email<input type="email" name="email" required /></label>
          <label>Senha<input type="password" name="password" minLength={mode === 'register' ? 12 : undefined} required /></label>
          <button disabled={busy}>{mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
        </form>
      </section> : <div className="grid">
        <section className="card wide">
          <h2>Empresa ativa</h2><p>{activeTenant?.name} · seu papel: {session.role}. Conta: {session.email}</p>
          {session.tenants.length > 1 && <form onSubmit={event => void run(async () => {
            const data = formValues(event); await switchTo(session, String(data.get('tenant_id')));
          })}><label>Trocar de empresa<select name="tenant_id" defaultValue={session.tenant_id} key={session.tenant_id}>
            {session.tenants.map(tenant => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.name} ({tenant.role})</option>)}
          </select></label><button disabled={busy}>Trocar empresa</button></form>}
        </section>
        <section className="card"><h2>Produtos</h2><p>Cadastre o produto próprio e concorrentes.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('products', session, { method: 'POST', body: JSON.stringify({
              name: data.get('name'), kind: data.get('kind'), website_url: data.get('website_url') || undefined,
            }) });
            form.reset(); await refresh(session);
          })}><label>Nome<input name="name" required /></label>
            <label>Tipo<select name="kind"><option value="own">Produto próprio</option><option value="competitor">Concorrente</option></select></label>
            <label>Site (opcional)<input name="website_url" type="url" /></label>
            <button disabled={busy || !canManage}>Adicionar produto</button></form>
          <ul>{products.map(product => <li key={product.id}><strong>{product.name}</strong> <small>{product.kind === 'own' ? 'Próprio' : 'Concorrente'}</small></li>)}</ul>
        </section>
        <section className="card"><h2>Fontes</h2>
          <p>A importação manual exige URL por avaliação. Confirme que você pode usar os dados enviados.</p>
          <p>Para testar, use <code>https://example.invalid/reviews</code>. Esse endereço fictício não abre uma página.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources', session, { method: 'POST', body: JSON.stringify({ product_id: data.get('product_id'), url: data.get('url') }) });
            form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>URL da fonte<input name="url" type="url" required /></label>
            <button disabled={busy || !canManage || !products.length}>Adicionar fonte</button></form>
          <ul>{sources.filter(source => source.source_type === 'manual_review').map(source => <li key={source.id}>{isExampleAddress(source.url) ?
            <span>{source.url} <small>(endereço fictício, sem página)</small></span> :
            <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}</li>)}</ul>
        </section>
        <section className="card wide"><h2>Issues públicos do GitHub</h2>
          <p>Discussões públicas que podem incluir bugs e pedidos de funcionalidades. Issues não são avaliações de clientes nem representam todo o mercado. A coleta não envia textos para a OpenAI.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources/github-issues', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), repository: data.get('repository'),
            }) });
            form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>Repositório público (owner/repo ou URL)<input name="repository" placeholder="owner/repo" required /></label>
            <button disabled={busy || !canManage || !products.length}>Adicionar fonte GitHub Issues</button></form>
          <ul>{sources.filter(source => source.source_type === 'github_issues').map(source => {
            const latest = sourceRuns.find(item => item.source_id === source.id);
            return <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
              <p>Última coleta: {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString('pt-BR') : 'nenhuma'}</p>
              {latest && <p>Estado: {latest.status}; Issues consultadas: {latest.documents_seen}; novas: {latest.documents_new}; atualizadas: {latest.documents_updated}; páginas: {latest.pages_fetched}; Pull Requests ignorados: {latest.pull_requests_skipped}.
                {latest.error_code && <> Falha: {latest.error_code}.</>}
                {latest.retry_after_at && <> Tente após {new Date(latest.retry_after_at).toLocaleString('pt-BR')}.</>}</p>}
              {session.role !== 'viewer' && <form onSubmit={event => void run(async () => {
                const data = formValues(event);
                await api(`sources/${source.id}/sync`, session, { method: 'POST', body: JSON.stringify({
                  max_pages: Number(data.get('max_pages')), max_items: Number(data.get('max_items')),
                }) });
                await refresh(session);
              })}><label>Páginas (1–3)<input name="max_pages" type="number" min="1" max="3" defaultValue="2" required /></label>
                <label>Issues (1–50)<input name="max_items" type="number" min="1" max="50" defaultValue="20" required /></label>
                <button className="small" disabled={busy || latest?.status === 'running'}>Coletar Issues</button></form>}
            </li>;
          })}</ul>
        </section>
        <section className="card"><h2>Importar CSV</h2><p>Até 100 linhas. Colunas: external_key, source_url, published_at, body, synthetic.</p>
          <p>No campo Arquivo CSV, escolha <code>fixtures/reviews.example.csv</code> na pasta do projeto.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('imports/reviews', session, { method: 'POST', body: data });
            form.reset(); await refresh(session);
          })}><label>Fonte<select name="source_id" required>{sources.filter(source => source.source_type === 'manual_review').map(source => <option key={source.id} value={source.id}>{source.url}</option>)}</select></label>
            <label>Arquivo CSV<input type="file" name="file" accept=".csv,text/csv" required /></label>
            <button disabled={busy || session.role === 'viewer' || !sources.some(source => source.source_type === 'manual_review')}>Enviar avaliações</button></form>
        </section>
        <section className="card"><h2>Importações</h2><p>O estado é atualizado automaticamente.</p>
          {imports.length ? <ul>{imports.map(item => <li key={item.id}><strong>{item.status}</strong> · {item.processed_rows}/{item.total_rows} linhas
            {item.last_error && <small>{item.last_error}</small>}
            {item.status === 'pending' && session.role !== 'viewer' && <button className="small" onClick={() => void run(async () => {
              await api(`imports/${item.id}/requeue`, session, { method: 'POST' }); await refresh(session);
            })}>Reenfileirar</button>}</li>)}</ul> : <p className="empty">Nenhuma importação ainda.</p>}
        </section>
        <section className="card wide"><h2>Documentos</h2><p>Avaliações mostram problemas com evidência; Issues públicas do GitHub mostram título, corpo, estado, data e origem para revisão humana. Dados sintéticos não contam como avaliações reais.</p>
          {documents.length ? <div className="documents">{documents.map(document => <article key={document.id}>
            <div className="meta">{document.document_type === 'github_issue' && <span className="badge">Issue público do GitHub</span>}{document.synthetic && <span className="badge">SINTÉTICO</span>}
              {document.published_at && <time>{new Date(document.published_at).toLocaleDateString('pt-BR')}</time>}<code>{document.external_key}</code></div>
            {document.document_type === 'github_issue' ? <><h3>{document.source_title}</h3><p>Repositório: {document.source_repository} · Estado: {document.source_state} · Atualizada: {document.source_updated_at ? new Date(document.source_updated_at).toLocaleString('pt-BR') : 'desconhecido'}</p><p>{document.source_body || 'Sem descrição.'}</p></> : <p>{document.body}</p>}{isExampleAddress(document.source_url) ?
              <small>URL fictícia, sem página: {document.source_url}</small> :
              <a href={document.source_url} target="_blank" rel="noreferrer">Abrir origem ↗</a>}
            {document.document_type === 'review' && <div className="analysis">
              <h3>Problemas extraídos</h3>
              {document.analysis_model === 'controlled-test-fixture-v1' && <p className="test-label">Resultado controlado de teste; não é uma análise feita por IA.</p>}
              {document.analysis_status === 'completed' ? document.issues.length ?
                <ul className="issue-list">{document.issues.map((issue, index) => <li key={`${document.id}-${index}`}>
                  <strong>{categoryNames[issue.category] ?? issue.category}</strong> · gravidade {severityNames[issue.severity] ?? issue.severity}
                  <p>{issue.description}</p><blockquote>“{issue.evidence_quote}”</blockquote>
                </li>)}</ul> : <p>Nenhum problema identificado nesta avaliação.</p> :
                <p>{document.analysis_status === 'unavailable' ? 'Análise indisponível: configure um provedor real para processar esta avaliação.' :
                  document.analysis_status === 'failed' ? `Análise falhou (${document.analysis_error ?? 'erro desconhecido'}).` :
                    document.analysis_status === 'processing' ? 'Análise em andamento…' : 'Análise aguardando processamento.'}</p>}
              {session.role !== 'viewer' && ['pending', 'failed', 'unavailable', null].includes(document.analysis_status) &&
                <button className="small" disabled={busy} onClick={() => void run(async () => {
                  await api(`documents/${document.id}/analyze`, session, { method: 'POST' }); await refresh(session);
                })}>Reenfileirar análise</button>}
            </div>}</article>)}</div> :
            <p className="empty">Os documentos aparecerão após o worker concluir a importação.</p>}
        </section>
        <section className="card wide"><h2>Membros e convites</h2>
          <p>Convites são códigos de uso único válidos por sete dias. Entregue o código à pessoa convidada por um canal seguro; o envio de email ainda não está integrado.</p>
          {canManage && <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            const result = await api<{ invitation_token: string }>('invitations', session, {
              method: 'POST', body: JSON.stringify({ email: data.get('email'), role: data.get('role') }),
            });
            setIssuedInvite(result.invitation_token); form.reset();
          })}><label>Email da pessoa<input name="email" type="email" required /></label>
            <label>Papel<select name="role">{session.role === 'owner' && <option value="admin">admin</option>}
              <option value="analyst">analyst</option><option value="viewer">viewer</option></select></label>
            <button disabled={busy}>Criar convite</button></form>}
          {issuedInvite && <p className="invite-code">Código de convite (mostrado uma vez): <code>{issuedInvite}</code></p>}
          <h3>Aceitar convite recebido</h3>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event);
            const next = await api<Session>('invitations/accept', session, {
              method: 'POST', body: JSON.stringify({ invitation_token: data.get('invitation_token') }),
            });
            sessionKey.current = next.csrf_token; clearTenantData(); setSession(next); await refresh(next);
          })}><label>Código de convite<input name="invitation_token" required /></label>
            <button disabled={busy}>Aceitar e entrar na empresa</button></form>
          <ul>{members.map(member => <li key={member.user_id}>
            <strong>{member.display_name}</strong> · {member.email} · {member.role}
            {canManage && (session.role === 'owner' || !['owner', 'admin'].includes(member.role)) &&
              <form className="member-actions" onSubmit={event => void run(async () => {
                const data = formValues(event);
                await api(`members/${member.user_id}`, session, { method: 'PATCH', body: JSON.stringify({ role: data.get('role') }) });
                const next = await api<Session>('auth/session', session);
                setSession(next); await refresh(next);
              })}><label>Alterar papel<select name="role" defaultValue={member.role}>
                {session.role === 'owner' && <><option value="owner">owner</option><option value="admin">admin</option></>}
                <option value="analyst">analyst</option><option value="viewer">viewer</option>
              </select></label><button disabled={busy}>Salvar papel</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(async () => {
                  await api(`members/${member.user_id}`, session, { method: 'DELETE' });
                  if (member.user_id === session.user_id) { sessionKey.current = null; clearTenantData(); setSession(null); }
                  else await refresh(session);
                })}>Remover</button></form>}
          </li>)}</ul>
        </section>
      </div>}
  </main>;
}
