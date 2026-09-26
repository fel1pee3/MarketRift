import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';
import { Accounts, AccountsController } from './accounts';
import { WebPagesController } from './web-pages';
import { EvidenceController } from './evidence';
import { SemanticController } from './semantic';
import { RetrievalReviewController } from './retrieval-review';

@Module({ controllers: [ApiController, AccountsController, WebPagesController, EvidenceController, SemanticController,
  RetrievalReviewController], providers: [Db, Jobs, Accounts] })
export class AppModule {}
