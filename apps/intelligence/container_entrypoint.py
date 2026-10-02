"""Local Docker alternative for Windows hosts that block native PyTorch DLLs."""
import os
import sys
from urllib.parse import urlsplit, urlunsplit


def host_gateway_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return value
    # Preserve credentials and port verbatim; do not print either one.
    netloc = parsed.netloc
    host_start = netloc.rfind("@") + 1
    host_port = netloc[host_start:]
    host_port = host_port.replace(parsed.hostname, "host.docker.internal", 1)
    return urlunsplit(parsed._replace(netloc=netloc[:host_start] + host_port))


def main() -> None:
    for name in ("DATABASE_ADMIN_URL", "RUNTIME_DATABASE_URL", "PROVISION_DATABASE_URL",
                 "REDIS_URL"):
        if os.getenv(name):
            os.environ[name] = host_gateway_url(os.environ[name])
    command = sys.argv[1:]
    if command == ["worker"]:
        module = ["-m", "marketrift_intelligence.worker"]
    elif command == ["http"]:
        module = ["-m", "uvicorn", "marketrift_intelligence.http:app",
                  "--host", "0.0.0.0", "--port", os.getenv("INTELLIGENCE_HTTP_PORT", "8000")]
    else:
        raise SystemExit("expected worker or http")
    os.execv(sys.executable, [sys.executable, *module])


if __name__ == "__main__":
    main()
