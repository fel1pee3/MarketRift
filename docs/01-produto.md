# Produto: por que o MarketRift existe

## Resultado desejado

Ajudar uma equipe a descobrir **sinais verificaveis** sobre a experiencia de clientes de concorrentes e a decidir quais hipoteses de produto ou marketing vale investigar. O usuario nao compra um numero magico de sentimento; ele recebe uma lista priorizada de temas, tendencia temporal e ligacao para a evidencia.

Exemplo honesto: "De 80 avaliacoes publicas deste concorrente coletadas entre 1 e 30 de setembro, 19 mencionam demora de atendimento. Em agosto, foram 8 de 75. Veja as fontes. Hipotese: investigar se nosso tempo de resposta e melhor antes de montar uma campanha." Isso nao prova perda de clientes nem causalidade.

## Para quem e como validar

Primeiro recorte: produtos SaaS B2B com concorrentes que possuem avaliacoes acessiveis e equipes pequenas de produto/marketing. Entrevistar cinco potenciais usuarios e observar como fazem a pesquisa hoje. Perguntar quanto tempo levam, que fontes confiam, como verificam achados e que decisao tomariam com um exemplo real.

Evitar vender uma assinatura antes de demonstrar repeticao de uso e disposicao de pagar. O valor comercial e uma hipotese, nao um resultado garantido pelo projeto.

## Objetos do dominio

- **Tenant:** a empresa cliente do MarketRift.
- **Produto proprio / concorrente:** entidades comparadas; uma empresa pode cadastrar varios concorrentes.
- **Fonte:** local de origem de avaliacoes ou precos, com URL e regras de acesso.
- **Documento:** avaliacao ou nota de versao com texto, data, URL e chave de deduplicacao.
- **Insight:** classificacao extraida com categoria, sentimento, gravidade, versao do extrator e trecho de evidencia.
- **Observacao de preco:** valor, moeda, periodo e URL observados num instante.
- **Embedding:** representacao vetorial de um documento para recuperar textos parecidos; o texto original permanece.
- **Recomendacao:** hipotese derivada de evidencias e metricas, sujeita a revisao humana (fase posterior).

## Primeira entrega e destino

Primeira entrega: importacao CSV, um concorrente, dashboard de categorias e historico, fonte clicavel, busca de documentos por tenant e avaliacao manual de uma amostra.

Produto completo: coleta agendada de reviews, precos e release notes; sinais, alertas, recomendacoes revisaveis, RAG e operacao SaaS. A primeira entrega nao encerra o projeto. Nao contornar bloqueios de sites. Nao misturar dados sinteticos com evidencias reais sem rotulo. Ver [escopo completo](00-escopo-completo.md).

## Medidas de qualidade

- Cobertura de proveniencia: 100% dos achados exibidos com URL/identificador e data de coleta.
- Isolamento: testes A/B para todas as rotas, workers e buscas vetoriais.
- Extracao: conjunto rotulado manualmente com precisao/recall por categoria, nao apenas exemplos escolhidos.
- Operacao: custo por 100 documentos, tempo da importacao, taxa de falhas e duplicatas.
- Valor ao usuario: tempo ate achar um tema relevante e quantos achados ele considera acionaveis apos ler a fonte.
