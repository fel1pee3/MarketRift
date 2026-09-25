"""Private embeddings. Controlled vectors exercise plumbing; local vectors use pinned weights."""
import hashlib
import math
import os
import re
from functools import lru_cache

DIMENSIONS = 384
MODEL_REVISION = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def identity() -> tuple[str, str]:
    provider = os.getenv("EMBEDDING_PROVIDER", "controlled")
    if provider == "controlled":
        return "controlled-hash-TESTE", "1"
    if provider == "local":
        return MODEL_NAME, MODEL_REVISION
    raise ValueError("unknown_embedding_provider")


@lru_cache(maxsize=1)
def _local_model():
    path = os.getenv("EMBEDDING_MODEL_PATH", "")
    if not path or not os.path.isdir(path):
        raise RuntimeError("local_embedding_model_missing")
    from sentence_transformers import SentenceTransformer  # optional; never downloads at runtime

    return SentenceTransformer(path, local_files_only=True)


def embed(text: str) -> list[float]:
    if not text.strip() or len(text) > 12000:
        raise ValueError("invalid_embedding_input")
    if os.getenv("EMBEDDING_PROVIDER", "controlled") == "local":
        vector = _local_model().encode(text, normalize_embeddings=True).tolist()
        if len(vector) != DIMENSIONS:
            raise RuntimeError("embedding_dimension_mismatch")
        return [float(value) for value in vector]
    identity()
    # Deterministic bag of words for TESTE only. It does not establish semantic quality.
    vector = [0.0] * DIMENSIONS
    for token in re.findall(r"\w+", text.casefold(), flags=re.UNICODE):
        digest = hashlib.sha256(token.encode()).digest()
        vector[int.from_bytes(digest[:4], "big") % DIMENSIONS] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else vector
