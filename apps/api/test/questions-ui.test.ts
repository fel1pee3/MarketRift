import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuestionsPanel from '../../web/src/app/QuestionsPanel';

test('question panel renders source/product filters and an explicit synthetic test opt-in', () => {
  const html = renderToStaticMarkup(createElement(QuestionsPanel, {
    products: [{ id: 'product-id', name: 'Produto de teste' }],
    sources: [{ id: 'source-id', product_id: 'product-id', source_type: 'b2b_csv_review',
      url: 'https://example.invalid/reviews' }], csrfToken: 'test-only', role: 'owner',
  }));
  assert.match(html, /Perguntas sobre evidências/);
  assert.match(html, /Produto de teste/);
  assert.match(html, /Incluir dados sintéticos só para TESTE/);
  assert.match(html, /Indexar\/continuar fonte \(até 16 trechos\)/);
  assert.match(html, /Discussion pública/);
});
