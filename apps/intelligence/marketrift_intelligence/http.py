import os
import secrets

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .embeddings import DIMENSIONS, embed, identity

app = FastAPI(title="MarketRift Intelligence Internal")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class EmbeddingRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@app.post("/internal/embeddings")
def embedding(request: EmbeddingRequest, x_internal_token: str = Header(default="")) -> dict:
    expected = os.getenv("EMBEDDING_INTERNAL_TOKEN", "")
    if not expected or (os.getenv('NODE_ENV') == 'production' and
                        (len(expected) < 32 or expected.startswith('replace-with-'))) or not secrets.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=401, detail="internal_auth_required")
    try:
        model, version = identity()
        vector = embed(request.text)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    return {"model": model, "version": version, "dimensions": DIMENSIONS, "vector": vector,
            "test_only": model.startswith("controlled-")}
