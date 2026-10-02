'use client';

import { FormEvent, useEffect, useState } from 'react';

type Product = { id: string; name: string };
type SourceType = 'csv_review' | 'b2b_review' | 'g2_review' | 'steam_review' | 'github_issue' |
  'github_discussion' | 'pricing_page' | 'release_notes' | 'rss_feed';
type Filters = { product_id: string; source_types: SourceType[]; from: string; to: string };
type Link = { signal_id: string; signal_state: string; hypothesis_id: string | null;
  hypothesis_status: string | null; signal_reviewed_at: string | null;
  hypothesis_reviewed_at: string | null; relation: string };
type Item = { event_id: string; item_id: string; kind: 'document' | 'snapshot' | 'changelog_entry' | 'price_change';
  source_type: SourceType; product_ids: string[]; product_names: string[]; association_count: number;
  title: string | null; excerpt: string; source_url: string; origin_reported_at: string | null;
  origin_date_literal: string | null; observed_at: string; capture_at: string | null;
  structure_observed_at: string | null; interpretation_at: string | null; rule_version: string | null;
  interpretation_status: string | null; interpretation_reason: string | null;
  interpretation_basis: string | null; capture_complete: boolean | null; version_no: number | null;
  content_sha256: string | null; synthetic: boolean; data_status: string | null;
  detail: Record<string, unknown> | null; status: 'observed' | 'confirmed' | 'partial' | 'unconfirmed';
  coverage: 'partial_cursor' | 'latest_scan_complete' | 'unknown' | 'not_applicable'; links: Link[] };
type Result = { items: Item[]; total: number; limit: number; offset: number };

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const sourceLabels: Record<SourceType, string> = {
  csv_review: 'Review CSV', b2b_review: 'Review B2B importada', g2_review: 'Review G2',
  steam_review: 'Review Steam', github_issue: 'Issue pública do GitHub',
  github_discussion: 'Discussion pública do GitHub', pricing_page: 'Página de preços',
  release_notes: 'Changelog',
  rss_feed: 'Publicação de feed (não é review)',
};
const sourceTypes = Object.keys(sourceLabels) as SourceType[];
const empty: Filters = { product_id: '', source_types: [], from: '', to: '' };
function formatDate(value: string): string { return new Date(value).toLocaleString('pt-BR'); }
export function originDateLabel(reportedAt: string | null, literal: string | null): string {
  if (reportedAt) return formatDate(reportedAt);
  if (!literal) return 'não informada';
  return `“${literal}”${/\b(?:19|20)\d{2}\b/.test(literal) ? '' : ' (ano não informado)'}`;
}
function isNavigable(url: string): boolean {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) &&
    !parsed.hostname.endsWith('.invalid'); } catch { return false; }
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function statusExplanation(item: Item): string {
  if (item.source_type === 'rss_feed') return item.coverage === 'partial_cursor'
    ? 'Publicação observada em feed parcial. Metadados apenas; não é review nem prova de impacto comercial.'
    : 'Publicação observada no feed. Metadados apenas; não é review nem prova de impacto comercial.';
  if (item.kind === 'document') return item.coverage === 'partial_cursor'
    ? 'Documento público armazenado; a coleta por cursor ainda é parcial, e o autor não foi identificado como cliente.'
    : item.source_type === 'github_issue' || item.source_type === 'github_discussion'
      ? 'Atividade pública armazenada; não é uma review comprovada de cliente.'
      : 'Texto armazenado com a proveniência declarada; a publicação não foi verificada novamente por esta tela.';
  if (item.kind === 'price_change')
    return 'Mudança observada entre duas capturas confirmadas do mesmo plano, moeda, período e condições. Não comprova oferta contratual.';
  if (item.kind === 'changelog_entry')
    return 'Título, link e trecho foram encontrados na interpretação confirmada. Isto não comprova adoção ou impacto comercial.';
  if (item.status === 'partial') return 'Captura incompleta ou interpretação parcial. Não confirma preço ou lançamento.';
  if (item.status === 'unconfirmed') return `Captura guardada, mas sem campos suficientes para confirmação${item.interpretation_reason ? ` (${item.interpretation_reason})` : ''}.`;
  return 'A regra confirmou campos nesta captura; isso não prova uma mudança entre versões nem uma oferta atual.';
}
function priceDetails(value: Record<string, unknown> | null): React.ReactNode {
  const before = object(value?.previous); const after = object(value?.current);
  if (!before || !after) return null;
  return <div><p><strong>Antes:</strong> {text(before.name)} · {text(before.currency)} {text(before.amount)}
    / {text(before.period)} · condições: {text(before.conditions)}</p>
    <blockquote>“{text(before.evidence)}”</blockquote>
    <p><strong>Depois:</strong> {text(after.name)} · {text(after.currency)} {text(after.amount)}
      / {text(after.period)} · condições: {text(after.conditions)}</p>
    <blockquote>“{text(after.evidence)}”</blockquote></div>;
}
function queryString(filters: Filters, offset: number): string {
  const query = new URLSearchParams({ limit: '20', offset: String(offset) });
  if (filters.product_id) query.set('product_id', filters.product_id);
  if (filters.source_types.length) query.set('source_types', filters.source_types.join(','));
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return query.toString();
}

export default function EvidenceTimeline({ products }: { products: Product[] }) {
  const [draft, setDraft] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(`${apiBase}/v1/evidence/timeline?${queryString(applied, offset)}`, {
      credentials: 'include', cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === 'object' && 'message' in payload ? payload.message : null;
        throw new Error(`Linha do tempo indisponível (HTTP ${response.status})${typeof message === 'string' ? `: ${message}` : ''}`);
      }
      return response.json() as Promise<Result>;
    }).then(value => { if (!controller.signal.aborted) { setResult(value); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Falha ao carregar a linha do tempo'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [applied, offset]);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); setOffset(0); setApplied({ ...draft, source_types: [...draft.source_types] });
  }
  return <section id="linha-do-tempo" className="card wide evidence-panel" aria-label="Linha do tempo de evidências">
    <h2>Linha do tempo de evidências</h2>
    <p>Eventos ordenados pela data em que o MarketRift observou a evidência, em dias UTC no filtro.
      Datas escritas pela origem e datas de interpretação aparecem separadas. Cada tipo conserva seu significado;
      a quantidade de eventos não mede mercado, reclamações nem causa e efeito.</p>
    <form onSubmit={submit} className="timeline-filters">
      <label>Produto<select value={draft.product_id} onChange={event => setDraft({ ...draft, product_id: event.target.value })}>
        <option value="">Todos</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select></label>
      <fieldset><legend>Tipos de fonte (nenhum marcado = todos)</legend><div className="timeline-types">
        {sourceTypes.map(type => <label key={type}><input type="checkbox" checked={draft.source_types.includes(type)}
          onChange={event => setDraft({ ...draft, source_types: event.target.checked
            ? [...draft.source_types, type] : draft.source_types.filter(value => value !== type) })} />
          {sourceLabels[type]}</label>)}</div></fieldset>
      <label>De (observado pelo MarketRift)<input type="date" value={draft.from}
        onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>Até (observado pelo MarketRift)<input type="date" value={draft.to}
        onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <button>Aplicar na linha do tempo</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p role="status">Carregando linha do tempo…</p>}
    {result && <><p>{result.total} registro(s) de observação/interpretação nos filtros.
      Captura e entrada identificada nela são tipos diferentes de evento; não some esse número como documentos distintos.</p>
      {!result.items.length && <p className="empty">Nenhum evento corresponde aos filtros.</p>}
      <div className="documents">{result.items.map(item => <article key={item.event_id}>
        <div className="meta"><span className="badge">{sourceLabels[item.source_type]}</span>
          <span className="badge">{item.kind === 'snapshot' ? 'Captura' :
            item.kind === 'changelog_entry' ? 'Entrada de changelog' :
              item.kind === 'price_change' ? 'Mudança de preço' : 'Documento'}</span>
          <span className="badge">{item.status === 'confirmed' ? 'Confirmado pela regra' :
            item.status === 'partial' ? 'Parcial' : item.status === 'unconfirmed' ? 'Não confirmado' : 'Observado'}</span>
          {item.synthetic && <span className="badge">TESTE / SINTÉTICO</span>}</div>
        <h3>{item.title ?? sourceLabels[item.source_type]}</h3>
        <p>Produto(s) associado(s): {item.product_names.join(', ')}.</p>
        {item.association_count > 1 && <p className="evidence-warning">A mesma origem está associada a {item.association_count} produtos.
          Ela aparece uma vez nesta lista; não some totais por produto. IDs associados: {item.product_ids.join(', ')}.</p>}
        <p><strong>Data informada pela origem:</strong> {originDateLabel(item.origin_reported_at, item.origin_date_literal)}.</p>
        <p><strong>MarketRift observou:</strong> {formatDate(item.observed_at)}.
          {item.capture_at && item.kind === 'changelog_entry' &&
            ` O texto da captura foi guardado em ${formatDate(item.capture_at)}.`}</p>
        {item.interpretation_at && <p><strong>Interpretação/comparação:</strong> {formatDate(item.interpretation_at)}
          {item.rule_version && ` · regra v${item.rule_version}`}.</p>}
        {item.interpretation_basis === 'later_same_text_capture' && item.capture_at &&
          <p className="evidence-warning">O HTML que sustenta título, data e link foi observado depois, em
            {' '}{formatDate(item.structure_observed_at ?? item.observed_at)}. Ele não é o HTML histórico da captura
            de {formatDate(item.capture_at)}.</p>}
        <p><strong>Por que este estado?</strong> {statusExplanation(item)}</p>
        {item.coverage === 'partial_cursor' && <p className="evidence-warning">Cobertura parcial por cursor:
          os itens coletados não são todo o histórico do repositório.</p>}
        {item.coverage === 'unknown' && <p className="evidence-warning">Cobertura do repositório não informada.</p>}
        {item.data_status === 'sandbox_test' && <p>Dados de sandbox, não avaliações reais.</p>}
        {item.kind === 'price_change' ? priceDetails(item.detail) :
          <blockquote>Trecho preservado: “{item.excerpt}”</blockquote>}
        <p>{isNavigable(item.source_url) ? <a href={item.source_url} target="_blank" rel="noreferrer">
          Abrir fonte atual ↗</a> : <span>URL fictícia ou sem link navegável: {item.source_url}</span>}
          {' '}O link pode mostrar conteúdo atual; o trecho acima é o registro armazenado.</p>
        <small>ID {item.item_id} {item.version_no && `· captura v${item.version_no}`}
          {item.content_sha256 && ` · hash ${item.content_sha256.slice(0, 12)}…`}</small>
        {item.links.map(link => <p key={link.signal_id}>
          <a href={`/revisao#signal-${link.signal_id}`}>Sinal relacionado ↗</a> · estado {link.signal_state}
          {link.signal_reviewed_at && ` · última decisão humana em ${formatDate(link.signal_reviewed_at)}`}
          {link.relation === 'activity_of_source' && ' · atividade agregada da fonte, não classificação desta publicação'}
          {link.relation === 'capture_used' && ' · esta captura sustenta o sinal'}
          {link.hypothesis_id && <> · <a href={`/revisao#hypothesis-${link.hypothesis_id}`}>Hipótese ↗</a>
            {' '}({link.hypothesis_status}; aprovação significa discussão interna, não campanha executada)
            {link.hypothesis_reviewed_at && ` · última decisão humana em ${formatDate(link.hypothesis_reviewed_at)}`}</>}</p>)}
      </article>)}</div>
      <div className="evidence-pages"><button className="small" disabled={offset === 0 || loading}
        onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</button>
        <span>Exibindo {result.total ? offset + 1 : 0}–{Math.min(offset + result.items.length, result.total)} de {result.total}</span>
        <button className="small" disabled={loading || offset + result.items.length >= result.total || offset >= 1000}
          onClick={() => setOffset(offset + 20)}>Próxima</button></div>
      {result.total > 1020 && <p>Paginação limitada às primeiras 1.020 entradas; reduza produto, tipo ou período.</p>}
    </>}
  </section>;
}
