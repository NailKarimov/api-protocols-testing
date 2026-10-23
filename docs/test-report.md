# Test summary report: quotes over gRPC, WebSocket and SSE (api-protocols-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test completion report), shortened.

- **Period:** 19.10.2026 – 23.10.2026
- **Build:** `main`, latest nightly run in GitHub Actions
- **Allure report:** https://nailkarimov.github.io/api-protocols-testing/

## 1. Summary

All 79 tests pass. The three protocols agree on every price, resume without gaps or duplicates, and free their
resources. The `.proto` matches its approved snapshot.

## 2. Results

| Metric                    | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Tests run                 | 79: 47 gRPC (including the contract), 32 WebSocket and SSE |
| Passed / failed / skipped | 79 / 0 / 0                                                 |
| Duration                  | ~9 s                                                       |
| Mutation check            | 26 of 26 planted bugs caught (12 gRPC, 14 realtime)        |

## 3. Findings

| ID   | Severity       | Summary                                                                                                 | Status                         |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| PR-1 | major (design) | RPCs shared request and response messages, so they could not evolve independently (found by `buf lint`) | fixed before the first release |

## 4. Deviations from the plan

None.

## 5. Recommendations

1. Keep `buf breaking` mandatory on pull requests. It caught all 8 typical breaking edits.
2. Add a load profile for the streams (k6 has gRPC and WebSocket support) if the feed gets real users.
