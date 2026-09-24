# Escopo do produto completo

## Missao

Reduzir o trabalho manual de inteligencia competitiva e ajudar equipes de produto/marketing a descobrir oportunidades verificaveis. A plataforma observa sinais, explica sua origem e propoe proximas acoes. O usuario decide se age. Sucesso comercial e participacao de mercado sao resultados externos a medir, nao conclusoes automaticas de reviews.

## Jornada final de ponta a ponta

1. Uma empresa cria conta, convida membros e define papeis. Cadastra seu produto e concorrentes.
2. Escolhe temas prioritarios (suporte, preco, usabilidade etc.) e fontes permitidas por concorrente e pelo proprio produto.
3. Conectores consultam avaliacoes, paginas de preco e notas de versao com cursores, limites e agendamento. Cada captura registra URL, instante, identificador, hash e referencia ao original.
4. O pipeline deduplica, normaliza, extrai categoria/sentimento/problema/gravidade com modelo versionado e guarda um trecho literal de evidencia. Resultados de baixa confianca vao para revisao.
5. O motor compara periodos equivalentes, produtos e precos da mesma moeda, plano e periodicidade. Detecta picos, alteracoes e possiveis lacunas; registra formula e exemplos sustentadores.
6. O painel exibe graficos, filtros, links de origem, cronologia, estado dos conectores e limites dos dados. Alertas aparecem para sinais relevantes; a equipe aprova, descarta ou comenta recomendacoes.
7. O chat recebe perguntas, autoriza tenant, usa SQL para contagens e retrieval para textos, cita fontes e declara insuficiencia quando a pergunta excede os dados.
8. Assinatura, auditoria, limites de uso, observabilidade e procedimentos de falha completam a operacao SaaS.

## Modulos obrigatorios para considerar o produto completo

| Modulo | Funcionalidade |
| --- | --- |
| Conta e organizacao | Autenticacao, convite, troca de tenant, RBAC, isolamento, configuracao e assinatura |
| Portfolio | Produto proprio, concorrentes, temas, capacidades proprias verificadas |
| Fontes | Cadastro, autorizacao, configuracao de coleta, cursores, agenda, monitoramento de saude |
| Avaliacoes | Ingestao, dedupe, normalizacao, idioma/data, classificacao e evidencias |
| Precos | Capturas, plano/moeda/periodo, diferenca percentual so entre valores comparaveis |
| Lancamentos | Release notes, versao/data, temas e correlacao temporal exploratoria com reviews |
| Sinais | Pico de queixas, alteracao de preco, impacto pos-release, gap comparativo, score explicavel |
| Planos de acao | Hipotese, justificativa, fontes, verificacao das alegacoes sobre o produto proprio, aprovacao |
| Alertas | Feed, severidade, visto/descartado, preferencias e entregas configuraveis |
| Pesquisa | Dashboard e chat com citacoes, filtro temporal e resposta de dados insuficientes |
| Operacao | Retry, reprocessamento idempotente, auditoria, custos, testes, deploy e documentacao |

## Fontes

ReclameAqui, G2, App Store, sites oficiais e outras fontes sao **candidatas**, nao conectores prometidos antes de confirmar acesso permitido, limites e dados necessarios. Cada conector tem contrato proprio e evidencia de coleta. Nunca contornar bloqueios ou assumir que uma pagina publica autoriza coleta automatizada.

## Fora das afirmacoes do produto

Nao prometer identificar quem abandonou um concorrente, obter o market share real, responder em tres segundos em qualquer carga, prever receita ou provar que uma atualizacao causou reclamacoes. Apresentar distribuicao da amostra, janela, cobertura e incerteza.
