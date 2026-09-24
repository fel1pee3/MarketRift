'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Product = { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type Source = { id: string; product_id: string; source_type: string; url: string };
type Import = { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null };
type Document = { id: string; source_id: string; external_key: string; source_url: string; body: string; published_at: string; synthetic: boolean };
type Session = { token: string; tenant_id: string };
const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function api<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}/v1/${path}`, { ...init, headers, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join(', ') : result.message ?? 'Falha na API');
  return result as T;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [imports, setImports] = useState<Import[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);

  const refresh = useCallback(async (token: string) => {
    const [nextProducts, nextSources, nextImports, nextDocuments] = await Promise.all([
      api<Product[]>('products', token), api<Source[]>('sources', token),
      api<Import[]>('imports', token), api<Document[]>('documents', token),
    ]);
    setProducts(nextProducts); setSources(nextSources); setImports(nextImports); setDocuments(nextDocuments);
  }, []);

  useEffect(() => {
    const raw = sessionStorage.getItem('marketrift-session');
    if (raw) { try { setSession(JSON.parse(raw) as Session); } catch { sessionStorage.removeItem('marketrift-session'); } }
  }, []);
  useEffect(() => {
    if (!session) return;
    void refresh(session.token).catch(err => setError(String(err)));
    const timer = setInterval(() => void refresh(session.token).catch(err => setError(String(err))), 3000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  function values(event: FormEvent<HTMLFormElement>): FormData { event.preventDefault(); return new FormData(event.currentTarget); }

  return <main>
    <header><div><span className="eyebrow">INTELIGÊNCIA COMPETITIVA</span><h1>MarketRift</h1><p>Primeira fatia: portfólio, fontes e avaliações com origem verificável.</p></div>{session && <button className="ghost" onClick={() => { sessionStorage.removeItem('marketrift-session'); setSession(null); }}>Sair</button>}</header>
    {error && <div className="error" role="alert">{error}</div>}
    {!session ? <section className="card auth"><div className="tabs"><button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Criar empresa</button><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Entrar</button></div><form onSubmit={event => void run(async () => {
      const data = values(event);
      const payload = mode === 'register' ? { email: data.get('email'), password: data.get('password'), display_name: data.get('display_name'), company_name: data.get('company_name') } : { email: data.get('email'), password: data.get('password') };
      const next = await api<Session>(`auth/${mode}`, null, { method: 'POST', body: JSON.stringify(payload) });
      sessionStorage.setItem('marketrift-session', JSON.stringify(next)); setSession(next);
    })}>
      {mode === 'register' && <><label>Seu nome<input name="display_name" required /></label><label>Empresa<input name="company_name" required /></label></>}
      <label>Email<input type="email" name="email" required /></label><label>Senha<input type="password" name="password" minLength={mode === 'register' ? 12 : undefined} required /></label><button disabled={busy}>{mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
    </form></section> : <div className="grid">
      <section className="card"><h2>Produtos</h2><p>Cadastre o produto próprio e concorrentes.</p><form onSubmit={event => void run(async () => {
        const data = values(event); const form = event.currentTarget;
        await api('products', session.token, { method: 'POST', body: JSON.stringify({ name: data.get('name'), kind: data.get('kind'), website_url: data.get('website_url') || undefined }) });
        form.reset(); await refresh(session.token);
      })}><label>Nome<input name="name" required /></label><label>Tipo<select name="kind"><option value="own">Produto próprio</option><option value="competitor">Concorrente</option></select></label><label>Site (opcional)<input name="website_url" type="url" /></label><button disabled={busy}>Adicionar produto</button></form><ul>{products.map(product => <li key={product.id}><strong>{product.name}</strong> <small>{product.kind === 'own' ? 'Próprio' : 'Concorrente'}</small></li>)}</ul></section>
      <section className="card"><h2>Fontes</h2><p>A importação manual exige URL por avaliação. Confirme que você pode usar os dados enviados.</p><form onSubmit={event => void run(async () => {
        const data = values(event); const form = event.currentTarget;
        await api('sources', session.token, { method: 'POST', body: JSON.stringify({ product_id: data.get('product_id'), url: data.get('url') }) });
        form.reset(); await refresh(session.token);
      })}><label>Produto<select name="product_id" required>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label>URL da fonte<input name="url" type="url" required /></label><button disabled={busy || !products.length}>Adicionar fonte</button></form><ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a></li>)}</ul></section>
      <section className="card"><h2>Importar CSV</h2><p>Até 100 linhas. Colunas: external_key, source_url, published_at, body, synthetic.</p><form onSubmit={event => void run(async () => {
        const data = values(event); const form = event.currentTarget;
        await api('imports/reviews', session.token, { method: 'POST', body: data });
        form.reset(); await refresh(session.token);
      })}><label>Fonte<select name="source_id" required>{sources.map(source => <option key={source.id} value={source.id}>{source.url}</option>)}</select></label><label>Arquivo CSV<input type="file" name="file" accept=".csv,text/csv" required /></label><button disabled={busy || !sources.length}>Enviar avaliações</button></form></section>
      <section className="card"><h2>Importações</h2><p>O estado é atualizado automaticamente.</p>{imports.length ? <ul>{imports.map(item => <li key={item.id}><strong>{item.status}</strong> · {item.processed_rows}/{item.total_rows} linhas {item.last_error && <small>{item.last_error}</small>}{item.status === 'pending' && <button className="small" onClick={() => void run(async () => { await api(`imports/${item.id}/requeue`, session.token, { method: 'POST' }); await refresh(session.token); })}>Reenfileirar</button>}</li>)}</ul> : <p className="empty">Nenhuma importação ainda.</p>}</section>
      <section className="card wide"><h2>Documentos</h2><p>Texto original, data e link da origem. Dados sintéticos aparecem identificados.</p>{documents.length ? <div className="documents">{documents.map(document => <article key={document.id}><div className="meta">{document.synthetic && <span className="badge">SINTÉTICO</span>}<time>{new Date(document.published_at).toLocaleDateString('pt-BR')}</time><code>{document.external_key}</code></div><p>{document.body}</p><a href={document.source_url} target="_blank" rel="noreferrer">Abrir origem ↗</a></article>)}</div> : <p className="empty">Os documentos aparecerão após o worker concluir a importação.</p>}</section>
    </div>}
  </main>;
}
