import json
import sys

from .web_pages import validate_job

if __name__ == "__main__":
    validate_job(json.load(sys.stdin))
    print("valid")
