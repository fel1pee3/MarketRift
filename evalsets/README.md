# Conjuntos de avaliação de avaliações

`review-quality.synthetic.v1.json` contém **seis textos criados para testes**: reclamação com dois problemas, cobrança, avaliação positiva, tentativa de instrução no texto, neutra e ambígua. Seus rótulos são sintéticos; uma pontuação perfeita nesse conjunto não mede precisão em clientes reais. `real.template.json` é um conjunto vazio: nenhum texto real ou rótulo humano foi inventado para este repositório.

## Montar um conjunto real

1. Escolha avaliações que você pode obter, armazenar e enviar ao provedor de IA. Verifique as condições da fonte e a base de uso antes de copiar texto. Preserve a URL e data de publicação quando existirem; não deduza data ou origem ausente. Remova dados pessoais desnecessários e nunca coloque segredos no texto ou na URL.
2. Copie `real.template.json` para `evalsets/private/reviews-v1.json`. Essa pasta é ignorada pelo Git. Se você tiver autorização para redistribuir os textos, pode optar por versionar um conjunto revisado fora de `private/`. Não envie dados reais ao Git sem essa verificação.
3. Adicione cada avaliação completa em `examples`, com `synthetic: false`, `rights_basis` descrevendo a permissão e `labeler: "human:<apelido>"`. Use IDs pseudônimos, estáveis e únicos. Marque `case_type` como `positive`, `neutral`, `complaint` ou `ambiguous`.
4. Uma pessoa lê o texto **antes** de ver a previsão da IA. Em `gold.decision`, use `problem` para reclamação verificável, `no_problem` para texto positivo/neutro sem reclamação ou `insufficient_evidence` quando o texto é ambíguo e não sustenta uma afirmação. Este último exige `case_type: "ambiguous"` e `issues: []`. Se houver problema, registre um item por problema com categoria, gravidade (`low`, `medium`, `high`) e um trecho literal contínuo do texto original. Não reescreva o trecho. Uma avaliação pode ter várias categorias e vários problemas da mesma categoria.
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

Remova `url` ou `published_at` se não existirem. As categorias v1 são `support`, `price`, `billing`, `performance`, `usability` e `features`. O validador rejeita rótulos sem trecho literal, IDs duplicados, decisões incompatíveis e mistura de dados reais com sintéticos no mesmo arquivo. Conjuntos separados evitam que exemplos artificiais inflem as métricas reais.

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

Uma categoria conta uma vez por exemplo pontuado, mesmo que a avaliação cite dois problemas dessa categoria. Precisão = TP/(TP+FP), recall = TP/(TP+FN) e F1 = 2TP/(2TP+FP+FN); denominador zero aparece como `null`. Falhas de formato, evidência inventada e falha do provedor ficam **sem pontuação**, não viram automaticamente falso negativo. Para `insufficient_evidence`, nenhuma reclamação prevista é um resultado correto; uma reclamação prevista conta como falso positivo. Trecho literal é condição necessária, mas não prova interpretação correta. `evidence_aligned_with_gold` exige mesma categoria e que uma citação contenha a outra, com pareamento de um para um; a gravidade só é comparada nesses pares. Revise manualmente os casos de erro antes de afirmar qualidade.
