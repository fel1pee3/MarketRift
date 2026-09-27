import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageNoteForSignal } from '../src/action-hypotheses';

test('a hypothesis keeps public activity and partial coverage distinct from customer reviews', () => {
  const partial = coverageNoteForSignal('github_discussions', 'partial_cursor');
  assert.match(partial, /atividade pública/);
  assert.match(partial, /não foram identificados como clientes/);
  assert.match(partial, /parcial por cursor/);
  assert.match(partial, /não representam todo o histórico/);
  assert.match(coverageNoteForSignal('github_issues', 'complete_for_latest_scan'), /documentos distintos/);
  assert.match(coverageNoteForSignal('pricing_page', null), /capturas confirmadas e comparáveis/);
  assert.match(coverageNoteForSignal('release_notes', null), /não comprova adoção/);
});
