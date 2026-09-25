'use client';

import React, { FormEvent, useState } from 'react';

type Product = { id: string; name: string };
type Source = { id: string; source_type: string; url: string; product_id: string };
type Citation = { id: string; source_type: string; product_name: string; source_url: string;
  observed_at: string; quote: string; synthetic: boolean; data_status: string | null;
  ambiguous_association: boolean; distance: number };
type Answer = { answer: string; citations: Citation[]; model: string; model_version: string;
  test_only: boolean; elapsed_ms: number; cost_usd: number };

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const labels: Record<string, string> = {
  review: 'Review CSV sintética', b2b_review: 'Review B2B', github_issue: 'Issue pública',
  github_discussion: 'Discussion pública (autor não verificado como cliente)',
  pricing_page: 'Captura de preço', release_notes: 'Captura de changelog',
};
function clickableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !['.invalid', '.test'].some(suffix => url.hostname.endsWith(suffix));
  } catch { return false; }
}

export default function QuestionsPanel({ products, sources, csrfToken, role }:
  { products: Product[]; sources: Source[]; csrfToken: string; role: string }) {
  const indexableSources = sources.filter(source => ['manual_review', 'b2b_csv_review', 'github_issues',
    'github_discussions', 'pricing_page', 'release_notes'].includes(source.source_type));
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState('');
  async function post<T>(path: string, body: object): Promise<T> {
    const response = await fetch(`${apiBase}/v1/evidence/${path}`, {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const message = typeof data === 'object' && data !== null && 'message' in data ? data.message : 'Falha na API';
      throw new Error(Array.isArray(message) ? message.join(', ') : String(message));
    }
    return data as T;
  }
  async function ask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setBusy(true); setError(''); setResult(null);
    const form = new FormData(event.currentTarget);
    try {
      setResult(await post<Answer>('questions', {
        question: form.get('question'), product_id: form.get('product_id') || undefined,
        source_type: form.get('source_type') || undefined, from: form.get('from') || undefined,
        to: form.get('to') || undefined, include_synthetic: form.get('include_synthetic') === 'on', limit: 5,
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function index(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setBusy(true); setError(''); setQueued('');
    const sourceId = String(new FormData(event.currentTarget).get('source_id'));
    try {
      await post('reindex', { source_id: sourceId });
      setQueued('Indexação solicitada. Aguarde o worker terminar e faça a pergunta novamente.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="card wide">
    <h2>Perguntas sobre evidências</h2>
    <p>Busca por similaridade e resposta extrativa: cada frase cita um trecho recuperado. Reviews, Issues, Discussions e páginas são populações distintas. Não calcula opinião do mercado. O modo controlado é TESTE e não mede qualidade semântica.</p>
    {role !== 'viewer' && <form onSubmit={event => void index(event)}>
      <label>Preparar índice de uma fonte<select name="source_id" required>
        {indexableSources.map(source =>
          <option key={source.id} value={source.id}>{products.find(p => p.id === source.product_id)?.name}: {source.url}</option>)}
      </select></label><button disabled={busy || !indexableSources.length}>Indexar fonte</button>
    </form>}
    {queued && <p role="status">{queued}</p>}
    <form onSubmit={event => void ask(event)}>
      <label>Pergunta<input name="question" minLength={3} maxLength={500} required placeholder="Quais problemas aparecem neste produto?" /></label>
      <label>Produto<select name="product_id"><option value="">Todos desta empresa</option>
        {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <label>Tipo de fonte<select name="source_type"><option value="">Todos os tipos elegíveis</option>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>De<input name="from" type="date" /></label><label>Até<input name="to" type="date" /></label>
      <label><input name="include_synthetic" type="checkbox" /> Incluir dados sintéticos só para TESTE</label>
      <button disabled={busy}>Perguntar</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {result && <div aria-live="polite">
      <p>{result.test_only ? 'TESTE, sem avaliação de qualidade' : 'Resposta extrativa local'} · modelo: {result.model} ({result.model_version}) · {result.elapsed_ms} ms nesta consulta · custo de IA externa USD {result.cost_usd}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
      {result.citations.map(citation => <article key={citation.id}>
        <strong>{labels[citation.source_type] ?? citation.source_type}</strong> · {citation.product_name} · {new Date(citation.observed_at).toLocaleDateString('pt-BR')}
        {citation.synthetic && <strong> · SINTÉTICO / TESTE</strong>}
        {citation.data_status === 'declared_real' && <small> · origem real segundo declaração, sem verificação automática dos direitos</small>}
        {citation.ambiguous_association && <strong> · mesma origem associada a mais de um produto</strong>}
        <blockquote>“{citation.quote}”</blockquote>
        {clickableUrl(citation.source_url) ?
          <a href={citation.source_url} target="_blank" rel="noreferrer">Abrir origem ↗</a> :
          <small>URL fictícia de teste, sem página</small>}
        <small> · citação {citation.id}</small>
      </article>)}
    </div>}
  </section>;
}
