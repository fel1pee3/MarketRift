/** Log operational error classes without SQL, connection strings or job payloads. */
export function schedulerErrorLabel(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const value = error as { code?: unknown; name?: unknown };
  if (value.code === '42501') return 'PostgreSQL: permissão insuficiente (SQLSTATE 42501)';
  if (value.code === '42P01') return 'PostgreSQL: tabela ausente (SQLSTATE 42P01)';
  if (value.code === '42703') return 'PostgreSQL: coluna ausente (SQLSTATE 42703)';
  if (value.code === '28P01') return 'PostgreSQL: autenticação recusada (SQLSTATE 28P01)';
  if (value.code === 'ECONNREFUSED') return 'conexão recusada pelo banco ou Redis (ECONNREFUSED)';
  if (typeof value.code === 'string' && /^[A-Z0-9]{5}$/.test(value.code))
    return `PostgreSQL: falha SQLSTATE ${value.code}`;
  return typeof value.name === 'string' ? value.name : 'unknown';
}
