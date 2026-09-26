'use client';

import { FormEvent, useEffect, useState } from 'react';

type Product = { id: string; name: string };
type SetInfo = { id: string; title: string; origin: 'public_real' | 'synthetic_test'; status: 'draft' | 'frozen'; version: number; created_at: string };
type Item = { id: string; source_type: 'github_issue' | 'github_discussion'; source_url: string;
  observed_at: string; text_content: string; source_partial: boolean; stale: boolean };
type Question = { id: string; text_content: string; language: 'pt' | 'en'; no_answer_claim: boolean };
type Judgment = { question_id: string; item_id: string; verdict: 'relevant' | 'irrelevant';
  reviewer_id: string; judged_at: string; revision: number };
type Metrics = { recall_at_k: number | null; mrr_at_k: number | null; answerable: number;
  without_answer: number; no_answer_correct: number; errors: { question_id: string; kind: string;
    retrieved_ids?: string[]; expected_ids?: string[] }[] };
type Run = { model: string; model_version: string; elapsed_ms: number; cold_ms?: number; warm_ms?: number;
  metrics: { at_3: { complete: Metrics | null; conditional_judged_only: { answerable_questions: number;
    recall: number | null; unjudged_in_top: unknown[] } }; at_5: { complete: Metrics | null;
    conditional_judged_only: { answerable_questions: number; recall: number | null; unjudged_in_top: unknown[] } } } };
type Report = { id: string; stale: boolean; created_at: string; result: { corpus_size: number;
  question_count: number; fully_judged_questions: number; judged_pairs: number; total_pairs: number;
  source_types: Record<string, number>; languages: Record<string, number>; runs: Record<string, Run>;
  index_version: string; external_cost_usd: number } };
type Detail = { set: SetInfo; items: Item[]; questions: Question[]; judgments: Judgment[];
  coverage: { judged: number; total: number; unjudged: number; fully_judged: boolean }; stale_items: number;
  reports: Report[] };

const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const percent = (value: number | null): string => value === null ? 'sem denominador' : `${(value * 100).toFixed(1)}%`;
const label = (type: string): string => type === 'github_issue' ? 'Issue pública' : 'Discussion pública';

export default function RetrievalReviewPanel({ products, csrfToken, role }:
  { products: Product[]; csrfToken: string; role: string }) {
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [questionId, setQuestionId] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const canReview = role === 'owner' || role === 'admin' || role === 'analyst';

  async function request<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`${base}/v1/retrieval-review/${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message = typeof value === 'object' && value !== null && 'message' in value ? value.message : 'Falha na API';
      throw new Error(Array.isArray(message) ? message.join(', ') : String(message));
    }
    return value as T;
  }
  async function refresh(id = selected): Promise<void> {
    const list = await request<SetInfo[]>('sets');
    setSets(list);
    if (id) {
      const next = await request<Detail>(`sets/${id}`);
      setDetail(next); setSelected(id);
      setQuestionId(current => next.questions.some(q => q.id === current) ? current : next.questions[0]?.id ?? '');
    } else { setDetail(null); }
  }
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); // first load for active company
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const selectedQuestion = detail?.questions.find(q => q.id === questionId);
  const judgments = new Map(detail?.judgments.filter(j => j.question_id === questionId).map(j => [j.item_id, j]));
  const visible = detail?.items.filter(item => !search ||
    `${item.text_content} ${item.source_url} ${item.source_type}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];

  return <section className="card wide">
    <h2>Revisão humana da busca</h2>
    <p>Área separada dos indicadores. Escolha até 30 trechos públicos de GitHub Issues e Discussions já indexados.
      Congele corpus e julgamentos antes de comparar MiniLM, busca literal e controlled-hash-TESTE.
      Nenhuma posição, pontuação ou resposta do modelo aparece durante a rotulagem.</p>
    <p>Roteiro: crie o conjunto, escreva uma pergunta em português ou inglês, julgue cada trecho após abrir a origem,
      marque sem resposta quando cabível, congele e execute a avaliação local. Trechos não julgados exigem confirmação
      e deixam o resultado apenas condicional.</p>
    {canReview && <form onSubmit={event => void run(async () => {
      event.preventDefault(); const f = new FormData(event.currentTarget);
      const created = await request<{ id: string; items: number }>('sets', {
        title: f.get('title'), product_id: f.get('product_id') || undefined,
        from: f.get('from') || undefined, to: f.get('to') || undefined, limit: Number(f.get('limit')),
      });
      await refresh(created.id); setMessage(`${created.items} trechos selecionados. Verifique a cobertura parcial.`);
    })}>
      <h3>Novo conjunto público</h3>
      <label>Título<input name="title" minLength={3} maxLength={120} required /></label>
      <label>Produto<select name="product_id"><option value="">Todos da empresa</option>
        {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <label>De<input type="date" name="from" /></label><label>Até<input type="date" name="to" /></label>
      <label>Máximo de trechos<input type="number" name="limit" min={1} max={30} defaultValue={20} /></label>
      <button disabled={busy}>Criar corpus</button>
    </form>}
    <label>Conjunto<select value={selected} onChange={event => void run(async () => {
      setSearch(''); await refresh(event.target.value);
    })}><option value="">Selecione</option>
      {sets.map(set => <option key={set.id} value={set.id}>{set.title} · v{set.version} · {set.origin === 'synthetic_test' ? 'TESTE' : 'público real'} · {set.status}</option>)}</select></label>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {detail && <>
      <p>{detail.items.length} trechos no corpus · {detail.items.filter(i => i.source_partial).length} de fontes com
        cursor/cobertura parcial · {detail.stale_items} alterados/removidos desde a captura.
        {detail.stale_items > 0 && ' Relatórios antigos se referem à versão congelada; não interprete como estado atual.'}
        {' '}Julgamentos: {detail.coverage.judged}/{detail.coverage.total}.</p>
      {canReview && detail.set.status === 'draft' && <form onSubmit={event => void run(async () => {
        event.preventDefault(); const f = new FormData(event.currentTarget);
        const question = await request<Question>(`sets/${selected}/questions`,
          { text: f.get('text'), language: f.get('language') });
        await refresh(); setQuestionId(question.id);
      })}>
        <h3>Adicionar pergunta</h3>
        <label>Pergunta<input name="text" required minLength={3} maxLength={500} /></label>
        <label>Idioma<select name="language"><option value="pt">Português</option><option value="en">English</option></select></label>
        <button disabled={busy}>Adicionar</button>
      </form>}
      {detail.questions.length > 0 && <label>Pergunta para julgar<select value={questionId}
        onChange={event => setQuestionId(event.target.value)}>
        {detail.questions.map(q => <option key={q.id} value={q.id}>{q.text_content} ({q.language})</option>)}</select></label>}
      {selectedQuestion && <>
        <p>Sem resposta no corpus: <strong>{selectedQuestion.no_answer_claim ? 'marcada pelo revisor' : 'não marcada'}</strong>.
          Uma opinião negativa ou uma palavra parecida não torna um trecho relevante.</p>
        {canReview && detail.set.status === 'draft' && <button disabled={busy}
          onClick={() => void run(async () => {
            await request(`sets/${selected}/questions/${questionId}/no-answer`,
              { no_answer: !selectedQuestion.no_answer_claim }); await refresh();
          })}>{selectedQuestion.no_answer_claim ? 'Desmarcar sem resposta' : 'Marcar sem resposta no corpus'}</button>}
        <label>Pesquisar somente neste corpus<input value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Termo no texto ou URL" /></label>
        <p>Ordem fixa do corpus; não é ranking do MiniLM. {visible.length} trechos visíveis.</p>
        {visible.map(item => <article key={item.id}>
          <p><strong>{label(item.source_type)}</strong> · {new Date(item.observed_at).toLocaleDateString('pt-BR')}
            {item.source_partial && ' · cobertura parcial da fonte'}{item.stale && ' · origem mudou ou foi removida'}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.text_content}</p>
          <a href={item.source_url} target="_blank" rel="noreferrer">Abrir origem pública ↗</a>
          <p>Julgamento: <strong>{judgments.get(item.id)?.verdict ?? 'não julgada'}</strong>
            {judgments.get(item.id) && ` · revisão ${judgments.get(item.id)!.revision} · ${new Date(judgments.get(item.id)!.judged_at).toLocaleString('pt-BR')} · revisor ${judgments.get(item.id)!.reviewer_id}`}</p>
          {canReview && detail.set.status === 'draft' && <p>
            {(['relevant', 'irrelevant'] as const).map(verdict => <button key={verdict} disabled={busy}
              onClick={() => void run(async () => {
                await request(`sets/${selected}/questions/${questionId}/judgments`, { item_id: item.id, verdict });
                await refresh();
              })}>{verdict === 'relevant' ? 'Relevante' : 'Irrelevante'}</button>)}
          </p>}
        </article>)}
      </>}
      {canReview && detail.set.status === 'draft' && <form onSubmit={event => void run(async () => {
        event.preventDefault(); const f = new FormData(event.currentTarget);
        await request(`sets/${selected}/freeze`, { acknowledge_unjudged: f.get('ack') === 'on' });
        await refresh(); setMessage('Corpus e julgamentos congelados nesta versão.');
      })}>
        <label><input type="checkbox" name="ack" /> Confirmo que revisei os {detail.coverage.unjudged}
          pares não julgados; métricas incompletas serão condicionais</label>
        <button disabled={busy || !detail.questions.length}>Congelar versão</button>
      </form>}
      {detail.set.status === 'frozen' && canReview && <p>
        <button disabled={busy} onClick={() => void run(async () => {
          await request(`sets/${selected}/evaluate`, {}); await refresh();
          setMessage('Relatório local salvo. Confira cobertura e tipos de fonte.');
        })}>Avaliar MiniLM, literal e controlled (USD 0)</button>
        <button disabled={busy} onClick={() => void run(async () => {
          const copy = await request<{ id: string }>(`sets/${selected}/fork`, {});
          await refresh(copy.id); setMessage('Nova versão em rascunho; pode continuar a rotulagem.');
        })}>Criar versão para continuar</button>
      </p>}
      {detail.reports.map(report => <article key={report.id}>
        <h3>Relatório · {new Date(report.created_at).toLocaleString('pt-BR')}</h3>
        {report.stale && <p><strong>Histórico: origem ou versão mudou; este relatório não descreve o estado atual.</strong></p>}
        <p>{report.result.corpus_size} trechos; {report.result.question_count} perguntas;
          {report.result.fully_judged_questions} inteiramente julgadas;
          {report.result.judged_pairs}/{report.result.total_pairs} pares julgados;
          tipos {JSON.stringify(report.result.source_types)}; idiomas {JSON.stringify(report.result.languages)};
          custo externo USD {report.result.external_cost_usd}.</p>
        <p>Versão do índice: {report.result.index_version}. Modelo controlado é somente referência de TESTE;
          este corpus de Issues/Discussions não mede reviews B2B.</p>
        {Object.entries(report.result.runs).map(([mode, run]) => <div key={mode}>
          <h4>{mode === 'controlled' ? 'controlled-hash-TESTE' : mode} · {run.model} ({run.model_version})</h4>
          <p>Tempo de ranking {run.elapsed_ms} ms{run.cold_ms !== undefined &&
            ` · carga/primeiro vetor ${run.cold_ms} ms · vetor quente ${run.warm_ms} ms`}.
            Perguntas inteiramente julgadas: Recall@3
            {' '}{percent(run.metrics.at_3.complete?.recall_at_k ?? null)}, Recall@5
            {' '}{percent(run.metrics.at_5.complete?.recall_at_k ?? null)}, MRR@5
            {' '}{percent(run.metrics.at_5.complete?.mrr_at_k ?? null)}.
            Sem resposta correta {run.metrics.at_5.complete?.no_answer_correct ?? 0}/
            {run.metrics.at_5.complete?.without_answer ?? 0}.</p>
          <p>Julgamento parcial (condicional, itens não julgados desconhecidos): Recall@3
            {' '}{percent(run.metrics.at_3.conditional_judged_only.recall)}, top-3 não julgados
            {' '}{run.metrics.at_3.conditional_judged_only.unjudged_in_top.length}.</p>
          {(run.metrics.at_5.complete?.errors ?? []).slice(0, 5).map((entry, n) =>
            <div key={n}><p>Erro {entry.kind} · pergunta {entry.question_id}</p>
              {(entry.retrieved_ids ?? entry.expected_ids ?? []).map(itemId => {
                const item = detail.items.find(candidate => candidate.id === itemId);
                return <p key={itemId}>Item {itemId}{item && <> · {label(item.source_type)}:
                  {' '}{item.text_content.slice(0, 180)}… {' '}
                  <a href={item.source_url} target="_blank" rel="noreferrer">Abrir origem ↗</a></>}</p>;
              })}</div>)}
        </div>)}
      </article>)}
    </>}
  </section>;
}
