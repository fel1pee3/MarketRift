import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Db } from './db';

export type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
export interface Principal { userId: string; tenantId: string; role: Role; sessionId: string; sessionToken: string }
interface SessionRow extends QueryResultRow { id: string; user_id: string; tenant_id: string; email: string }
interface MembershipRow extends QueryResultRow { tenant_id: string; name: string; role: Role }
interface InvitationRow extends QueryResultRow { id: string; tenant_id: string; email: string; role: Role; active: boolean; accepted_at: Date | null }
export interface SessionView {
  user_id: string;
  email: string;
  display_name: string;
  tenant_id: string;
  role: Role;
  tenants: MembershipRow[];
  csrf_token: string;
}

const uuid = z.uuid();
const registerInput = z.object({
  email: z.email().max(254), password: z.string().min(12).max(200),
  display_name: z.string().trim().min(1).max(120),
  company_name: z.string().trim().min(1).max(120).optional(),
  invitation_token: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
const loginInput = z.object({ email: z.email(), password: z.string() }).strict();
const invitationInput = z.object({ email: z.email().max(254), role: z.enum(['admin', 'analyst', 'viewer']) }).strict();
const acceptInput = z.object({ invitation_token: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const switchInput = z.object({ tenant_id: uuid }).strict();
const roleInput = z.object({ role: z.enum(['owner', 'admin', 'analyst', 'viewer']) }).strict();

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash || !/^[0-9a-f]{128}$/.test(hash)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
function databaseConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') throw new ConflictException('Resource already exists');
  throw error;
}

export function browserCookiePolicy(environment = process.env.NODE_ENV): {
  name: string; options: { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/' }
} {
  const secure = environment === 'production';
  return { name: secure ? '__Host-marketrift_session' : 'marketrift_session',
    options: { httpOnly: true, secure, sameSite: 'lax', path: '/' } };
}

@Injectable()
export class Accounts {
  constructor(@Inject(Db) private readonly db: Db) {}

  private rawCookie(request: Request): string | null {
    const name = browserCookiePolicy().name;
    const pair = (request.headers.cookie ?? '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${name}=`));
    const value = pair?.slice(name.length + 1);
    return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
  }
  private csrf(raw: string): string {
    return createHmac('sha256', (process.env.SESSION_SECRET ?? process.env.JWT_SECRET)!).update('marketrift-csrf-v1:').update(raw).digest('hex');
  }
  private checkCsrf(request: Request, raw: string): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const supplied = request.header('x-csrf-token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(this.csrf(raw), 'hex'))) {
      throw new ForbiddenException('Invalid CSRF token');
    }
  }
  private async session(request: Request): Promise<{ row: SessionRow; raw: string }> {
    const raw = this.rawCookie(request);
    if (!raw) throw new UnauthorizedException();
    const result = await this.db.provisioning.query<SessionRow>(
      `SELECT s.id, s.user_id, s.tenant_id, u.email
       FROM marketrift.browser_sessions s JOIN marketrift.users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [digest(raw)]);
    if (!result.rows[0]) throw new UnauthorizedException();
    this.checkCsrf(request, raw);
    return { row: result.rows[0], raw };
  }
  async principal(request: Request, allowed: Role[] = ['owner', 'admin', 'analyst', 'viewer']): Promise<Principal> {
    const { row, raw } = await this.session(request);
    const roles = await this.db.tenant(row.tenant_id, client => this.db.rows<{ role: Role }>(client,
      'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [row.tenant_id, row.user_id]));
    if (!roles[0]) throw new UnauthorizedException();
    if (!allowed.includes(roles[0].role)) throw new ForbiddenException();
    return { userId: row.user_id, tenantId: row.tenant_id, role: roles[0].role, sessionId: row.id, sessionToken: raw };
  }
  private async view(userId: string, tenantId: string, raw: string): Promise<SessionView> {
    const user = await this.db.provisioning.query<{ email: string; display_name: string }>(
      'SELECT email, display_name FROM marketrift.users WHERE id = $1', [userId]);
    const members = await this.db.provisioning.query<MembershipRow>(
      `SELECT m.tenant_id, t.name, m.role FROM marketrift.memberships m
       JOIN marketrift.tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 ORDER BY m.created_at, m.tenant_id`, [userId]);
    const selected = members.rows.find(row => row.tenant_id === tenantId);
    if (!user.rows[0] || !selected) throw new UnauthorizedException();
    return { user_id: userId, email: user.rows[0].email, display_name: user.rows[0].display_name,
      tenant_id: tenantId, role: selected.role, tenants: members.rows, csrf_token: this.csrf(raw) };
  }
  private async issue(client: PoolClient, userId: string, tenantId: string): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    await client.query(
      "INSERT INTO marketrift.browser_sessions (user_id, tenant_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '12 hours')",
      [userId, tenantId, digest(raw)]);
    return raw;
  }
  private setCookie(response: Response, raw: string): void {
    const policy = browserCookiePolicy();
    response.cookie(policy.name, raw, policy.options);
    response.setHeader('Cache-Control', 'no-store');
  }
  clearCookie(response: Response): void {
    const policy = browserCookiePolicy();
    response.clearCookie(policy.name, policy.options);
    response.setHeader('Cache-Control', 'no-store');
  }
  private async withProvisioning<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.provisioning.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      return databaseConflict(error);
    } finally { client.release(); }
  }
  private async validInvitation(client: PoolClient, token: string, email: string): Promise<InvitationRow> {
    const result = await client.query<InvitationRow>(
      'SELECT id, tenant_id, email, role, expires_at > now() AS active, accepted_at FROM marketrift.member_invitations WHERE token_hash = $1 FOR UPDATE',
      [digest(token)]);
    const invitation = result.rows[0];
    if (!invitation || invitation.accepted_at || !invitation.active || invitation.email !== email) {
      throw new BadRequestException('Invalid or expired invitation');
    }
    return invitation;
  }

  async register(body: unknown, response: Response): Promise<SessionView> {
    const data = input(registerInput, body);
    if (!data.invitation_token && !data.company_name) throw new BadRequestException('Company name required');
    const email = data.email.toLowerCase();
    const created = await this.withProvisioning(async client => {
      const invitation = data.invitation_token ? await this.validInvitation(client, data.invitation_token, email) : null;
      const users = await client.query<{ id: string }>(
        'INSERT INTO marketrift.users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [email, data.display_name, passwordHash(data.password)]);
      const userId = users.rows[0]!.id;
      const tenantId = invitation?.tenant_id ?? (await client.query<{ id: string }>(
        'INSERT INTO marketrift.tenants (name) VALUES ($1) RETURNING id', [data.company_name])).rows[0]!.id;
      await client.query('INSERT INTO marketrift.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [tenantId, userId, invitation?.role ?? 'owner']);
      if (invitation) await client.query(
        'UPDATE marketrift.member_invitations SET accepted_at = now(), accepted_by = $1 WHERE id = $2', [userId, invitation.id]);
      return { userId, tenantId, raw: await this.issue(client, userId, tenantId) };
    });
    this.setCookie(response, created.raw);
    return this.view(created.userId, created.tenantId, created.raw);
  }
  async login(body: unknown, response: Response): Promise<SessionView> {
    const data = input(loginInput, body);
    const result = await this.db.provisioning.query<{ id: string; password_hash: string; tenant_id: string }>(
      `SELECT u.id, u.password_hash, m.tenant_id FROM marketrift.users u
       JOIN marketrift.memberships m ON m.user_id = u.id
       WHERE u.email = $1 ORDER BY m.created_at, m.tenant_id LIMIT 1`, [data.email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !passwordMatches(data.password, user.password_hash)) throw new UnauthorizedException();
    const raw = await this.withProvisioning(client => this.issue(client, user.id, user.tenant_id));
    this.setCookie(response, raw);
    return this.view(user.id, user.tenant_id, raw);
  }
  async current(request: Request): Promise<SessionView> {
    const principal = await this.principal(request);
    return this.view(principal.userId, principal.tenantId, principal.sessionToken);
  }
  async logout(request: Request, response: Response): Promise<void> {
    const { row } = await this.session(request);
    await this.db.provisioning.query('UPDATE marketrift.browser_sessions SET revoked_at = now() WHERE id = $1', [row.id]);
    this.clearCookie(response);
  }
  async switchTenant(request: Request, response: Response, body: unknown): Promise<SessionView> {
    const principal = await this.principal(request);
    const { tenant_id: target } = input(switchInput, body);
    const roles = await this.db.tenant(target, client => this.db.rows<{ role: Role }>(client,
      'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [target, principal.userId]));
    if (!roles[0]) throw new ForbiddenException('Not a member of this company');
    const raw = await this.withProvisioning(async client => {
      await client.query('UPDATE marketrift.browser_sessions SET revoked_at = now() WHERE id = $1', [principal.sessionId]);
      return this.issue(client, principal.userId, target);
    });
    this.setCookie(response, raw);
    return this.view(principal.userId, target, raw);
  }
  async invite(request: Request, body: unknown): Promise<{ invitation_token: string; expires_at: Date }> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const data = input(invitationInput, body);
    if (principal.role === 'admin' && data.role === 'admin') throw new ForbiddenException();
    const email = data.email.toLowerCase();
    const token = randomBytes(32).toString('hex');
    const expiresAt = await this.withProvisioning(async client => {
      const actor = await client.query<{ role: Role }>(
        'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [principal.tenantId, principal.userId]);
      if (!actor.rows[0] || !['owner', 'admin'].includes(actor.rows[0].role) ||
        (actor.rows[0].role === 'admin' && data.role === 'admin')) throw new ForbiddenException();
      const existing = await client.query(
        `SELECT 1 FROM marketrift.memberships m JOIN marketrift.users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND u.email = $2`, [principal.tenantId, email]);
      if (existing.rows[0]) throw new ConflictException('Already a member');
      const result = await client.query<{ expires_at: Date }>(
        `INSERT INTO marketrift.member_invitations
         (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING expires_at`,
        [principal.tenantId, email, data.role, digest(token), principal.userId]);
      return result.rows[0]!.expires_at;
    });
    return { invitation_token: token, expires_at: expiresAt };
  }
  async accept(request: Request, response: Response, body: unknown): Promise<SessionView> {
    const principal = await this.principal(request);
    const data = input(acceptInput, body);
    const target = await this.withProvisioning(async client => {
      const invitation = await this.validInvitation(client, data.invitation_token, (await client.query<{ email: string }>(
        'SELECT email FROM marketrift.users WHERE id = $1', [principal.userId])).rows[0]!.email);
      await client.query('INSERT INTO marketrift.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [invitation.tenant_id, principal.userId, invitation.role]);
      await client.query('UPDATE marketrift.member_invitations SET accepted_at = now(), accepted_by = $1 WHERE id = $2',
        [principal.userId, invitation.id]);
      await client.query('UPDATE marketrift.browser_sessions SET revoked_at = now() WHERE id = $1', [principal.sessionId]);
      return { tenantId: invitation.tenant_id, raw: await this.issue(client, principal.userId, invitation.tenant_id) };
    });
    this.setCookie(response, target.raw);
    return this.view(principal.userId, target.tenantId, target.raw);
  }
  async members(request: Request): Promise<{ user_id: string; email: string; display_name: string; role: Role }[]> {
    const principal = await this.principal(request);
    const result = await this.db.provisioning.query<{ user_id: string; email: string; display_name: string; role: Role }>(
      `SELECT m.user_id, u.email, u.display_name, m.role FROM marketrift.memberships m
       JOIN marketrift.users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY m.created_at, m.user_id`,
      [principal.tenantId]);
    return result.rows;
  }
  async changeRole(request: Request, userIdValue: string, body: unknown): Promise<{ user_id: string; role: Role }> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const userId = input(uuid, userIdValue);
    const { role } = input(roleInput, body);
    return this.withProvisioning(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [principal.tenantId]);
      const actor = await client.query<{ role: Role }>(
        'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [principal.tenantId, principal.userId]);
      const target = await client.query<{ role: Role }>(
        'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [principal.tenantId, userId]);
      if (!actor.rows[0] || !['owner', 'admin'].includes(actor.rows[0].role)) throw new ForbiddenException();
      if (!target.rows[0]) throw new NotFoundException();
      if (actor.rows[0].role === 'admin' &&
        (['owner', 'admin'].includes(target.rows[0].role) || ['owner', 'admin'].includes(role))) throw new ForbiddenException();
      if (target.rows[0].role === 'owner' && role !== 'owner') await this.ensureAnotherOwner(client, principal.tenantId);
      await client.query('UPDATE marketrift.memberships SET role = $1 WHERE tenant_id = $2 AND user_id = $3',
        [role, principal.tenantId, userId]);
      return { user_id: userId, role };
    });
  }
  async removeMember(request: Request, userIdValue: string): Promise<void> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const userId = input(uuid, userIdValue);
    await this.withProvisioning(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [principal.tenantId]);
      const actor = await client.query<{ role: Role }>(
        'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [principal.tenantId, principal.userId]);
      const target = await client.query<{ role: Role }>(
        'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [principal.tenantId, userId]);
      if (!actor.rows[0] || !['owner', 'admin'].includes(actor.rows[0].role)) throw new ForbiddenException();
      if (!target.rows[0]) throw new NotFoundException();
      if (actor.rows[0].role === 'admin' && ['owner', 'admin'].includes(target.rows[0].role)) throw new ForbiddenException();
      if (target.rows[0].role === 'owner') await this.ensureAnotherOwner(client, principal.tenantId);
      await client.query('DELETE FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2',
        [principal.tenantId, userId]);
    });
  }
  private async ensureAnotherOwner(client: PoolClient, tenantId: string): Promise<void> {
    const count = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM marketrift.memberships WHERE tenant_id = $1 AND role = 'owner'", [tenantId]);
    if (Number(count.rows[0]?.count ?? 0) <= 1) throw new ConflictException('The last owner cannot be removed');
  }
}

@Controller('v1')
export class AccountsController {
  constructor(@Inject(Accounts) private readonly accounts: Accounts) {}

  @Post('auth/register')
  register(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<SessionView> {
    return this.accounts.register(body, response);
  }
  @Post('auth/login') @HttpCode(200)
  login(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<SessionView> {
    return this.accounts.login(body, response);
  }
  @Get('auth/session')
  session(@Req() request: Request): Promise<SessionView> { return this.accounts.current(request); }
  @Post('auth/logout') @HttpCode(204)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    return this.accounts.logout(request, response);
  }
  @Post('auth/switch-tenant') @HttpCode(200)
  switchTenant(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown): Promise<SessionView> {
    return this.accounts.switchTenant(request, response, body);
  }
  @Get('members')
  members(@Req() request: Request): ReturnType<Accounts['members']> { return this.accounts.members(request); }
  @Post('invitations')
  invite(@Req() request: Request, @Body() body: unknown): ReturnType<Accounts['invite']> { return this.accounts.invite(request, body); }
  @Post('invitations/accept') @HttpCode(200)
  accept(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown): Promise<SessionView> {
    return this.accounts.accept(request, response, body);
  }
  @Patch('members/:id')
  changeRole(@Req() request: Request, @Param('id') id: string, @Body() body: unknown): ReturnType<Accounts['changeRole']> {
    return this.accounts.changeRole(request, id, body);
  }
  @Delete('members/:id') @HttpCode(204)
  remove(@Req() request: Request, @Param('id') id: string): Promise<void> { return this.accounts.removeMember(request, id); }
}
