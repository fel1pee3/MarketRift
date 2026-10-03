'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
type Candidate = { id: string; product_id: string; canonical_url: string; discovered_from_url: string;
  discovery_method: string; confidence: string; status: string; category: string; suggested_type: string;
  identity_version: number; existing_source_id: string | null };
type Product = { id: string; name: string };
type FeedEntry = { id: string; canonical_url: string; title: string; source_id: string };
type FeedSource = { id: string; product_id: string; url: string };
type Source = { id: string; product_name: string; url: string; source_type: string; monitoring_enabled: boolean;
  origins?: { kind: string; suggested_url: string; from_url: string | null; title: string | null }[] };
type Run = { id: string; source_id: string; status: string; error_code: string | null; documents_new: number;
  retry_after_at: string | null; capture_mode?: 'static' | 'rendered_dom' };
type Snapshot = { id: string; source_id: string; version_no: number; fetched_at: string;
  final_url: string; content_sha256: string; capture_complete: boolean; capture_limit_kind: string | null;
  interpretation_version: number | null; interpretation_reason: string | null;
  extracted: { title?: string | null; excerpt: string; capture_method?: 'static_html' | 'rendered_dom';
    dom_observed_at?: string | null; origin_date_literal?: string | null;
    origin_reported_at?: string | null; origin_date_basis?: string | null;
    origin_date_evidence?: { element: string; text: string | null; datetime_attribute: string | null } | null;
    comparison_status?: string | null } };
type Pages = { sources: Source[]; runs: Run[]; snapshots: Snapshot[] };
type Feeds = { sources: FeedSource[]; entries: FeedEntry[] };
const errorReason: Record<string, string> = {
  robots_disallowed: 'robots.txt não permite a captura', robots_unavailable: 'robots.txt indisponível ou ilegível',
  unsafe_destination: 'destino ou redirecionamento inseguro', access_denied: 'acesso negado pela origem',
  not_found: 'página não encontrada', rate_limited: 'limite da origem; respeite a espera indicada',
  unsupported_content_type: 'resposta não é HTML ou texto acessível', no_extractable_content: 'texto visível insuficiente',
  network_failure: 'falha de rede ou TLS', response_too_large: 'limite seguro de leitura excedido',
  insufficient_main_content: 'O navegador não encontrou título e prosa principal suficiente; nenhuma evidência foi salva',
  renderer_not_configured: 'Serviço de renderização não configurado',
  renderer_unavailable: 'Serviço de renderização indisponível; verifique o container renderer',
  renderer_invalid_response: 'Serviço de renderização respondeu fora do contrato esperado',
  renderer_unauthorized: 'Credencial interna do renderizador não confere entre worker e serviço',
  renderer_failure: 'Falha no navegador isolado', render_timeout: 'Tempo máximo de renderização excedido',
  render_budget_exceeded: 'Limite seguro de requisições ou bytes excedido',
  source_changed: 'fonte alterada durante a captura', internal_failure: 'falha interna da captura',
};
function domain(url: string): string { try { return new URL(url).hostname; } catch { return 'URL inválida'; } }
function when(value: string): string { return new Date(value).toLocaleString('pt-BR'); }

export default function IndividualPagePanel({ candidates, products, pages, role, busy, act, request, refresh }: {
  candidates: Candidate[]; products: Product[]; pages: Pages; role: Role; busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  request: (path: string, init: RequestInit) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const [feeds, setFeeds] = useState<Feeds>({ sources: [], entries: [] });
  const [chosen, setChosen] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setFeeds(await request('feeds', { method: 'GET' }) as Feeds); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível listar entradas de feed.'); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  const options = [
    ...candidates.filter(item => item.status !== 'rejected' && item.category !== 'reviews'
      && !['g2', 'reclameaqui', 'app_store', 'play_store'].includes(item.suggested_type))
      .map(item => ({ key: `candidate:${item.id}`, url: item.canonical_url,
        product: products.find(product => product.id === item.product_id)?.name ?? 'Produto indisponível',
        origin: item.discovery_method === 'web_search' ? 'Busca externa não verificada' :
          `Descoberta em ${item.discovered_from_url}`, existing: item.existing_source_id })),
    ...feeds.entries.map(item => ({ key: `feed:${item.id}`, url: item.canonical_url,
      product: products.find(product => product.id === feeds.sources.find(source => source.id === item.source_id)?.product_id)?.name
        ?? 'Produto indisponível', origin: `Entrada de feed: ${item.title}`,
      existing: pages.sources.find(source => source.url === item.canonical_url)?.id ?? null })),
  ];
  const selected = options.find(item => item.key === chosen);
  const canManage = role === 'owner' || role === 'admin';
  function create(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (!selected || !confirmed) return;
    const [kind, id] = selected.key.split(':');
    void act(async () => {
      setError('');
      try {
        await request('page-sources/individual', { method: 'POST', body: JSON.stringify({
          [kind === 'candidate' ? 'candidate_id' : 'feed_entry_id']: id, association_confirmed: true,
        }) });
        setChosen(''); setConfirmed(false); await refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cadastro não concluído.'); throw cause; }
    });
  }
  const sources = pages.sources.filter(source => source.source_type === 'public_page');
  return <section id="paginas-individuais" className="card wide" aria-label="Páginas públicas individuais">
    <h2>Páginas públicas individuais</h2>
    <p>Escolha UMA URL já descoberta ou um link de feed. URL descoberta é só indicação: nenhum conteúdo do destino foi capturado.
      Confirme o produto e o domínio antes de cadastrar. O cadastro fica pausado e não consulta a página; use o botão de captura manual depois.
      Uma página observada não é review, preço ou lançamento confirmado. Links externos continuam ambíguos até sua revisão.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {canManage && <form onSubmit={create}><label>URL descoberta ou entrada de feed
      <select value={chosen} onChange={event => { setChosen(event.target.value); setConfirmed(false); }} required>
        <option value="">Selecione uma indicação</option>{options.map(item => <option key={item.key} value={item.key}>
          {item.product} · {item.url} · {item.origin}
        </option>)}</select></label>
      {selected && <div><p><strong>Produto:</strong> {selected.product}. <strong>Domínio de destino:</strong> {domain(selected.url)}.</p>
        <p><strong>URL indicada:</strong> {selected.url}. <strong>Origem:</strong> {selected.origin}.</p>
        {selected.existing && <p>Fonte já cadastrada; confira a lista abaixo ou as páginas principais. Não será duplicada.</p>}
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />
          Revisei o vínculo desta URL com o produto e autorizo apenas seu cadastro pausado.</label></div>}
      <button disabled={busy || !selected || !confirmed || !!selected.existing}>Cadastrar página pausada</button>
    </form>}
    {!sources.length && <p>Nenhuma página individual cadastrada nesta empresa.</p>}
    {sources.map(source => {
      const latest = pages.runs.find(run => run.source_id === source.id);
      const snapshots = pages.snapshots.filter(snapshot => snapshot.source_id === source.id)
        .sort((a, b) => b.version_no - a.version_no);
      return <article key={source.id}><h3>{source.product_name} · {domain(source.url)}</h3>
        <p><strong>Página cadastrada, monitoramento pausado:</strong> <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>.</p>
        {source.origins?.map((origin, index) => <p key={`${origin.suggested_url}-${index}`}>
          Indicada por {origin.kind === 'feed' ? 'entrada de feed' : 'descoberta'}:
          {' '}{origin.title ?? origin.from_url ?? origin.suggested_url}.
          {origin.from_url && <> <a href={origin.from_url} target="_blank" rel="noreferrer">Abrir origem da indicação ↗</a></>}
        </p>)}
        {canManage && <button className="small" disabled={busy || latest?.status === 'pending' || latest?.status === 'running'}
          onClick={() => void act(async () => {
            setError('');
            try { await request(`page-sources/${source.id}/check`, { method: 'POST', body: '{}' }); await refresh(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Captura não solicitada.'); throw cause; }
          })}>Capturar esta URL agora (1 página)</button>}
        {canManage && <button className="small" disabled={busy || latest?.status === 'pending' || latest?.status === 'running'}
          onClick={() => void act(async () => {
            setError('');
            try { await request(`page-sources/${source.id}/check-rendered`, { method: 'POST', body: '{}' }); await refresh(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Captura renderizada não solicitada.'); throw cause; }
          })}>Capturar DOM renderizado agora (1 página)</button>}
        <p>A captura renderizada abre somente esta URL em um navegador isolado. Ela faz uma nova observação;
          não altera a captura histórica e pode falhar se não houver artigo visível.</p>
        {latest && <p>Última captura: <strong>{latest.status}</strong> · {latest.documents_new ? 'nova versão' : 'sem nova versão'}
          {latest.error_code && ` · motivo: ${errorReason[latest.error_code] ?? latest.error_code}`}
          {latest.retry_after_at && ` · tente após ${when(latest.retry_after_at)}`}.</p>}
        {!snapshots.length && <p>Conteúdo ainda não capturado.</p>}
        {snapshots.slice(0, 5).map(snapshot => <div key={snapshot.id} className="page-history">
          <p><strong>Conteúdo capturado:</strong> versão {snapshot.version_no} · {when(snapshot.fetched_at)} · hash
            {' '}<code>{snapshot.content_sha256.slice(0, 12)}</code>.</p>
          <p>Método: {snapshot.extracted.capture_method === 'rendered_dom' ? 'DOM renderizado' : 'HTML direto'}.
            Versão da regra: {snapshot.interpretation_version ?? 'não registrada'}.
            {snapshot.extracted.dom_observed_at && ` Observado no navegador em ${when(snapshot.extracted.dom_observed_at)}.`}</p>
          {snapshot.extracted.title && <p>Título observado: {snapshot.extracted.title}.</p>}
          {snapshot.extracted.origin_date_basis === 'feed_metadata' ?
            <p>Data da página não comprovada; a data do feed pertence à indicação da URL.</p> :
          snapshot.extracted.origin_date_evidence && (snapshot.extracted.origin_reported_at || snapshot.extracted.origin_date_literal) ?
            <p>Data declarada pela origem: {snapshot.extracted.origin_date_literal ??
              when(snapshot.extracted.origin_reported_at!)}. Evidência: elemento {snapshot.extracted.origin_date_evidence.element}
              {snapshot.extracted.origin_date_evidence.datetime_attribute &&
                `, atributo datetime=${snapshot.extracted.origin_date_evidence.datetime_attribute}`}.</p> :
            <p>Data de publicação não comprovada nesta página.</p>}
          {snapshot.interpretation_reason === 'insufficient_main_content' ||
            snapshot.interpretation_version !== null && snapshot.interpretation_version < 4 &&
            snapshot.extracted.excerpt.trim().toLowerCase() === 'skip to content' ?
            <p>Interpretação insuficiente: o trecho preservado não contém conteúdo principal útil.
              Esta versão histórica não tem HTML estrutural para reinterpretação.</p> :
            <blockquote>“{snapshot.extracted.excerpt}”</blockquote>}
          {snapshot.extracted.comparison_status === 'previous_markup_unavailable' &&
            <p>Nova observação com regra corrigida. A estrutura da versão anterior não foi guardada;
              não é possível afirmar que a página mudou.</p>}
          <p><a href={snapshot.final_url} target="_blank" rel="noreferrer">Abrir URL final atual ↗</a>.
            A página atual pode ter mudado desde a captura.
            {!snapshot.capture_complete && (snapshot.extracted.capture_method === 'rendered_dom'
              ? ' Cobertura parcial: subrecursos externos ou excedentes foram bloqueados.'
              : ` Cobertura parcial: limite ${snapshot.capture_limit_kind ?? 'de leitura'}.`)}</p>
        </div>)}
      </article>;
    })}
  </section>;
}
