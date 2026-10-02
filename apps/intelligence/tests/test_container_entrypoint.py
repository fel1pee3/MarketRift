from container_entrypoint import host_gateway_url


def test_host_gateway_rewrites_loopback_without_changing_credentials_or_port():
    assert host_gateway_url("postgresql://user:pass@127.0.0.1:5543/db?sslmode=disable") == (
        "postgresql://user:pass@host.docker.internal:5543/db?sslmode=disable"
    )
    assert host_gateway_url("redis://localhost:6381/0") == "redis://host.docker.internal:6381/0"


def test_host_gateway_leaves_other_hosts_unchanged():
    assert host_gateway_url("postgresql://user:pass@postgres:5432/db") == (
        "postgresql://user:pass@postgres:5432/db"
    )
