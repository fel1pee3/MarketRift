"""Explicit local-only smoke test on an existing synthetic B2B source."""
import argparse
import asyncio
import os
import time
from uuid import uuid4

import psycopg

from .embeddings import embed, identity
from .evidence_index import index_source


async def run(product_name: str, question: str) -> None:
    model, version = identity()
    if os.getenv("EMBEDDING_PROVIDER") != "local":
        raise ValueError("local_smoke_requires_local_embeddings")
    with psycopg.connect(os.environ["DATABASE_ADMIN_URL"]) as admin:
        rows = admin.execute("""SELECT DISTINCT s.tenant_id, s.id
          FROM marketrift.sources s
          JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
          JOIN marketrift.documents d ON d.tenant_id = s.tenant_id AND d.source_id = s.id
          WHERE p.name = %s AND s.source_type = 'b2b_csv_review'
            AND d.document_type = 'b2b_review' AND d.synthetic
            AND d.review_data_status = 'synthetic_fixture'""", (product_name,)).fetchall()
    if len(rows) != 1:
        raise ValueError(f"expected_one_existing_synthetic_b2b_source_found_{len(rows)}")
    tenant_id, source_id = map(str, rows[0])
    start = time.perf_counter()
    progress = await index_source({"contract_version": "index-evidence.v1", "tenant_id": tenant_id,
                                   "source_id": source_id, "idempotency_key": f"local-smoke-{uuid4()}"})
    index_ms = round((time.perf_counter() - start) * 1000)
    start = time.perf_counter()
    vector = "[" + ",".join(str(value) for value in embed(question)) + "]"
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:  # noqa: SIM117 - explicit tenant transaction
        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            result = await (await connection.execute("""SELECT e.id,
                (e.embedding <=> %s::vector)::float AS distance,
                strpos(d.body, e.text_content) > 0 AS literal,
                d.source_url IS NOT NULL AS has_url
              FROM marketrift.evidence_chunks e
              JOIN marketrift.documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
              JOIN marketrift.sources s ON s.tenant_id = e.tenant_id AND s.id = e.source_id
              WHERE e.source_id = %s AND e.embedding_model = %s AND e.embedding_version = %s
                AND e.status = 'ready' AND e.synthetic AND s.enabled AND s.storage_permitted
                AND s.rights_reference IS NOT NULL AND e.content_version = md5(d.body)
              ORDER BY e.embedding <=> %s::vector LIMIT 1""",
                (vector, source_id, model, version, vector))).fetchone()
    query_ms = round((time.perf_counter() - start) * 1000)
    if result is None or not result[2] or not result[3]:
        raise RuntimeError("local_smoke_no_valid_citation")
    print(f"model={model} revision={version} indexed={progress['indexed']} "
          f"ready={progress['ready']}/{progress['total']} remaining={progress['remaining']} "
          f"index_ms={index_ms} query_ms={query_ms} distance={result[1]:.4f} "
          "literal_citation=yes synthetic_test=yes external_cost_usd=0")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-name", required=True)
    parser.add_argument("--question", required=True)
    args = parser.parse_args()
    if os.name == "nt":
        asyncio.run(run(args.product_name, args.question), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(run(args.product_name, args.question))


if __name__ == "__main__":
    main()
