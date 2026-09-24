# Como transformar dados em sinais e acoes

## Pipeline analitico

**Coleta -> documento com proveniencia -> extracao estruturada -> agregados -> sinal -> recomendacao -> revisao.** Cada etapa possui versao, data, status e referencia ao insumo anterior. Texto original permanece acessivel para auditoria. Vetor e indice de busca, nao substituto do documento.

## Exemplos de sinais

### Pico de reclamacoes

Comparar proporcoes, nao somente contagens: 19/80 sobre suporte nesta janela contra 8/75 na anterior. Exigir amostra minima configurada, janelas iguais, mesma fonte/produto e rotulo de categoria com qualidade avaliada. Calcular variacao, registrar numeros e sinalizar baixa amostra. O score de prioridade pode combinar intensidade, recencia, gravidade, cobertura e confianca, com pesos versionados e visiveis.

### Alteracao de preco

Comparar duas observacoes do mesmo concorrente, plano, moeda e periodo. Percentual = (novo - anterior) / anterior * 100. Identificar promoções, impostos, regiao e mudancas de empacotamento antes de publicar. Registrar URLs e capturas de ambos os pontos.

### Lancamento e impacto

Uma release note cria evento datado. O sistema mostra reclamacoes antes/depois por tema e plataforma; descreve correlacao temporal, sem afirmar causa. Uma pessoa pode confirmar se o evento parece relevante.

### Gap frente ao produto proprio

Cruzar dor recorrente de um concorrente com capacidade propria *verificada*. Se o produto proprio nao tiver evidencia atual, a recomendacao deve dizer "validar internamente" em vez de declarar superioridade. O score deve mostrar todos os fatores e links de origem.

## Recomendacao revisavel

Campos minimos: sinal, oportunidade, acao sugerida, justificativa, fatos comprovados, alegacoes a verificar, riscos, URLs e estado (rascunho/aprovada/rejeitada). Uma campanha externa nunca e disparada automaticamente pelo modelo. Revisao e historico ficam auditaveis.

## Avaliacao de IA

Manter conjunto rotulado por humanos com amostra de positivos/negativos por categoria. Medir precisao, recall, confusoes, taxa de trechos nao localizados no documento e custo por 100 documentos. Rodar avaliacao sempre que trocar modelo, prompt ou taxonomia. Saida estruturada validada por Pydantic; respostas invalidas podem ser reprocessadas, sem ocultar falha.

## RAG responsavel

Busca textual e vetorial recupera documentos do tenant e do modelo correto. SQL responde contagens, periodos e percentuais. Resposta cita IDs/URLs/datas; se nao houver base suficiente, nao inventa. Testes adversariais incluem pergunta sobre outro tenant, conteudo malicioso numa review e ausencia de dados.
