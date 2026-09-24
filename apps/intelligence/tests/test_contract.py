import pytest
from jsonschema import ValidationError

from marketrift_intelligence.job import validate_job


def test_v1_contract_accepts_ids_only():
    payload = {
        "version": 1,
        "tenant_id": "b522d3cb-556c-46f3-bca3-a4d9a3a75e69",
        "import_id": "e8f28408-d57b-4839-989b-f519550c8e0d",
        "source_id": "79d47c62-9f2e-4dd6-97db-abdbbbfd7660",
        "idempotency_key": "import-e8f28408-d57b-4839-989b-f519550c8e0d-v1",
    }
    assert validate_job(payload) == payload
    with pytest.raises(ValidationError):
        validate_job({**payload, "jwt": "secret"})
