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
type Capability = { id: string; product_id: string; topic: string; claim: string; evidence_url: string;
  verification_status: string; verified_at: string | null; reviewed_by: string | null };
type HypothesisFact = { evidence_id: string; observed_at: string; quote: string; url: string; kind: string };
type HypothesisEvent = { actor_user_id: string | null; action: string; from_status: string | null;
  to_status: string; reason: string | null; occurred_at: string };
type Hypothesis = { id: string; signal_id: string; signal_fact_key: string; signal_evidence_hash: string;
  signal_rule_version: string; signal_state: string; signal_test_data: boolean;
  signal_source_enabled: boolean; hypothesis_kind: 'product' | 'marketing'; status: string;
  source_type: string; coverage_note: string; facts: HypothesisFact[]; interpretation: string;
  proposed_action: string; unverified_claims: string; verification_steps: string; risks: string;
  own_capability_id: string | null; own_advantage_claim: string | null;
  author_user_id: string | null; reviewer_user_id: string | null; review_reason: string | null;
  created_at: string; updated_at: string; submitted_at: string | null; reviewed_at: string | null;
  history: HypothesisEvent[] };
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

export default function SignalsPanel({ tenantId, userId, csrfToken, role, ownProducts }: { tenantId: string;
  userId: string; csrfToken: string; role: Role; ownProducts: { id: string; name: string }[] }) {
  const [result, setResult] = useState<Result | null>(null);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const get = useCallback(async (): Promise<void> => {
    const [signals, plans, own] = await Promise.all([
      fetch(`${base}/v1/reviewable-signals`, { credentials: 'include', cache: 'no-store' }),
      fetch(`${base}/v1/action-hypotheses`, { credentials: 'include', cache: 'no-store' }),
      fetch(`${base}/v1/action-hypotheses/capabilities`, { credentials: 'include', cache: 'no-store' }),
    ]);
    if (!signals.ok || !plans.ok || !own.ok)
      throw new Error(`Consulta de revisão falhou (HTTP ${[signals, plans, own].find(item => !item.ok)?.status})`);
    setResult(await signals.json() as Result);
    setHypotheses(await plans.json() as Hypothesis[]);
    setCapabilities(await own.json() as Capability[]);
  }, []);
  useEffect(() => { let active = true;
    void get().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Falha ao carregar sinais'); });
    const timer = setInterval(() => { void get().catch(() => undefined); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [get, tenantId]);
  async function mutate(path: string, body: object = {}, method: 'POST' | 'PATCH' = 'POST'): Promise<boolean> {
    setBusy(true); setError('');
    try { const response = await fetch(`${base}/v1/${path}`, {
      method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
      if (!response.ok) { const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : '';
        throw new Error(`Operação falhou (HTTP ${response.status})${message ? `: ${message}` : ''}`); }
      await get(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha na operação'); return false; }
    finally { setBusy(false); }
  }
  async function act(path: string, body: object = {}): Promise<void> {
    await mutate(`reviewable-signals/${path}`, body);
  }
  const canReview = role === 'owner' || role === 'admin';
  return <section className="card wide" aria-label="Sinais para revisão">
    <h2>Sinais para revisão</h2>
    <p>Fatos observados nas fontes cadastradas. Coleta, interpretação e aprovação humana são etapas diferentes. Nenhum sinal recomenda campanha, comprova impacto comercial ou representa participação de mercado.</p>
    <p><strong>Hipóteses humanas:</strong> rascunho = ainda não enviado; proposta = aguarda owner/admin;
      aprovada = revisada para discussão interna; rejeitada = decisão registrada; precisa de revisão = o sinal perdeu suporte.
      Aprovar não publica nem executa uma ação.</p>
    <h3>Capacidades do produto próprio</h3>
    <p>Uma vantagem própria só pode ser alegada após cadastrar uma capacidade com URL HTTPS e revisá-la.
      Essa revisão é uma declaração humana; o MarketRift não verifica o site ou o contrato automaticamente.
      Sem capacidade verificada, a hipótese deve dizer “verificar internamente”.</p>
    {canReview && <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget;
      const data = new FormData(form);
      void mutate('action-hypotheses/capabilities', {
        product_id: data.get('product_id'), topic: data.get('topic'), claim: data.get('claim'),
        evidence_url: data.get('evidence_url'),
      }).then(ok => { if (ok) form.reset(); });
    }}><label>Produto próprio<select name="product_id" required>{ownProducts.map(product =>
      <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <label>Tema da capacidade<input name="topic" minLength={2} maxLength={100} required /></label>
      <label>Capacidade observável<input name="claim" minLength={10} maxLength={500} required /></label>
      <label>URL HTTPS da evidência<input name="evidence_url" type="url" required /></label>
      <button disabled={busy || !ownProducts.length}>Cadastrar para revisão</button></form>}
    {capabilities.length ? <ul>{capabilities.map(item => <li key={item.id}>
      <strong>{item.claim}</strong> · {item.topic} · {item.verification_status === 'verified'
        ? `revisada em ${date(item.verified_at!)}` : 'ainda não verificada'} · {link(item.evidence_url, 'Evidência')}
      {canReview && item.verification_status === 'unverified' && <button className="small" disabled={busy}
        onClick={() => void mutate(`action-hypotheses/capabilities/${item.id}/verify`)}>
          Confirmar revisão da evidência</button>}
    </li>)}</ul> : <p className="empty">Nenhuma capacidade própria cadastrada; verificar internamente qualquer vantagem alegada.</p>}
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
      {result.signals.length ? <div className="documents">{result.signals.map(item => <article key={item.id} id={`signal-${item.id}`}>
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
        {item.state === 'approved' && role !== 'viewer' && !hypotheses.some(plan => plan.signal_id === item.id) &&
          <details><summary>Escrever hipótese a partir deste sinal</summary>
            <p>Os fatos, IDs, datas, trechos e links serão copiados do sinal aprovado pela API. Escreva abaixo
              a interpretação, o que ainda precisa ser comprovado e uma verificação humana. Issues e Discussions
              são atividade pública, não reviews de clientes; coleta parcial não representa todo o histórico.</p>
            <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget;
              const data = new FormData(form); const capabilityId = String(data.get('own_capability_id') ?? '');
              const ownClaim = String(data.get('own_advantage_claim') ?? '').trim();
              void mutate('action-hypotheses', { signal_id: item.id,
                hypothesis_kind: data.get('hypothesis_kind'), interpretation: data.get('interpretation'),
                proposed_action: data.get('proposed_action'), unverified_claims: data.get('unverified_claims'),
                verification_steps: data.get('verification_steps'), risks: data.get('risks'),
                ...(capabilityId ? { own_capability_id: capabilityId } : {}),
                ...(ownClaim ? { own_advantage_claim: ownClaim } : {}),
              }).then(ok => { if (ok) form.reset(); });
            }}><label>Área<select name="hypothesis_kind"><option value="product">Produto</option>
              <option value="marketing">Marketing</option></select></label>
              <label>Interpretação ou oportunidade possível<textarea name="interpretation" minLength={10} maxLength={2000} required /></label>
              <label>Ação a considerar, sem execução automática<textarea name="proposed_action" minLength={10} maxLength={2000} required /></label>
              <label>Alegações ainda não verificadas<textarea name="unverified_claims" minLength={5} maxLength={2000} required /></label>
              <label>Passos para conferir a hipótese<textarea name="verification_steps" minLength={10} maxLength={2000} required /></label>
              <label>Riscos e limites adicionais<textarea name="risks" maxLength={2000} /></label>
              <label>Capacidade própria verificada, se aplicável<select name="own_capability_id">
                <option value="">Nenhuma — verificar internamente</option>
                {capabilities.filter(capability => capability.verification_status === 'verified').map(capability =>
                  <option key={capability.id} value={capability.id}>{capability.claim}</option>)}</select></label>
              <label>Alegação específica de vantagem própria (somente com capacidade acima)
                <input name="own_advantage_claim" minLength={10} maxLength={500} /></label>
              <button disabled={busy}>Salvar rascunho</button></form>
          </details>}
        {hypotheses.filter(plan => plan.signal_id === item.id).map(plan =>
          <section key={plan.id} id={`hypothesis-${plan.id}`} className="card" aria-label="Hipótese ligada ao sinal">
            <h5>Hipótese {plan.hypothesis_kind === 'product' ? 'de produto' : 'de marketing'} · {plan.status}
              {plan.signal_test_data && ' · TESTE'}</h5>
            <p><a href={`#signal-${item.id}`}>Sinal de origem {item.id}</a> · versão {plan.signal_rule_version}
              {' · '}fato <code>{plan.signal_fact_key.slice(0, 12)}</code>.</p>
            <p><strong>Fatos observados:</strong> {plan.coverage_note}</p>
            {plan.facts.length ? <ul>{plan.facts.map(fact => <li key={fact.evidence_id}>
              {fact.kind} · <code>{fact.evidence_id}</code> · {date(fact.observed_at)} · “{fact.quote}” ·
              {link(fact.url, 'Origem')}</li>)}</ul> :
              <p className="evidence-warning">Trechos históricos retirados após perda de suporte do sinal.</p>}
            <p><strong>Interpretação:</strong> {plan.interpretation}</p>
            <p><strong>Ação apenas proposta:</strong> {plan.proposed_action}</p>
            <p><strong>Alegações a verificar:</strong> {plan.unverified_claims}</p>
            <p><strong>Próximos passos:</strong> {plan.verification_steps}</p>
            {plan.risks && <p><strong>Riscos:</strong> {plan.risks}</p>}
            <p><strong>Produto próprio:</strong> {plan.own_advantage_claim ?? 'verificar internamente'}
              {plan.own_capability_id && ` · capacidade ${plan.own_capability_id}`}</p>
            <small>Autor {plan.author_user_id ?? 'conta removida'} · criado em {date(plan.created_at)};
              atualizado em {date(plan.updated_at)}.
              {plan.reviewer_user_id && ` Revisor ${plan.reviewer_user_id}; decisão em ${date(plan.reviewed_at!)}.`}
              {plan.review_reason && ` Motivo: ${plan.review_reason}`}</small>
            {plan.status === 'draft' && (canReview || plan.author_user_id === userId) &&
              <details><summary>Editar texto do rascunho</summary>
                <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget);
                  const capabilityId = String(data.get('own_capability_id') ?? '');
                  const ownClaim = String(data.get('own_advantage_claim') ?? '').trim();
                  void mutate(`action-hypotheses/${plan.id}`, {
                    signal_id: plan.signal_id, hypothesis_kind: data.get('hypothesis_kind'), interpretation: data.get('interpretation'),
                    proposed_action: data.get('proposed_action'), unverified_claims: data.get('unverified_claims'),
                    verification_steps: data.get('verification_steps'), risks: data.get('risks'),
                    ...(capabilityId ? { own_capability_id: capabilityId } : {}),
                    ...(ownClaim ? { own_advantage_claim: ownClaim } : {}),
                  }, 'PATCH');
                }}><label>Área<select name="hypothesis_kind" defaultValue={plan.hypothesis_kind}>
                    <option value="product">Produto</option><option value="marketing">Marketing</option></select></label>
                  <label>Interpretação<textarea name="interpretation" defaultValue={plan.interpretation} minLength={10} maxLength={2000} required /></label>
                  <label>Ação a considerar<textarea name="proposed_action" defaultValue={plan.proposed_action} minLength={10} maxLength={2000} required /></label>
                  <label>Alegações não verificadas<textarea name="unverified_claims" defaultValue={plan.unverified_claims} minLength={5} maxLength={2000} required /></label>
                  <label>Passos de verificação<textarea name="verification_steps" defaultValue={plan.verification_steps} minLength={10} maxLength={2000} required /></label>
                  <label>Riscos<textarea name="risks" defaultValue={plan.risks} maxLength={2000} /></label>
                  <label>Capacidade própria verificada<select name="own_capability_id" defaultValue={plan.own_capability_id ?? ''}>
                    <option value="">Nenhuma — verificar internamente</option>
                    {capabilities.filter(capability => capability.verification_status === 'verified').map(capability =>
                      <option key={capability.id} value={capability.id}>{capability.claim}</option>)}</select></label>
                  <label>Alegação específica de vantagem própria<input name="own_advantage_claim"
                    defaultValue={plan.own_advantage_claim ?? ''} minLength={10} maxLength={500} /></label>
                  <button disabled={busy}>Salvar edição</button></form>
              </details>}
            {plan.status === 'draft' && (canReview || plan.author_user_id === userId) && <button className="small" disabled={busy}
              onClick={() => void mutate(`action-hypotheses/${plan.id}/submit`)}>Enviar para revisão</button>}
            {plan.status === 'proposed' && canReview && <div className="member-actions">
              <label>Motivo da decisão<input minLength={3} maxLength={500} value={reason[plan.id] ?? ''}
                onChange={event => setReason({ ...reason, [plan.id]: event.target.value })} /></label>
              <button className="small" disabled={busy || (reason[plan.id] ?? '').trim().length < 3}
                onClick={() => void mutate(`action-hypotheses/${plan.id}/review`,
                  { status: 'approved', reason: reason[plan.id] })}>Aprovar hipótese interna</button>
              <button className="small" disabled={busy || (reason[plan.id] ?? '').trim().length < 3}
                onClick={() => void mutate(`action-hypotheses/${plan.id}/review`,
                  { status: 'rejected', reason: reason[plan.id] })}>Rejeitar</button>
            </div>}
            <details><summary>Histórico de decisões ({plan.history.length})</summary>
              <ul>{plan.history.map((event, index) => <li key={`${event.occurred_at}-${index}`}>
                {date(event.occurred_at)} · {event.action} · {event.from_status ?? 'novo'} → {event.to_status}
                {' · '}{event.actor_user_id ?? 'sistema'} {event.reason && `· ${event.reason}`}
              </li>)}</ul></details>
          </section>)}
      </article>)}</div> : <p className="empty">Nenhum fato elegível. É preciso ter duas capturas v2 confirmadas e comparáveis ou uma coleta pública GitHub concluída. Capturas parciais, homepage editorial, dados sintéticos e reviews sem qualidade medida não geram sinais reais.</p>}
    </>}
  </section>;
}
