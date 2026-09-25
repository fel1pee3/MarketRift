"""Explicit one-time download. Never called during worker or API startup."""
from pathlib import Path

from huggingface_hub import snapshot_download

from .embeddings import MODEL_NAME, MODEL_REVISION


def main() -> None:
    target = Path(__file__).resolve().parents[1] / ".models" / "multilingual-minilm-l12-v2"
    snapshot_download(repo_id=MODEL_NAME, revision=MODEL_REVISION, local_dir=target,
                      allow_patterns=["*.json", "*.txt", "*.model", "model.safetensors",
                                      "1_Pooling/*"])
    print(f"Model downloaded to {target}; set EMBEDDING_MODEL_PATH to this path")


if __name__ == "__main__":
    main()
