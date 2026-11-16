# Human-in-the-Loop (HITL) B2B Content Publishing Engine

An automated, serverless content generation and publishing pipeline that bridges Google Sheets, Google Docs, and Google Cloud Run. This system uses multi-stage AI reasoning (Google Gemini) to draft, refine, and optimize long-form B2B content while ensuring human editors maintain complete narrative control.

> **Personal Note:** I originally built this engine for myself to support my own blog and scale my content operations. It was designed to solve the exact bottlenecks I faced when trying to publish high-quality, technical product management content—allowing me to scale output without turning my blog into an automated AI "feature factory." 

## 1. The Business Problem (Why This Exists)

In modern B2B SaaS organizations, scaling content production usually creates a false binary:
*   **The Velocity Trap:** Teams use AI to autonomously generate and publish high volumes of content, resulting in generic "digital waste" that fails to rank or resonate with technical audiences.
*   **The Resource Bottleneck:** Highly skilled product marketers and content strategists spend days manually researching, drafting, and formatting a single article, making it impossible to scale organic reach.

**The Solution:**
This architecture solves this by separating the content workflow into two distinct phases with a mandatory "Human Approval Gate" in the middle. The AI does the heavy lifting of research, outlining, and initial drafting (Phase 1). A human expert then injects proprietary anecdotes and refines the tone. Finally, the AI handles the tedious technical polish of SEO formatting and metadata generation (Phase 2). **The AI never optimizes unverified content.**

## 2. Product Architecture & Stack

The system is a stateless, serverless architecture triggered entirely from a familiar Google Workspace frontend.

### The Technology Stack
*   **Frontend (UI):** Google Sheets (Master Content Tracker)
*   **Middleware Router:** Google Apps Script (`Code.gs`)
*   **Backend Compute:** Google Cloud Run (Python 3.11, serverless containers)
*   **AI Engine:** `google-genai` SDK
    *   *Complex Reasoning Tasks (Drafting):* Gemini 3.1 Pro
    *   *Structural Tasks (Outlining & SEO):* Gemini 3.8 Flash
*   **Storage:** Google Drive (for v1 Drafts and v2 Final documents)

### The Agent Hierarchy
The Cloud Run backend utilizes four distinct AI personas in a sequential chain:
1.  **The Intelligence Researcher (Pro):** Challenges industry assumptions and gathers contrarian angles based on the core topic.
2.  **The Editorial Architect (Flash):** Structures the researcher's findings into a high-retention, inverted-pyramid outline.
3.  **The Senior B2B Writer (Pro):** Drafts the full narrative, explicitly avoiding AI clichés and standard B2B jargon.
4.  **The SEO/GEO Specialist (Flash):** Polishes the human-approved text, adds answer-first summaries for Generative Engine Optimization, and prepends Title/Meta tags.

## 3. The End-to-End Workflow

The entire pipeline is operated by non-technical content leads through a custom `🚀 AI Content Engine` menu inside Google Sheets.

### Phase 1: Automated Drafting
1.  **Input:** The Content Lead fills out a new row in the Master Content Tracker with a `Topic`, `Core Focus`, and `Description`.
2.  **Trigger:** They click **🚀 AI Content Engine > Phase 1: Generate Draft**.
3.  **Execution:** Apps Script sends the inputs to Cloud Run. Agents 1, 2, and 3 run sequentially.
4.  **Output:** A new Google Doc named `[Topic] - v1 (Draft)` is generated and saved to a dedicated Google Drive folder. The document URL is written back to Column D in the spreadsheet, and the status is set to `Pending Review`.

### The Human-in-the-Loop Checkpoint
This is the critical quality control gate.
1.  The human editor opens the `v1 (Draft)` Google Doc.
2.  They review the prose, inject company-specific data, adjust the tone, and verify claims.
3.  Once satisfied, they return to the Google Sheet and change Column E (`Human Edits`) to **Approved**. *(Phase 2 will be blocked if this cell does not say exactly "Approved".)*

### Phase 2: SEO & GEO Optimization
1.  **Trigger:** The Content Lead clicks **🚀 AI Content Engine > Phase 2: SEO/GEO Optimize**.
2.  **Execution:** Apps Script verifies the approval status, extracts the raw text directly from the human-edited `v1` Google Doc, and sends it to Cloud Run.
3.  **Optimization:** Agent 4 (The SEO Specialist) structures the document for search engines and appends metadata.
4.  **Output:** A brand new Google Doc named `[Topic] - v2 (Final)` is generated and saved to Drive. The URL is written to Column F, ready for final CMS publishing.

## 4. Setup & Deployment Guide

To replicate this system, you must configure the three core environments:

**A. Google Workspace (Storage & UI)**
1.  Create a target folder in Google Drive and copy the Folder ID from the URL.
2.  Create a Google Sheet with the following columns: `Topic`, `Core Focus`, `Description`, `Output Doc Link`, `Human Edits`, `Reviewed Doc Link`, `Human Review`.
3.  Open *Extensions > Apps Script*, paste your `Code.gs` middleware, and update the `DESTINATION_FOLDER_ID` constant.

**B. Google Cloud (Backend Compute)**
1.  Create a new project in Google Cloud Console.
2.  Enable the Cloud Run and Cloud Build APIs.
3.  Deploy the Python backend (`main.py` and `requirements.txt`) to Cloud Run via GitHub integration (using Buildpacks) or a custom Dockerfile.
4.  Add your Gemini API Key as an environment variable (`GOOGLE_API_KEY_ARTICLE`).
5.  Set the service to "Allow unauthenticated invocations" and copy the service URL.

**C. Connecting the Loop**
1.  In your Google Apps Script (`Code.gs`), paste the Cloud Run URL into the `CLOUD_FUNCTION_URL` constant.
2.  *(Note: The prompt templates are stored externally in Google Docs for easy editing by content teams. The IDs for these documents must also be configured in `Code.gs`.)*