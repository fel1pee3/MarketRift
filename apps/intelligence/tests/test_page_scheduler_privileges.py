"""The production page scheduler uses its restricted provisioning login."""

import os

import psycopg
import pytest


def test_provisioner_can_read_the_sandbox_exclusion_column():
    url = os.getenv("PROVISION_DATABASE_URL")
    if not url:
        pytest.skip("PROVISION_DATABASE_URL is required for database integration")
    with psycopg.connect(url) as connection:
        allowed = connection.execute(
            "SELECT has_column_privilege(current_user,'marketrift.sources',"
            "'access_environment','SELECT')"
        ).fetchone()[0]
        assert allowed is True
        # This is the real production filter. No run is created or published.
        connection.execute(
            "SELECT r.id FROM marketrift.source_runs r "
            "JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id "
            "WHERE r.run_kind='web_page' AND r.status='pending' "
            "AND s.monitoring_enabled AND s.enabled "
            "AND s.access_environment IS DISTINCT FROM 'sandbox' LIMIT 1"
        ).fetchall()
        connection.rollback()
