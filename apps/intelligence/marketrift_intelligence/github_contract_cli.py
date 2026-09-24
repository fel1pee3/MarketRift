import json
import sys

from .github_issues import validate_job


def main() -> None:
    validate_job(json.load(sys.stdin))
    print("valid")


if __name__ == "__main__":
    main()
