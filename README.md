# MotiveOps

**Motivation-Aware Agent for AI Workflow Adoption**

MotiveOps reframes the original Motivation Lab project from a moral decision
observatory into a B2B research prototype for one money-facing problem:

> Companies buy AI tools, but employees often do not convert training and seat
> licenses into repeated workflow use.

The product claim is that AI adoption failure is not only a tooling problem.
It is also a motivation, trust, competence, and psychological-safety problem.
MotiveOps diagnoses the worker's adoption blocker, retrieves a matching
behavioral intervention policy, recommends a small motivationally aligned
micro-action, and audits whether its own recommendation matches the intended
motivation frame.

## Why this pivot

Enterprise AI spend is already large, but business value is uneven:

- Stanford HAI's 2025 AI Index reports that 78 percent of organizations used
  AI in 2024, up from 55 percent the previous year, while U.S. private AI
  investment reached $109.1B.
- McKinsey's 2025 workplace AI report frames the gap as a scaling problem:
  almost all companies invest in AI, but only 1 percent believe they have
  reached AI maturity.
- McKinsey's 2025 global AI survey reports that most organizations are still
  experimenting or piloting, and only 39 percent report enterprise-level EBIT
  impact.
- MIT NANDA's 2025 GenAI Divide report argues that many pilots stall because of
  workflow integration and organizational learning gaps, not because foundation
  models are incapable.

MotiveOps turns that gap into a focused research and product wedge: help an
organization convert paid AI capability into actual employee adoption by making
the first action low-risk, personally relevant, and auditable.

Sources used in the report and docs:

- Stanford HAI, [2025 AI Index Report](https://hai.stanford.edu/ai-index/2025-ai-index-report)
- McKinsey, [Superagency in the workplace](https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/superagency-in-the-workplace-empowering-people-to-unlock-ais-full-potential-at-work)
- McKinsey, [The state of AI in 2025](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai/)
- MIT NANDA, [The GenAI Divide: State of AI in Business 2025](https://pureinsights.com/wp-content/uploads/2025/09/MIT-Report-v0.1_State_of_AI_in_Business_2025_Report.pdf)

## Product definition

**One sentence**

MotiveOps helps companies turn AI training into actual AI usage by diagnosing
each worker's adoption blocker and generating a personalized, motivationally
aligned micro-intervention.

**Presentation version**

When a company introduces an AI coding assistant, Copilot, ChatGPT Enterprise,
Cursor, or an internal agent, employees may avoid it because they do not trust
the output, fear manager evaluation, expect rework, or do not know where AI
fits. MotiveOps identifies that blocker and recommends a safe first step.

## What changed from Motivation Lab

The technical structure is intentionally preserved.

| Old frame | MotiveOps frame |
| --- | --- |
| Scenario | AI workflow adoption case |
| Motivation profile | Motivation profile |
| Decision options | Intervention options |
| L1/L2/L3 decision audit | L1/L2/L3 intervention alignment audit |
| Heatmap of decision flips | Heatmap of intervention sensitivity |
| Research demo | B2B adoption and ROI demo |

The app still uses the same experiment shape:

1. Choose one of 9 canonical cases.
2. Run four motivation profiles against the same case.
3. Aggregate 5 trials per profile.
4. Judge the chosen intervention with a separate model.
5. Extract the rationale motivation.
6. Classify L1/L2/L3 alignment.
7. Run a 144-cell sensitivity grid to find load-bearing motivation axes.

## Behavioral Intervention Playbook

The new `src/domain/intervention-playbook.ts` layer acts like a lightweight RAG
policy source. It does not retrieve factual trivia. It retrieves adoption
intervention policies:

```json
{
  "blocker": "low trust in AI output",
  "signals": ["I do not trust the output", "What if it is wrong?", "It creates rework"],
  "recommendedFrame": ["Security", "Competence"],
  "strategy": "bounded low-risk experiment",
  "interventionTemplate": "Use AI only on a reversible support task with a clear stop condition.",
  "avoid": "forcing full workflow adoption or productivity pressure"
}
```

The prompt receives the top matching policies, then returns the same structured
JSON contract used by the original app. That keeps backend changes small while
changing the product meaning.

## Example demo

Input:

```text
My company introduced an AI coding assistant and wants us to use it, but I avoid
using it because I do not trust the output, I am afraid it will slow me down,
and I do not want my manager to think I am dependent on AI.
```

Expected MotiveOps output:

```text
Diagnosed blocker:
Low trust in output; fear of evaluation; concern about rework.

Motivation profile:
Primary: Security / Preservation.
Secondary: Competence / Achievement.
Avoid: pressure-based adoption.

Retrieved strategy:
Bounded low-risk experiment; small mastery experience.

Micro-action:
Tomorrow at 10am, use the AI assistant only to generate unit test names for one
low-risk function. Do not accept code directly. Compare its suggestions with
your own list and keep only useful ideas.

Manager-safe accountability:
I am testing AI on low-risk support tasks first and tracking where it saves time
versus where it creates rework.

Audit:
L1 intended: Security + Competence.
L2 action: low-risk experiment + skill-building.
L3 rationale: reduce uncertainty + build confidence.
Classification: Aligned.
```

## Repository map

- `src/domain/seeds.ts` - 9 AI workflow adoption cases and 4 motivation profiles.
- `src/domain/intervention-playbook.ts` - heuristic playbook retrieval layer.
- `src/services/prompts.ts` - MotiveOps prompt translation.
- `src/services/provider.ts` - OpenAI/mock provider and moderator commentary.
- `src/judges/value-judge.ts` - L2 intervention motivation judge.
- `src/extractors/rationale-values.ts` - L3 rationale motivation extractor.
- `src/experiments/canonical-battery.ts` - 9-case canonical battery runner.
- `src/experiments/sensitivity-grid.ts` - 144-cell load-bearing heatmap runner.
- `src/App.jsx` and `src/ui/` - 5-tab research UI.
- `final_program_tex/final_project.tex` - final report source outside this
  Vite app directory.

## Local setup

```bash
npm install
npm run dev
```

`npm run dev` starts only the Vite frontend. The screen will load, but API-backed
actions such as diagnostics, experiment runs, Q&A, evidence, and artifacts need
the local Cloudflare Worker too.

For the normal UI/UX test path, create local Worker variables and run the Vite
frontend and Cloudflare Worker together:

```bash
cp dev.vars.example .dev.vars
npm run dev:all
```

This starts both local servers from one terminal. Stop both with `Ctrl+C`.

If you want to run them separately, use two terminals:

```bash
npm run dev
npm run dev:worker
```

The Vite app runs locally and proxies API calls to the Worker origin configured
in `vite.config.js`. By default, `/api/*` is proxied to
`http://127.0.0.1:8787`, the usual `wrangler dev` origin. If Wrangler is running
on a different origin, start Vite with `VITE_WORKER_ORIGIN`:

```bash
VITE_WORKER_ORIGIN=http://127.0.0.1:8788 npm run dev
```

### OpenAI/API mode

The example local variables set `DEMO_MODE=true`, so the Worker can run without
an OpenAI API key and will return deterministic demo results where live model
calls would otherwise be used.

To test live OpenAI calls locally, edit `.dev.vars`:

```bash
DEMO_MODE=false
OPENAI_API_KEY=sk-...
```

Alternatively, keep `DEMO_MODE=true` and paste an OpenAI key into the app's
settings panel. The browser sends that key to the Worker in the `X-OpenAI-Key`
header for API calls that can use OpenAI. Do not commit `.dev.vars`; it is
ignored by git.

Useful verification:

```bash
npm run typecheck
npm run build
```

## API surface

The route names still use `scenario` and `decision` in a few data contracts for
backward compatibility, but their semantic meaning is now adoption cases and
intervention choices.

- `GET /api/scenarios`
- `GET /api/scenarios/:id`
- `POST /api/scenarios/custom`
- `GET /api/value-profiles`
- `POST /api/experiments/run`
- `POST /api/research/run-canonical-battery`
- `GET /api/research/canonical-evidence`
- `POST /api/sensitivity-grid`
- `GET /api/sensitivity-grid/:jobId`
- `POST /api/sensitivity-grid/:jobId/retry-failed`
- `POST /api/three-layer-analysis/:runId`
- `GET /api/evidence-ledger`
- `GET /api/artifacts/:runId`
- `POST /api/questions/answer`

## Production verification

Production URL:

```text
https://motiveops-api-production.blueredian.workers.dev
```

Latest deployment is configured with `DEMO_MODE=false` and a Cloudflare Worker
`OPENAI_API_KEY` secret. Diagnostics confirm D1, KV, and R2 bindings are
healthy.

After the OpenAI billing/quota issue was fixed, live OpenAI verification
succeeded:

- `POST /api/questions/answer` returned `mode=openai`.
- `POST /api/experiments/run` returned HTTP `200`, `status=completed`, and
  4/4 profile outputs for run `run_db266deecdfe4499`.
- Achievement and Preservation selected `option_b` (10-minute unit-test-name
  experiment).
- Exploration selected `option_d` (choose-your-own support-task sandbox).
- Neutral selected `option_c` (manager-safe accountability statement).
- Synthesis reported substantive divergence with divergence metric `0.6667`.
- Three-layer audit distribution: 1 Aligned, 1 Rationalizing, 1 Drifting, and
  1 Contradictory.

## Evaluation plan and current evidence

The strongest evaluation shape for this pivot is not a generic accuracy score.
It should prove that MotiveOps is doing adoption-specific work:

- **Playbook retrieval accuracy**: for each of the 9 adoption cases, define
  expected blocker-policy ids and check whether retrieval returns them. The
  current deterministic fixture reports Top-1 accuracy `9/9 = 1.00` and Top-3
  expected-policy coverage `20/26 = 0.769`.
- **Intervention card completeness**: every generated output is now expected to
  include `diagnosedBlocker`, `motivationProfile`, `retrievedStrategy`,
  `microAction`, `ifThenPlan`, `accountabilityScript`, and `successMetric`.
  The latest live run reports field completeness `1.00` and complete-output
  rate `4/4 = 1.00`.
- **Bad advice detection**: the regression fixture marks "Use AI for all coding
  tasks this week to maximize productivity" as `Contradictory` for the
  low-trust/security-anxiety case.
- **Motivational alignment accuracy**: this is not claimed yet. It should be
  measured with 20-30 hand-labeled outputs before reporting human-label
  agreement against L1/L2/L3.

Endpoint:

```text
GET /api/evaluations/adoption-readiness?runId=<optional-run-id>
```

## Business framing

MotiveOps is not an employee surveillance tool and not an HR decision system.
The commercial wedge is adoption enablement:

- Reduce wasted AI seat spend by increasing activated usage.
- Move AI training from generic content into personalized workflow trials.
- Give managers a safer language for accountability without stigma.
- Produce evidence about which motivational frame is load-bearing for each
  blocker.
- Connect adoption analytics to a controllable intervention layer instead of
  only reporting usage dashboards.

## Guardrails

- Fictional workplace adoption cases only.
- Not HR, legal, employment, or performance-management advice.
- No claim that the 4-axis model is a validated employee assessment.
- No production personnel decision should be made from this prototype.
- The paper treats outputs as experimental evidence about model behavior and
  intervention alignment.
