import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "packages/contracts/analyze-document-job.v1.schema.json"
VALIDATOR = Draft202012Validator(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")), format_checker=FormatChecker())


def make_analysis_job(tenant_id: str, document_id: str, extractor_version: str) -> dict:
    job = {
        "version": 1,
        "tenant_id": tenant_id,
        "document_id": document_id,
        "extractor_version": extractor_version,
        "idempotency_key": f"analysis-{document_id}-{extractor_version}",
    }
    return validate_analysis_job(job)


def validate_analysis_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    expected = f"analysis-{payload['document_id']}-{payload['extractor_version']}"
    if payload["idempotency_key"] != expected:
        raise ValueError("analysis idempotency key does not match document and version")
    return payload
