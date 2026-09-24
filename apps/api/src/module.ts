import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';
import { Accounts, AccountsController } from './accounts';

@Module({ controllers: [ApiController, AccountsController], providers: [Db, Jobs, Accounts] })
export class AppModule {}
