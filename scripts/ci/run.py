"""Run a command verbatim, streaming its output to the console and a CI log."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", args.label):
        parser.error("label must contain only letters, numbers, underscores, or hyphens")
    if not args.command:
        parser.error("a command is required")
    directory = Path("ci-results")
    directory.mkdir(exist_ok=True)
    logfile = directory / f"{args.label}.log"
    with logfile.open("wb") as log:
        try:
            process = subprocess.Popen(args.command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except OSError as exc:
            message = f"Could not launch command: {exc}\n"
            print(message, file=sys.stderr, end="")
            log.write(message.encode("utf-8"))
            code = 127
        else:
            try:
                while True:
                    chunk = process.stdout.read1(65536)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                    log.write(chunk)
                    log.flush()
                code = process.wait()
            except KeyboardInterrupt:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                code = 130
            finally:
                process.stdout.close()
    # POSIX signal termination is negative; returning it directly is ambiguous.
    if code < 0:
        code = 128 - code
    status = "PASS" if code == 0 else "FAIL"
    message = f"{status}: {args.label} (exit {code}); log: {logfile.as_posix()}"
    print(message, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write(f"- **{status}** `{args.label}` — exit `{code}`, log `{logfile.as_posix()}`\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
