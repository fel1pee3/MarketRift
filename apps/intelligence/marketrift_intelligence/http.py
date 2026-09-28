import json
import os
import secrets
from contextlib import asynccontextmanager
from decimal import Decimal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, ValidationError

from .b2b_eval import extract_with_current_rights
from .embeddings import DIMENSIONS, embed, identity, verify_local_model
from .extract import extract_review
from .quality_eval import EvalDataset, EvalSettings, evaluate_quality
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


@app.post("/internal/b2b-quality/evaluate")
async def b2b_quality_evaluation(payload: dict, x_internal_token: str = Header(default="")) -> dict:
    authorize(x_internal_token)
    try:
        dataset = EvalDataset.model_validate_json(json.dumps(payload.get("dataset"), ensure_ascii=False))
        options = payload.get("settings")
        if not isinstance(options, dict):
            raise TypeError("settings")
        provider = options.get("provider")
        model = options.get("model")
        if dataset.schema_version != "review-quality-dataset-v2" or not dataset.dataset_id.startswith("b2b-") or not dataset.examples:
            raise ValueError("dataset")
        if any(item.source.kind != "b2b_csv" for item in dataset.examples):
            raise ValueError("source")
        if provider == "test":
            if any(not item.synthetic for item in dataset.examples) or model != "controlled-test-fixture-v1":
                raise ValueError("controlled_only_synthetic")
        elif provider == "openai":
            if (any(item.synthetic for item in dataset.examples) or options.get("allow_paid") is not True
                    or not isinstance(model, str) or not model or not os.getenv("OPENAI_API_KEY")
                    or not 1 <= options.get("max_examples", 0) <= 3):
                raise ValueError("paid_configuration")
        else:
            raise ValueError("provider")
        settings = EvalSettings(provider=provider, model=model, max_examples=options["max_examples"],
                                max_output_tokens=options["max_output_tokens"],
                                budget_usd=Decimal(str(options["budget_usd"])) if provider == "openai" else None,
                                input_usd_per_million=Decimal(str(options["input_usd_per_million"])) if provider == "openai" else None,
                                output_usd_per_million=Decimal(str(options["output_usd_per_million"])) if provider == "openai" else None)
        if provider == "openai" and (settings.budget_usd is None or settings.budget_usd > Decimal("0.05")):
            raise ValueError("budget")
    except (ValueError, KeyError, TypeError, ValidationError):
        # Validation errors can include private review text. Do not return them.
        raise HTTPException(status_code=400, detail="invalid_quality_dataset_or_settings") from None

    async def production_extractor(text: str):
        return await extract_review(text, provider_override=provider, model_override=model,
                                    controlled_test_allowed=(provider == "test"),
                                    max_output_tokens=settings.max_output_tokens, max_retries=0)

    active = None

    async def before_extract(example):
        nonlocal active
        active = example

    async def guarded_extractor(text: str):
        if provider == "openai":
            # Re-check source, document and external AI rights under a DB lock immediately before each paid call.
            return await extract_with_current_rights(active, production_extractor)
        return await production_extractor(text)

    import hashlib
    dataset_json = json.dumps(dataset.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    return await evaluate_quality(dataset, hashlib.sha256(dataset_json.encode()).hexdigest(), settings,
                                  guarded_extractor, before_extract)
