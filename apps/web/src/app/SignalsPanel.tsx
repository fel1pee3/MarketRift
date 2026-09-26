'use client';

import { useCallback, useEffect, useState } from 'react';

type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
type Evidence = { repository?: string; count?: number; coverage?: string; product_ids?: string[];
  ambiguous_association?: boolean; examples_truncated?: boolean;
  examples?: { document_id: string; url: string; title: string | null; observed_at: string }[];
  previous?: { snapshot_id: string; url: string; at: string; quote: string; amount?: string };
  current?: { snapshot_id: string; url: string; at: string; quote: string; amount?: string; entry_url?: string };
  plan?: string; currency?: string; period?: string; conditions?: string };
type Signal = { id: string; state: 'candidate' | 'approved' | 'discarded' | 'obsolete';
  signal_type: string; source_type: string; summary: string; interpretation_limit: string;
  evidence: Evidence; observed_at: string; reviewed_at: string | null; review_reason: string | null;
  obsolete_reason: string | null; rule_version: string; test_data: boolean; read_at: string | null };
type Result = { signals: Signal[]; alerts: Signal[]; real_count: number; test_count: number;
  reconciliation: { last_at: string | null; pending: number; failed: number; reasons: string[] } };
const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
function date(value: string): string { return new Date(value).toLocaleString('pt-BR'); }
function failureReason(code: string): string {
  if (code === 'fact_limit_exceeded') return 'limite de fatos da empresa excedido; revise a origem e tente a atualização manual';
  if (code === 'source_not_visible') return 'fonte ou produto não está acessível neste tenant';
  return 'falha interna de reconciliação; consulte o scheduler e tente a atualização manual';
}
function link(url: string | undefined, label: string): React.ReactNode {
  if (!url) return null;
  try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (parsed.hostname.endsWith('.invalid')) return <small>{label}: URL fictícia de teste</small>;
    return <a href={url} target="_blank" rel="noreferrer">{label} ↗</a>;
  } catch { return null; }
}
function evidence(signal: Signal): React.ReactNode {
  const value = signal.evidence;
  if (signal.signal_type === 'price_change' || signal.signal_type === 'release_entry') return <div>
    <p><strong>Antes:</strong> “{value.previous?.quote}” · {value.previous && date(value.previous.at)} ·
      captura <code>{value.previous?.snapshot_id}</code> · {link(value.previous?.url, 'Origem anterior')}</p>
    <p><strong>Depois:</strong> “{value.current?.quote}” · {value.current && date(value.current.at)} ·
      captura <code>{value.current?.snapshot_id}</code> · {link(value.current?.url, 'Origem atual')}</p>
    {value.current?.entry_url && <p>{link(value.current.entry_url, 'Entrada do changelog')}</p>}
    {signal.signal_type === 'price_change' && <p>Plano {value.plan} · {value.currency} · {value.period} ·
      condições explícitas: {value.conditions}</p>}
    <small>Links podem abrir a página atual; os trechos foram preservados em cada captura.</small>
  </div>;
  return <div><p>Repositório: {value.repository} · {value.count} documentos públicos distintos armazenados ·
    {value.coverage === 'partial_cursor' ? ' coleta parcial por cursor' : ' último percurso concluído'}</p>
    <ul>{value.examples?.map(item => <li key={item.document_id}>{item.title ?? 'Sem título'} ·
      {date(item.observed_at)} · {link(item.url, 'Origem pública')}</li>)}</ul>
    {value.examples_truncated && <small>Exibindo até 20 exemplos; a contagem considera todas as origens distintas armazenadas.</small>}
  </div>;
}

export default function SignalsPanel({ tenantId, csrfToken, role }: { tenantId: string; csrfToken: string; role: Role }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const get = useCallback(async (): Promise<void> => {
    const response = await fetch(`${base}/v1/reviewable-signals`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`Consulta de sinais falhou (HTTP ${response.status})`);
    setResult(await response.json() as Result);
  }, []);
  useEffect(() => { let active = true;
    void get().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Falha ao carregar sinais'); });
    const timer = setInterval(() => { void get().catch(() => undefined); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [get, tenantId]);
  async function act(path: string, body: object = {}): Promise<void> {
    setBusy(true); setError('');
    try { const response = await fetch(`${base}/v1/reviewable-signals/${path}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
      if (!response.ok) { const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : '';
        throw new Error(`Operação falhou (HTTP ${response.status})${message ? `: ${message}` : ''}`); }
      await get();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha na operação'); }
    finally { setBusy(false); }
  }
  const canReview = role === 'owner' || role === 'admin';
  return <section className="card wide" aria-label="Sinais para revisão">
    <h2>Sinais para revisão</h2>
    <p>Fatos observados nas fontes cadastradas. Coleta, interpretação e aprovação humana são etapas diferentes. Nenhum sinal recomenda campanha, comprova impacto comercial ou representa participação de mercado.</p>
    {canReview && <button className="small" disabled={busy} onClick={() => void act('refresh')}>Atualizar candidatos a partir das evidências armazenadas</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <><p>Reconciliação automática: {result.reconciliation.last_at
      ? `última conclusão ${date(result.reconciliation.last_at)}` : 'ainda não concluída nesta empresa'}.
      {' '}{result.reconciliation.pending} fonte(s) pendente(s); {result.reconciliation.failed} com falha.
      {result.reconciliation.reasons.length > 0 && ` Motivo: ${result.reconciliation.reasons.map(failureReason).join('; ')}.`}</p>
      <p>A reconciliação não coleta fontes, não ativa monitoramento e não aprova candidatos. O botão acima permite recuperação manual.</p></>}
    {result && <><p>{result.real_count} sinais com suporte atual em fontes não marcadas TESTE · {result.test_count} sinais de TESTE, separados.</p>
      <h3>Alertas internos recentes</h3><p>Somente sinais aprovados nos últimos 30 dias; lido/não lido é individual. Nenhuma mensagem externa é enviada.</p>
      {result.alerts.length ? <ul>{result.alerts.map(item => <li key={item.id}>
        <strong>{item.read_at ? 'Lido' : 'Não lido'}</strong> · {item.summary} {item.test_data && <span className="badge">TESTE</span>}
        <button className="small" disabled={busy} onClick={() => void act(`${item.id}/read`, { read: !item.read_at })}>
          Marcar como {item.read_at ? 'não lido' : 'lido'}</button>
      </li>)}</ul> : <p className="empty">Nenhum sinal aprovado recente para alertar.</p>}
      <h3>Candidatos e decisões</h3>
      {result.signals.length ? <div className="documents">{result.signals.map(item => <article key={item.id}>
        <div className="meta"><span className="badge">{item.state}</span><span>{item.source_type}</span>
          {item.test_data && <span className="badge">TESTE — fora dos sinais reais</span>}
          <time>{date(item.observed_at)}</time></div>
        <h4>{item.summary}</h4><p>{item.interpretation_limit}</p>
        {item.evidence.ambiguous_association && <p className="evidence-warning">Origem associada a mais de um produto. O fato conta uma vez nesta empresa; não some subtotais por produto.</p>}
        {item.state === 'obsolete' ? <p className="evidence-warning">Suporte alterado, removido ou fonte desativada. Conteúdo antigo retirado; exige nova revisão.</p> : evidence(item)}
        <small>Regra {item.rule_version} · estado {item.state}. {item.review_reason && `Motivo: ${item.review_reason}`}</small>
        {canReview && item.state === 'candidate' && <div className="member-actions">
          <label>Motivo da decisão<input minLength={3} maxLength={500} value={reason[item.id] ?? ''}
            onChange={event => setReason({ ...reason, [item.id]: event.target.value })} /></label>
          <button className="small" disabled={busy || (reason[item.id] ?? '').trim().length < 3}
            onClick={() => void act(`${item.id}/review`, { state: 'approved', reason: reason[item.id] })}>Aprovar</button>
          <button className="small" disabled={busy || (reason[item.id] ?? '').trim().length < 3}
            onClick={() => void act(`${item.id}/review`, { state: 'discarded', reason: reason[item.id] })}>Descartar</button>
        </div>}
      </article>)}</div> : <p className="empty">Nenhum fato elegível. É preciso ter duas capturas v2 confirmadas e comparáveis ou uma coleta pública GitHub concluída. Capturas parciais, homepage editorial, dados sintéticos e reviews sem qualidade medida não geram sinais reais.</p>}
    </>}
  </section>;
}
