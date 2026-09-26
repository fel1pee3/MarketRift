# ADR 0016: relevância da recuperação em evidências públicas

**Status:** implementado para revisão humana; nenhuma pergunta pública real rotulada por pessoa nesta entrega.

## Unidade e fronteira

Um conjunto captura até 30 **trechos** de Issues e Discussions públicas já coletadas e indexadas para o MiniLM local. A seleção pode filtrar empresa ativa, produto e período. A consulta deduplica a mesma origem e número de trecho quando o repositório foi associado a dois produtos. Guarda ID de documento e trecho, URL, tipo, data, texto congelado, hash SHA-256, versão do conteúdo e se a fonte tinha coleta parcial. A amostra é de trechos disponíveis, não do histórico total do repositório. G2, Steam, CSV e reviews B2B não entram neste avaliador público. O conjunto sintético de E2E tem `origin=synthetic_test` e não aparece como dado real.

As tabelas `retrieval_sets`, `retrieval_items`, `retrieval_questions`, `retrieval_judgments` e `retrieval_reports` têm RLS forçada por `app.tenant_id`. A API deriva o tenant da sessão com membership verificada; owner, admin e analyst criam e julgam, viewer apenas consulta. O navegador não envia tenant autorizado. POST exige CSRF existente. O texto e o token interno não entram em jobs; a avaliação é síncrona, limitada a 30 trechos e 20 perguntas, e usa o FastAPI em loopback com o segredo interno. Não há OpenAI neste fluxo.

## Julgamento cego e congelamento

O revisor vê corpus em ordem fixa, pode pesquisar e abrir a origem, e marca cada par pergunta/trecho como relevante ou irrelevante. Ausência de julgamento permanece desconhecida. Pergunta sem evidência exige marcação explícita e, antes de congelar, todos os pares sem julgamento exigem confirmação de cobertura incompleta. Cada julgamento registra usuário, horário e revisão. Uma versão congelada é imutável; `fork` cria a versão seguinte com cópia de corpus e julgamentos, permitindo continuar. Hashes canônicos do corpus e dos julgamentos ligam o relatório à versão. Se documento, fonte ou vetor mudar/desaparecer, a consulta marca item e relatório como históricos. A cópia congelada permanece para interpretar o relatório antigo; política de retenção/exclusão formal continua pendente.

## Métricas

O mesmo corpus congelado alimenta o MiniLM local, uma referência de sobreposição literal e, separado como **TESTE**, o controlled-hash. O código Python reutiliza `embed()` da produção e a mesma versão fixada do modelo. Similaridade local usa o limiar provisório de 0,15, equivalente à distância máxima de 0,85 da API. O limiar não foi ajustado com este conjunto. Para perguntas **inteiramente julgadas** e com ao menos um trecho relevante, Recall@k é a média da fração de relevantes recuperados; MRR@5 é a média do inverso da primeira posição relevante. Perguntas explicitamente sem resposta entram apenas na taxa de abstenção correta. Itens julgados irrelevantes nos primeiros resultados são reportados por ID. Perguntas incompletas ficam fora das métricas principais; o relatório mostra separadamente métricas condicionais aos positivos já julgados e IDs ainda não julgados nos primeiros resultados. Isso não equivale a qualidade final. O relatório registra idiomas, tipos de fonte, tamanho, versão do índice/modelo, latência e custo externo USD 0.

O ranking é calculado sobre os textos congelados com embeddings da mesma implementação local usada pelo worker, em vez de um índice vivo que pode mudar durante a revisão. É uma avaliação de recuperação nesse corpus pequeno, não benchmark de tempo ou recall do PostgreSQL em produção. Nenhuma conclusão sobre reviews B2B, clientes verificados ou participação de mercado decorre de Issues/Discussions. A próxima etapa é obter julgamentos humanos suficientes e depois avaliar separadamente reviews B2B com acesso permitido.
