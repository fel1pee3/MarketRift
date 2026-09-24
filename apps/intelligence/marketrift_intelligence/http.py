from fastapi import FastAPI

app = FastAPI(title="MarketRift Intelligence Internal")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
