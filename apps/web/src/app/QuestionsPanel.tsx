'use client';

import React, { FormEvent, useEffect, useState } from 'react';

type Product = { id: string; name: string };
type Source = { id: string; source_type: string; url: string; product_id: string };
type Citation = { id: string; source_type: string; product_name: string; source_url: string;
  observed_at: string; quote: string; synthetic: boolean; data_status: string | null;
  ambiguous_association: boolean; distance: number };
type Answer = { answer: string; citations: Citation[]; model: string; model_version: string;
  test_only: boolean; elapsed_ms: number; cost_usd: number };
type IndexStatus = { model: string; model_version: string; test_only: boolean; sources: {
  source_id: string; state: 'complete' | 'partial' | 'not_indexed_for_model' | 'no_eligible_content' | 'disabled';
  total_chunks: number; ready_chunks: number; controlled_test_chunks: number }[] };
const indexLabels: Record<string, string> = { complete: 'Indexada para o modelo ativo',
  partial: 'Indexação parcial; clique novamente para continuar',
  not_indexed_for_model: 'Não indexada para o modelo ativo',
  no_eligible_content: 'Sem conteúdo elegível', disabled: 'Fonte desativada' };

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
  const [selectedSource, setSelectedSource] = useState(indexableSources[0]?.id ?? '');
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const sourceIds = indexableSources.map(source => source.id).join(',');
  async function refreshStatus(): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/v1/evidence/index-status`,
        { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('Estado do índice indisponível; confira o serviço local de embeddings.');
      setIndexStatus(await response.json() as IndexStatus); setStatusError('');
    } catch (cause) { setStatusError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => {
    if (!indexableSources.some(source => source.id === selectedSource))
      setSelectedSource(indexableSources[0]?.id ?? '');
    void refreshStatus();
    // Source IDs change when the active tenant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIds]);
  useEffect(() => {
    if (!queued) return;
    let checks = 0;
    const timer = setInterval(() => {
      void refreshStatus();
      if (++checks >= 12) clearInterval(timer);
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, sourceIds]);
  const selectedStatus = indexStatus?.sources.find(source => source.source_id === selectedSource);
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
        to: form.get('to') || undefined, include_synthetic: form.get('include_synthetic') === 'on', limit: 1,
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
    <p>Busca por similaridade e resposta extrativa: a resposta mostra somente o melhor trecho recuperado, com citação literal. Confirme se ele realmente responde à pergunta. Reviews, Issues, Discussions e páginas são populações distintas. Não calcula opinião do mercado. O modo controlado é TESTE e não mede qualidade semântica.</p>
    {role !== 'viewer' && <form onSubmit={event => void index(event)}>
      <label>Preparar índice de uma fonte<select name="source_id" value={selectedSource}
        onChange={event => setSelectedSource(event.target.value)} required>
        {indexableSources.map(source =>
          <option key={source.id} value={source.id}>{products.find(p => p.id === source.product_id)?.name}: {source.url}</option>)}
      </select></label><button disabled={busy || !indexableSources.length}>Indexar/continuar fonte (até 16 trechos)</button>
    </form>}
    {indexStatus && <p role="status">Modelo ativo: {indexStatus.model} ({indexStatus.model_version}).
      {selectedStatus && <> {indexLabels[selectedStatus.state]}: {selectedStatus.ready_chunks}/{selectedStatus.total_chunks} trechos.
        {selectedStatus.controlled_test_chunks > 0 && indexStatus.model !== 'controlled-hash-TESTE' &&
          <> Há {selectedStatus.controlled_test_chunks} vetores controlled-hash-TESTE separados; eles não entram nesta busca.</>}</>}
      {indexStatus.sources.some(source => source.state === 'partial' || source.state === 'not_indexed_for_model') &&
        <> Cobertura da empresa parcial para o modelo ativo.</>}
    </p>}
    {statusError && <p role="alert">{statusError}</p>}
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
      <p>{result.test_only ? 'TESTE, sem avaliação de qualidade' : 'Resposta extrativa local'} · modelo: {result.model} ({result.model_version}) · {result.elapsed_ms} ms nesta consulta · custo de IA externa USD {result.cost_usd}. Consulte a cobertura acima antes de interpretar ausência de evidência.</p>
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
