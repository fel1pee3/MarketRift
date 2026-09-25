# Conjuntos de avaliação de avaliações

`review-quality.synthetic.v1.json` contém **seis textos criados para testes**: reclamação com dois problemas, cobrança, avaliação positiva, tentativa de instrução no texto, neutra e ambígua. Seus rótulos são sintéticos; uma pontuação perfeita nesse conjunto não mede precisão em clientes reais. `real.template.json` permanece vazio. A amostra privada Steam contém textos reais; o operador informou ter rotulado três casos de Portal 2 para verificar a ferramenta. Isso não mede a qualidade para SaaS B2B.

## Piloto privado com reviews Steam já coletadas

Na raiz do repositório, com `.env` local e PostgreSQL acessível, veja os pares tenant/App ID sem imprimir textos. `DATABASE_ADMIN_URL` é usado **somente neste comando local do operador**; nenhuma rota web recebe essa credencial. Se houver mais de um tenant para o mesmo App ID, acrescente `--tenant-id` ao comando de amostra. O mesmo App ID em dois produtos do mesmo tenant é esperado: a seleção remove duplicatas por `(app_id, recommendationid)`.

```powershell
npm run eval:steam -- sources
npm run eval:steam -- sample --app-id 620 --limit 30 --fetch-missing --max-pages 2
npm run eval:steam -- validate
```

`sample` lê primeiro as reviews já armazenadas, ignora texto vazio ou maior que 10.000 caracteres e, com `--fetch-missing`, consulta no máximo duas páginas de 20 da API JSON oficial do Steam para completar a amostra. **Não chama IA e não grava novos documentos nos tenants.** A amostra fica em `evalsets/private/steam-sample-v1.json`, ignorada pelo Git, e guarda App ID, `recommendationid`, texto original, idioma, datas, voto de recomendação, origem e se veio do banco ou da API. O link é para a seção de reviews do produto, não para uma review individual. Os IDs do avaliador são pseudônimos estáveis; o ID Steam original permanece apenas no arquivo privado. A seleção distribui recomendações positivas/negativas e comprimentos, mas essas faixas **não são rótulos de problema**.

Antes de rotular, uma busca opcional e curta de recomendações negativas pode equilibrar a amostra quando a coleta recente trouxe quase só votos positivos. O filtro usa `review_type=negative` da API oficial, no máximo 20 itens e uma página no exemplo abaixo. Execute-o **antes** do primeiro rótulo; o comando recusa rebalancear um conjunto já rotulado. A amostra atual de App ID 620 já foi equilibrada dessa forma, portanto não precisa repetir a chamada.

```powershell
npm run eval:steam -- sample --app-id 620 --limit 30 --balance-negative --max-pages 1
```

Para começar a **rotulagem humana**, confirme antes que você pode guardar esses textos localmente e enviá-los ao provedor da avaliação. Preencha `--rights-basis` com sua justificativa real; não use a frase de exemplo como declaração automática de permissão. O comando mostra uma review por vez, sem previsão do modelo e sem exibir o voto Steam. `p` marca problema concreto, `n` ausência de problema e `i` evidência insuficiente. Para cada problema, escolha categoria ou `o` para fora da taxonomia, copie um trecho literal contínuo e indique gravidade apenas quando o texto a sustenta (`?` deixa sem nota). Aceita múltiplos problemas. `q` ou Ctrl+C interrompe; cada resposta completa é salva imediatamente e a próxima execução retoma do primeiro item ainda não rotulado. O arquivo de progresso é `evalsets/private/steam-labels-v1.json`; o conjunto produzido no formato do avaliador é `evalsets/private/reviews-v1.json`.

```powershell
npm run eval:steam -- label --labeler human:felipe --rights-basis 'DESCREVA AQUI SUA BASE REAL DE USO E ENVIO' --max-items 3
npm run eval:steam -- validate
```

Na retomada, basta `npm run eval:steam -- label --max-items 3`. O validador confere vínculo com a amostra, hashes dos textos, ausência de duplicatas, coerência das decisões e que todo trecho de evidência ocorre literalmente no texto. Caso queira corrigir um rótulo, use `npm run eval:steam -- label --edit ID_DA_REVIEW`; o ID aparece no terminal durante a rotulagem e no conjunto privado. **Recomendação negativa não vira automaticamente reclamação.** Exemplos sobre história, gameplay e outros assuntos sem categoria B2B adequada podem receber `out_of_taxonomy` com um tema livre; não são forçados para as seis categorias. `insufficient_evidence` é uma decisão válida sem problemas. A gravidade pode ficar vazia quando o texto não a sustenta.

Depois de haver **ao menos três rótulos humanos válidos**, confira o preço atual do modelo escolhido e digite as taxas de entrada/saída em USD por milhão de tokens. O comando abaixo é o primeiro lote operacional; ele **não foi executado nesta entrega**. A API paga só é chamada com `--allow-paid`, provedor/modelo explícitos e orçamento. O arquivo produzido não contém texto, URL nem trechos de reviews.

```powershell
$inputRate = Read-Host 'USD por 1M tokens de entrada (preço atual verificado)'
$outputRate = Read-Host 'USD por 1M tokens de saida (preço atual verificado)'
npm run eval:quality -- --dataset evalsets/private/reviews-v1.json --provider openai --model gpt-5-nano --allow-paid --max-examples 3 --max-output-tokens 1024 --budget-usd 0.05 --input-usd-per-million $inputRate --output-usd-per-million $outputRate --output .tmp/quality-steam-3.json
Get-Content .tmp/quality-steam-3.json
```

Antes de ampliar o lote, confira `run.api_calls_attempted`, `run.stopped`, `run.reported_input_tokens`, `run.reported_output_tokens`, `run.usage_based_estimated_cost_usd` e `metrics`. O terminal também mostra uma tabela por exemplo sem textos. `budget_skipped` indica que a próxima reserva estimada não coube no orçamento; `provider_error` é falha da chamada; `missing_evidence`, `invalid_evidence` e `invalid_format` são saídas não pontuadas. `false_positive_categories` e `false_negative_categories` aparecem por exemplo pontuado. `outside_only_forced_into_taxonomy` conta casos que um humano colocou só fora da taxonomia e o modelo forçou para uma das seis classes. Revise cada erro contra o texto privado e, se necessário, ajuste a taxonomia/prompt em uma nova versão antes de concluir sobre qualidade. Três casos são apenas um teste inicial de funcionamento, sem poder estatístico para afirmar confiabilidade.

## Montar um conjunto real

1. Escolha avaliações que você pode obter, armazenar e enviar ao provedor de IA. Verifique as condições da fonte e a base de uso antes de copiar texto. Preserve a URL e data de publicação quando existirem; não deduza data ou origem ausente. Remova dados pessoais desnecessários e nunca coloque segredos no texto ou na URL.
2. Copie `real.template.json` para `evalsets/private/reviews-v1.json`. Essa pasta é ignorada pelo Git. Se você tiver autorização para redistribuir os textos, pode optar por versionar um conjunto revisado fora de `private/`. Não envie dados reais ao Git sem essa verificação.
3. Adicione cada avaliação completa em `examples`, com `synthetic: false`, `rights_basis` descrevendo a permissão e `labeler: "human:<apelido>"`. Use IDs pseudônimos, estáveis e únicos. Marque `case_type` como `positive`, `neutral`, `complaint` ou `ambiguous`.
4. Uma pessoa lê o texto **antes** de ver a previsão da IA. Em `gold.decision`, use `problem` para reclamação verificável, `no_problem` para texto positivo/neutro sem reclamação ou `insufficient_evidence` quando o texto é ambíguo e não sustenta uma afirmação. Este último exige `case_type: "ambiguous"` e `issues: []`. Se houver problema, registre um item por problema com categoria e um trecho literal contínuo do texto original. No formato v1, gravidade (`low`, `medium`, `high`) é obrigatória; no v2, usado pelo Steam, ela pode ser `null` quando não houver base para graduá-la. Não reescreva o trecho. Uma avaliação pode ter várias categorias e vários problemas da mesma categoria.
5. Resolva divergências entre anotadores com revisão humana antes de consolidar o `gold`; documente o critério adotado e aumente `version` ao alterar textos ou rótulos. O relatório guarda SHA-256 dos bytes do arquivo, modelo e versões do extrator para reprodução.

Estrutura de **preenchimento**, não uma avaliação real nem um arquivo pronto para executar:

```json
{
  "id": "review-001",
  "synthetic": false,
  "case_type": "complaint",
  "text": "COLE AQUI O TEXTO ORIGINAL AUTORIZADO",
  "source": {"name": "NOME DA FONTE", "url": "https://URL-REAL-SE-EXISTIR", "published_at": "AAAA-MM-DD"},
  "labeler": "human:apelido-do-revisor",
  "rights_basis": "DESCREVA A PERMISSAO DE USO E ENVIO AO PROVEDOR",
  "gold": {
    "decision": "problem",
    "issues": [{"category": "support", "severity": "medium", "evidence_quote": "TRECHO LITERAL DO TEXTO ORIGINAL"}]
  }
}
```

Remova `url` ou `published_at` se não existirem. As seis categorias do extrator são `support`, `price`, `billing`, `performance`, `usability` e `features`. O formato de rótulos v2 também aceita `out_of_taxonomy` com `outside_topic`; o extrator atual não produz essa categoria. O validador rejeita rótulos sem trecho literal, IDs duplicados, decisões incompatíveis e mistura de dados reais com sintéticos no mesmo arquivo. Conjuntos separados evitam que exemplos artificiais inflem as métricas reais.

## Executar

Na raiz do projeto, a execução padrão usa apenas o provedor controlado; ela não chama a API paga nem grava dados nos tenants:

```powershell
npm run eval:quality -- --dataset evalsets/review-quality.synthetic.v1.json --max-examples 6 --output .tmp/quality-synthetic.json
```

Para uma execução real pequena, defina as **taxas atuais que você verificou para o modelo escolhido**, em USD por milhão de tokens. Os valores abaixo são lidos de você, não são preços presumidos pelo projeto:

```powershell
$inputRate = Read-Host 'USD por 1M tokens de entrada'
$outputRate = Read-Host 'USD por 1M tokens de saida'
npm run eval:quality -- --dataset evalsets/private/reviews-v1.json --provider openai --model gpt-5-nano --allow-paid --max-examples 3 --max-output-tokens 1024 --budget-usd 0.05 --input-usd-per-million $inputRate --output-usd-per-million $outputRate --output .tmp/quality-real-v1.json
```

`--allow-paid`, modelo, limite de exemplos, orçamento e taxas são obrigatórios para OpenAI. Sem isso, o comando falha **antes** de chamar o provedor. Cada exemplo faz no máximo uma tentativa no avaliador (`max_retries=0`), e a resposta tem limite de tokens. Antes de cada chamada, a reserva estima tokens de entrada a partir dos bytes UTF-8 do prompt, texto e schema, duplica essa contagem, soma 2.048 tokens de margem e acrescenta o limite de saída. Se a próxima reserva ultrapassar o orçamento, os exemplos restantes recebem `budget_skipped`. Essa é uma **proteção operacional estimada**, não um limite de cobrança imposto pelo provedor: diferenças de tokenização, cache, formato da API ou tarifas podem alterar a cobrança real. Confira o consumo no provedor. Nenhum preço fica fixado no código.

O terminal mostra Markdown sem textos, URLs ou trechos das avaliações; `--output` escreve o relatório JSON completo, também sem esses campos. O relatório mostra, por exemplo, rótulo e previsão por ID, falhas, TP/FP/FN/TN para presença de problema e para cada categoria, alinhamento de evidência, gravidade, tokens informados pelo provedor e custo **estimado** pelas taxas fornecidas. Quando o provedor não informa tokens, o custo baseado em uso fica `null`; a reserva prévia continua registrada. Não confunda o custo estimado com fatura.

Uma categoria da taxonomia conta uma vez por exemplo pontuado, mesmo que a avaliação cite dois problemas dessa categoria. Precisão = TP/(TP+FP), recall = TP/(TP+FN) e F1 = 2TP/(2TP+FP+FN); denominador zero aparece como `null`. Falhas de formato, trecho ausente/inventado e falha do provedor ficam **sem pontuação**, não viram automaticamente falso negativo. Para `insufficient_evidence`, nenhuma reclamação prevista é um resultado correto; uma reclamação prevista conta como falso positivo. Um caso rotulado só fora da taxonomia não vira falso negativo de uma das seis classes; se o modelo o força para uma delas, essa previsão conta como falso positivo e também em `outside_only_forced_into_taxonomy`. Trecho literal é condição necessária, mas não prova interpretação correta. `evidence_aligned_with_gold` exige mesma categoria e que uma citação contenha a outra, com pareamento de um para um; a gravidade só é comparada nesses pares quando o humano a informou. Revise manualmente os casos de erro antes de afirmar qualidade.
