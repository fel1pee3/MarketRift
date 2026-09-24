"""Validate one producer payload from stdin for the cross-language contract test."""

import json
import sys

from .job import validate_job


def main() -> None:
    validate_job(json.load(sys.stdin))
    print("valid")


if __name__ == "__main__":
    main()
