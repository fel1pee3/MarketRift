import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { ForbiddenException } from '@nestjs/common';
import { ExperienceController } from '../src/experience';
import { EvidenceController } from '../src/evidence';
import { ApiController } from '../src/routes';

test('normal API excludes test products, test sources and synthetic reviews across tenants', async t => {
  if (!process.env.DATABASE_ADMIN_URL) { t.skip('DATABASE_ADMIN_URL unavailable'); return; }
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  await client.query('BEGIN');
  try {
    const tenants = (await client.query<{ id: string }>(`INSERT INTO marketrift.tenants(name)
      VALUES ('experience-fixture-a'),('experience-fixture-b') RETURNING id`)).rows;
    const [a, b] = tenants.map(row => row.id);
    assert.ok(a && b);
    const products = (await client.query<{ id: string; tenant_id: string; usage_classification: string }>(`
      INSERT INTO marketrift.products(tenant_id,name,kind,usage_classification) VALUES
      ($1,'real-product','competitor','real'),($1,'test-product','competitor','test'),
      ($2,'other-product','competitor','real') RETURNING id,tenant_id,usage_classification`, [a,b])).rows;
    const realProduct = products.find(row => row.tenant_id === a && row.usage_classification === 'real')!.id;
    const testProduct = products.find(row => row.tenant_id === a && row.usage_classification === 'test')!.id;
    const otherProduct = products.find(row => row.tenant_id === b)!.id;
    await client.query(`INSERT INTO marketrift.competitor_profiles(tenant_id,product_id,official_domain)
      VALUES ($1,$2,'example.org')`,[a,realProduct]);
    await client.query(`INSERT INTO marketrift.discovery_runs
      (tenant_id,product_id,identity_version,status,test_data,finished_at)
      VALUES ($1,$2,1,'succeeded',false,now())`,[a,realProduct]);
    for (const [key,flag] of [['historical',null],['controlled',true],['public',false]] as const) {
      await client.query(`INSERT INTO marketrift.discovery_candidates
        (tenant_id,product_id,canonical_url,category,suggested_type,
        discovered_from_url,discovery_method,association_evidence,confidence,identity_version,test_data,
        first_discovered_from_url,first_discovery_method)
        VALUES ($1,$2,$3,'product','pricing_page','https://example.org/',
        'homepage','fixture','official_host',1,$4,'https://example.org/','homepage')`,
      [a,realProduct,`https://example.org/${key}`,flag]);
    }
    const sources = (await client.query<{ id: string; product_id: string; usage_classification: string }>(`
      INSERT INTO marketrift.sources(tenant_id,product_id,source_type,url,usage_classification) VALUES
      ($1,$3,'github_issues','https://github.com/example/real','real'),
      ($1,$3,'github_issues','https://github.com/example/test','test'),
      ($1,$4,'github_issues','https://github.com/example/product-test','real'),
      ($2,$5,'github_issues','https://github.com/example/other','real'),
      ($1,$3,'b2b_csv_review','https://example.invalid/synthetic','real')
      RETURNING id,product_id,usage_classification`, [a,b,realProduct,testProduct,otherProduct])).rows;
    const [realSource,testSource,testProductSource,otherSource,b2bSource] = sources.map(row => row.id);
    assert.ok(realSource && testSource && testProductSource && otherSource && b2bSource);
    await client.query(`UPDATE marketrift.sources SET access_environment='production',
      rights_reference='controlled-fixture-only',storage_permitted=true,
      rights_expires_at=now()+interval '1 day' WHERE id=$1`, [b2bSource]);
    for (const [tenant,source,key,kind,synthetic,status] of [
      [a,realSource,'public','github_issue',false,null],
      [a,testSource,'test-source','github_issue',false,null],
      [a,testProductSource,'test-product','github_issue',false,null],
      [b,otherSource,'other-tenant','github_issue',false,null],
      [a,b2bSource,'synthetic','b2b_review',true,'synthetic_fixture'],
    ] as const) {
      await client.query(`INSERT INTO marketrift.documents(tenant_id,source_id,document_type,
        external_key,source_url,body,synthetic,review_data_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenant,source,kind,key,`https://github.com/example/${key}`,`controlled-${key}`,synthetic,status]);
    }
    for (const [source,key,flag] of [[realSource,'a',false],[realSource,'b',true],
      [testSource,'c',false]] as const) {
      await client.query(`INSERT INTO marketrift.reviewable_signals
        (tenant_id,fact_key,rule_version,signal_type,source_type,state,source_id,
        summary,interpretation_limit,evidence,evidence_hash,test_data,observed_at)
        VALUES ($1,$2,'controlled-v1','github_issue_activity','github_issues','approved',
        $3,'controlled-signal','public activity only','{}'::jsonb,$2,$4,now())`,
      [a,key.repeat(64),source,flag]);
    }
    let activeTenant = a;
    let activeRole: 'owner' | 'viewer' = 'owner';
    const db = {
      tenant: async <T>(tenantId: string, work: (connection: pg.Client) => Promise<T>): Promise<T> => {
        assert.equal(tenantId, activeTenant);
        await client.query('SET ROLE marketrift_runtime');
        try {
          await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
          return await work(client);
        } finally { await client.query('RESET ROLE'); }
      },
      rows: async <T extends pg.QueryResultRow>(connection: pg.Client, sql: string, args: unknown[] = []): Promise<T[]> =>
        (await connection.query<T>(sql,args)).rows,
    };
    const accounts = { principal: async (_request: unknown, allowed?: string[]) => {
      if (allowed && !allowed.includes(activeRole)) throw new ForbiddenException();
      return { tenantId: activeTenant, userId: a, role: activeRole };
    } };
    const experience = new ExperienceController(db as never,accounts as never);
    const evidence = new EvidenceController(db as never,accounts as never);
    const routes = new ApiController(db as never,{} as never,accounts as never);
    const first = await experience.list({} as never);
    assert.deepEqual(first.products.map(item => item.id),[realProduct]);
    assert.equal(first.suggestions[0]?.count,1);
    assert.equal(first.attention.length,1);
    assert.deepEqual(new Set(first.sources.map(item => item.id)),new Set([realSource,b2bSource]));
    assert.equal(first.sources.find(item => item.id === realSource)?.evidence_count,1);
    assert.equal(first.sources.find(item => item.id === b2bSource)?.evidence_count,0);
    const visible = await evidence.search({} as never,{ scope: 'normal' });
    assert.equal(visible.total,1);
    assert.equal(visible.items[0]?.source_id,realSource);
    assert.equal((await evidence.search({} as never,{ scope:'normal', product_id:otherProduct })).total,0);
    assert.equal((await evidence.search({} as never,{ scope:'normal', source_type:'b2b_review' })).total,0);
    const advanced = await evidence.search({} as never,{});
    assert.equal(advanced.total,4);
    const allProducts = await routes.products({} as never);
    assert.equal(allProducts.length,2);
    const fixtureSource = await routes.createSource({} as never,
      { product_id:realProduct, url:'https://example.invalid/reviews' });
    assert.equal((await routes.sources({} as never)).find(item => item.id === fixtureSource.id)?.usage_classification,'test');
    activeRole='viewer';
    await assert.rejects(routes.classifyProduct({} as never,testProduct,
      { usage_classification:'real' }), { status: 403 });
    await assert.rejects(routes.classifySource({} as never,realSource,
      { usage_classification:'test' }), { status: 403 });
    activeRole='owner';
    await assert.rejects(routes.classifySource({} as never,b2bSource,
      { usage_classification:'real' }), { status: 400 });
    await assert.rejects(routes.classifyProduct({} as never,otherProduct,
      { usage_classification:'test' }), { status: 404 });
    await routes.classifyProduct({} as never,testProduct,{ usage_classification:'real' });
    assert.equal((await experience.list({} as never)).products.length,2);
    await routes.classifyProduct({} as never,testProduct,{ usage_classification:'test' });
    await routes.classifySource({} as never,testSource,{ usage_classification:'real' });
    assert.equal((await evidence.search({} as never,{ scope:'normal' })).total,2);
    await routes.classifySource({} as never,testSource,{ usage_classification:'test' });
    assert.equal((await evidence.search({} as never,{ scope:'normal' })).total,1);
    activeTenant=b;
    const second = await experience.list({} as never);
    assert.deepEqual(second.products.map(item => item.id),[otherProduct]);
    const otherVisible = await evidence.search({} as never,{ scope:'normal' });
    assert.equal(otherVisible.total,1);
    assert.equal(otherVisible.items[0]?.source_id,otherSource);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
