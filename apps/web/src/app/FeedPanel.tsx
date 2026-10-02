'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
type Product = { id: string; name: string; kind: string };
type Candidate = { id: string; product_id: string; canonical_url: string; suggested_type: string;
  confidence: string; status: string; linked_source_id: string | null; discovery_method: string };
type Source = { id: string; product_name: string; url: string; monitoring_enabled: boolean;
  check_interval_minutes: number | null; next_check_at: string | null; last_checked_at: string | null;
  last_status: string | null; last_error: string | null; last_attempt_at: string | null;
  last_success_at: string | null; scan_complete: boolean | null; retry_after_at: string | null;
  active: boolean; entries_count: number };
type Run = { id: string; source_id: string; status: string; trigger_kind: string;
  documents_seen: number; documents_new: number; documents_updated: number;
  scan_complete: boolean | null; error_code: string | null; retry_after_at: string | null;
  started_at: string };
type Entry = { id: string; source_id: string; canonical_url: string; title: string;
  date_literal: string | null; published_at: string | null; first_seen_at: string; version_no: number };
type Data = { sources: Source[]; runs: Run[]; entries: Entry[] };
const empty: Data = { sources: [], runs: [], entries: [] };
const when = (value: string | null): string => value ? new Date(value).toLocaleString('pt-BR') : 'nenhuma';
const errors: Record<string, string> = {
  robots_unavailable: 'robots.txt não pôde ser interpretado dentro do limite; coleta bloqueada.',
  robots_disallowed: 'robots.txt proíbe esta coleta.', robots_crawl_delay: 'Intervalo da origem ainda não terminou.',
  response_too_large: 'Resposta excedeu o limite antes de uma amostra segura ser obtida.',
  no_complete_entries_within_limit: 'Nenhuma entrada XML completa coube nos primeiros 512.000 bytes; nada foi publicado.',
  xml_structure_limit: 'A amostra continha mais elementos XML que o limite seguro; nenhuma entrada foi publicada.',
  xml_entities_forbidden: 'XML com entidades/DOCTYPE foi rejeitado.',
  invalid_xml: 'XML inválido.', unsupported_feed_format: 'O recurso não é RSS 2.0 nem Atom.',
  rate_limited: 'Origem limitou requisições.', unsafe_redirect: 'Redirecionamento inseguro ou para outro host.',
  monitoring_changed: 'Monitoramento alterado durante a execução.',
  monitoring_paused: 'A verificação foi cancelada quando o monitoramento foi pausado.',
  worker_unavailable: 'O worker antigo não consumia jobs de feed; esta tentativa foi cancelada sem consultar a origem.',
  source_changed: 'A fonte foi alterada antes da execução.',
  run_state_changed: 'A fonte ou execução mudou antes da gravação.',
};

export default function FeedPanel({ products, candidates, role, busy, act, request, refresh }: {
  products: Product[]; candidates: Candidate[]; role: Role; busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  request: (path: string, init: RequestInit) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const [data, setData] = useState<Data>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [chosen, setChosen] = useState('');
  const [url, setUrl] = useState('');
  const [productId, setProductId] = useState('');
  const load = useCallback(async () => {
    try { setData(await request('feeds', { method: 'GET' }) as Data); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha ao carregar feeds.'); }
    finally { setLoading(false); }
  }, [request]);
  async function actionRequest(path: string, init: RequestInit): Promise<unknown> {
    setActionError('');
    try { return await request(path, init); }
    catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.');
      throw cause;
    }
  }
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer); }, [load]);
  const canManage = role === 'owner' || role === 'admin';
  const suggested = candidates.filter(item => item.suggested_type === 'blog_or_feed'
    && item.status !== 'rejected' && !item.linked_source_id);
  function create(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void act(async () => {
      await actionRequest('feeds', { method: 'POST', body: JSON.stringify({ product_id: productId,
        url, ...(chosen ? { candidate_id: chosen } : {}),
        association_confirmed: values.get('association_confirmed') === 'on' }) });
      setChosen(''); setUrl(''); form.reset(); await load(); await refresh();
    });
  }
  return <section id="feeds" className="card wide" aria-label="Feeds RSS e Atom">
    <h2>Feeds RSS e Atom</h2>
    <p>Publicações da origem, não avaliações de clientes nem prova de impacto comercial. O MarketRift guarda
      apenas ID, título, link, data declarada quando existe, hash e versões. Não abre os links das matérias,
      não armazena seu texto integral e não chama IA. Uma URL descoberta ainda não comprova associação ao concorrente.</p>
    {loading && <p>Carregando feeds...</p>}{error && <p className="error" role="alert">{error}</p>}
    {actionError && <p className="error" role="alert">{actionError}</p>}
    {canManage && <form onSubmit={create}>
      <label>Candidata descoberta (opcional)<select value={chosen} onChange={event => {
        const next = suggested.find(item => item.id === event.target.value);
        setChosen(event.target.value); if (next) { setUrl(next.canonical_url); setProductId(next.product_id); }
      }}><option value="">URL HTTPS conhecida</option>{suggested.map(item => <option key={item.id} value={item.id}>
        {item.canonical_url} · {item.confidence === 'official_host' ? 'site oficial' : 'link externo ambíguo'}
      </option>)}</select></label>
      <label>Concorrente<select required value={productId} onChange={event => { setProductId(event.target.value); setChosen(''); }}>
        <option value="">Selecione</option>{products.filter(item => item.kind === 'competitor').map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>URL HTTPS do feed<input type="url" required value={url} onChange={event => { setUrl(event.target.value); setChosen(''); }}
        placeholder="https://exemplo.com/feed.xml" /></label>
      <label><input name="association_confirmed" type="checkbox" required /> Revisei o vínculo deste feed com o concorrente.
        Sei que links externos exigem revisão e que a URL será validada como RSS/Atom na primeira execução.</label>
      <button disabled={busy || !productId || !url}>Cadastrar feed pausado</button>
    </form>}
    {!data.sources.length && !loading && <p className="empty">Nenhum feed cadastrado. Escolha uma candidata descoberta
      ou informe uma URL HTTPS conhecida; o cadastro não faz requisições.</p>}
    {data.sources.map(source => {
      const last = data.runs.find(run => run.source_id === source.id);
      const late = source.monitoring_enabled && source.next_check_at &&
        new Date(source.next_check_at).getTime() < Date.now() && !source.active;
      return <div key={source.id} className="discovery-product"><h3>{source.product_name}</h3>
        <p><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> · monitoramento
          {' '}<strong>{source.monitoring_enabled ? 'ativo' : 'pausado'}</strong> · {source.entries_count} entrada(s) guardada(s).</p>
        <p>Última tentativa: {when(source.last_attempt_at)} · último sucesso: {when(source.last_success_at)}
          {' '}· próxima execução: {source.monitoring_enabled ? when(source.next_check_at) : 'não agendada'}.
          {source.last_status === 'pending' && ' Verificação na fila; ainda não começou a coleta.'}
          {source.last_status === 'running' && ' Verificação em andamento.'}
          {source.last_status === 'pending' && source.last_attempt_at &&
            Date.now()-new Date(source.last_attempt_at).getTime()>30_000 &&
            ' Aguardando worker: confira se o container Python foi reconstruído com o consumidor de feeds.'}
          {late && ' Execução atrasada: confira scheduler e worker.'}
          {source.scan_complete === false && ' Cobertura parcial: no máximo 20 entradas completas da janela lida foram guardadas; o XML inteiro e o histórico não foram examinados.'}
          {source.last_error && source.last_status === 'cancelled' &&
            ` Última execução cancelada: ${errors[source.last_error] ?? source.last_error}.`}
          {source.last_error && source.last_status === 'failed' && source.last_error === 'monitoring_paused' &&
            ` Execução histórica cancelada: ${errors[source.last_error]}.`}
          {source.last_error && source.last_status === 'failed' && source.last_error !== 'monitoring_paused' &&
            ` Última falha: ${errors[source.last_error] ?? source.last_error}.`}
          {source.retry_after_at && ` Respeite o limite da origem até ${when(source.retry_after_at)}.`}</p>
        {canManage && <form onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget);
          void act(async () => { await actionRequest(`feeds/${source.id}/monitor`, { method:'POST',
            body: JSON.stringify({ enabled:true, interval_minutes:Number(values.get('interval_minutes')) }) }); await load(); });
        }}><label>Periodicidade<select name="interval_minutes" defaultValue={source.check_interval_minutes ?? 1440}>
          <option value="360">A cada 6 horas</option><option value="1440">Diária</option>
          <option value="10080">Semanal</option></select></label>
          <button className="small" disabled={busy}>{source.monitoring_enabled ? 'Salvar periodicidade' : 'Ativar monitoramento'}</button>
          {source.monitoring_enabled && <button type="button" className="small ghost" disabled={busy}
            onClick={() => void act(async () => { await actionRequest(`feeds/${source.id}/monitor`, { method:'POST',
              body:JSON.stringify({ enabled:false,interval_minutes:source.check_interval_minutes ?? 1440 }) }); await load(); })}>
            Pausar monitoramento</button>}</form>}
        {role !== 'viewer' && <button className="small" disabled={busy || !source.monitoring_enabled || source.active}
          onClick={() => void act(async () => { await actionRequest(`feeds/${source.id}/run`, { method:'POST', body:'{}' }); await load(); })}>
          Verificar agora (limite pequeno)</button>}
        {last && <p>Última execução: {last.status === 'cancelled' ? 'cancelada' : last.status} ·
          {' '}{last.documents_seen} examinada(s) · {last.documents_new} nova(s)
          {' '}· {last.documents_updated} editada(s){last.scan_complete === false ? ' · cobertura parcial' : ''}.
          {last.status === 'cancelled' && last.error_code &&
            ` Motivo: ${errors[last.error_code] ?? last.error_code}.`}</p>}
        <ul>{data.entries.filter(entry => entry.source_id === source.id).map(entry =>
          <li key={entry.id}><strong>Publicação de feed:</strong> <a href={entry.canonical_url} target="_blank" rel="noreferrer">
            {entry.title}</a> · data declarada: {entry.published_at ? when(entry.published_at)
              : entry.date_literal || 'não informada'} · observada: {when(entry.first_seen_at)} · versão {entry.version_no}</li>)}</ul>
      </div>;
    })}
  </section>;
}
