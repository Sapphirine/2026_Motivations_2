# MotiveOps

**Motivation-Aware Agent for AI Workflow Adoption**

MotiveOps is a B2B research prototype for one practical AI-adoption problem:

> Companies buy AI tools, but employees often do not convert training and seat
> licenses into repeated workflow use.

The product claim is that AI adoption failure is not only a tooling problem.
It is also a motivation, trust, competence, and psychological-safety problem.
MotiveOps diagnoses the worker's adoption blocker, retrieves a matching
behavioral intervention policy, recommends a small motivationally aligned
micro-action, and audits whether its own recommendation matches the intended
motivation frame.

The optional local Policy-Grounding RAG sidecar adds a second grounding layer:
before the motivation agents respond, MotiveOps detects the domain and risk
surface for the scenario, retrieves responsible-AI policy constraints from a
local Chroma vector store, and asks the agents to generate interventions that
remain compatible with those constraints.

## Team

- Chih-Hsin Chen (`cc5240`)

## Why this matters

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

## Core workflow

1. Choose one of 9 canonical cases or create a custom adoption scenario.
2. Optionally complete motivation intake by selecting self-reported adoption
   concerns.
3. Detect blockers, domain, stakeholders, risk types, and deployment stage.
4. Retrieve adoption-playbook entries and policy-grounding chunks.
5. Run four motivation profiles against the same case.
6. Aggregate 5 trials per profile into per-profile recommendations.
7. Judge the chosen intervention with a separate model.
8. Extract the rationale motivation.
9. Classify L1/L2/L3 alignment.
10. Run a sensitivity grid to find load-bearing motivation axes. A single
   adoption case uses 16 contrasts; the full canonical battery uses 144
   contrasts. Each contrast compares low (`0.2`) versus high (`0.8`) settings
   for one target axis, so each contrast uses two endpoint calls.

## Behavioral Intervention Playbook

The `src/domain/intervention-playbook.ts` layer acts like a lightweight RAG
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

The prompt receives the top matching policies, then returns a structured JSON
contract that the UI renders as an intervention card.

## Policy-Grounding RAG

The policy-grounding RAG layer is separate from the intervention playbook. Its job is not
to recommend the motivational strategy. Its job is to make the recommendation
deployable in a real organization.

Pipeline:

```text
Scenario
-> risk / domain detection
-> local Chroma policy retrieval
-> motivation profile agents
-> constraint-aware intervention generation
-> L1/L2/L3 motivation alignment audit
-> lightweight policy compliance check
-> boundary / sensitivity map
```

The curated corpus lives in `rag_corpus/policy_chunks.json`. It summarizes the
local documents in `doc/` into short retrievable constraints covering:

- Responsible-AI governance: NIST AI RMF, NIST GenAI Profile, Microsoft RAI.
- Privacy/security: NIST Privacy Framework, NIST CSF, OpenAI usage policies.
- Education: FERPA, PPRA, student privacy, UNESCO education AI guidance.
- Workplace adoption: Department of Labor AI guidance and worker well-being.
- HR/employment: EEOC selection-procedure guidance.
- Legal operations: ABA Formal Opinion 512.
- Finance/model accountability: Federal Reserve/OCC model-risk guidance.
- Customer/marketing/support: FTC privacy, deceptive AI claims, and AI screening cases.

The sidecar runs locally on `http://127.0.0.1:8010`. The Worker calls it through
`POST /api/rag/policy`. If the sidecar is not running, the app still works and
falls back to the detected risk context plus the existing intervention playbook.

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

## Repository Layout

```text
MotiveOps/
├── README.md                                   // Project overview, setup, evaluation, and reproducibility guide.
├── package.json                                // Node scripts and frontend/Worker dependencies.
├── dev.vars.example                            // Template for local Worker/OpenAI/RAG environment variables.
├── wrangler.toml                               // Cloudflare Worker local-development configuration.
├── vite.config.js                              // Vite config and local API proxy setup.
├── index.html                                  // Vite app HTML entry point.
├── src/                                        // Main React UI, Worker API, domain data, and evaluation logic.
│   ├── App.jsx                                 // Five-tab research console and demo workflow.
│   ├── main.jsx                                // React entry point.
│   ├── worker.ts                               // Hono Worker API with scenario, run, audit, RAG, and artifact routes.
│   ├── api/
│   │   └── schemas.ts                          // Zod schemas shared across Worker endpoints.
│   ├── domain/
│   │   ├── seeds.ts                            // Full 9 canonical scenarios, intervention options, and 4 motivation profiles.
│   │   └── intervention-playbook.ts            // Behavioral intervention playbook and blocker-to-strategy retrieval.
│   ├── services/
│   │   ├── prompts.ts                          // Subject-agent prompt assembly and JSON output contract.
│   │   ├── policy-rag.ts                       // Risk detection, local RAG client, and policy-coverage checks.
│   │   ├── experiment.ts                       // Multi-profile agent run orchestration.
│   │   ├── artifacts.ts                        // Evidence export and report artifact helpers.
│   │   ├── storage.ts                          // In-memory/local persistence abstraction.
│   │   ├── provider.ts                         // OpenAI and deterministic demo providers.
│   │   ├── metrics.ts                          // Evaluation and summary metric helpers.
│   │   ├── config.ts                           // Runtime model and feature configuration.
│   │   └── problem.ts                          // Shared error/problem response helpers.
│   ├── experiments/
│   │   ├── canonical-battery.ts                // Worker endpoint runner for the 9-case canonical battery.
│   │   ├── sensitivity-grid.ts                 // Low-vs-high motivation-axis perturbation grid.
│   │   ├── adoption-evaluation.ts              // Adoption-specific evaluation helpers.
│   │   └── policy-rag-evaluation.ts            // Policy retrieval and constraint-uptake evaluation.
│   ├── analysis/
│   │   ├── three-layer-runner.ts               // L1/L2/L3 motivation audit orchestration.
│   │   └── alignment-pattern.ts                // Aligned/rationalizing/drifting/contradictory classification logic.
│   ├── judges/
│   │   └── value-judge.ts                      // L2 selected-action motivation classifier prompt and parser.
│   ├── extractors/
│   │   └── rationale-values.ts                 // L3 rationale-axis lexicon and fallback classifier.
│   └── ui/                                     // Reusable UI components for agents, compass, heatmap, tabs, and evidence.
├── scripts/
│   └── run-local-evaluation.ts                 // Standalone local OpenAI canonical evaluation runner.
├── rag_server/
│   ├── policy_rag_server.py                    // Local Chroma policy-RAG sidecar API.
│   └── requirements.txt                        // Python dependencies for the RAG sidecar.
├── rag_corpus/
│   └── policy_chunks.json                      // Runtime policy-grounding chunks loaded into Chroma.
├── doc/                                        // Public source documents and derived policy-corpus documentation.
│   ├── sources.md                              // Source list for the policy-grounding corpus.
│   ├── policy_chunks.json                      // Human-readable copy of the 37 curated policy chunks.
│   └── <source files>.pdf/.csv/.xlsx           // Public source documents used to curate policy chunks.
├── evaluation-results/
│   ├── local-canonical-evaluation.raw.json     // Full local canonical run state and generated outputs.
│   └── local-canonical-evaluation.summary.json // Paper-ready summary metrics.
├── public/evaluation/
│   ├── latest-local-evaluation.json            // Frontend copy of the canonical evaluation summary.
│   └── latest-policy-rag-evaluation.json       // Frontend copy of the policy-RAG evaluation summary.
```

## Reproducibility assets

The paper keeps the scenario and prompt details compact for space. The full
materials used to reproduce the reported evaluation are in the repository:

- **Full canonical scenarios**: `src/domain/seeds.ts` contains the 9 canonical
  adoption cases, including full scenario context, stakeholders, tradeoffs,
  motivational conflict notes, and all intervention options.
- **Motivation profiles and prompt assembly**: `src/domain/seeds.ts` stores the
  four profile weights and profile translations; `src/services/prompts.ts`
  builds the subject-agent prompt used for generation.
- **Audit prompt contracts**: `src/judges/value-judge.ts` contains the L2
  selected-action classifier prompt, and `src/extractors/rationale-values.ts`
  contains the L3 rationale-axis extractor and fallback classifier prompt.
- **Policy corpus and source list**: `doc/sources.md` lists the public policy
  sources; `doc/policy_chunks.json` and `rag_corpus/policy_chunks.json` contain
  the 37 curated policy-grounding chunks used by the local RAG sidecar.
- **Generated evaluation artifacts**:
  `evaluation-results/local-canonical-evaluation.raw.json` contains the full
  local canonical run state; `evaluation-results/local-canonical-evaluation.summary.json`
  contains the paper-ready metrics; `public/evaluation/latest-local-evaluation.json`
  and `public/evaluation/latest-policy-rag-evaluation.json` are the frontend
  copies loaded by the Method / Report tab.
- **Generated report tables/figures**: `final_program_tex/local_eval_results.tex`,
  `final_program_tex/policy_rag_eval_results.tex`, and
  `final_program_tex/full_eval_heatmap.tex` are the generated LaTeX artifacts
  used by the report.

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

To include the local Chroma policy-RAG sidecar in the demo, install the Python
dependency once and run the RAG service with the frontend and Worker:

```bash
npm run rag:install
npm run dev:rag
```

`npm run dev:rag` starts three local processes:

- frontend: `http://localhost:5173`
- Worker backend: `http://localhost:8787`
- policy-RAG sidecar: `http://127.0.0.1:8010`

For separate terminals:

```bash
npm run rag:policy
npm run dev:worker
npm run dev
```

The Setup tab will show risk/domain detection and retrieved policy constraints
when the sidecar is available.

The Setup tab supports two scenario modes:

- **Canonical case**: use one of the 9 fixed benchmark scenarios. Use this mode
  for reproducible evaluation numbers.
- **Custom scenario**: enter a title, domain, scenario description,
  stakeholders, tradeoffs, motivational conflict notes, and four candidate
  intervention options. The app saves the scenario through
  `POST /api/scenarios/custom`, then runs the same four motivational agents on
  that custom case.

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
- 144 sensitivity-grid contrasts. Each contrast runs two endpoint calls for one target
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
- `public/evaluation/latest-policy-rag-evaluation.json` - loaded by the policy-RAG evaluation panel.
- `final_program_tex/local_eval_results.tex` - included by `final_project.tex`.
- `final_program_tex/policy_rag_eval_results.tex` - policy-RAG evaluation table.
- `final_program_tex/full_eval_heatmap.tex` - compact 144-cell sensitivity heatmap.

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
- `POST /api/rag/policy`
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
- 144/144 sensitivity-grid low-vs-high contrasts.
- Average modal stability: `90.0%`.
- Divergent scenario rate: `33.3%`.
- Intervention-card complete output rate: `100.0%`.
- Three-layer audit coverage: `180/180`.
- Sensitivity-grid endpoint flip rate: `19.4%`.
- Same-profile baseline average modal stability: `70.0%`.
- Policy risk/domain detection: `9/9`.
- Policy Retrieval Recall@5: `59.3%`.
- Constraint uptake: `61.1%`.

The generated live summary is in
`evaluation-results/local-canonical-evaluation.summary.json`, the frontend reads
`public/evaluation/latest-local-evaluation.json`, and the report includes
`final_program_tex/local_eval_results.tex`.

## Evaluation plan and current evidence

The strongest evaluation shape for MotiveOps is not a generic accuracy score.
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
- **Policy-grounding coverage**: for each run, the Worker records detected risk
  types, retrieved policy chunks, and a lightweight coverage check showing which
  risk types were reflected in the generated intervention text.
- **Canonical sensitivity battery**: `npm run eval:local` reports subject
  completion, profile-cell modal stability, profile divergence, three-layer
  audit coverage, same-profile baseline stability, and the 144-contrast
  endpoint flip rate.
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
