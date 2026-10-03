# ADR 0035 — Separação da experiência normal e dados de teste

Data: 2026-10-03. Estado: implementada.

## Contexto

Produtos, fontes e descobertas antigos não tinham classificação confiável de uso interno. Os documentos já distinguiam `synthetic`, ambientes sandbox e alguns direitos, mas a navegação principal consultava listas completas. Nome de produto, domínio público e presença de uma captura não comprovam, isoladamente, autenticidade nem associação correta.

## Decisão

- A migração 035 acrescenta `usage_classification` a produto e fonte, com valores `unreviewed`, `real` e `test`. O padrão dos dados antigos é `unreviewed`; fontes novas explicitamente sandbox ou com URL fictícia começam como `test`. Owner/admin podem corrigir a classificação por API e pela Administração avançada. A mudança não apaga dados.
- Execuções e candidatas de descoberta novas registram `test_data`; as antigas permanecem com valor desconhecido e não alimentam os totais normais. Uma execução controlada do worker propaga a marca ao candidato.
- `/`, `/concorrentes` e `/investigar` usam uma API de experiência separada e o escopo `normal` da busca de evidências. O banco filtra produto e fonte classificados como `real`, documento não sintético, ambiente não sandbox e direitos de armazenamento aplicáveis. CSV legado e dados G2 não autorizados permanecem na área avançada. A API calcula sinais apenas quando `test_data=false` e a fonte/produto são revisados.
- O filtro é aplicado antes da deduplicação por origem. Uma associação a produto de teste não pode contaminar o conjunto normal. A mesma origem em dois produtos legítimos conserva aviso de associação múltipla; contagens por tipo são de evidências distintas, não participação de mercado.
- A identidade oficial confirmada e uma candidata revisada podem apoiar o vínculo de uma fonte ao concorrente. Sem isso, a interface assinala associação ainda não confirmada. A classificação do produto não converte automaticamente uma fonte em real, e a classificação de fonte não valida textos ou direitos. Fontes sandbox e endereços fictícios não podem ser classificados como reais. O CSV legado não tem comprovação de direitos e fica apenas nas ferramentas avançadas.

## Limites

Fontes antigas precisam de revisão humana. Capturas históricas sem proveniência de ambiente própria dependem da classificação da fonte; uma classificação equivocada pelo operador pode expô-las no escopo normal. A Administração avançada preserva consultas completas para operação e testes, sob sessão, RBAC e RLS. A área normal de investigação usa busca de evidências; perguntas semânticas e ferramentas de avaliação continuam na Administração avançada até terem um escopo normal equivalente.

## Verificação

`npm run db:migrate:experience-classification` aplica 035 incrementalmente uma vez. O teste direcionado `node --env-file=../../.env --import tsx --test test/experience-db.test.ts` em `apps/api` usa duas empresas e fixtures em transação revertida: produto de teste, fonte de teste, review sintética e Issue pública. Também confere mudança e reversão de classificação, consulta avançada e RLS. Lint/build da API e web são as verificações de compilação desta entrega.
