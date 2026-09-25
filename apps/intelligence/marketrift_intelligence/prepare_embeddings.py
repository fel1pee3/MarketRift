"""Download only the pinned CPU safetensors model, on explicit operator request."""
import hashlib
import json
from pathlib import Path

from huggingface_hub import snapshot_download

from .embeddings import MODEL_NAME, MODEL_REVISION, REQUIRED_FILES

TARGET = Path(__file__).resolve().parents[1] / ".models" / "multilingual-minilm-l12-v2"
def main() -> None:
    snapshot_download(repo_id=MODEL_NAME, revision=MODEL_REVISION, local_dir=TARGET,
                      allow_patterns=list(REQUIRED_FILES), max_workers=2, token=False)
    manifest = {"repository": MODEL_NAME, "revision": MODEL_REVISION, "files": {}}
    for name in REQUIRED_FILES:
        path = TARGET / name
        if not path.is_file():
            raise RuntimeError(f"local_embedding_model_incomplete: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        manifest["files"][name] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    if manifest["files"]["model.safetensors"]["bytes"] < 100_000_000:
        raise RuntimeError("local_embedding_weights_incomplete")
    (TARGET / "marketrift-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Pinned model verified: {MODEL_REVISION}; {len(REQUIRED_FILES)} files; {TARGET}")


if __name__ == "__main__":
    main()
