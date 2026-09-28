import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './module';
import { restoreGateStatus } from './restore-gate';

async function main(): Promise<void> {
  for (const key of ['RUNTIME_DATABASE_URL', 'PROVISION_DATABASE_URL', 'REDIS_URL']) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  const sessionSecret = process.env.SESSION_SECRET ?? process.env.JWT_SECRET ?? '';
  if (sessionSecret.length < 32 || sessionSecret.startsWith('replace-with-')) {
    throw new Error('SESSION_SECRET must be a random value of at least 32 characters (legacy JWT_SECRET is accepted)');
  }
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  if (new URL(webOrigin).origin !== webOrigin ||
    (process.env.NODE_ENV === 'production' && !webOrigin.startsWith('https://'))) {
    throw new Error('WEB_ORIGIN must be an exact origin, using HTTPS in production');
  }
  const app = await NestFactory.create(AppModule);
  app.use((request: { method: string; originalUrl: string }, response: {
    setHeader: (name: string, value: string) => void;
    status: (status: number) => { json: (body: object) => void };
  }, next: () => void) => {
    void (async () => {
      const status = await restoreGateStatus(process.env.RUNTIME_DATABASE_URL);
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET' && request.originalUrl === '/health') {
        response.status(status === 'released' ? 200 : 503).json({ status: status === 'released'
          ? 'ok' : 'restoration_quarantine' });
      } else if (status !== 'released') {
        response.status(503).json({ statusCode: 503, message: 'Restauração em quarentena',
          code: status === 'quarantined' ? 'restoration_quarantine' : 'restoration_gate_unavailable' });
      } else next();
    })().catch(() => response.status(503).json({ statusCode: 503,
      message: 'Restauração em quarentena', code: 'restoration_gate_unavailable' }));
  });
  app.enableCors({ origin: webOrigin, credentials: true });
  app.use((request: { method: string; headers: { origin?: string } }, response: { setHeader: (name: string, value: string) => void; status: (status: number) => { json: (body: object) => void } }, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== webOrigin) {
      response.status(403).json({ statusCode: 403, message: 'Invalid Origin' });
      return;
    }
    next();
  });
  await app.listen(Number(process.env.API_PORT ?? 3001));
}
void main();
