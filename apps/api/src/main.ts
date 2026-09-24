import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './module';

async function main(): Promise<void> {
  for (const key of ['RUNTIME_DATABASE_URL', 'PROVISION_DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  if ((process.env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET must have at least 32 characters');
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  await app.listen(Number(process.env.API_PORT ?? 3001));
}
void main();
