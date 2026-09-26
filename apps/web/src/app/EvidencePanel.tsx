'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Product = { id: string; name: string };
type SourceType = 'csv_review' | 'b2b_review' | 'g2_review' | 'steam_review' | 'github_issue' | 'github_discussion' | 'pricing_page' | 'release_notes';
type Filters = { product_id: string; source_type: string; from: string; to: string; q: string };
type EvidenceItem = { item_id: string; source_type: SourceType; product_name: string;
  product_ids: string[]; product_names: string[]; source_url: string; title: string | null;
  excerpt: string; observed_at: string; collected_at: string; synthetic: boolean; data_status: string | null;
  interpretation_status: string | null; interpretation_reason: string | null;
  content_status: string | null; association_count: number; duplicate_rows: number;
  analysis_status: string | null; analysis_model: string | null;
  issues: { category: string; severity: string; description: string; evidence_quote: string }[] };
type SourceCount = { source_type: SourceType; count: number; ambiguous_count: number;
  first_at: string; last_at: string };
type PartialSource = { source_id: string; source_type: string; product_name: string; last_run_at: string };
type SearchResult = { items: EvidenceItem[]; counts: SourceCount[]; total: number; ambiguous_total: number;
  observed_from: string | null; observed_to: string | null; partial_sources: PartialSource[];
  limit: number; offset: number };
type ReviewBucket = { source_type: 'csv_review' | 'b2b_review' | 'g2_review' | 'steam_review'; synthetic: boolean; data_status: string;
  total_reviews: number; analyzed_reviews: number; documents_without_analysis: number };
type Category = { source_type: ReviewBucket['source_type']; synthetic: boolean; data_status: string;
  category: string; documents_with_problem: number };
type PageDetail = { kind: string; name?: string; previous?: Record<string, string> | null;
  current?: Record<string, string> | null };
type PageEvent = { id: string; source_type: 'pricing_page' | 'release_notes'; product_name: string;
  product_ids: string[]; previous_url: string; current_url: string;
  previous_at: string; current_at: string; detected_at: string; detail: PageDetail;
  association_count: number };
type Signals = { review_buckets: ReviewBucket[]; categories: Category[]; page_events: PageEvent[];
  page_events_truncated: boolean; extractor_version: string };

const initialFilters: Filters = { product_id: '', source_type: '', from: '', to: '', q: '' };
const sourceLabels: Record<SourceType, string> = {
  csv_review: 'Review CSV legado/teste', b2b_review: 'Review B2B importada', g2_review: 'Review G2',
  steam_review: 'Review Steam', github_issue: 'Issue pública do GitHub',
  github_discussion: 'Discussion pública do GitHub', pricing_page: 'Captura de preço',
  release_notes: 'Captura de changelog',
};
const categoryLabels: Record<string, string> = { support: 'Suporte', price: 'Preço',
  billing: 'Cobrança', performance: 'Desempenho', usability: 'Usabilidade', features: 'Funcionalidades' };
const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function dateTime(value: string): string { return new Date(value).toLocaleString('pt-BR'); }
function validLink(value: string): boolean {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
function params(filters: Filters, offset: number, includeSearch: boolean): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && (includeSearch || key !== 'q')) result.set(key, value);
  }
  if (includeSearch) { result.set('limit', '20'); result.set('offset', String(offset)); }
  return result.toString();
}
async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase}/v1/evidence/${path}`, { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === 'object' && body !== null && 'message' in body ? body.message : null;
    const detail = Array.isArray(message) ? message.join(', ') : typeof message === 'string' ? message : '';
    throw new Error(`Consulta de evidências falhou (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  return response.json() as Promise<T>;
}
function detailEvidence(detail: PageDetail): { before: string; after: string } {
  if (detail.kind === 'price_observed') {
    const before = detail.previous;
    const after = detail.current;
    return { before: before ? `${before.name}: ${before.currency} ${before.amount} / ${before.period}. Condições: ${before.conditions}. Trecho: “${before.evidence}”` : 'ausente',
      after: after ? `${after.name}: ${after.currency} ${after.amount} / ${after.period}. Condições: ${after.conditions}. Trecho: “${after.evidence}”` : 'ausente' };
  }
  const before = detail.previous;
  const after = detail.current;
  return { before: before ? `${before.title}. Trecho: “${before.evidence}”` : 'Entrada não encontrada na captura anterior.',
    after: after ? `${after.title}. Trecho: “${after.evidence}”` : 'ausente' };
}

export default function EvidencePanel({ products }: { products: Product[] }) {
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [applied, setApplied] = useState<Filters>(initialFilters);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [signals, setSignals] = useState<Signals | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (controller: AbortController) => {
    try {
      const [nextSearch, nextSignals] = await Promise.all([
        get<SearchResult>(`search?${params(applied, offset, true)}`, controller.signal),
        get<Signals>(`signals?${params(applied, 0, false)}`, controller.signal),
      ]);
      if (!controller.signal.aborted) { setSearch(nextSearch); setSignals(nextSignals); setError(''); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Falha na consulta.');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [applied, offset]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller);
    const timer = setInterval(() => void load(controller), 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [load]);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); setLoading(true); setOffset(0); setApplied({ ...draft });
  }
  const activeTypes: SourceType[] = ['csv_review', 'b2b_review', 'g2_review', 'steam_review', 'github_issue', 'github_discussion', 'pricing_page', 'release_notes'];
  return <section id="explorar" className="card wide evidence-panel" aria-label="Visão de evidências">
    <h2>Visão de evidências</h2>
    <p>Uma linha por documento de origem ou conteúdo distinto de página, mesmo após repetir a coleta. O filtro usa dias UTC da publicação original; quando ela falta, usa a data da coleta. Horários exibidos no fuso do navegador. Os totais descrevem apenas o material armazenado nesta empresa.</p>
    <form className="evidence-filters" onSubmit={submit}>
      <label>Produto<select value={draft.product_id} onChange={event => setDraft({ ...draft, product_id: event.target.value })}>
        <option value="">Todos</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select></label>
      <label>Fonte<select value={draft.source_type} onChange={event => setDraft({ ...draft, source_type: event.target.value })}>
        <option value="">Todas, separadas por tipo</option>{activeTypes.map(type => <option key={type} value={type}>{sourceLabels[type]}</option>)}
      </select></label>
      <label>De<input type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>Até<input type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>Termo no título ou texto<input maxLength={120} value={draft.q} onChange={event => setDraft({ ...draft, q: event.target.value })} placeholder="Ex.: integração" /></label>
      <button>Aplicar filtros</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && !search && <p>Consultando evidências…</p>}
    {search && <>
      <h3>Material encontrado</h3>
      <p>{search.total} origem(ns) distinta(s) no filtro{search.observed_from && search.observed_to ?
        ` · período observado: ${dateTime(search.observed_from)} a ${dateTime(search.observed_to)}` : ''}.
        {applied.q && ' O termo filtra esta lista e suas contagens; os indicadores de problemas abaixo usam todo o produto/período selecionado.'}</p>
      <div className="evidence-counts">{activeTypes.map(type => {
        const count = search.counts.find(row => row.source_type === type);
        return <div key={type}><strong>{sourceLabels[type]}</strong><span>{count?.count ?? 0}</span>
          {count && <small>{dateTime(count.first_at)} a {dateTime(count.last_at)}</small>}</div>;
      })}</div>
      {search.ambiguous_total > 0 && <p className="evidence-warning">{search.ambiguous_total} origem(ns) no filtro estão ligadas a mais de um produto. Cada uma aparece uma vez no total geral; a associação está indicada nos itens. Não compare produtos somando estes totais.</p>}
      {search.partial_sources.length > 0 && <p className="evidence-warning">Cobertura parcial por cursor em {search.partial_sources.length} fonte(s) (lista limitada a 50): {search.partial_sources.map(item => `${item.product_name} · ${item.source_type}`).join('; ')}. A janela coletada não representa todo o histórico.</p>}
      <div className="documents">{search.items.map(item => <article key={`${item.source_type}-${item.item_id}`}>
        <div className="meta"><span className="badge">{sourceLabels[item.source_type]}</span>
          {item.synthetic && <span className="badge">SINTÉTICO</span>}
          {item.data_status === 'sandbox_test' && <span className="badge">TESTE / SANDBOX</span>}
          {item.data_status === 'unverified_legacy' && <span className="badge">Direitos não verificados</span>}
          {item.data_status === 'declared_real' && <span className="badge">Direitos declarados</span>}
          <time>{dateTime(item.observed_at)}</time></div>
        <p><strong>{item.title ?? item.product_name}</strong> · produto associado: {item.product_names.join(', ')}</p>
        {item.association_count > 1 && <p className="evidence-warning">Associação ambígua: {item.association_count} produtos usam esta origem. Contada uma vez no total geral.</p>}
        <p>{item.excerpt}</p>
        {item.source_type === 'b2b_review' && <div className="analysis">
          <strong>Análise desta review:</strong> {item.analysis_status === 'completed' ?
            item.issues.length ? <ul>{item.issues.map((issue, index) => <li key={`${item.item_id}-${index}`}>
              {categoryLabels[issue.category] ?? issue.category} · gravidade {issue.severity} · {issue.description}
              <blockquote>“{issue.evidence_quote}”</blockquote>
            </li>)}</ul> : <p>Nenhum problema nas categorias atuais; isso não comprova satisfação.</p> :
            <p>{item.analysis_status === 'processing' ? 'Em andamento' :
              item.analysis_status === 'failed' ? 'Falhou, sem insight publicado' :
                item.analysis_status === 'unavailable' ? 'Indisponível; confira direitos e configuração' :
                  item.analysis_status === 'pending' ? 'Na fila' : 'Não solicitada'}</p>}
          {item.analysis_model === 'controlled-test-fixture-v1' &&
            <small>Resultado controlado de TESTE, não produzido por IA.</small>}
        </div>}
        {item.interpretation_status && <p>Interpretação da captura: {item.interpretation_status} ({item.interpretation_reason ?? 'sem motivo'}). Captura não confirmada não vira mudança confirmada.</p>}
        {item.content_status === 'insufficient' && <p>Conteúdo insuficiente para inferir problema.</p>}
        {validLink(item.source_url) && !new URL(item.source_url).hostname.endsWith('.invalid') ?
          <a href={item.source_url} target="_blank" rel="noreferrer">Abrir origem ↗</a> :
          <small>Origem fictícia ou sem link navegável: {item.source_url}</small>}
        {item.source_type === 'steam_review' && <small> O link do Steam abre a página de reviews do produto, não uma review individual.</small>}
      </article>)}</div>
      {!search.items.length && <p className="empty">Nenhuma evidência corresponde aos filtros.</p>}
      <div className="evidence-pages"><button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</button>
        <span>Exibindo {search.total ? offset + 1 : 0}–{Math.min(offset + search.items.length, search.total)} de {search.total}</span>
        <button className="small" disabled={offset + search.items.length >= search.total || offset >= 1000} onClick={() => setOffset(offset + 20)}>Próxima</button></div>
      {search.total > 1020 && <p>A navegação está limitada às primeiras 1.020 origens. Restrinja produto, fonte, período ou termo para investigar as demais.</p>}
    </>}
    {signals && <>
      <h3>Problemas extraídos de reviews</h3>
      <p>Unidade: reviews distintas publicadas no período. Numerador: reviews com ao menos um problema da categoria e trecho literal no texto. Denominador: reviews com análise concluída na versão {signals.extractor_version}; sem análise fica fora do denominador. Repetir a coleta ou citar a categoria duas vezes na mesma review não aumenta o numerador. Esses rótulos automáticos ainda não foram validados em uma amostra humana de SaaS B2B.</p>
      {signals.review_buckets.length ? signals.review_buckets.map(bucket => <div className="signal-bucket" key={`${bucket.source_type}-${bucket.synthetic}`}>
        <h4>{sourceLabels[bucket.source_type]} · {bucket.data_status === 'sandbox_test' ? 'TESTE / sandbox' : bucket.data_status === 'unverified_legacy' ? 'direitos não verificados' : bucket.data_status === 'declared_real' ? 'direitos declarados' : bucket.synthetic ? 'sintéticas (teste)' : 'dados da origem'}</h4>
        <p>{bucket.total_reviews} reviews distintas · {bucket.analyzed_reviews} analisadas · {bucket.documents_without_analysis} sem análise válida para este indicador.
          {bucket.analyzed_reviews < 30 && ' Amostra pequena: não conclua uma tendência.'}</p>
        {bucket.synthetic && <p>Resultados sintéticos e de sandbox não entram nos indicadores de dados reais.</p>}
        {signals.categories.filter(row => row.source_type === bucket.source_type && row.synthetic === bucket.synthetic && row.data_status === bucket.data_status).length ?
          <ul>{signals.categories.filter(row => row.source_type === bucket.source_type && row.synthetic === bucket.synthetic && row.data_status === bucket.data_status).map(row =>
            <li key={row.category}>{categoryLabels[row.category] ?? row.category}: <strong>{row.documents_with_problem}/{bucket.analyzed_reviews}</strong> reviews analisadas</li>)}</ul> :
          <p>Nenhuma categoria com evidência literal nas análises concluídas.</p>}
      </div>) : <p className="empty">Nenhuma review no produto/período selecionado.</p>}
      <h3>Mudanças confirmadas de páginas</h3>
      <p>Somente eventos com duas capturas interpretadas como confirmadas pela versão 2 ou superior. Preço exige mesmo plano, moeda, período e condições explícitas; changelog exige entrada e link. Diferenças textuais, capturas parciais e antigas em revisão não aparecem como mudança confirmada.</p>
      {signals.page_events.length ? <div className="documents">{signals.page_events.map((event, index) => {
        const evidence = detailEvidence(event.detail);
        return <article key={`${event.id}-${event.detail.kind}-${index}`}><strong>{event.source_type === 'pricing_page' ? 'Preço observado' : 'Entrada de changelog'} · {event.product_name}</strong>
          {event.association_count > 1 && <p className="evidence-warning">Origem associada a {event.association_count} produtos; evento mostrado uma vez.</p>}
          <p>Antes ({dateTime(event.previous_at)}): {evidence.before}</p>
          <p>Depois ({dateTime(event.current_at)}): {evidence.after}</p>
          <p>{validLink(event.previous_url) && <a href={event.previous_url} target="_blank" rel="noreferrer">Fonte da captura anterior ↗</a>}
            {' · '}{validLink(event.current_url) && <a href={event.current_url} target="_blank" rel="noreferrer">Fonte da captura nova ↗</a>}</p>
          <small>As duas URLs podem apontar à mesma página atual; os trechos acima são os registros preservados em cada captura.</small>
        </article>;
      })}</div> : <p className="empty">Nenhuma mudança confirmada no produto/período selecionado.</p>}
      {signals.page_events_truncated && <p>Exibindo somente os 50 eventos confirmados mais recentes.</p>}
      <p>Issues e Discussions são atividade e feedback públicos, com totais próprios acima. Não são reviews de clientes; não há taxa de reclamação ou participação de mercado calculada a partir delas.</p>
    </>}
  </section>;
}
