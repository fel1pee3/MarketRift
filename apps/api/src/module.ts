import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';
import { Accounts, AccountsController } from './accounts';
import { WebPagesController } from './web-pages';
import { EvidenceController } from './evidence';
import { SemanticController } from './semantic';
import { RetrievalReviewController } from './retrieval-review';
import { ReviewableSignalsController } from './reviewable-signals';
import { SourceDiscoveryController } from './source-discovery';
import { ActionHypothesesController } from './action-hypotheses';

@Module({ controllers: [ApiController, AccountsController, WebPagesController, EvidenceController, SemanticController,
  RetrievalReviewController, ReviewableSignalsController, ActionHypothesesController,
  SourceDiscoveryController], providers: [Db, Jobs, Accounts] })
export class AppModule {}
