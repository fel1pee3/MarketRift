import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class Db implements OnModuleDestroy {
  readonly runtime = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
  readonly provisioning = new Pool({ connectionString: process.env.PROVISION_DATABASE_URL });

  async tenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async rows<T extends QueryResultRow>(client: PoolClient, sql: string, args: unknown[] = []): Promise<T[]> {
    return (await client.query<T>(sql, args)).rows;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.runtime.end(), this.provisioning.end()]);
  }
}
