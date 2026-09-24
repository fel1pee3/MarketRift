"""Validate one producer payload from stdin for the cross-language contract test."""

import json
import sys

from .analysis_job import validate_analysis_job
from .job import validate_job


def main() -> None:
    payload = json.load(sys.stdin)
    if len(sys.argv) > 1 and sys.argv[1] == "analysis":
        validate_analysis_job(payload)
    else:
        validate_job(payload)
    print("valid")


if __name__ == "__main__":
    main()
