'use client';

import { useEffect, useRef, useState } from 'react';

type Product = { id: string; name: string };
type Source = { id: string; product_id: string; url: string; source_type: string; access_environment: string | null };
type SetInfo = { id: string; title: string; origin: 'real' | 'synthetic_test'; status: 'draft' | 'frozen' | 'purged';
  version: number; corpus_hash: string | null; created_at: string };
type Issue = { category: string; severity: 'low' | 'medium' | 'high' | null;
  start: number; end: number; outside_topic?: string };
type Item = { id: string; document_id: string; source_id: string; eligible: boolean; stale_reason: string | null;
  body: string | null; source_url: string | null; published_at: string | null; content_hash: string;
  external_ai_eligible: boolean };
type Label = { item_id: string; decision: 'problem' | 'no_problem' | 'insufficient_evidence';
  issues: Issue[]; reviewer_id: string; revision: number; judged_at: string };
type Score = { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null };
type QualityReport = { dataset: { selected_real: number; selected_synthetic: number }; run: {
  model: string; provider: string; prompt_version: string; taxonomy_version: string;
  budget_usd: number | null; usage_based_estimated_cost_usd: number | null; scored: number };
  metrics: { scored_real_examples: number; scored_synthetic_examples: number; provider_failures: number;
    format_failures: number; invalid_evidence_quotes: number; missing_evidence_responses: number;
    evidence_aligned_with_gold: number; literal_evidence_issues: number;
    severity_correct_on_aligned: number; severity_scored_on_aligned: number;
    problem_presence: Score; categories: Record<string, Score> };
  examples: { id: string; status: string; false_positive_categories?: string[];
    false_negative_categories?: string[]; error_code?: string }[] };
type Report = { id: string; status: string; provider: string; model: string;
  result: QualityReport | null; stale: boolean; error_code: string | null; created_at: string };
type Detail = { set: SetInfo; items: Item[]; labels: Label[]; reports: Report[] };

const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const categories = [
  ['support', 'Suporte'], ['price', 'Preço'], ['billing', 'Cobrança'],
  ['performance', 'Desempenho'], ['usability', 'Usabilidade'], ['features', 'Funcionalidades'],
  ['out_of_taxonomy', 'Fora da taxonomia'],
] as const;
const percent = (value: number | null): string => value === null ? 'sem denominador' : `${(value * 100).toFixed(1)}%`;
const evaluatorFailures: Record<string, string> = {
  evaluator_unreachable: 'FastAPI não estava acessível. Inicie npm run dev:intelligence-http e tente novamente.',
  internal_auth_failed: 'Token interno da API e do FastAPI não coincide; reinicie os dois serviços.',
  evaluator_endpoint_missing: 'FastAPI está desatualizado; reinicie npm run dev:intelligence-http.',
  invalid_quality_contract: 'API e FastAPI discordam do contrato; reinicie as duas versões atualizadas.',
  evaluator_not_ready: 'FastAPI ainda não está pronto; aguarde a inicialização e tente novamente.',
  evaluator_timeout: 'O avaliador local excedeu o tempo limite.',
  invalid_evaluator_response: 'FastAPI retornou uma resposta inválida.',
  report_contract_mismatch: 'O relatório não corresponde ao conjunto congelado.',
  evaluation_unavailable: 'A falha anterior não registrou a causa específica; tente novamente com os serviços atualizados.',
};

export default function B2BQualityPanel({ products, sources, role, csrfToken }:
  { products: Product[]; sources: Source[]; role: string; csrfToken: string }) {
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [summary, setSummary] = useState<{ real_reviews: number; real_human_labels: number } | null>(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [index, setIndex] = useState(0);
  const [decision, setDecision] = useState<Label['decision']>('no_problem');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [category, setCategory] = useState('features');
  const [severity, setSeverity] = useState<Issue['severity']>('medium');
  const [outsideTopic, setOutsideTopic] = useState('');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const canCreate = role === 'owner' || role === 'admin';
  const canLabel = canCreate || role === 'analyst';
  const item = detail?.items[index];
  const label = detail?.labels.find(value => value.item_id === item?.id);
  const judged = detail?.labels.length ?? 0;
  const controlledReport = detail?.reports.find(report => report.provider === 'test');

  async function request<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`${base}/v1/b2b-quality/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = value && typeof value === 'object' && 'message' in value ? value.message : `HTTP ${response.status}`;
      throw new Error(Array.isArray(reason) ? reason.join(', ') : String(reason));
    }
    return value as T;
  }
  async function refresh(id = selected): Promise<void> {
    const current = ++sequence.current;
    const [list, counts] = await Promise.all([request<SetInfo[]>('sets'),
      request<{ real_reviews: number; real_human_labels: number }>('summary')]);
    if (current !== sequence.current) return;
    setSets(list); setSummary(counts);
    if (!id) { setSelected(''); setDetail(null); return; }
    const value = await request<Detail>(`sets/${id}`);
    if (current !== sequence.current) return;
    if (value.set.id !== id) throw new Error('A API retornou outro conjunto');
    setSelected(id); setDetail(value); setIndex(previous => Math.min(previous, value.items.length - 1));
  }
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); // active tenant mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setDecision(label?.decision ?? 'no_problem'); setIssues(label?.issues ?? []); setRange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, index, label?.revision]);
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (selected) await refresh(selected).catch(() => undefined);
    }
    finally { setBusy(false); }
  }
  function selectedRange(): void {
    const field = textRef.current;
    if (field && field.selectionEnd > field.selectionStart)
      setRange({ start: field.selectionStart, end: field.selectionEnd });
  }
  const hasRealReport = detail?.reports.some(report => !report.stale && report.status === 'completed'
    && (report.result?.metrics.scored_real_examples ?? 0) > 0) ?? false;

  return <section className="card wide">
    <h2>Qualidade da extração B2B</h2>
    <p>Área de julgamento humano, separada dos indicadores executivos. Você vê o texto e a origem de uma review por vez.
      As previsões da IA ficam ocultas até congelar os rótulos. Nenhuma ação nesta página coleta reviews.</p>
    <p><strong>Reviews B2B reais com armazenamento declarado vigente:</strong> {summary?.real_reviews ?? 'carregando'} ·
      <strong> julgamentos humanos reais registrados:</strong> {summary?.real_human_labels ?? 'carregando'}.
      {hasRealReport ? ' Relatórios reais são exploratórios até haver uma amostra humana suficiente e representativa.'
        : ' Qualidade real ainda não medida.'}</p>
    <p>A declaração de direitos é registrada pelo operador; esta tela não verifica juridicamente a licença da fonte.
      G2 e outras origens não entram neste conjunto.</p>
    {canCreate && <form onSubmit={event => void run(async () => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      const created = await request<{ id: string; items: number }>('sets', {
        title: values.get('title'), origin: values.get('origin'),
        product_id: values.get('product_id') || undefined, source_id: values.get('source_id') || undefined,
        from: values.get('from') || undefined, to: values.get('to') || undefined,
        limit: Number(values.get('limit')),
      });
      setIndex(0); await refresh(created.id); setMessage(`${created.items} review(s) selecionada(s).`);
    })}>
      <h3>Criar conjunto pequeno</h3>
      <label>Nome do conjunto<input name="title" required minLength={3} maxLength={120} /></label>
      <label>Ambiente<select name="origin" defaultValue="synthetic_test">
        <option value="synthetic_test">TESTE / SINTÉTICO</option><option value="real">REAL com direitos declarados</option>
      </select></label>
      <label>Produto<select name="product_id"><option value="">Todos da empresa</option>
        {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <label>Fonte B2B<select name="source_id"><option value="">Todas as fontes B2B elegíveis</option>
        {sources.filter(source => source.source_type === 'b2b_csv_review').map(source =>
          <option key={source.id} value={source.id}>{source.url} ({source.access_environment})</option>)}</select></label>
      <label>De (data da review)<input type="date" name="from" /></label>
      <label>Até (data da review)<input type="date" name="to" /></label>
      <label>Máximo de reviews<input name="limit" type="number" min={1} max={25} defaultValue={5} /></label>
      <button disabled={busy}>Criar conjunto</button>
    </form>}
    <label>Conjunto<select value={selected} onChange={event => void run(async () => {
      setIndex(0); await refresh(event.target.value);
    })}><option value="">Selecione</option>{sets.map(set => <option key={set.id} value={set.id}>
      {set.title} · v{set.version} · {set.origin === 'real' ? 'REAL' : 'TESTE'} · {set.status}</option>)}</select></label>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {detail && <>
      {detail.set.status === 'purged' && <p className="evidence-warning">Os textos e relatórios deste conjunto foram
        apagados pela política de direitos da fonte. O registro mínimo da versão permanece para auditoria.</p>}
      <p><strong>{detail.set.origin === 'real' ? 'REAL com direitos declarados' : 'TESTE / SINTÉTICO'}</strong> ·
        versão {detail.set.version} · {detail.set.status} · {judged}/{detail.items.length} julgadas ·
        {detail.items.filter(i => !i.eligible).length} inelegíveis.
        {detail.items.some(i => !i.eligible) && ' A versão antiga é histórica; crie outra após corrigir a fonte.'}</p>
      {item && <article className="quality-review">
        <div className="evidence-pages"><button type="button" className="small" disabled={index === 0}
          onClick={() => setIndex(index - 1)}>Anterior</button><span>Review {index + 1} de {detail.items.length}</span>
          <button type="button" className="small" disabled={index + 1 >= detail.items.length}
            onClick={() => setIndex(index + 1)}>Próxima</button></div>
        <p>ID {item.document_id} · versão {item.content_hash.slice(0,12)} ·
          {label ? ` julgada por ${label.reviewer_id} em ${new Date(label.judged_at).toLocaleString('pt-BR')} (revisão ${label.revision})` : ' ainda não julgada'}.</p>
        {!item.eligible ? <p className="evidence-warning">Review inelegível: {item.stale_reason}. Texto e trechos não são exibidos.</p> : <>
          <p>Origem: {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer">Abrir URL declarada ↗</a>}
            {item.published_at && ` · ${new Date(item.published_at).toLocaleString('pt-BR')}`}</p>
          <label>Texto original (selecione com o mouse um trecho literal)<textarea ref={textRef} readOnly
            value={item.body ?? ''} onSelect={selectedRange} rows={6} /></label>
          {canLabel && detail.set.status === 'draft' && <div>
            <fieldset><legend>Julgamento desta review</legend>
              {([['problem','Há problema concreto'],['no_problem','Não há problema concreto'],
                ['insufficient_evidence','Evidência insuficiente']] as const).map(([value,title]) =>
                <label key={value}><input type="radio" name={`decision-${item.id}`} checked={decision === value}
                  onChange={() => { setDecision(value); if (value !== 'problem') setIssues([]); }} />{title}</label>)}</fieldset>
            {decision === 'problem' && <>
              <p>Selecione um trecho no campo acima. Cada problema precisa de categoria, gravidade sustentada pelo texto
                (ou “não determinada”) e um trecho literal de 3 a 500 caracteres.</p>
              <label>Categoria<select value={category} onChange={event => setCategory(event.target.value)}>
                {categories.map(([value,title]) => <option key={value} value={value}>{title}</option>)}</select></label>
              <label>Gravidade<select value={severity ?? ''} onChange={event => setSeverity(
                (event.target.value || null) as Issue['severity'])}>
                <option value="">Não determinada</option><option value="low">Baixa</option>
                <option value="medium">Média</option><option value="high">Alta</option></select></label>
              {category === 'out_of_taxonomy' && <label>Tema fora da taxonomia<input value={outsideTopic}
                onChange={event => setOutsideTopic(event.target.value)} /></label>}
              {range && <p>Trecho selecionado: “{item.body?.slice(range.start,range.end)}”</p>}
              <button type="button" className="small" disabled={!range || busy} onClick={() => {
                if (!range) return;
                setIssues([...issues, { category, severity, ...range,
                  ...(category === 'out_of_taxonomy' && outsideTopic.trim() ? { outside_topic: outsideTopic.trim() } : {}) }]);
                setRange(null);
              }}>Adicionar problema com trecho selecionado</button>
              <ul>{issues.map((issue,position) => <li key={`${issue.category}-${issue.start}-${position}`}>
                {issue.category} · {issue.severity ?? 'gravidade não determinada'} ·
                “{item.body?.slice(issue.start,issue.end)}” <button className="small" type="button"
                  onClick={() => setIssues(issues.filter((_,i) => i !== position))}>Remover</button></li>)}</ul>
            </>}
            <button disabled={busy} onClick={() => void run(async () => {
              await request(`sets/${selected}/labels`, { item_id: item.id, decision,
                issues: decision === 'problem' ? issues : [] });
              await refresh(selected); setMessage('Julgamento salvo. Você pode continuar ou corrigir antes de congelar.');
            })}>Salvar julgamento desta review</button>
          </div>}
        </>}</article>}
      {canCreate && detail.set.status === 'draft' && <button disabled={busy || judged !== detail.items.length ||
        detail.items.some(i => !i.eligible)} onClick={() => void run(async () => {
        await request(`sets/${selected}/freeze`, {}); await refresh(selected);
        setMessage('Versão congelada. As previsões podem ser avaliadas agora.');
      })}>Congelar textos e julgamentos</button>}
      {canCreate && detail.set.status === 'frozen' && <button disabled={busy} onClick={() => void run(async () => {
        const copied = await request<{ id: string }>(`sets/${selected}/copy`, {});
        setIndex(0); await refresh(copied.id); setMessage('Nova versão criada; julgamentos de reviews alteradas precisam ser refeitos.');
      })}>Criar nova versão para corrigir</button>}
      {canCreate && detail.set.status === 'frozen' && detail.set.origin === 'synthetic_test' &&
        <button disabled={busy || detail.items.some(i => !i.eligible) ||
          (controlledReport !== undefined && controlledReport.status !== 'failed')}
          onClick={() => void run(async () => { await request(`sets/${selected}/evaluate-test`, {});
            await refresh(selected); setMessage('Avaliação controlada de TESTE concluída. USD 0 em API.'); })}>
          {controlledReport?.status === 'failed' ? 'Repetir avaliação controlada (mesma versão, USD 0)'
            : 'Avaliar com provedor controlado (TESTE, USD 0)'}</button>}
      {canCreate && detail.set.status === 'frozen' && detail.set.origin === 'real' &&
        <PaidEvaluation disabled={busy || detail.items.some(i => !i.external_ai_eligible)} items={detail.items}
          onRun={body => run(async () => { await request(`sets/${selected}/evaluate-paid`, body);
            await refresh(selected); setMessage('Avaliação paga concluída; confira o relatório e a cobrança do provedor.'); })} />}
      <h3>Relatórios da versão</h3>
      {!detail.reports.length && <p>Nenhum relatório. Rótulos congelados não são previsões da IA.</p>}
      {detail.reports.map(report => <div className="quality-report" key={report.id}>
        <h4>{report.provider === 'test' ? 'TESTE controlado, não IA' : `OpenAI · ${report.model}`} · {report.status}</h4>
        {report.stale && <p className="evidence-warning">Histórico: uma review mudou, foi removida ou perdeu direitos.
          Este relatório não descreve a versão atual.</p>}
        {report.error_code && <p>Falha: {evaluatorFailures[report.error_code] ?? report.error_code}.
          {report.provider === 'test' ? ' Você pode repetir nesta mesma versão, sem alterar os julgamentos.'
            : ' A operação paga não é repetida automaticamente.'}</p>}
        {report.result && <>
          <p>{report.result.metrics.scored_real_examples} reviews reais avaliadas ·
            {report.result.metrics.scored_synthetic_examples} sintéticas avaliadas ·
            modelo {report.result.run.model} · prompt {report.result.run.prompt_version} ·
            taxonomia {report.result.run.taxonomy_version} ·
            custo estimado USD {report.result.run.usage_based_estimated_cost_usd ?? 'indisponível'}.</p>
          {report.result.metrics.scored_real_examples === 0 && <p>Qualidade real ainda não medida; números de TESTE não
            estimam desempenho em clientes B2B.</p>}
          {report.result.metrics.scored_real_examples > 0 && <p>Resultado exploratório em amostra real rotulada.
            Confira denominadores e cobertura por categoria; uma amostra pequena não comprova confiabilidade.</p>}
          <p>Falhas: provedor {report.result.metrics.provider_failures}, formato {report.result.metrics.format_failures},
            evidência inventada {report.result.metrics.invalid_evidence_quotes}, evidência ausente
            {report.result.metrics.missing_evidence_responses}. Trechos alinhados ao rótulo humano:
            {report.result.metrics.evidence_aligned_with_gold}/{report.result.metrics.literal_evidence_issues}.
            Gravidade correta em problemas alinhados:
            {report.result.metrics.severity_correct_on_aligned}/{report.result.metrics.severity_scored_on_aligned}.</p>
          <p>Problema na taxonomia: precisão {percent(report.result.metrics.problem_presence.precision)},
            recall {percent(report.result.metrics.problem_presence.recall)};
            TP {report.result.metrics.problem_presence.tp}, FP {report.result.metrics.problem_presence.fp},
            FN {report.result.metrics.problem_presence.fn}.</p>
          <div className="quality-metrics">{Object.entries(report.result.metrics.categories).map(([name,score]) =>
            <p key={name}><strong>{name}</strong>: TP {score.tp}, FP {score.fp}, FN {score.fn}, TN {score.tn};
              precisão {percent(score.precision)}, recall {percent(score.recall)}</p>)}</div>
          <h5>Exemplos a revisar (sem texto no relatório)</h5><ul>{report.result.examples.map(example =>
            <li key={example.id}>{example.id}: {example.status}; FP {example.false_positive_categories?.join(', ') || '0'};
              FN {example.false_negative_categories?.join(', ') || '0'}; {example.error_code ?? 'sem falha técnica'}</li>)}</ul>
        </>}
      </div>)}
    </>}
  </section>;
}

function PaidEvaluation({ disabled, items, onRun }: { disabled: boolean; items: Item[];
  onRun: (body: Record<string, unknown>) => void }) {
  const [model, setModel] = useState('gpt-5-nano');
  const [max, setMax] = useState(1);
  const [output, setOutput] = useState(256);
  const [budget, setBudget] = useState(0.05);
  const [inputRate, setInputRate] = useState('');
  const [outputRate, setOutputRate] = useState('');
  const [confirm, setConfirm] = useState(false);
  const estimate = items.slice(0,max).reduce((sum,item) => sum + 16000 +
    2 * new TextEncoder().encode(item.body ?? '').length, 0) * Number(inputRate) / 1_000_000
    + max * output * Number(outputRate) / 1_000_000;
  return <form onSubmit={event => { event.preventDefault(); onRun({ provider: 'openai', model,
    max_examples: max, max_output_tokens: output, budget_usd: budget,
    input_usd_per_million: Number(inputRate), output_usd_per_million: Number(outputRate),
    confirmation: 'AUTORIZO AVALIACAO PAGA' }); }}>
    <h3>Avaliação paga, operação separada</h3>
    <p>Somente reviews REAIS com direito vigente de envio à OpenAI. A API e o avaliador conferem os direitos novamente.
      Uma tentativa é reservada por versão/modelo para evitar cobrança duplicada em retries. Confira as taxas oficiais
      atuais antes de preencher; esta tela não busca preços automaticamente.</p>
    <label>Modelo autorizado<input value={model} onChange={event => setModel(event.target.value)} required /></label>
    <label>Máximo de exemplos<input type="number" min={1} max={3} value={max} onChange={event => setMax(Number(event.target.value))} /></label>
    <label>Máximo de tokens de saída por exemplo<input type="number" min={128} max={512} value={output}
      onChange={event => setOutput(Number(event.target.value))} /></label>
    <label>Taxa de entrada USD por milhão de tokens<input type="number" step="any" min="0.000001" value={inputRate}
      onChange={event => setInputRate(event.target.value)} required /></label>
    <label>Taxa de saída USD por milhão de tokens<input type="number" step="any" min="0.000001" value={outputRate}
      onChange={event => setOutputRate(event.target.value)} required /></label>
    <label>Orçamento máximo USD<input type="number" step="0.0001" min="0.0001" max="0.05" value={budget}
      onChange={event => setBudget(Number(event.target.value))} /></label>
    <p>Reserva conservadora estimada: USD {Number.isFinite(estimate) ? estimate.toFixed(5) : 'indisponível'}.
      O servidor repete o bloqueio por orçamento; a cobrança efetiva deve ser conferida no provedor.</p>
    <label><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />
      Confirmo direito vigente de envio externo, modelo, limites e possível cobrança desta operação.</label>
    <button disabled={disabled || !confirm || !inputRate || !outputRate || estimate > budget}>Autorizar esta avaliação paga</button>
  </form>;
}
