"""Restore control lives in postgres, outside the application database dump."""

import asyncio
import os
from urllib.parse import urlsplit, urlunsplit

import psycopg


def _status() -> str:
    database_url = os.getenv("RUNTIME_DATABASE_URL", "")
    if not database_url:
        return "unavailable"
    try:
        parsed = urlsplit(database_url)
        database_name = parsed.path.lstrip("/")
        if not database_name or database_name == "postgres":
            return "unavailable"
        control_url = urlunsplit((parsed.scheme, parsed.netloc, "/postgres", parsed.query, ""))
        with psycopg.connect(control_url, connect_timeout=2) as connection, connection.cursor() as cursor:
            cursor.execute("SELECT state,database_name FROM public.marketrift_restore_gate WHERE id=true")
            row = cursor.fetchone()
        if not row or row[1] != database_name:
            return "unavailable"
        return "released" if row[0] == "released" else "quarantined"
    except psycopg.errors.UndefinedTable:
        return "unavailable" if os.getenv("RESTORE_GATE_REQUIRED") == "1" else "released"
    except (psycopg.Error, ValueError, OSError):
        return "unavailable"


async def status() -> str:
    # psycopg async connections require SelectorEventLoop on Windows; FastAPI tests
    # and uvicorn may choose another loop. A short sync check in a thread is portable.
    return await asyncio.to_thread(_status)


async def require_released() -> None:
    gate = await status()
    if gate != "released":
        raise RuntimeError(f"restore_{gate}")
