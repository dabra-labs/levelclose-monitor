# LevelClose public health monitor

This standalone monitor observes only the already public
`https://levelclose.com/api/health`. It contains no private application code,
customer data, production credentials or npm dependencies. Node 24 runs on a
standard GitHub-hosted Ubuntu runner in this public repository.
[Standard public runners are free](https://docs.github.com/en/actions/concepts/billing-and-usage).
Do not move this workflow into a private hosted repository or choose a larger
runner without separately approving its cost.

## What it proves

HTTP 200, `ok: true`, and exactly one healthy `database`, `signin`,
`identity_api` and `auth_project` check are required. Redirects, skipped or
missing checks, invalid bodies and timeouts are failures. The target is fixed.
Requests finish within 10 seconds and response bodies are limited to 8 KiB.
Logs and incidents contain only sanitized result codes and run links.

An outage creates one labeled issue. Continued failures leave it unchanged;
recovery updates and closes that same issue once. The monitor never assigns
or mentions someone. GitHub API failure fails the run; it does not prove an
alert was delivered. A healthy response does not prove sign-in completion,
accounting correctness, backup recovery or the accuracy of customer data.
Workflow success means the probe and incident handling completed; a confirmed
outage can still have a green run after its incident was recorded. Read the
sanitized observation and incident state rather than treating a green badge
as service health.

The four-check contract was reviewed against LevelClose `CheckName` on
2026-09-30. Review both sides deliberately if the public contract changes;
do not accept arbitrary extra/missing checks as healthy.

## Publication checklist

This payload is prepared, not operational. Publish only these four files into
a fresh public repository, without the application's history. Enable issues
and pre-create labels `levelclose-monitor` and `self-test`. Do not add personal
tokens or production secrets: the workflow uses its own short-lived token
only for its own repository's issue API.

Record repository URL: **pending publication**.
Record publication date: **pending publication**.
First monthly owner review due: **set to publication date plus one month**.
Owner notification delivery: **unverified**.

Run live mode once. Then dispatch `synthetic-failure` twice and
`synthetic-recovery` twice: one conspicuously labeled SELF-TEST issue should
be created and closed, with no repeated issue writes. Synthetic modes never
request or alter the product and cannot close a live incident. Confirm the
next scheduled live run actually occurs.

Munish must watch this repository with issue notifications enabled and
confirm receiving the synthetic incident and recovery. Record actual evidence
before replacing the unverified delivery status. Do not infer delivery from
an issue, successful workflow or default email preferences.

## Schedule and monthly owner review

The intended interval is 15 minutes, at UTC minutes 7, 22, 37 and 52.
[GitHub schedules can be delayed or dropped](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule);
this is not an uptime SLA and it cannot independently detect GitHub's own
outage. Public schedules disable after 60 days without repository activity.

Every month the delegated owner checks recent scheduled runs and enabled
state, repeats the synthetic exercise, confirms owner notification settings,
and adds a genuine dated review entry below with evidence and the next due
date. Do not create dummy commits to manufacture activity. If disabled,
[re-enable the workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
and verify the next scheduled run. Manual dispatch alone is not proof that
the inactivity clock was reset.

Review log: **none yet; publication and delivery verification are pending**.

## Local verification

Run `node --test monitor.test.mjs` on Node 24. Tests use synthetic responses
and injected GitHub adapters; they do not contact the product or create issues.
Official action pins were read from their upstream v5 references on
2026-09-30: [checkout](https://github.com/actions/checkout/commit/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09),
[setup-node](https://github.com/actions/setup-node/commit/a0853c24544627f65ddf259abe73b1d18a591444).
