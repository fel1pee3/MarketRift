import os
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .embeddings import DIMENSIONS, embed, identity, verify_local_model
from .retrieval_eval import FROZEN_CONTRACT_VERSION, FROZEN_EVALUATOR_VERSION, evaluate_frozen


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.getenv("EMBEDDING_PROVIDER") == "local":
        verify_local_model()
        embed("MarketRift local model warmup")
    yield


app = FastAPI(title="MarketRift Intelligence Internal", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class EmbeddingRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


def authorize(x_internal_token: str) -> None:
    expected = os.getenv("EMBEDDING_INTERNAL_TOKEN", "")
    if not expected or (os.getenv('NODE_ENV') == 'production' and
                        (len(expected) < 32 or expected.startswith('replace-with-'))) or not secrets.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=401, detail="internal_auth_required")


@app.get("/internal/embeddings/status")
def embedding_status(x_internal_token: str = Header(default="")) -> dict:
    authorize(x_internal_token)
    try:
        model, version = identity()
        if os.getenv("EMBEDDING_PROVIDER", "controlled") == "local":
            verify_local_model()
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    return {"model": model, "version": version, "dimensions": DIMENSIONS,
            "retrieval_evaluator_version": FROZEN_EVALUATOR_VERSION,
            "retrieval_contract_version": FROZEN_CONTRACT_VERSION,
            "test_only": model.startswith("controlled-")}


@app.post("/internal/embeddings")
def embedding(request: EmbeddingRequest, x_internal_token: str = Header(default="")) -> dict:
    authorize(x_internal_token)
    try:
        model, version = identity()
        vector = embed(request.text)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    return {"model": model, "version": version, "dimensions": DIMENSIONS, "vector": vector,
            "test_only": model.startswith("controlled-")}


@app.post("/internal/retrieval/evaluate")
def retrieval_evaluation(dataset: dict, x_internal_token: str = Header(default="")) -> dict:
    authorize(x_internal_token)
    test_only = (dataset.get("origin") == "synthetic" and os.getenv("MARKETRIFT_TEST_MODE") == "1"
                 and os.getenv("EMBEDDING_PROVIDER") == "controlled"
                 and os.getenv("NODE_ENV") != "production")
    if not test_only and (dataset.get("origin") != "real" or os.getenv("EMBEDDING_PROVIDER") != "local"):
        raise HTTPException(status_code=503, detail="local_model_required")
    try:
        return evaluate_frozen(dataset, providers=("controlled",) if test_only else ("local", "controlled"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except RuntimeError:
        raise HTTPException(status_code=503, detail="local_model_unavailable") from None
