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
7. Run a 144-cell sensitivity grid to find load-bearing motivation axes. Each
   cell compares low (`0.2`) versus high (`0.8`) settings for one target axis.

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

## Full evaluation run locally

The paper-grade evaluation path is the canonical battery:

- 9 adoption cases x 4 profiles x 5 trials = 180 subject-model outputs.
- 20 same-profile baseline calls for the coding-assistant case.
- 144 sensitivity-grid cells. Each cell runs two endpoint calls for one target
  axis, setting it low (`0.2`) and high (`0.8`) while holding other axes fixed.
- L1/L2/L3 audit for the 180 subject outputs.

This repo now has a standalone local runner, so you do not need the remote
Cloudflare URL or hosted D1/KV/R2 bindings for the paper evaluation. The runner
reads `.dev.vars`, calls OpenAI directly from Node when `DEMO_MODE=false`, and
writes the summary files used by the local website and paper.

For paper-grade numbers, put your key in `.dev.vars`:

```bash
DEMO_MODE=false
OPENAI_API_KEY=sk-...
```

Then run:

```bash
npm run eval:local -- --reset
```

If the key is already available as a shell environment variable and you do not
want to edit `.dev.vars`, use:

```bash
npm run eval:local -- --reset --live
```

The command is resumable. If it stops partway through, run `npm run eval:local`
again without `--reset` and it will keep completed cells from the raw local
state.

Generated artifacts:

- `evaluation-results/local-canonical-evaluation.raw.json` - full local run state.
- `evaluation-results/local-canonical-evaluation.summary.json` - paper-ready metrics.
- `public/evaluation/latest-local-evaluation.json` - loaded by the Method / Report tab.
- `final_program_tex/local_eval_results.tex` - included by `final_project.tex`.

For a deterministic smoke test, keep `.dev.vars` in demo mode and pass
`--demo` explicitly:

```bash
npm run eval:local -- --reset --demo
```

Without `--demo`, the runner refuses to produce a paper table while
`DEMO_MODE=true`; this prevents accidentally submitting demo numbers as live
OpenAI evaluation results.

After a live local evaluation, rebuild the report PDF:

```bash
cd final_program_tex
pdflatex final_project.tex
pdflatex final_project.tex
```

To view the summary in the frontend, start the local app and open the
Method / Report tab:

```bash
npm run dev:all
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
- `GET /api/evaluations/adoption-readiness`
- `GET /api/evaluations/canonical-battery?batteryId=<battery-id>`

## Local verification status

The local runner completed the paper-grade live OpenAI evaluation with
`DEMO_MODE=false` and `OPENAI_MODEL=gpt-5.4-nano`:

- 180/180 subject-model outputs.
- 20/20 same-profile baseline calls.
- 144/144 sensitivity-grid low-vs-high contrast cells with 0 grid errors.
- Average modal stability: `86.1%`.
- Divergent scenario rate: `44.4%`.
- Intervention-card complete output rate: `100.0%`.
- Three-layer audit coverage: `180/180`.
- Previous sensitivity-grid flip rate: `23.6%`.
- Same-profile baseline average modal stability: `90.0%`.

These values were generated before the low-vs-high contrast grid update. Rerun
`npm run eval:local -- --live --reset` before using final sensitivity-grid
numbers in the report.

The generated live summary is in
`evaluation-results/local-canonical-evaluation.summary.json`, the frontend reads
`public/evaluation/latest-local-evaluation.json`, and the report includes
`final_program_tex/local_eval_results.tex`.

## Evaluation plan and current evidence

The strongest evaluation shape for this pivot is not a generic accuracy score.
It should prove that MotiveOps is doing adoption-specific work:

- **Playbook retrieval accuracy**: for each of the 9 adoption cases, define
  expected blocker-policy ids and check whether retrieval returns them. The
  current deterministic fixture reports Top-1 accuracy `9/9 = 1.00` and Top-3
  expected-policy coverage `20/26 = 0.769`.
- **Intervention card completeness**: every generated output is expected to
  include `diagnosedBlocker`, `motivationProfile`, `retrievedStrategy`,
  `microAction`, `ifThenPlan`, `accountabilityScript`, and `successMetric`.
  The live local canonical summary reports complete-output rate `180/180 =
  1.00`.
- **Canonical sensitivity battery**: `npm run eval:local` reports subject
  completion, profile-cell modal stability, profile divergence, three-layer
  audit coverage, same-profile baseline stability, and the 144-cell endpoint
  flip rate. Rerun the live evaluation after grid-method changes
  before reporting final values.
- **Bad advice detection**: the regression fixture marks "Use AI for all coding
  tasks this week to maximize productivity" as `Contradictory` for the
  low-trust/security-anxiety case.
- **Motivational alignment accuracy**: this is not claimed yet. It should be
  measured with 20-30 hand-labeled outputs before reporting human-label
  agreement against L1/L2/L3.

Local summary files:

```text
evaluation-results/local-canonical-evaluation.summary.json
public/evaluation/latest-local-evaluation.json
final_program_tex/local_eval_results.tex
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
