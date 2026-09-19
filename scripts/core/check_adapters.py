"""Deterministic adapters for explicitly selected test runners, not console text."""
from __future__ import annotations

import json
from pathlib import Path
import stat
import sys
import unittest
import xml.etree.ElementTree as ET

LIMIT = 1024 * 1024
ADAPTERS = ("exit-code", "junit", "python-unittest", "node-test", "playwright")


def bounded_bytes(path):
    if not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > LIMIT:
        raise ValueError("Report is not a bounded regular file")
    with path.open("rb") as source:
        raw = source.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("Report is too large")
    return raw


def counts(tests, failures=0, errors=0, skipped=0):
    value = dict(tests=tests, failures=failures, errors=errors, skipped=skipped)
    if any(type(n) is not int or not 0 <= n <= 1000000 for n in value.values()) or failures + errors + skipped > tests:
        raise ValueError("Invalid test counts")
    return value


def report_summary(path, adapter="junit"):
    raw = bounded_bytes(path)
    if adapter in {"junit", "node-test"}:
        if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
            raise ValueError("DTD reports are unsupported")
        tree = ET.fromstring(raw)
        if tree.tag not in {"testsuites", "testsuite"}:
            raise ValueError("Not a JUnit report")
        cases = list(tree.iter("testcase"))
        has_cases = {}
        for suite in reversed(list(tree.iter())):
            has_cases[suite] = suite.tag == "testcase" or any(has_cases[child] for child in suite)
            if suite.tag in {"testsuite", "testsuites"} and not has_cases[suite]:
                for field in ("tests", "failures", "errors", "skipped"):
                    if field in suite.attrib and int(suite.attrib[field]) != 0:
                        raise ValueError("Aggregate-only JUnit counts have no testcase evidence")
        # Node TODOs remain skipped even when their unfinished body fails.
        # Other testcase results use error, failure, then skip precedence.
        outcomes = []
        for case in cases:
            skipped = case.find("skipped")
            if adapter == "node-test" and skipped is not None and skipped.get("type") == "todo":
                outcomes.append("skipped")
            elif case.find("error") is not None:
                outcomes.append("errors")
            elif case.find("failure") is not None:
                outcomes.append("failures")
            elif skipped is not None:
                outcomes.append("skipped")
        return counts(len(cases), outcomes.count("failures"), outcomes.count("errors"), outcomes.count("skipped"))
    value = json.loads(raw)
    if adapter == "python-unittest":
        if not isinstance(value, dict) or value.get("version") != 1 or value.get("adapter") != adapter or value.get("completed") is not True:
            raise ValueError("Incomplete unittest report")
        if value.get("runnerErrors", 0):
            raise ValueError("Unittest fixture errors are outside executed testcase totals")
        return counts(**value["tests"])
    if adapter == "playwright":
        if not isinstance(value, dict) or not isinstance(value.get("suites"), list) or not isinstance(value.get("stats"), dict):
            raise ValueError("Not a Playwright JSON report")
        if value.get("errors"):
            raise ValueError("Playwright runner errors are outside executed testcase totals")
        statuses = []

        def visit(suites, depth=0):
            if depth > 40:
                raise ValueError("Nested report limit exceeded")
            for suite in suites:
                for spec in suite.get("specs", []):
                    for test in spec["tests"]:
                        status = test["status"]
                        if status not in {"expected", "unexpected", "flaky", "skipped"}:
                            raise ValueError("Unknown Playwright test result")
                        statuses.append(status)
                visit(suite.get("suites", []), depth + 1)

        visit(value["suites"])
        # Retries belong to one test. Flaky tests eventually meet expectations.
        result = counts(len(statuses), statuses.count("unexpected"), 0, statuses.count("skipped"))
        stats = value["stats"]
        for key in ("expected", "unexpected", "flaky", "skipped"):
            if type(stats.get(key)) is not int or stats[key] != statuses.count(key):
                raise ValueError("Playwright totals do not match test results")
        return result
    raise ValueError("No report adapter selected")


class ObservedResult(unittest.TextTestResult):
    """Count terminal test cases once even when multiple subtests fail."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outcomes = {}
        self.runner_errors = 0

    def startTest(self, test):
        self.outcomes[id(test)] = "passed"
        super().startTest(test)

    def addFailure(self, test, error):
        if self.outcomes.get(id(test)) != "errors":
            self.outcomes[id(test)] = "failures"
        super().addFailure(test, error)

    def addError(self, test, error):
        if id(test) in self.outcomes:
            self.outcomes[id(test)] = "errors"
        else:
            self.runner_errors += 1
        super().addError(test, error)

    def addSkip(self, test, reason):
        parent = getattr(test, "test_case", test)
        if self.outcomes.get(id(parent)) == "passed":
            self.outcomes[id(parent)] = "skipped"
        super().addSkip(test, reason)

    def addUnexpectedSuccess(self, test):
        self.outcomes[id(test)] = "failures"
        super().addUnexpectedSuccess(test)

    def addExpectedFailure(self, test, error):
        self.outcomes[id(test)] = "skipped"
        super().addExpectedFailure(test, error)

    def addSubTest(self, test, subtest, error):
        if error:
            if not issubclass(error[0], test.failureException):
                self.outcomes[id(test)] = "errors"
            elif self.outcomes.get(id(test)) != "errors":
                self.outcomes[id(test)] = "failures"
        super().addSubTest(test, subtest, error)


def unittest_main(arguments):
    report = Path(arguments[0])
    sys.path.insert(0, str(Path.cwd()))
    class Runner(unittest.TextTestRunner):
        resultclass = ObservedResult

    program = unittest.TestProgram(module=None, argv=["python -m unittest", *arguments[1:]], testRunner=Runner, exit=False)
    result = program.result
    outcomes = list(result.outcomes.values())
    value = {"version": 1, "adapter": "python-unittest", "completed": True, "runnerErrors": result.runner_errors,
             "tests": counts(result.testsRun, outcomes.count("failures"), outcomes.count("errors"), outcomes.count("skipped"))}
    # Reporting failure must preserve the actual unittest result.
    try:
        report.write_text(json.dumps(value) + "\n", encoding="utf-8")
    except OSError as error:
        print(f"Check observation unavailable: {error}", file=sys.stderr)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(unittest_main(sys.argv[1:]))
