"""Validate the TypeScript-produced job without exposing its contents."""

import json
import sys

from .github_discussions import validate_job

validate_job(json.load(sys.stdin))
print("valid")
