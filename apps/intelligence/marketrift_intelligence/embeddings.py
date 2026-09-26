"""Private embeddings. Controlled vectors exercise plumbing; local vectors use pinned weights."""
import hashlib
import math
import os
import re
from functools import lru_cache
from pathlib import Path
from threading import Lock

DIMENSIONS = 384
MODEL_REVISION = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
REQUIRED_FILES = (
    "1_Pooling/config.json", "config.json", "config_sentence_transformers.json",
    "model.safetensors", "modules.json", "sentence_bert_config.json",
    "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
)
_model_lock = Lock()


def identity(provider: str | None = None) -> tuple[str, str]:
    provider = provider or os.getenv("EMBEDDING_PROVIDER", "controlled")
    if provider == "controlled":
        return "controlled-hash-TESTE", "1"
    if provider == "local":
        return MODEL_NAME, MODEL_REVISION
    raise ValueError("unknown_embedding_provider")


@lru_cache(maxsize=1)
def verify_local_model() -> Path:
    path = os.getenv("EMBEDDING_MODEL_PATH", "")
    target = Path(path) if path else None
    if target is None or not target.is_dir():
        raise RuntimeError("local_embedding_model_missing: run npm run prepare:embeddings")
    manifest_path = target / "marketrift-manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("local_embedding_manifest_missing: run npm run prepare:embeddings")
    import json

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("repository") != MODEL_NAME or manifest.get("revision") != MODEL_REVISION:
        raise RuntimeError("local_embedding_revision_mismatch")
    if set(manifest.get("files", {})) != set(REQUIRED_FILES):
        raise RuntimeError("local_embedding_model_incomplete")
    for name, expected in manifest["files"].items():
        file = (target / name).resolve()
        if not file.is_relative_to(target.resolve()) or not file.is_file() or file.stat().st_size != expected["bytes"]:
            raise RuntimeError("local_embedding_model_incomplete")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected["sha256"]:
            raise RuntimeError("local_embedding_checksum_mismatch")
    if (target / "pytorch_model.bin").exists():
        raise RuntimeError("local_embedding_weights_invalid")
    return target


@lru_cache(maxsize=1)
def _local_model():
    path = verify_local_model()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    import torch
    from sentence_transformers import SentenceTransformer  # optional; no runtime download

    torch.set_num_threads(2)
    return SentenceTransformer(str(path), device="cpu", local_files_only=True,
                               trust_remote_code=False, model_kwargs={"use_safetensors": True})


def embed(text: str, provider: str | None = None) -> list[float]:
    if not text.strip() or len(text) > 12000:
        raise ValueError("invalid_embedding_input")
    selected = provider or os.getenv("EMBEDDING_PROVIDER", "controlled")
    if selected == "local":
        with _model_lock:
            vector = _local_model().encode(text, normalize_embeddings=True).tolist()
        if len(vector) != DIMENSIONS:
            raise RuntimeError("embedding_dimension_mismatch")
        return [float(value) for value in vector]
    identity(selected)
    # Deterministic bag of words for TESTE only. It does not establish semantic quality.
    vector = [0.0] * DIMENSIONS
    for token in re.findall(r"\w+", text.casefold(), flags=re.UNICODE):
        digest = hashlib.sha256(token.encode()).digest()
        vector[int.from_bytes(digest[:4], "big") % DIMENSIONS] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else vector
