# Definicao de produto completo

Nao chamar o MarketRift de completo ate cumprir e demonstrar todos os itens abaixo.

## Produto

- [ ] Conta, convite, papeis, assinatura e limites por organizacao funcionam.
- [ ] Produto proprio, tres concorrentes e temas de interesse podem ser geridos no painel.
- [ ] Ao menos uma fonte de avaliacoes, uma de precos e uma de release notes operam continuamente com acesso permitido, cursores e historico.
- [ ] Dashboard mostra temas, comparacoes e tendencia com denominador, periodo e cobertura.
- [ ] Mudanca de preco so e calculada entre planos comparaveis; release notes e avaliacoes podem ser vistas na linha do tempo.
- [ ] Sinais e alertas possuem criterio documentado e evidencias navegaveis.
- [ ] Recomendacoes mostram fatos, suposicoes e status de revisao; nenhuma acao externa e executada automaticamente.
- [ ] Chat responde com citacoes e recusa inferencias sem dados suficientes.

## Engenharia

- [ ] Fluxos web -> API -> fila -> Python -> banco -> web cobertos por integracao.
- [ ] Testes com dois tenants cobrem todas as superficies, incluindo vetores e jobs.
- [ ] Retry, dedupe, reconciliacao de pendencias, rate limit e falhas permanentes testados.
- [ ] Cada extracao e sinal guarda versao, proveniencia e data; modelo avaliado com conjunto rotulado.
- [ ] Logs, metricas, custos, backup, restore, deploy e rollback documentados e exercitados.
- [ ] Documentacao de setup, exemplo sintetico, demo reproduzivel e guia de contribuicao publicados.

## Validacao

- [ ] Cinco usuarios do perfil inicial testaram o fluxo e suas duvidas e decisoes foram registradas.
- [ ] Qualidade da extracao, tempo por fluxo, custo e taxa de alertas considerados uteis sao publicados com metodologia.
- [ ] Alegacoes de valor comercial usam dados observados, nao promessas do conceito.

O produto pode continuar evoluindo apos esses itens. Esta lista define um marco verificavel, nao a garantia de sucesso comercial.
