'use client';

import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import EvidencePanel from './EvidencePanel';
import SignalsPanel from './SignalsPanel';
import QuestionsPanel from './QuestionsPanel';
import RetrievalReviewPanel from './RetrievalReviewPanel';

type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
type Tenant = { tenant_id: string; name: string; role: Role };
type Session = { user_id: string; email: string; display_name: string; tenant_id: string; role: Role; tenants: Tenant[]; csrf_token: string };
export function sessionIdentity(value: Pick<Session, 'user_id' | 'tenant_id' | 'role' | 'csrf_token'>): string {
  return JSON.stringify([value.user_id, value.tenant_id, value.role, value.csrf_token]);
}
type Member = { user_id: string; email: string; display_name: string; role: Role };
type Product = { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type Source = { id: string; product_id: string; source_type: string; url: string; last_checked_at: string | null;
  external_product_id: string | null; access_environment: 'sandbox' | 'production' | null; access_status: string;
  rights_recorded: boolean; rights_expires_at: string | null; storage_permitted: boolean; external_ai_permitted: boolean;
  ai_rights_recorded: boolean; ai_provider: string | null; ai_rights_expires_at: string | null;
  ai_rights_revoked_at: string | null };
type SourceRun = { id: string; source_id: string; status: string; documents_seen: number; documents_new: number; documents_updated: number; documents_ignored: number; scan_complete: boolean | null; pages_fetched: number; pull_requests_skipped: number; error_code: string | null; retry_after_at: string | null; started_at: string; finished_at: string | null };
type Import = { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null };
type Issue = { category: string; sentiment: string; severity: string; description: string; evidence_quote: string };
type Document = { id: string; source_id: string; product_id: string; product_name: string; document_type: 'review' | 'b2b_review' | 'g2_review' | 'github_issue' | 'github_discussion' | 'steam_review'; external_key: string; source_url: string; source_url_kind: string | null; body: string; steam_app_id: string | null; review_language: string | null; review_rating: number | null; review_data_status: string | null; review_voted_up: boolean | null; source_title: string | null; source_body: string | null; source_state: string | null; source_repository: string | null; discussion_category: string | null; discussion_author: string | null; discussion_content_status: string | null; discussion_relevance: string | null; source_created_at: string | null; source_updated_at: string | null; published_at: string | null; synthetic: boolean; analysis_status: string | null; analysis_model: string | null; analysis_error: string | null; analysis_eligibility: string | null; issues: Issue[] };
type PageSource = { id: string; product_id: string; product_name: string; source_type: 'pricing_page' | 'release_notes'; url: string; check_interval_minutes: number; last_checked_at: string | null; monitoring_enabled: boolean; next_check_at: string | null; consecutive_failures: number };
type PageRun = { id: string; source_id: string; status: string; error_code: string | null; retry_after_at: string | null; documents_new: number; started_at: string; finished_at: string | null; trigger_kind: 'manual' | 'scheduled' };
type PagePlan = { name: string; amount: string | null; currency: string | null; period: string | null; conditions: string; confirmed: boolean; evidence: string };
type PageEntry = { title: string; date: string | null; url: string; evidence: string };
type PageExtract = { kind: string; text: string; status: string; reason?: string; excerpt: string; plans?: PagePlan[]; entries?: PageEntry[] };
type PageSnapshot = { id: string; source_id: string; version_no: number; final_url: string; content_sha256: string; normalized_text: string; extracted: PageExtract; fetched_at: string; interpretation_version: number | null; interpretation_status: string; interpretation_reason: string };
type PageDetail = { kind: string; name?: string; previous?: string | PagePlan | PageEntry | null; current?: string | PagePlan | PageEntry | null; percent_change?: string | null };
type PageChange = { id: string; source_id: string; previous_snapshot_id: string; current_snapshot_id: string; change_details: PageDetail[]; detected_at: string };
type PageData = { sources: PageSource[]; runs: PageRun[]; snapshots: PageSnapshot[]; changes: PageChange[] };
type View = 'overview' | 'sources' | 'evidence' | 'questions' | 'signals' | 'retrieval-review' | 'account';
type SignalSummary = { id: string; state: string; summary: string; source_type: string; test_data: boolean; read_at: string | null };
type SignalResult = { signals: SignalSummary[]; alerts: SignalSummary[];
  reconciliation: { last_at: string | null; pending: number; failed: number; reasons: string[] } };
export const views: { id: View; href: string; title: string; description: string }[] = [
  { id: 'overview', href: '/', title: 'Visão geral', description: 'Acompanhamento, mudanças observadas e atenção necessária.' },
  { id: 'sources', href: '/fontes', title: 'Produtos e fontes', description: 'Produtos, conectores, permissões e importações.' },
  { id: 'evidence', href: '/evidencias', title: 'Evidências', description: 'Documentos, origem e indicadores descritivos.' },
  { id: 'questions', href: '/perguntas', title: 'Perguntas', description: 'Indexação local e respostas extrativas com citações.' },
  { id: 'signals', href: '/revisao', title: 'Revisão de sinais', description: 'Candidatos, decisões e alertas internos.' },
  { id: 'retrieval-review', href: '/avaliacao-busca', title: 'Avaliação da busca', description: 'Julgamento humano e relatórios de recuperação.' },
  { id: 'account', href: '/conta', title: 'Conta e equipe', description: 'Empresa ativa, membros, convites e sessão.' },
];
export function WorkspaceNavigation({ view }: { view: View }) {
  return <nav className="workspace-nav" aria-label="Navegação principal">
    {views.map(item => <Link key={item.id} href={item.href} aria-current={view === item.id ? 'page' : undefined}>
      {item.title}</Link>)}
  </nav>;
}
const emptyPageData: PageData = { sources: [], runs: [], snapshots: [], changes: [] };
function pageEvidence(value: PageDetail['previous']): string {
  if (!value) return 'ausente nesta versão';
  if (typeof value === 'string') return value;
  if ('amount' in value) return `${value.name}: ${value.currency} ${value.amount} / ${value.period ?? 'período não confirmado'}. Condições: ${value.conditions}. Trecho: “${value.evidence}”`;
  return `${value.title}${value.date ? ` · ${value.date}` : ''}. Trecho: “${value.evidence}”`;
}
const interpretationStatus: Record<string, string> = {
  confirmed: 'confirmada', partial: 'parcialmente confirmada', unconfirmed: 'não confirmada',
  needs_review: 'precisa de revisão',
};
const interpretationReasons: Record<string, string> = {
  legacy_extractor_requires_review: 'Captura anterior às regras atuais; a interpretação antiga não foi validada.',
  release_context_missing: 'A página não se identifica como changelog ou notas de versão.',
  release_entries_missing: 'Nenhuma entrada de alteração de produto foi encontrada.',
  release_link_or_title_missing: 'Faltou título, evidência de alteração ou link específico da entrada.',
  some_release_entries_unconfirmed: 'Algumas entradas não têm evidência completa.',
  release_entries_confirmed: 'Entradas com contexto de release e links específicos.',
  pricing_context_missing: 'A página não se identifica como página de preços.',
  price_fields_missing: 'Plano, valor, moeda ou período não estão explícitos.',
  some_plans_unconfirmed: 'Alguns planos não têm todos os campos explícitos.',
  price_plans_confirmed: 'Planos com valor, moeda e período explícitos.',
};
const pageErrorReasons: Record<string, string> = {
  access_denied: 'A origem recusou o acesso.', robots_disallowed: 'A origem não permite esta coleta em robots.txt.',
  robots_unavailable: 'Não foi possível confirmar as regras de robots.txt.',
  rate_limited: 'A origem limitou as requisições.', not_found: 'A página não foi encontrada.',
  no_extractable_content: 'Não há conteúdo textual utilizável.', network_failure: 'Falha de rede.',
  worker_timeout: 'O worker não concluiu a verificação no tempo esperado.',
  monitor_paused: 'A verificação agendada foi cancelada porque a monitoração foi pausada.',
  invalid_test_host: 'Um worker em modo de teste tentou verificar uma página real. Reinicie o worker sem MARKETRIFT_TEST_MODE e WEB_PAGE_TEST_BASE_URL; a captura anterior foi preservada.',
};
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
  if (!response.ok) {
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? 'Falha na API';
    const friendly = response.status === 409 && path.startsWith('page-sources/') ?
      message.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
        (value: string) => new Date(value).toLocaleString('pt-BR')) : message;
    throw new ApiError(friendly, response.status);
  }
  return body as T;
}

function formValues(event: FormEvent<HTMLFormElement>): FormData {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export default function WorkspaceApp({ view }: { view: View }) {
  const [session, setSession] = useState<Session | null>(null);
  const sessionKey = useRef<string | null>(null);
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
  const [pageData, setPageData] = useState<PageData>(emptyPageData);
  const [members, setMembers] = useState<Member[]>([]);
  const [signalResult, setSignalResult] = useState<SignalResult | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  const refresh = useCallback(async (current: Session) => {
    const [nextProducts, nextSources, nextRuns, nextImports, nextDocuments, nextMembers, nextPages, nextSignals] = await Promise.all([
      api<Product[]>('products', current), api<Source[]>('sources', current),
      api<SourceRun[]>('source-runs', current),
      api<Import[]>('imports', current), api<Document[]>('documents', current),
      api<Member[]>('members', current),
      api<PageData>('page-sources', current),
      view === 'overview' ? api<SignalResult>('reviewable-signals', current) : Promise.resolve(null),
    ]);
    if (sessionKey.current !== sessionIdentity(current)) return;
    setProducts(nextProducts); setSources(nextSources); setSourceRuns(nextRuns); setImports(nextImports);
    setDocuments(nextDocuments); setMembers(nextMembers); setPageData(nextPages);
    setSignalResult(nextSignals); setDataLoaded(true);
  }, [view]);

  useEffect(() => {
    sessionStorage.removeItem('marketrift-session');
    void api<Session>('auth/session', null)
      .then(next => { sessionKey.current = sessionIdentity(next); setSession(next); })
      .catch(cause => {
        sessionKey.current = null;
        if (!(cause instanceof ApiError && cause.status === 401))
          setError('Não foi possível verificar a sessão. Confira a API e tente novamente.');
        setSession(null);
      })
      .finally(() => setLoadingSession(false));
  }, []);
  useEffect(() => {
    if (!session) return;
    const report = (err: unknown) => {
      if (sessionKey.current !== sessionIdentity(session)) return;
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
    setProducts([]); setSources([]); setSourceRuns([]); setImports([]); setDocuments([]); setMembers([]);
    setPageData(emptyPageData); setSignalResult(null); setDataLoaded(false); setIssuedInvite('');
  }
  async function switchTo(current: Session, tenantId: string): Promise<void> {
    const next = await api<Session>('auth/switch-tenant', current, {
      method: 'POST', body: JSON.stringify({ tenant_id: tenantId }),
    });
    sessionKey.current = sessionIdentity(next);
    clearTenantData(); setSession(next);
    await refresh(next);
  }

  const canManage = session?.role === 'owner' || session?.role === 'admin';
  const activeTenant = session?.tenants.find(tenant => tenant.tenant_id === session.tenant_id);
  const currentView = views.find(item => item.id === view)!;

  return <main>
    {session && <a className="skip-link" href="#main-content">Pular para o conteúdo</a>}
    <header>
      <div><span className="eyebrow">INTELIGÊNCIA COMPETITIVA</span><h1>MarketRift</h1>
        <p>Portfólio, avaliações com origem e problemas extraídos com evidências.</p></div>
      {session && <button className="ghost" disabled={busy} onClick={() => void run(async () => {
        await api('auth/logout', session, { method: 'POST' });
        sessionKey.current = null; clearTenantData(); setSession(null);
      })}>Sair</button>}
    </header>
    {session && <><WorkspaceNavigation view={view} />
      <div className="workspace-context"><div><strong>{currentView.title}</strong><p>{currentView.description}</p></div>
        <Link href="/conta">{activeTenant?.name ?? 'Empresa ativa'} · {session.role}</Link></div></>}
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
          sessionKey.current = sessionIdentity(next); setSession(next);
        })}>
          {mode === 'register' && <><label>Seu nome<input name="display_name" required /></label>
            <label>Empresa (obrigatória sem convite)<input name="company_name" required={!inviteInput} /></label>
            <label>Código de convite (opcional)<input name="invitation_token" value={inviteInput} onChange={event => setInviteInput(event.target.value.trim())} /></label></>}
          <label>Email<input type="email" name="email" required /></label>
          <label>Senha<input type="password" name="password" minLength={mode === 'register' ? 12 : undefined} required /></label>
          <button disabled={busy}>{mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
        </form>
      </section> : <div className="grid" id="main-content" key={session.tenant_id} aria-busy={!dataLoaded}>
        {view === 'account' && <section className="card wide">
          <h2>Empresa ativa</h2><p>{activeTenant?.name} · seu papel: {session.role}. Conta: {session.email}</p>
          {session.tenants.length > 1 && <form onSubmit={event => void run(async () => {
            const data = formValues(event); await switchTo(session, String(data.get('tenant_id')));
          })}><label>Trocar de empresa<select name="tenant_id" defaultValue={session.tenant_id} key={session.tenant_id}>
            {session.tenants.map(tenant => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.name} ({tenant.role})</option>)}
          </select></label><button disabled={busy}>Trocar empresa</button></form>}
        </section>}
        {!dataLoaded && <div className="card wide" role="status"><p>{error ? 'Não foi possível carregar os dados desta empresa.' : `Carregando dados de ${activeTenant?.name ?? 'sua empresa'}...`}</p>
          {error && <button className="small" onClick={() => void run(() => refresh(session))}>Tentar novamente</button>}</div>}
        {view === 'overview' && dataLoaded && <Overview tenantName={activeTenant?.name ?? 'Empresa ativa'}
          role={session.role} products={products} sources={sources} sourceRuns={sourceRuns}
          pages={pageData} signals={signalResult} />}
        {view === 'evidence' && <section className="card wide source-jump" aria-label="Ir para evidências">
          <h2>Encontre uma evidência</h2><div className="jump-links"><a href="#explorar">Busca e indicadores</a>
            <a href="#discussions-coletadas">Discussions públicas</a><a href="#documentos">Documentos e análises</a></div>
        </section>}
        {view === 'evidence' && <EvidencePanel key={session.tenant_id} products={products} />}
        {view === 'signals' && <SignalsPanel key={`signals-${session.tenant_id}`} tenantId={session.tenant_id} csrfToken={session.csrf_token} role={session.role} />}
        {view === 'questions' && <QuestionsPanel key={`questions-${session.tenant_id}`} products={products} sources={sources}
          csrfToken={session.csrf_token} role={session.role} />}
        {view === 'retrieval-review' && <RetrievalReviewPanel key={`retrieval-review-${session.tenant_id}`} products={products}
          csrfToken={session.csrf_token} role={session.role} />}
        {view === 'sources' && <><section className="card wide source-jump" aria-label="Ir para uma fonte">
          <h2>Encontre uma fonte</h2><div className="jump-links">
            <a href="#produtos">Produtos</a><a href="#csv-legado">CSV legado</a><a href="#b2b">Reviews B2B</a>
            <a href="#g2">G2</a><a href="#github-issues">GitHub Issues</a><a href="#github-discussions">GitHub Discussions</a>
            <a href="#steam">Steam</a><a href="#paginas">Preços e changelogs</a><a href="#importacoes">Importações</a>
          </div></section>
        <section id="produtos" className="card"><h2>Produtos</h2><p>Cadastre o produto próprio e concorrentes.</p>
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
        <section id="csv-legado" className="card"><h2>Fontes</h2>
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
        <section id="b2b" className="card wide"><h2>Avaliações B2B com permissão declarada</h2>
          <p>Este caminho é separado do CSV legado. Cadastre a origem e uma referência verificável da licença/autorização para guardar o texto. O MarketRift registra sua declaração; ainda não verifica contratos externos automaticamente. O envio à IA exige autorização adicional e uma ação por review.</p>
          {canManage && <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources/b2b-csv', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), url: data.get('url'),
              rights_reference: data.get('rights_reference'), storage_permitted: data.get('storage_permitted') === 'on',
              external_ai_permitted: false, synthetic_only: data.get('synthetic_only') === 'on',
            }) }); form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>URL HTTPS da origem<input name="url" type="url" placeholder="https://fornecedor.example/reviews" required /></label>
            <label>Referência da autorização de armazenamento<input name="rights_reference" placeholder="Contrato/licença e seção, sem segredo" minLength={8} required /></label>
            <label><input name="synthetic_only" type="checkbox" /> Fonte somente de teste: todas as linhas deverão ter <code>synthetic=true</code>.</label>
            <label><input name="storage_permitted" type="checkbox" required /> Confirmo que tenho permissão para armazenar estes textos.</label>
            <button disabled={busy || !products.length}>Cadastrar origem B2B</button></form>}
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('imports/b2b-reviews', session, { method: 'POST', body: data });
            form.reset(); await refresh(session);
          })}><label>Origem autorizada<select name="source_id" required>{sources.filter(source => source.source_type === 'b2b_csv_review').map(source =>
            <option key={source.id} value={source.id}>{products.find(p => p.id === source.product_id)?.name}: {source.url}</option>)}</select></label>
            <label>CSV autorizado (real ou sintético conforme a fonte)<input name="file" type="file" accept=".csv,text/csv" required /></label>
            <button disabled={busy || session.role === 'viewer' || !sources.some(source => source.source_type === 'b2b_csv_review')}>Importar avaliações B2B</button></form>
          <p>Colunas: <code>external_key,source_url,published_at,body</code>; opcionais: <code>language,rating,synthetic</code>. Até 100 linhas. Uma linha real com URL fictícia é recusada. Fonte de teste aceita apenas linhas <code>synthetic=true</code>. Reenviar o mesmo ID na mesma origem não duplica a review.</p>
          <ul>{sources.filter(source => source.source_type === 'b2b_csv_review').map(source => <li key={source.id}>
            {products.find(p => p.id === source.product_id)?.name} · {source.url} · {source.access_environment === 'sandbox' ? 'TESTE, somente sintético' : 'direitos declarados'} · armazenamento declarado: {source.storage_permitted ? 'sim' : 'não'} · referência registrada: {source.rights_recorded ? 'sim' : 'não'}
            {source.access_environment === 'production' && <p>Envio à IA externa: {source.external_ai_permitted && source.ai_rights_expires_at && new Date(source.ai_rights_expires_at) > new Date() && !source.ai_rights_revoked_at ?
              `declarado para ${source.ai_provider} até ${new Date(source.ai_rights_expires_at).toLocaleDateString('pt-BR')}` :
              source.ai_rights_revoked_at ? 'revogado' : 'não autorizado ou expirado'}. A declaração não verifica o contrato automaticamente.</p>}
            {canManage && source.access_environment === 'production' && source.storage_permitted && <form onSubmit={event => void run(async () => {
              const data = formValues(event); const form = event.currentTarget;
              await api(`sources/b2b-csv/${source.id}/ai-rights`, session, { method: 'POST', body: JSON.stringify({
                provider: 'openai', rights_reference: data.get('rights_reference'),
                rights_expires_at: new Date(String(data.get('rights_expires_at'))).toISOString(),
                external_ai_permitted: data.get('external_ai_permitted') === 'on',
              }) }); form.reset(); await refresh(session);
            })}><label>Referência da autorização específica para envio à OpenAI<input name="rights_reference" minLength={8} required /></label>
              <label>Validade dessa autorização<input name="rights_expires_at" type="date" required /></label>
              <label><input name="external_ai_permitted" type="checkbox" required /> Confirmo que o envio externo ao provedor está permitido, além do armazenamento.</label>
              <button disabled={busy}>Registrar ou renovar direito de envio</button></form>}
            {canManage && source.external_ai_permitted && <button className="small" disabled={busy} onClick={() => void run(async () => {
              await api(`sources/b2b-csv/${source.id}/revoke-ai-rights`, session, { method: 'POST' }); await refresh(session);
            })}>Revogar somente envio à IA</button>}
            {session.role === 'owner' && source.storage_permitted && <button className="small" disabled={busy} onClick={() => {
              if (!window.confirm('Revogar direitos e apagar os textos desta fonte? Esta ação não pode ser desfeita.')) return;
              void run(async () => { await api(`sources/${source.id}/revoke-review-rights`, session, { method: 'POST' }); await refresh(session); });
            }}>Revogar e apagar textos</button>}
          </li>)}</ul>
        </section>
        <section id="g2" className="card wide"><h2>G2: integração condicionada ao acesso</h2>
          <p>Reviews G2 são uma fonte candidata de clientes B2B. Cadastrar um produto não prova acesso às reviews de concorrentes. Sem credencial específica de syndication e direitos documentados, a coleta real falha de modo explícito. Dados do transporte controlado de teste aparecem como TESTE; nenhuma review G2 é enviada à OpenAI.</p>
          {canManage && <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources/g2', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), g2_product_id: data.get('g2_product_id'),
              product_url: data.get('product_url'), environment: data.get('environment'),
            }) }); form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>G2 Product ID (mapeamento oficial)<input name="g2_product_id" required /></label>
            <label>URL pública do produto no G2<input name="product_url" type="url" placeholder="https://www.g2.com/products/exemplo" required /></label>
            <label>Ambiente<select name="environment"><option value="sandbox">Teste / sandbox</option><option value="production">Produção, somente com acordo</option></select></label>
            <button disabled={busy || !products.length}>Cadastrar fonte G2</button></form>}
          <ul>{sources.filter(source => source.source_type === 'g2').map(source => {
            const latest = sourceRuns.find(run => run.source_id === source.id);
            const reasons: Record<string, string> = {
              credential_missing: 'Credencial de syndication ausente no worker.', credential_invalid: 'G2 recusou a credencial (401).',
              scope_or_product_access_denied: 'G2 recusou o escopo ou o acesso a este produto (403).',
              product_not_found: 'Produto não encontrado (404).', rights_unconfirmed: 'Direito de armazenamento não confirmado ou integração de produção desabilitada.',
              sandbox_endpoint_unconfirmed: 'O endpoint oficial de sandbox ainda não foi confirmado; não houve coleta.',
              rate_limited: 'Limite da G2; aguarde o horário indicado.', upstream_failure: 'Falha transitória da G2.',
            };
            return <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> · {source.access_environment === 'sandbox' ? 'TESTE' : 'produção'} · acesso: {source.access_status}.
              <p>Última coleta: {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString('pt-BR') : 'nenhuma'}.</p>
              {latest && <p>Execução: <strong>{latest.status}</strong> · consultadas: {latest.documents_seen} · novas: {latest.documents_new} · atualizadas: {latest.documents_updated} · páginas: {latest.pages_fetched}.
                {latest.scan_complete === false && ' Cobertura parcial; outra execução continua pelo checkpoint.'}
                {latest.error_code && ` ${reasons[latest.error_code] ?? latest.error_code}`}
                {latest.retry_after_at && ` Tente após ${new Date(latest.retry_after_at).toLocaleString('pt-BR')}.`}</p>}
              {source.access_environment === 'production' && <p>Direitos de armazenamento: {source.storage_permitted && source.rights_recorded ? 'declarados' : 'pendentes'} · validade: {source.rights_expires_at ? new Date(source.rights_expires_at).toLocaleDateString('pt-BR') : 'não registrada'}.</p>}
              {session.role === 'owner' && source.access_environment === 'production' &&
                <form onSubmit={event => void run(async () => {
                  const data = formValues(event); const form = event.currentTarget;
                  await api(`sources/g2/${source.id}/rights`, session, { method: 'POST', body: JSON.stringify({
                    rights_reference: data.get('rights_reference'), rights_expires_at: new Date(String(data.get('rights_expires_at'))).toISOString(),
                    storage_permitted: data.get('storage_permitted') === 'on', external_ai_permitted: false,
                  }) }); form.reset(); await refresh(session);
                })}><label>Referência do acordo G2 para armazenamento<input name="rights_reference" minLength={8} required /></label>
                  <label>Validade do acordo<input name="rights_expires_at" type="date" required /></label>
                  <label><input name="storage_permitted" type="checkbox" required /> Confirmo direito expresso de armazenamento.</label>
                  <button disabled={busy}>{source.storage_permitted ? 'Atualizar declaração de direitos' : 'Registrar declaração de direitos'}</button></form>}
              {session.role !== 'viewer' && <button className="small" disabled={busy || latest?.status === 'running' || latest?.status === 'pending'} onClick={() => void run(async () => {
                await api(`sources/${source.id}/sync`, session, { method: 'POST', body: JSON.stringify({ max_pages: 1, max_items: 5 }) }); await refresh(session);
              })}>Testar coleta limitada (1 página, 5 itens)</button>}
              {session.role === 'owner' && source.access_status !== 'denied' && <button className="small" disabled={busy} onClick={() => {
                if (!window.confirm('Revogar direitos e apagar os textos G2 desta fonte? Esta ação não pode ser desfeita.')) return;
                void run(async () => { await api(`sources/${source.id}/revoke-review-rights`, session, { method: 'POST' }); await refresh(session); });
              }}>Revogar e apagar textos</button>}
            </li>;
          })}</ul>
        </section>
        <section id="github-issues" className="card wide"><h2>Issues públicos do GitHub</h2>
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
        <section id="github-discussions" className="card wide"><h2>GitHub Discussions públicas</h2>
          <p>Debates e feedback da comunidade em repositórios públicos. Autores não foram verificados como clientes. Esta fonte fica separada de Issues e reviews; não há análise automática por IA.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources/github-discussions', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), repository: data.get('repository'),
            }) });
            form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>Repositório público com Discussions (owner/repo ou URL)<input name="repository" placeholder="owner/repo" required /></label>
            <button disabled={busy || !canManage || !products.length}>Adicionar fonte Discussions</button></form>
          <ul>{sources.filter(source => source.source_type === 'github_discussions').map(source => {
            const latest = sourceRuns.find(item => item.source_id === source.id);
            const reason: Record<string, string> = {
              configuration_pending: 'Configure GITHUB_DISCUSSIONS_TOKEN no ambiente do worker e reinicie-o.',
              repository_unavailable_or_private: 'Repositório indisponível, privado ou sem acesso público.',
              discussions_disabled: 'Discussions não estão habilitadas neste repositório.',
              github_unauthorized: 'GitHub recusou a credencial (401). Confira se o token está válido e reinicie o worker.',
              github_access_denied: 'Credencial GitHub recusada ou sem permissão nesta execução antiga. Solicite nova coleta para obter a categoria específica.',
              github_forbidden: 'GitHub recusou o acesso (403). Confira as permissões do token e as regras da conta.',
              github_permission_denied: 'O token não tem permissão para esta consulta GraphQL. Confira o acesso a repositórios públicos e Discussions.',
              rate_limited: 'Limite da API GitHub; aguarde o horário indicado.',
              graphql_query_invalid: 'A consulta GraphQL tem um campo ou argumento inválido. Atualize o conector.',
              graphql_error: 'A API GraphQL recusou a consulta por outro motivo. Consulte o código da execução no servidor.',
              network_failure: 'Falha de rede.', upstream_failure: 'Falha transitória do GitHub.',
            };
            return <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
              <p>Última coleta: {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString('pt-BR') : 'nenhuma; repositório ainda não validado pelo worker'}</p>
              {latest && <p>Estado: <strong>{latest.status}</strong>; consultadas: {latest.documents_seen}; novas: {latest.documents_new}; atualizadas: {latest.documents_updated}; páginas: {latest.pages_fetched}.
                {latest.scan_complete === false && <> Coleta parcial; outra execução continuará pelo cursor.</>}
                {latest.error_code && <> {reason[latest.error_code] ?? `Falha: ${latest.error_code}.`}</>}
                {latest.retry_after_at && <> Tente após {new Date(latest.retry_after_at).toLocaleString('pt-BR')}.</>}</p>}
              {session.role !== 'viewer' && <form onSubmit={event => void run(async () => {
                const data = formValues(event);
                await api(`sources/${source.id}/sync`, session, { method: 'POST', body: JSON.stringify({
                  max_pages: Number(data.get('max_pages')), max_items: Number(data.get('max_items')),
                }) });
                await refresh(session);
              })}><label>Páginas (1–3)<input name="max_pages" type="number" min="1" max="3" defaultValue="1" required /></label>
                <label>Discussions (1–50)<input name="max_items" type="number" min="1" max="50" defaultValue="5" required /></label>
                <button className="small" disabled={busy || latest?.status === 'running'}>Coletar Discussions</button></form>}
            </li>;
          })}</ul>
        </section>
        <section id="steam" className="card wide"><h2>Avaliações de usuários do Steam</h2>
          <p>Piloto para produtos publicados no Steam. A coleta é manual e limitada. Recomendação positiva ou negativa é um dado da plataforma; a extração de problemas por IA exige escolher uma review depois.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('sources/steam-reviews', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), app: data.get('app'),
            }) });
            form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>Steam App ID ou URL do produto<input name="app" placeholder="620 ou https://store.steampowered.com/app/620/" required /></label>
            <button disabled={busy || !canManage || !products.length}>Adicionar fonte Steam</button></form>
          <ul>{sources.filter(source => source.source_type === 'steam_reviews').map(source => {
            const latest = sourceRuns.find(item => item.source_id === source.id);
            const product = products.find(item => item.id === source.product_id);
            const duplicatedApp = sources.some(item => item.id !== source.id && item.source_type === 'steam_reviews' && item.url === source.url);
            return <li key={source.id}><strong>{product?.name ?? 'Produto não encontrado'}</strong> · <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
              {duplicatedApp && <p>Este App ID também está associado a outro produto deste tenant. Os mesmos relatos não devem ser somados duas vezes numa comparação futura.</p>}
              <p>Última coleta: {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString('pt-BR') : 'nenhuma'}</p>
              {latest && <p>Estado: {latest.status}; recebidas: {latest.documents_seen}; novas: {latest.documents_new}; atualizadas: {latest.documents_updated}; ignoradas: {latest.documents_ignored}; páginas: {latest.pages_fetched}.
                {latest.scan_complete === false && <> Janela não percorrida até o fim por causa do limite configurado.</>}
                {latest.error_code && <> Falha: {latest.error_code}.</>}
                {latest.retry_after_at && <> Tente após {new Date(latest.retry_after_at).toLocaleString('pt-BR')}.</>}</p>}
              {session.role !== 'viewer' && <form onSubmit={event => void run(async () => {
                const data = formValues(event);
                await api(`sources/${source.id}/sync`, session, { method: 'POST', body: JSON.stringify({
                  max_pages: Number(data.get('max_pages')), max_items: Number(data.get('max_items')),
                }) });
                await refresh(session);
              })}><label>Páginas (1–3)<input name="max_pages" type="number" min="1" max="3" defaultValue="1" required /></label>
                <label>Reviews (1–50)<input name="max_items" type="number" min="1" max="50" defaultValue="5" required /></label>
                <button className="small" disabled={busy || latest?.status === 'running'}>Coletar reviews</button></form>}
            </li>;
          })}</ul>
        </section>
        <section id="paginas" className="card wide"><h2>Páginas de preços e changelogs</h2>
          <p>A monitoração inicia automaticamente após o cadastro e segue a periodicidade escolhida enquanto o agendador estiver ligado. Você também pode pedir uma verificação manual. Capturar uma página não confirma que ela contém preços ou notas de versão. Não há análise por IA neste fluxo.</p>
          <form onSubmit={event => void run(async () => {
            const data = formValues(event); const form = event.currentTarget;
            await api('page-sources', session, { method: 'POST', body: JSON.stringify({
              product_id: data.get('product_id'), url: data.get('url'), source_type: data.get('source_type'),
              check_interval_minutes: Number(data.get('check_interval_minutes')),
            }) });
            form.reset(); await refresh(session);
          })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
            <label>Tipo<select name="source_type"><option value="pricing_page">Página de preços</option><option value="release_notes">Changelog</option></select></label>
            <label>URL pública HTTPS, sem parâmetros<input name="url" type="url" placeholder="https://exemplo.com/pricing" required /></label>
            <label>Periodicidade desejada<select name="check_interval_minutes"><option value="1440">Diária</option><option value="360">A cada 6 horas</option><option value="60">Horária</option><option value="10080">Semanal</option></select></label>
            <button disabled={busy || !canManage || !products.length}>Adicionar página</button></form>
          {pageData.sources.length ? <ul>{pageData.sources.map(source => {
            const latest = pageData.runs.find(run => run.source_id === source.id);
            const snapshots = pageData.snapshots.filter(snapshot => snapshot.source_id === source.id)
              .sort((a, b) => b.version_no - a.version_no);
            const changes = pageData.changes.filter(change => change.source_id === source.id);
            return <li key={source.id}><strong>{source.product_name}</strong> · {source.source_type === 'pricing_page' ? 'Preços' : 'Changelog'} · <a href={source.url} target="_blank" rel="noreferrer">Página cadastrada ↗</a>
              <p>Monitoração: <strong>{source.monitoring_enabled ? 'ativa' : 'pausada'}</strong> · periodicidade: {source.check_interval_minutes} min. · última verificação concluída: {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString('pt-BR') : 'nenhuma'} · próxima prevista: {source.monitoring_enabled && source.next_check_at ? new Date(source.next_check_at).toLocaleString('pt-BR') : 'não agendada'}</p>
              {latest && <p>Execução {latest.trigger_kind === 'scheduled' ? 'automática' : 'manual'}: <strong>{latest.status}</strong> · novo snapshot: {latest.documents_new ? 'sim' : 'não'}
                {latest.error_code && <> · motivo: {pageErrorReasons[latest.error_code] ?? latest.error_code}</>}
                {latest.retry_after_at && <> · aguarde até {new Date(latest.retry_after_at).toLocaleString('pt-BR')}</>}</p>}
              {canManage && <button className="small" disabled={busy} onClick={() => void run(async () => {
                await api(`page-sources/${source.id}/${source.monitoring_enabled ? 'pause' : 'resume'}`, session, { method: 'POST' }); await refresh(session);
              })}>{source.monitoring_enabled ? 'Pausar monitoração' : 'Reativar monitoração'}</button>}
              {session.role !== 'viewer' && <button className="small" disabled={busy || latest?.status === 'running' || latest?.status === 'pending'} onClick={() => void run(async () => {
                await api(`page-sources/${source.id}/check`, session, { method: 'POST' }); await refresh(session);
              })}>Verificar agora (1 página)</button>}
              {snapshots.length > 0 && <div className="page-history"><h3>Capturas verificáveis</h3><ul>{snapshots.slice(0, 5).map(snapshot => <li key={snapshot.id}>
                Versão {snapshot.version_no} · {new Date(snapshot.fetched_at).toLocaleString('pt-BR')} · hash <code>{snapshot.content_sha256.slice(0, 12)}</code> · <a href={snapshot.final_url} target="_blank" rel="noreferrer">URL final ↗</a>
                <p>Interpretação: <strong>{interpretationStatus[snapshot.interpretation_status] ?? snapshot.interpretation_status}</strong> · {interpretationReasons[snapshot.interpretation_reason] ?? snapshot.interpretation_reason}</p>
                {snapshot.interpretation_status === 'needs_review' ? <p>Trecho histórico para revisão: “{snapshot.extracted.excerpt}”</p> : <>
                  {snapshot.interpretation_status !== 'confirmed' && <p>Trecho da página: “{snapshot.extracted.excerpt}”</p>}
                  {snapshot.extracted.plans?.map(plan => <p key={plan.name}><strong>{plan.name}</strong>: {plan.confirmed ? `${plan.currency} ${plan.amount} / ${plan.period}` : 'preço não confirmado'} · trecho: “{plan.evidence}”</p>)}
                  {snapshot.extracted.entries?.map((entry, index) => <p key={`${entry.url}-${index}`}><strong>{entry.title}</strong> · {entry.date ?? 'data não informada'} · <a href={entry.url} target="_blank" rel="noreferrer">entrada confirmada ↗</a></p>)}
                </>}
              </li>)}</ul></div>}
              {changes.length > 0 && <div className="page-history"><h3>Mudanças observadas</h3>{changes.slice(0, 5).map(change => <article key={change.id}>
                <p>{new Date(change.detected_at).toLocaleString('pt-BR')} · versões {snapshots.find(item => item.id === change.previous_snapshot_id)?.version_no ?? '?'} → {snapshots.find(item => item.id === change.current_snapshot_id)?.version_no ?? '?'}.
                  <a href={snapshots.find(item => item.id === change.previous_snapshot_id)?.final_url ?? source.url} target="_blank" rel="noreferrer"> URL anterior ↗</a> ·
                  <a href={snapshots.find(item => item.id === change.current_snapshot_id)?.final_url ?? source.url} target="_blank" rel="noreferrer"> URL atual ↗</a></p>
                {snapshots.find(item => item.id === change.previous_snapshot_id)?.interpretation_status === 'needs_review' ||
                 snapshots.find(item => item.id === change.current_snapshot_id)?.interpretation_status === 'needs_review' ?
                  <p>Comparação histórica anterior às regras atuais. Revise os textos das duas capturas; os campos estruturados antigos não são considerados confirmados.</p> :
                  change.change_details.map((detail, index) => <div key={index}><strong>{detail.kind}</strong>{detail.name && <> · {detail.name}</>}{detail.percent_change !== null && detail.percent_change !== undefined && <> · variação comparável: {detail.percent_change}%</>}
                  <p>Antes: {pageEvidence(detail.previous)}</p><p>Depois: {pageEvidence(detail.current)}</p></div>)}
              </article>)}</div>}
            </li>;
          })}</ul> : <p className="empty">Nenhuma página de preço ou changelog cadastrada.</p>}
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
        <section id="importacoes" className="card"><h2>Importações</h2><p>O estado é atualizado automaticamente.</p>
          {imports.length ? <ul>{imports.map(item => <li key={item.id}><strong>{item.status}</strong> · {item.processed_rows}/{item.total_rows} linhas
            {item.last_error && <small>{item.last_error}</small>}
            {item.status === 'pending' && session.role !== 'viewer' && <button className="small" onClick={() => void run(async () => {
              await api(`imports/${item.id}/requeue`, session, { method: 'POST' }); await refresh(session);
            })}>Reenfileirar</button>}</li>)}</ul> : <p className="empty">Nenhuma importação ainda.</p>}
        </section></>}
        {view === 'evidence' && <><section id="discussions-coletadas" className="card wide"><h2>Discussions públicas coletadas</h2>
          <p>Conversas da comunidade; o autor pode não ser cliente. Categoria e texto preservados para revisão humana. Sem classificação por IA e sem inclusão nas métricas de reviews.</p>
          {documents.some(document => document.document_type === 'github_discussion') ?
            <div className="documents">{documents.filter(document => document.document_type === 'github_discussion').map(document =>
              <article key={document.id}><div className="meta"><span className="badge">Discussion pública do GitHub</span>
                {document.source_created_at && <time>{new Date(document.source_created_at).toLocaleDateString('pt-BR')}</time>}</div>
                <h3>{document.source_title}</h3>
                <p>Produto: {document.product_name} · Repositório: {document.source_repository} · Categoria: {document.discussion_category} · Estado: {document.source_state}</p>
                <p>Autor público: {document.discussion_author ?? 'não disponível'} (não verificado como cliente) · Atualizada: {document.source_updated_at ? new Date(document.source_updated_at).toLocaleString('pt-BR') : 'desconhecida'}</p>
                <p>{document.source_body || 'Sem corpo publicado.'}</p>
                {document.discussion_content_status === 'insufficient' && <p>Conteúdo insuficiente para inferir um problema.</p>}
                {document.discussion_relevance === 'announcement' && <p>Categoria de anúncio; não classificada como feedback de produto.</p>}
                <a href={document.source_url} target="_blank" rel="noreferrer">Abrir Discussion original ↗</a>
              </article>)}</div> : <p className="empty">Nenhuma Discussion coletada nesta empresa.</p>}
        </section>
        <section id="documentos" className="card wide"><h2>Documentos</h2><p>CSV de teste, CSV B2B com direitos declarados, G2, Steam e feedback GitHub são populações diferentes. A análise B2B exige ação por review; TESTE não conta como review real. G2 continua bloqueado para IA.</p>
          {documents.some(document => document.document_type !== 'github_discussion') ? <div className="documents">{documents.filter(document => document.document_type !== 'github_discussion').map(document => <article key={document.id}>
            <div className="meta">{document.document_type === 'github_issue' && <span className="badge">Issue público do GitHub</span>}{document.document_type === 'steam_review' && <span className="badge">Avaliação de usuário do Steam</span>}{document.document_type === 'b2b_review' && <span className="badge">Review B2B importada · direitos declarados</span>}{document.document_type === 'g2_review' && <span className="badge">Review G2 via API oficial</span>}{document.synthetic && <span className="badge">{document.review_data_status === 'sandbox_test' ? 'TESTE / SANDBOX' : 'SINTÉTICO'}</span>}{document.review_data_status === 'unverified_legacy' && <span className="badge">Direitos não verificados</span>}
              {document.published_at && <time>{new Date(document.published_at).toLocaleDateString('pt-BR')}</time>}<code>{document.external_key}</code></div>
            <p><strong>Produto associado:</strong> {document.product_name}</p>
            {document.document_type === 'github_issue' ? <><h3>{document.source_title}</h3><p>Repositório: {document.source_repository} · Estado: {document.source_state} · Atualizada: {document.source_updated_at ? new Date(document.source_updated_at).toLocaleString('pt-BR') : 'desconhecido'}</p><p>{document.source_body || 'Sem descrição.'}</p></> : <><p>{document.body}</p>{document.document_type === 'steam_review' && <p>App ID: {document.steam_app_id} · Idioma: {document.review_language} · Recomendação no Steam: {document.review_voted_up ? 'positiva' : 'negativa'} · Atualizada: {document.source_updated_at ? new Date(document.source_updated_at).toLocaleString('pt-BR') : 'desconhecida'}</p>}{['b2b_review', 'g2_review'].includes(document.document_type) && <p>Idioma: {document.review_language ?? 'não informado'} · nota: {document.review_rating ?? 'não informada'} · origem: {document.review_data_status === 'sandbox_test' || document.review_data_status === 'synthetic_fixture' ? 'TESTE, fora de métricas reais' : document.review_data_status === 'declared_real' ? 'real segundo declaração da fonte' : 'direitos não verificados'}.</p>}</>}{isExampleAddress(document.source_url) ?
              <small>URL fictícia, sem página: {document.source_url}</small> :
              <a href={document.source_url} target="_blank" rel="noreferrer">{document.source_url_kind === 'product_reviews' ? 'Abrir página de avaliações do produto (não é link individual) ↗' : 'Abrir origem ↗'}</a>}
            {['review', 'steam_review', 'b2b_review'].includes(document.document_type) && <div className="analysis">
              <h3>Problemas extraídos</h3>
              {document.analysis_model === 'controlled-test-fixture-v1' && <p className="test-label">Resultado controlado de teste; não é uma análise feita por IA.</p>}
              {document.analysis_status === 'completed' ? document.issues.length ?
                <ul className="issue-list">{document.issues.map((issue, index) => <li key={`${document.id}-${index}`}>
                  <strong>{categoryNames[issue.category] ?? issue.category}</strong> · gravidade {severityNames[issue.severity] ?? issue.severity}
                  <p>{issue.description}</p><blockquote>“{issue.evidence_quote}”</blockquote>
                </li>)}</ul> : <p>{document.document_type === 'steam_review' || document.document_type === 'b2b_review' ?
                  'Nenhum problema nas categorias atuais. Isso não comprova satisfação nem ausência de reclamação no texto.' :
                  'Nenhum problema identificado nesta avaliação.'}</p> :
                <p>{document.analysis_status === 'unavailable' ? (document.document_type === 'b2b_review' ? 'Análise indisponível: verifique direitos de envio, validade e configuração da operação.' : 'Análise indisponível: configure um provedor para processar esta avaliação.') :
                  document.analysis_status === 'failed' ? `Análise falhou (${document.analysis_error ?? 'erro desconhecido'}).` :
                    document.analysis_status === 'processing' ? 'Análise em andamento…' :
                      (document.document_type === 'steam_review' || document.document_type === 'b2b_review') && document.analysis_status === null ? 'Análise não solicitada.' : 'Análise aguardando processamento.'}</p>}
              {document.document_type === 'b2b_review' && document.analysis_status !== 'completed' &&
                <p>{document.analysis_eligibility === 'controlled_test' ? 'Somente provedor controlado: resultado de TESTE, sem chamada à OpenAI.' :
                  document.analysis_eligibility === 'paid_opt_in' ? 'Envio externo declarado; cada chamada paga exige confirmação e orçamento.' :
                    'Análise bloqueada: direito de envio externo ausente, expirado, revogado ou fonte desativada.'}</p>}
              {session.role !== 'viewer' && document.document_type !== 'b2b_review' && ['pending', 'failed', 'unavailable', null].includes(document.analysis_status) &&
                <button className="small" disabled={busy} onClick={() => void run(async () => {
                  await api(`documents/${document.id}/analyze`, session, { method: 'POST' }); await refresh(session);
                })}>{document.document_type === 'steam_review' ? 'Analisar esta review (1 item)' : 'Reenfileirar análise'}</button>}
              {session.role !== 'viewer' && document.document_type === 'b2b_review' && document.analysis_eligibility === 'controlled_test'
                && ['pending', 'failed', 'unavailable', null].includes(document.analysis_status) &&
                <button className="small" disabled={busy} onClick={() => void run(async () => {
                  await api(`documents/${document.id}/analyze-b2b`, session, { method: 'POST',
                    body: JSON.stringify({ provider: 'test' }) }); await refresh(session);
                })}>Analisar esta review (TESTE controlado)</button>}
              {session.role !== 'viewer' && document.document_type === 'b2b_review' && document.analysis_eligibility === 'paid_opt_in'
                && ['pending', 'failed', 'unavailable', null].includes(document.analysis_status) &&
                <form onSubmit={event => void run(async () => {
                  const data = formValues(event);
                  await api(`documents/${document.id}/analyze-b2b`, session, { method: 'POST', body: JSON.stringify({
                    provider: 'openai', allow_paid: data.get('allow_paid') === 'on', max_items: 1,
                    model: data.get('model'), max_output_tokens: Number(data.get('max_output_tokens')),
                    budget_usd: Number(data.get('budget_usd')),
                  }) }); await refresh(session);
                })}><label>Modelo configurado no servidor<input name="model" defaultValue="gpt-5-nano" required /></label>
                  <label>Máximo de tokens de saída<input name="max_output_tokens" type="number" min="128" max="512" defaultValue="512" required /></label>
                  <label>Orçamento estimado máximo (USD, até 0,05)<input name="budget_usd" type="number" min="0.0001" max="0.05" step="0.0001" defaultValue="0.05" required /></label>
                  <label><input name="allow_paid" type="checkbox" required /> Autorizo esta chamada paga de uma review.</label>
                  <button disabled={busy}>Analisar esta review (1 chamada paga)</button></form>}
            </div>}</article>)}</div> :
            <p className="empty">Os documentos aparecerão após o worker concluir a importação.</p>}
        </section></>}
        {view === 'account' && <section className="card wide"><h2>Membros e convites</h2>
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
            sessionKey.current = sessionIdentity(next); clearTenantData(); setSession(next); await refresh(next);
          })}><label>Código de convite<input name="invitation_token" required /></label>
            <button disabled={busy}>Aceitar e entrar na empresa</button></form>
          <ul>{members.map(member => <li key={member.user_id}>
            <strong>{member.display_name}</strong> · {member.email} · {member.role}
            {canManage && (session.role === 'owner' || !['owner', 'admin'].includes(member.role)) &&
              <form className="member-actions" onSubmit={event => void run(async () => {
                const data = formValues(event);
                await api(`members/${member.user_id}`, session, { method: 'PATCH', body: JSON.stringify({ role: data.get('role') }) });
                const next = await api<Session>('auth/session', session);
                sessionKey.current = sessionIdentity(next); setSession(next); await refresh(next);
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
        </section>}
      </div>}
  </main>;
}

const sourceLabels: Record<string, { title: string; href: string }> = {
  manual_review: { title: 'CSV legado', href: '/fontes#csv-legado' },
  b2b_csv_review: { title: 'Review B2B importada', href: '/fontes#b2b' },
  g2: { title: 'G2 condicionado ao acesso', href: '/fontes#g2' },
  github_issues: { title: 'GitHub Issues públicas', href: '/fontes#github-issues' },
  github_discussions: { title: 'GitHub Discussions públicas', href: '/fontes#github-discussions' },
  steam_reviews: { title: 'Reviews de usuários do Steam', href: '/fontes#steam' },
};
function displayDate(value: string | null): string { return value ? new Date(value).toLocaleString('pt-BR') : 'ainda não registrada'; }

export function Overview({ tenantName, role, products, sources, sourceRuns, pages, signals }: {
  tenantName: string; role: Role; products: Product[]; sources: Source[]; sourceRuns: SourceRun[];
  pages: PageData; signals: SignalResult | null;
}) {
  const candidates = signals?.signals.filter(item => item.state === 'candidate') ?? [];
  const alerts = signals?.alerts ?? [];
  const unread = alerts.filter(item => !item.read_at);
  const candidateTests = candidates.filter(item => item.test_data).length;
  const unreadTests = unread.filter(item => item.test_data).length;
  const latestRuns = [
    ...sourceRuns.map(item => ({ id: item.id, sourceId: item.source_id, at: item.finished_at ?? item.started_at,
      status: item.status, error: item.error_code, newItems: item.documents_new, updatedItems: item.documents_updated,
      partial: item.scan_complete === false, page: false })),
    ...pages.runs.map(item => ({ id: item.id, sourceId: item.source_id, at: item.finished_at ?? item.started_at,
      status: item.status, error: item.error_code, newItems: item.documents_new, updatedItems: 0,
      partial: false, page: true })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
  return <>
    <section className="card wide overview-intro"><h2>O que está sendo acompanhado</h2>
      <p><strong>{tenantName}</strong> · {products.length} produto(s) · {sources.length + pages.sources.length} associação(ões) de fonte.</p>
      <p>Associações não são documentos distintos: a mesma origem pode estar ligada a mais de um produto. Confira os totais deduplicados e filtros em <Link href="/evidencias">Evidências</Link>.</p>
      <div className="overview-stats"><Link href="/fontes#produtos"><strong>{products.length}</strong><span>Produtos</span></Link>
        <Link href="/fontes"><strong>{sources.length + pages.sources.length}</strong><span>Fontes associadas</span></Link>
        <Link href="/revisao"><strong>{role === 'viewer' ? '—' : candidates.length - candidateTests}</strong><span>Candidatos reais para revisão{role === 'viewer' ? ' (papel sem acesso)' : ''}{candidateTests > 0 && ` · ${candidateTests} TESTE`}</span></Link>
        <Link href="/revisao"><strong>{unread.length - unreadTests}</strong><span>Alertas internos reais não lidos{unreadTests > 0 && ` · ${unreadTests} TESTE`}</span></Link></div>
    </section>
    <section className="card wide"><h2>Cobertura e limites das fontes</h2>
      <p>Issues e Discussions são atividade pública; reviews B2B, CSV e Steam são populações separadas. Coleta parcial, direitos pendentes e interpretações não confirmadas continuam visíveis.</p>
      {sources.length + pages.sources.length === 0 ? <p className="empty">Nenhuma fonte cadastrada. <Link href="/fontes">Cadastrar produto e fonte</Link>.</p> :
        <ul className="coverage-list">{sources.map(source => {
          const latest = sourceRuns.find(run => run.source_id === source.id);
          const config = sourceLabels[source.source_type] ?? { title: source.source_type, href: '/fontes' };
          const product = products.find(item => item.id === source.product_id);
          const flags = [latest?.scan_complete === false && 'coleta parcial por cursor',
            latest?.error_code && `último erro: ${latest.error_code}`,
            source.source_type === 'g2' && source.access_status !== 'authorized' &&
              `acesso G2: ${source.access_status}`,
            source.source_type === 'g2' && (!source.storage_permitted || !source.rights_recorded) && 'direitos de armazenamento pendentes',
            source.source_type === 'g2' && source.rights_expires_at && Date.parse(source.rights_expires_at) <= Date.now() &&
              'direitos de armazenamento expirados',
            source.source_type === 'b2b_csv_review' && !source.storage_permitted && 'armazenamento não autorizado',
            source.source_type === 'b2b_csv_review' && source.access_environment === 'production' &&
              (!source.external_ai_permitted || !!source.ai_rights_revoked_at || !source.ai_rights_expires_at ||
                Date.parse(source.ai_rights_expires_at) <= Date.now()) && 'envio à IA não autorizado ou expirado',
            source.access_environment === 'sandbox' && 'TESTE / sandbox',
          ].filter(Boolean);
          return <li key={source.id}><strong><Link href={config.href}>{config.title}</Link></strong> · {product?.name ?? 'produto indisponível'}
            <span className="coverage-meta">Última coleta: {displayDate(source.last_checked_at)} · {latest?.status ?? 'sem execução'}.</span>
            {flags.length > 0 && <span className="coverage-warning">{flags.join(' · ')}</span>}</li>;
        })}{pages.sources.map(source => {
          const latest = pages.runs.find(run => run.source_id === source.id);
          const snapshot = pages.snapshots.filter(item => item.source_id === source.id)
            .sort((a, b) => b.version_no - a.version_no)[0];
          const flags = [!source.monitoring_enabled && 'monitoramento pausado',
            latest?.error_code && `último erro: ${pageErrorReasons[latest.error_code] ?? latest.error_code}`,
            snapshot && snapshot.interpretation_status !== 'confirmed' &&
              `interpretação ${interpretationStatus[snapshot.interpretation_status] ?? snapshot.interpretation_status}`].filter(Boolean);
          return <li key={source.id}><strong><Link href="/fontes#paginas">{source.source_type === 'pricing_page' ? 'Página de preços' : 'Changelog'}</Link></strong> · {source.product_name}
            <span className="coverage-meta">Última verificação: {displayDate(source.last_checked_at)} · {latest?.status ?? 'sem execução'}.</span>
            {flags.length > 0 && <span className="coverage-warning">{flags.join(' · ')}</span>}</li>;
        })}</ul>}
    </section>
    <section className="card"><h2>O que mudou</h2>
      <p>Execuções recentes e dados persistidos; novas linhas ou capturas ainda exigem interpretação. Abrir esta página não inicia coletas.</p>
      {latestRuns.length ? <ul>{latestRuns.map(run => <li key={run.id}><Link href={run.page ? '/fontes#paginas' : sourceLabels[sources.find(item => item.id === run.sourceId)?.source_type ?? '']?.href ?? '/fontes'}>
        {run.page ? 'Verificação de página' : sourceLabels[sources.find(item => item.id === run.sourceId)?.source_type ?? '']?.title ?? 'Coleta'}</Link>
        {' '}· {displayDate(run.at)} · {run.status} · {run.newItems} novo(s), {run.updatedItems} atualizado(s)
        {run.partial && <span className="coverage-warning">Cobertura parcial por cursor.</span>}
        {run.error && <span className="coverage-warning">Erro: {run.error}</span>}</li>)}</ul> :
        <p className="empty">Ainda não há coletas ou verificações nesta empresa.</p>}
    </section>
    <section className="card"><h2>O que exige atenção</h2>
      <p>Revisão humana separa fatos observados de decisões. Nenhuma aprovação ou recomendação é automática.</p>
      {signals?.reconciliation && <p>Reconciliação: {signals.reconciliation.pending} pendente(s), {signals.reconciliation.failed} com falha · última conclusão {displayDate(signals.reconciliation.last_at)}.</p>}
      {candidates.length > 0 && <p><Link href="/revisao">{candidates.length - candidateTests} candidato(s) reais e {candidateTests} de TESTE aguardam decisão</Link>.</p>}
      {unread.length > 0 && <p><Link href="/revisao">{unread.length - unreadTests} alerta(s) reais e {unreadTests} de TESTE não lidos</Link>.</p>}
      {alerts.length > 0 && <ul>{alerts.slice(0, 3).map(item => <li key={item.id}>
        <Link href="/revisao">{item.summary}</Link> · {item.read_at ? 'lido' : 'não lido'}
        {item.test_data && <span className="badge">TESTE</span>}</li>)}</ul>}
      {signals?.reconciliation.reasons.length ? <p className="coverage-warning">Falha de reconciliação: {signals.reconciliation.reasons.join('; ')}</p> : null}
      {!candidates.length && !unread.length && !signals?.reconciliation.pending && !signals?.reconciliation.failed &&
        <p className="empty">Nenhum candidato ou alerta pendente nos dados consultados.</p>}
      {role === 'viewer' && <p>Seu papel mostra somente sinais aprovados; candidatos exigem acesso de revisão.</p>}
      <p><Link href="/avaliacao-busca">Avaliação humana da busca</Link> fica fora desta visão executiva.</p>
    </section>
  </>;
}
