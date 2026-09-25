import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';
import { Accounts, AccountsController } from './accounts';
import { WebPagesController } from './web-pages';
import { EvidenceController } from './evidence';

@Module({ controllers: [ApiController, AccountsController, WebPagesController, EvidenceController], providers: [Db, Jobs, Accounts] })
export class AppModule {}
