# How a B2B Product Management Consultancy Replaced Fragile AI Prototypes with a Governed, Human-in-the-Loop Content Engine

## 1. Executive Snapshot (At-a-Glance)

**Scaling practitioner-grade B2B thought leadership without trading away editorial authority—or cloud security.** By adopting a two-phase, Human-in-the-Loop (HITL) publishing architecture, a B2B Product Management advisory team eliminated monolithic LLM timeouts, accidental document overwrites, and unauthenticated cloud exposure while keeping human editors in full control of the narrative.

| Dimension | Summary |
| :--- | :--- |
| **The Hero** | A B2B Product Management consultancy and its non-technical editorial team scaling practitioner-grade thought leadership inside Google Workspace. |
| **The Core Bottleneck** | A synchronous, unauthenticated v1 prototype coupled LLM reasoning, prompt delivery, and Cloud Run deployment into a single fragile path—causing timeout cliffs, lost reviewer feedback, and open API key exposure. |
| **The Intervention** | `hitl-content-engine` v2: split-stage Phase 1 orchestration (`research` -> `plan` -> `write`) with Drive checkpointing, a mandatory human + unresolved-comment gate, `Experiment_Config` routing, Secret Manager + `X-Webhook-Secret` auth, and a `pytest` CI gate. |
| **Headline Results** | • **30/30** automated `pytest` checks enforced in CI before every Cloud Run deploy<br>• **0** plain-text API keys in code or env vars (`401` / `405` / `200` boundary verified live)<br>• **100%** preservation of prior Doc URLs and reviewer comments before Phase 2<br>• **[INSERT METRIC: e.g., % reduction in first-draft turnaround time or hours saved per article]** |

---

## 2. The Hero & The Stakes (StoryBrand: Character & Inciting Incident)

**The Hero's reality:** A B2B Product Management consultancy needed to publish deeply technical, practitioner-grade articles consistently—without turning its blog into a generic AI "feature factory." Its editorial leads and product advisors worked daily in Google Sheets and Google Docs, not terminal windows.

**The external stakes:** Senior Product Managers and Engineering Leaders spot shallow, cliché-ridden AI prose within two sentences. Publishing unverified content risked eroding hard-won advisory credibility, while manual research-to-CMS drafting created an unsustainable resource bottleneck (`[INSERT METRIC: e.g., articles published per month before vs. target]`).

**The internal stakes:** An early v1 automation prototype initially looked promising, but quickly bred operational anxiety. Editors feared clicking the menu twice or running from the wrong tab would overwrite an approved draft link, while engineering reviewers discovered the prototype webhook was publicly exposed and auto-deploying untested changes straight to production.

---

## 3. The Problem: Peeling Back the Layers (PSR: Problem + 5 Whys)

**Why surface fixes failed:** Early attempts to patch the v1 workflow—tweaking prompts, reminding editors to check tab names, or bumping request timeouts—only masked deeper structural flaws. Phase 2 (`SEO/GEO Optimize`) remained completely non-functional against existing `open?id=` links, and editors had no safe way to iterate on prompts without risking production regressions.

### 5 Whys Root Cause Analysis

1. **Why #1 (Visible Symptom):** Editorial runs frequently timed out mid-draft, overwrote existing Google Doc URLs with error text, or silently dropped reviewer comments when moving to Phase 2.
2. **Why #2 (Workflow Coupling):** Phase 1 executed three heavy sequential AI stages (Pro + Search -> Flash -> Pro) inside a single synchronous HTTP request (`~112s–191s`) with no intermediate checkpoints, while Apps Script had no tab guard, concurrency lock, or Drive comment check.
3. **Why #3 (Broken Cross-System Contracts):** The frontend (`Code.gs`), backend (`main.py`), and Agent D prompt lacked a shared, validated contract—expecting `/document/d/` URLs when Drive returned `open?id=`, omitting `<inputs>` XML wrappers, and passing raw system prompts from the client.
4. **Why #4 (Prototype Security & Config Debt):** All URLs, prompt IDs, and the Gemini API key had been wired for rapid prototyping—leaving Cloud Run publicly callable with wildcard CORS, plain-text env vars, an over-privileged default Compute Service Account, and zero `Experiment_Config` control plane.
5. **Why #5 (True Root Cause):** **The system treated an editorial production pipeline like a single-script prototype, lacking enforced boundaries between untrusted orchestration, verified prompt governance, human editorial gates, and CI-gated cloud infrastructure.**

---

## 4. Enter the Guide & The Strategic Plan (StoryBrand: Guide + PSR: Solution)

`hitl-content-engine` stepped in strictly as the **Guide**—meeting editors inside the Google Sheets and Google Docs workspace they already knew, while giving engineering a defensible, zero-trust cloud boundary. Rather than forcing editors into a custom web app or stripping away human judgment, the architecture separated **AI velocity** from **editorial authority**.

The refactored v2 plan directly neutralized the **Why #5** root cause across four pillars:

* **Split-Stage Orchestration with Checkpointing:** Phase 1 was broken into three discrete, synchronous stage calls (`research` -> `plan` -> `write`) orchestrated by Apps Script, persisting intermediate JSON checkpoints in Google Drive so late-stage failures resume without re-paying earlier stages.
* **Mandatory Human + Unresolved-Comment Gate:** Phase 2 (`optimize`) was locked behind both a case-insensitive `Approved` status in Column E and a live `Drive.Comments.list` check that blocks optimization if any Google Docs margin comment remains unresolved.
* **Server-Side Prompt & Secret Trust Boundary:** Cloud Run stopped accepting raw prompt strings from callers. Instead, Apps Script sends a `prompt_doc_id` from a protected `Experiment_Config` tab; Cloud Run authenticates `X-Webhook-Secret` via `hmac.compare_digest`, verifies the Doc resides inside `ALLOWED_PROMPT_FOLDER_ID` using a least-privilege runtime Service Account, and pulls secrets exclusively from GCP Secret Manager.
* **CI-Gated Infrastructure:** Every push to `main` was gated behind a `pytest` step in `cloudbuild.yaml` before building a hardened, non-root `python:3.11.11-slim-bookworm` Gunicorn container.

---

## 5. Execution & Overcoming Friction

**Phased rollout under production guardrails:** Because Cloud Build auto-deployed every push to `main` directly to 100% live traffic, all refactoring was executed on an isolated feature branch (`refactor/security-and-v2-pipeline`) while the team manually audited the live bound Apps Script and backed up the Master Sheet first.

**Real-world constraints and trade-offs navigated:**
* **Checkpointing without adding a database:** Rather than introducing Firestore or Cloud SQL (which would complicate self-hosting and ops), intermediate `research_dossier` and `editorial_blueprint` artifacts were checkpointed as `.hitl_checkpoint_row_<row>.json` files inside `Draft_Folder_ID` via Drive API v3, keyed by a SHA-256 hash of the row's brief.
* **Non-destructive Sheet telemetry:** Instead of writing `⏳` or `❌ Error` over Doc URLs in Columns D and F, progress, experiment IDs, checkpoint state, token metrics, and errors were moved to dedicated Columns H–L, while replaced Doc URLs are archived in cell Notes.
* **Markdown-to-Docs formatting & legacy URLs:** Raw Markdown (`#`, `##`) previously dumped via `setText()` was replaced with a Markdown-to-HTML converter imported via `Drive.Files.create`, and `extractGoogleDocId()` was updated to support both `/document/d/` and legacy `open?id=` links.
* **Gemini API key format friction:** Provisioning surfaced a subtle SDK routing distinction between standard Google AI Studio keys (`AIzaSy...`, targeting `generativelanguage.googleapis.com/v1beta`) and Vertex AI Express keys (`AQ.A...`, requiring `vertexai=True`), documented explicitly in `DEVELOPERS.md` so future operators avoid silent `API_KEY_INVALID` failures.

---

## 6. The Transformation & Quantifiable Results (PSR: Result + StoryBrand: Success)

### Before vs. After Operational Comparison

| Operational Dimension | Before (v1 Prototype) | After (`hitl-content-engine` v2) |
| :--- | :--- | :--- |
| **Phase 1 Timeout & Retry Risk** | Single `112s–191s` synchronous call against a `300s` cliff; failures discarded all token spend | 3 bounded stage calls (`research` -> `plan` -> `write`) with `429`/`503` backoff + Drive checkpoints |
| **Human Review & Comment Safety** | Exact-case `'Approved'` check; `open?id=` links failed; Google Docs comments silently dropped | Normalized `approved` check; `/document/d/` + `?id=` regex; `Drive.Comments.list` blocks unresolved comments |
| **Sheet Data Integrity** | No tab guard or lock; errors overwrote Doc URLs in Cols D/F | Active tab guard + `LockService.getDocumentLock()`; Cols H–L telemetry; old URLs archived in cell Notes |
| **Cloud & Secret Security** | Publicly callable (`GET` triggered Pro+Search); `*` CORS; plain-text API key; default Compute SA | `X-Webhook-Secret` (`401`); `POST`-only (`405`); Secret Manager; dedicated `content-engine-runtime` SA |
| **Prompt Versioning & Docs** | Hardcoded private Doc IDs; Agent D unwired; raw Markdown pasted as plain text | `Experiment_Config` tab + `prompts/` templates; Agent D wired (`<draft_text>`); formatted HTML->Doc import |
| **Release Gate** | Zero tests; pushes to `main` deployed untested code | `cloudbuild.yaml` runs **30/30 `pytest` unit tests** before Docker build & Cloud Run update |

### Measurable Outcomes & Day-to-Day Impact

* **Verified Production Hardening:** Live Cloud Run smoke tests confirmed `GET /health` (`200`), `GET /` (`405 Method Not Allowed`), and unauthenticated `POST /` & `POST /stage` (`401 Unauthorized`), running as `content-engine-runtime` with `concurrency=4`, `maxScale=3`, and zero plain-text secrets.
* **Confident Editorial Velocity:** Non-technical editors now trigger multi-agent research, outlining, drafting, and SEO/GEO optimization from a single `🚀 AI Content Engine` menu—with clear progress badges and zero fear of losing work (`[INSERT METRIC: e.g., % reduction in total time from brief to CMS-ready draft]`).
* **SEO & GEO Readiness:** `[INSERT METRIC: e.g., organic impressions or AI answer-engine citations over 90 days]`.

> "[INSERT HERO QUOTE: Quote from the Editorial Lead on how the human gate and comment check changed review confidence and draft quality.]"

> "[INSERT HERO QUOTE: Quote from the Engineering/Platform Lead on eliminating plain-text secrets, timeout failures, and unverified main deploys.]"

---

## 7. Key Takeaways & Replicable Lessons

1. **Separate AI Velocity from Editorial Authority:** Never let an optimization or publishing agent bypass a human quality gate—and enforce technical checks (like unresolved Google Docs comments) so human feedback cannot be accidentally skipped.
2. **Design Long LLM Workflows Around Bounded Stages, Not Larger Timeouts:** Splitting sequential reasoning into discrete, checkpointed stage calls eliminates timeout cliffs and lets teams resume failed runs without re-paying earlier token spend.
3. **Keep Prompts Out of Client Payloads:** Let lightweight frontends pass a reference ID (`prompt_doc_id`) while the backend verifies folder allowlists and fetches prompts server-side under a least-privilege Service Account.
4. **Gate Every Production Deploy Before You Need It:** Adding a mocked `pytest` suite in `cloudbuild.yaml` and moving configuration into an `Experiment_Config` tab lets editorial teams iterate on prompts daily while engineering sleeps soundly.

*Explore the architecture and replication guides in [README.md](./README.md), [DEVELOPERS.md](./DEVELOPERS.md), and [USER_GUIDE.md](./USER_GUIDE.md).*
