import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';
import { Accounts, AccountsController } from './accounts';
import { WebPagesController } from './web-pages';
import { EvidenceController } from './evidence';
import { EvidenceTimelineController } from './evidence-timeline';
import { B2BQualityController } from './b2b-quality';
import { SemanticController } from './semantic';
import { RetrievalReviewController } from './retrieval-review';
import { ReviewableSignalsController } from './reviewable-signals';
import { SourceDiscoveryController } from './source-discovery';
import { ActionHypothesesController } from './action-hypotheses';
import { FeedsController } from './feeds';
import { ExperienceController } from './experience';

@Module({ controllers: [ApiController, AccountsController, WebPagesController, EvidenceController, SemanticController,
  EvidenceTimelineController, B2BQualityController, RetrievalReviewController, ReviewableSignalsController, ActionHypothesesController,
  SourceDiscoveryController, FeedsController, ExperienceController], providers: [Db, Jobs, Accounts] })
export class AppModule {}
