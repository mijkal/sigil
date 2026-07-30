# Triage: "CI - main (c7d6748)" run-failed notification

Could not reproduce a build break on the current `main` (= this branch's HEAD,
`d855de2`). Ran every gate in `.github/workflows/ci.yml` locally and all pass:

- `go build ./...` / `go vet ./...` / `go test ./... -timeout 120s` — clean
- `npx tsc --noEmit` — clean
- `npx vitest run` — 114/114 passing
- `npm run lint` — 0 errors (7 pre-existing warnings, not gated)
- `bash scripts/lint-colors.sh` — clean
- `npx vite build` — succeeds

Reason: this notification is for commit `c7d6748` ("docs(readme): surface agent
supervision as a first-class capability"), which sits *before* the two CI fixes
already merged to main:

- `9f1b1e0` fix(ci): align setup-go version with go.mod (1.24.2)
- `ea55da7` fix(web): clear the lint-colors CI gate blocking main

Those were delivered by two earlier triage runs (`d872f39`, `d855de2`) against
the same recurring "CI failing on main" report. This looks like a stale/delayed
GitHub Actions notification for the pre-fix commit, not a new failure at
current `main`.

## Question for a human
If CI is still red on the actual current `main` HEAD (not just replaying an old
notification for c7d6748), please point to the failing run URL/job — nothing
in the workflow as configured reproduces a failure locally.
