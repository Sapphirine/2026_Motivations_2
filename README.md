# MotiveOps

**Motivation-Aware Agent for AI Workflow Adoption**

MotiveOps is a research prototype for one practical AI-adoption problem:
companies buy AI tools, but employees often do not convert training and seat
licenses into repeated workflow use.

The system treats motivation as an explicit, inspectable control variable. It
diagnoses an adoption blocker, retrieves a behavioral intervention strategy,
optionally retrieves responsible-AI constraints from a local policy RAG sidecar,
runs four controlled motivation-profile agents, recommends a small next action,
and audits whether the action and rationale match the declared motivation frame.

## Team

- Chih-Hsin Chen (`cc5240`)

## Project Links

- Demo video: https://youtu.be/Y1ficoPgtyU
- GitHub repository: https://github.com/nomnomeriii/eecs6895-final

## Repository Layout

```text
MotiveOps/
├── README.md                                   // Project overview, setup, evaluation, and reproducibility guide.
├── package.json                                // Node scripts and frontend/Worker dependencies.
├── package-lock.json                           // Locked Node dependency versions.
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
│   │   ├── seeds.ts                            // Full 9 canonical scenarios, intervention options, and motivation profiles.
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
└── public/evaluation/
    ├── latest-local-evaluation.json            // Frontend copy of the canonical evaluation summary.
    └── latest-policy-rag-evaluation.json       // Frontend copy of the policy-RAG evaluation summary.
```

## Requirements

- Node.js and npm
- Python 3, only needed for the optional local policy-RAG sidecar
- OpenAI API key, only needed for live model runs

## Quick Start

Install dependencies:

```bash
npm install
```

Start the frontend and local Worker API:

```bash
cp dev.vars.example .dev.vars
npm run dev:all
```

Open the app at:

```text
http://localhost:5173
```

`npm run dev:all` starts:

- frontend: `http://localhost:5173`
- Worker backend: `http://localhost:8787`

The default `.dev.vars` template can run in deterministic demo mode. For live
OpenAI calls, set:

```dotenv
DEMO_MODE=false
OPENAI_API_KEY=sk-...
```

Do not commit `.dev.vars`; it is ignored by git.

## Optional Policy-RAG Sidecar

The local policy-grounding sidecar retrieves responsible-AI constraints from the
curated policy corpus before the motivation agents generate interventions.

Install the Python dependency once:

```bash
npm run rag:install
```

Run the frontend, Worker, and policy-RAG sidecar together:

```bash
npm run dev:rag
```

`npm run dev:rag` starts:

- frontend: `http://localhost:5173`
- Worker backend: `http://localhost:8787`
- policy-RAG sidecar: `http://127.0.0.1:8010`

If the sidecar is not running, the app still works and falls back to detected
risk context plus the behavioral intervention playbook.

## App Workflow

1. Choose one of 9 canonical adoption cases or create a custom scenario.
2. Optionally complete motivation intake to estimate the user's closest profile
   and strongest value-axis signal from self-reported adoption concerns.
3. Detect adoption blockers, domain, stakeholders, risk types, and deployment stage.
4. Retrieve behavioral playbook entries and policy-grounding chunks.
5. Run four motivation profiles: Achievement, Exploration, Preservation, and Neutral.
6. Aggregate five trials per profile into per-profile recommendations.
7. Run the L1/L2/L3 motivation audit.
8. Run the sensitivity grid to test whether value-axis changes alter the selected intervention.

## Example Use Case

The final demo uses a custom AI tutor deployment scenario because it clearly
triggers policy/RAG constraints around education, minors, privacy, bias,
consent, human oversight, and equity.

Motivation intake selections:

- I am worried about risk, safety, or policy.
- I care most about protecting affected people.
- I do not know where to safely start.

Expected intake estimate:

```text
Closest profile: Preservation
Strongest signal: Security
Secondary concern: Benevolence / protecting affected people
```

Copy-paste custom scenario:

**Title**

```text
AI Tutor Deployment in Public Schools
```

**Domain**

```text
Education technology adoption
```

**Decision scenario**

```text
Our school district is deciding whether to deploy an AI tutoring system across K-12 classrooms. A pilot showed a 15% improvement in math scores, but the system logs every student interaction, flags at-risk learners using behavioral signals, and our equity review found measurable bias in reading-level assessments. Teachers are concerned that the tool may quietly create teacher-effectiveness scores. Parents in wealthier schools can opt out, but families in Title I schools may not have the same practical choice because the district accepted grant funding tied to deployment. We need one adoption intervention that moves forward without forcing vulnerable students into an unvetted system.
```

**Stakeholders**

```text
Students, teachers, parents, school board, teachers' union, district technology office, equity reviewers, privacy officer, grant compliance officer
```

**Tradeoffs**

```text
Learning gains, student privacy, surveillance risk, algorithmic bias, teacher autonomy, parent consent, equity across income levels, grant compliance
```

**Motivational conflict notes**

```text
Achievement pushes for the 15% math improvement and grant compliance. Security must contain privacy, bias, and surveillance risk. Benevolence must protect students and teachers from harm. Self-direction must preserve teacher judgment and family choice, especially where opt-out access is unequal.
```

**Intervention options**

```text
Option A: Full rollout with monitoring
Deploy district-wide next semester, monitor bias and privacy issues after launch, and publish a quarterly impact report.

Option B: Restricted opt-in pilot with safeguards
Continue only with an opt-in pilot that includes teacher review, parent consent, bias monitoring, data minimization, and an independent stop/go review.

Option C: Training and communication campaign
Run teacher training sessions and parent information meetings to explain the AI tutor, address concerns, and encourage voluntary adoption, without changing the deployment scope.

Option D: Pause deployment until compliance review
Stop expansion until privacy, bias, labor, and federal grant constraints are resolved by district counsel and equity reviewers.
```

Expected recommendation:

```text
Option B: Restricted opt-in pilot with safeguards.
```

In the recorded demo, all four motivation-profile agents selected the same safe
pilot intervention for this high-constraint education case. The result is
interpreted as desirable stability: policy, equity, privacy, consent, bias, and
human-oversight constraints dominate over an unrestricted achievement-oriented
rollout.

## Reproducibility Materials

Full scenario text, prompt contracts, policy chunks, generated outputs, and
evaluation summaries are provided here for reproducibility:

- Full canonical scenarios: `src/domain/seeds.ts`
- Motivation profiles and prompt translations: `src/domain/seeds.ts`
- Subject-agent prompt assembly and JSON output contract: `src/services/prompts.ts`
- L2 selected-action motivation judge: `src/judges/value-judge.ts`
- L3 rationale-axis extractor and fallback classifier: `src/extractors/rationale-values.ts`
- Policy source list: `doc/sources.md`
- Curated policy chunks: `doc/policy_chunks.json` and `rag_corpus/policy_chunks.json`
- Full local canonical run state: `evaluation-results/local-canonical-evaluation.raw.json`
- Paper-ready summary metrics: `evaluation-results/local-canonical-evaluation.summary.json`
- Frontend evaluation summaries:
  `public/evaluation/latest-local-evaluation.json` and
  `public/evaluation/latest-policy-rag-evaluation.json`

## Full Evaluation Run

The report's quantitative results are reproduced with the local canonical
battery:

- 9 adoption cases x 4 profiles x 5 trials = 180 subject-model outputs.
- 20 same-profile baseline calls for estimating profile-internal noise.
- 144 sensitivity-grid contrasts; each contrast compares low (`0.2`) and high
  (`0.8`) endpoint settings for one target value axis and records whether the
  selected intervention changes.
- L1/L2/L3 audit for all 180 subject outputs.
- Policy-grounding detection, retrieval, and constraint-uptake checks when the
  local RAG sidecar is available.

For live local evaluation, set `.dev.vars`:

```dotenv
DEMO_MODE=false
OPENAI_API_KEY=sk-...
```

Then run:

```bash
npm run eval:local -- --reset
```

If the key is already available as a shell environment variable:

```bash
npm run eval:local -- --reset --live
```

The runner is resumable. If it stops partway through, run it again without
`--reset` and it will keep completed cells from the raw local state.

For a deterministic smoke test:

```bash
npm run eval:local -- --reset --demo
```

Without `--demo`, the runner refuses to produce a paper table while
`DEMO_MODE=true`; this prevents accidentally submitting demo numbers as live
OpenAI evaluation results.

## Current Saved Evaluation Results

The checked-in live local evaluation was run with `DEMO_MODE=false` and
`OPENAI_MODEL=gpt-5.4-nano` for subject-agent outputs.

Canonical battery:

- Subject outputs: `180/180`
- Profile cells complete: `36/36`
- Average modal stability: `90.0%`
- Divergent scenario rate: `33.3%`
- Intervention-card complete output rate: `100.0%`
- Three-layer audit coverage: `180/180`
- Sensitivity-grid contrasts: `144/144`
- Endpoint flip rate: `19.4%`
- Same-profile baseline: `20/20`; average modal stability `70.0%`

Policy-grounding evaluation:

- Risk/domain detection: `9/9`
- Policy Retrieval Recall@5: `16/27 = 59.3%`
- Constraint uptake: `110/180 = 61.1%`
- Policy corpus: `37` curated chunks over 9 canonical cases

Adoption-specific checks:

- Playbook Top-1 accuracy: `9/9`
- Playbook Top-3 coverage: `20/26 = 0.769`
- Card completeness: `180/180`
- Bad-advice fixture: productivity mandate flagged as contradictory for the
  security-anxiety case

## Local Verification

Useful local checks:

```bash
npm run typecheck
npm run build
```

The app can also be opened with deterministic demo data:

```bash
npm run dev:all
```

## Guardrails

- Fictional workplace adoption cases only.
- Not HR, legal, employment, productivity, or performance-management advice.
- No claim that the four-axis model is a validated employee assessment.
- The motivation intake is a transparent self-report signal, not hidden
  psychometric inference.
- No production personnel decision should be made from this prototype.
- The paper treats outputs as experimental evidence about model behavior,
  motivation sensitivity, and intervention-alignment auditing.
