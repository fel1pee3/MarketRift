import { Module } from '@nestjs/common';
import { ApiController } from './routes';
import { Db } from './db';
import { Jobs } from './queue';

@Module({ controllers: [ApiController], providers: [Db, Jobs] })
export class AppModule {}
