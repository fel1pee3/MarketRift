import { Client } from 'pg';

export type RestoreGateStatus = 'released' | 'quarantined' | 'unavailable';

/** The control table lives in the postgres database, outside the dumped application database. */
export async function restoreGateStatus(databaseUrl: string | undefined): Promise<RestoreGateStatus> {
  if (!databaseUrl) return 'unavailable';
  let client: Client | undefined;
  try {
    const controlUrl = new URL(databaseUrl);
    const databaseName = decodeURIComponent(controlUrl.pathname.slice(1));
    if (!databaseName || databaseName === 'postgres') return 'unavailable';
    controlUrl.pathname = '/postgres';
    client = new Client({ connectionString: controlUrl.toString(), connectionTimeoutMillis: 2000 });
    await client.connect();
    const result = await client.query<{ state: string; database_name: string }>(`
      SELECT state,database_name FROM public.marketrift_restore_gate WHERE id=true`);
    const row = result.rows[0];
    if (!row || row.database_name !== databaseName) return 'unavailable';
    return row.state === 'released' ? 'released' : 'quarantined';
  } catch (error) {
    if ((error as { code?: string }).code === '42P01' &&
        process.env.RESTORE_GATE_REQUIRED !== '1') return 'released';
    return 'unavailable';
  } finally { await client?.end().catch(() => {}); }
}

export async function requireRestoreReleased(databaseUrl: string | undefined): Promise<void> {
  const status = await restoreGateStatus(databaseUrl);
  if (status !== 'released') throw new Error(`restore_${status}`);
}
