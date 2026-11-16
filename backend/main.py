import os
import json
import functions_framework
from google import genai
from google.genai import types

PRO_MODEL = "gemini-3.1-pro-preview"
FLASH_MODEL = "gemini-3.8-flash"

@functions_framework.http
def generate_blog_post(request):
    # 1. Handle CORS preflight
    if request.method == 'OPTIONS':
        return ('', 204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        })

    headers = {'Access-Control-Allow-Origin': '*'}
    current_stage = "Initialization"

    try:
        # 2. Parse payload from Google Apps Script
        request_json = request.get_json(silent=True) or {}

        action = request_json.get('action', 'draft')
        topic = request_json.get('topic', 'B2B Content')
        core_focus = request_json.get('core_focus', '')
        description = request_json.get('description', '')
        draft_text = request_json.get('draft_text', '')

        # Construct the base XML inputs required by V2 prompts
        xml_base_inputs = f"""
<topic>{topic}</topic>
<core_focus>{core_focus}</core_focus>
<description>{description}</description>
"""

        # 3. Retrieve API key & initialize client
        api_key = os.environ.get("GOOGLE_API_KEY_ARTICLE") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            return (
                json.dumps({"error": "Missing GOOGLE_API_KEY_ARTICLE environment variable"}),
                500,
                {**headers, "Content-Type": "application/json"}
            )

        client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(api_version="v1beta")
        )

        # ======================================================================
        # PHASE 1: AUTOMATED DRAFTING
        # ======================================================================
        if action == 'draft':

            # --- STAGE 1: Intelligence Researcher (Pro + Google Search) ---
            current_stage = f"Stage 1: Researcher ({PRO_MODEL})"
            research_prompt = request_json.get('research_prompt', 'You are a researcher.')
            
            # Append strict XML inputs
            full_research_prompt = f"{research_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}"

            research_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=full_research_prompt,
                config=types.GenerateContentConfig(
                    tools=[{"google_search": {}}],
                    temperature=0.7, # Lowered slightly for factual research rigidity
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                )
            )
            research_dossier = research_res.text

            # HALT PIPELINE IF RESEARCHER THROWS INPUT ERROR
            if "INPUT ERROR:" in research_dossier:
                raise ValueError(f"Researcher Aborted: {research_dossier.strip()}")

            # --- STAGE 2: Editorial Architect / Planner (Flash) ---
            current_stage = f"Stage 2: Planner ({FLASH_MODEL})"
            plan_prompt = request_json.get('plan_prompt', 'You are an Editorial Architect.')
            
            # Append strict XML inputs including the new dossier
            full_plan_prompt = f"{plan_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}\n<research_dossier>\n{research_dossier}\n</research_dossier>"

            plan_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=full_plan_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                )
            )
            editorial_blueprint = plan_res.text

            # HALT PIPELINE IF PLANNER THROWS INPUT ERROR
            if "INPUT ERROR:" in editorial_blueprint:
                raise ValueError(f"Planner Aborted: {editorial_blueprint.strip()}")

            # --- STAGE 3: Master Creative Writer (Pro) ---
            current_stage = f"Stage 3: Writer ({PRO_MODEL})"
            writer_prompt = request_json.get('writer_prompt', 'You are a B2B writer.')
            
            # Append strict XML inputs including dossier and blueprint
            full_writer_prompt = f"{writer_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}\n<research_dossier>\n{research_dossier}\n</research_dossier>\n<editorial_blueprint>\n{editorial_blueprint}\n</editorial_blueprint>"

            writer_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=full_writer_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.7, # Lowered slightly to respect blueprint constraints
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                )
            )
            raw_writer_output = writer_res.text
            
            # HALT PIPELINE IF WRITER THROWS INPUT ERROR
            if "INPUT ERROR:" in raw_writer_output:
                raise ValueError(f"Writer Aborted: {raw_writer_output.strip()}")

            # STRIP THE SCRATCHPAD (V2 Rule: Writer outputs internal reasoning in <scratchpad>)
            if "</scratchpad>" in raw_writer_output:
                final_output = raw_writer_output.split("</scratchpad>")[-1].strip()
            else:
                final_output = raw_writer_output.strip()

        # ======================================================================
        # PHASE 2: SEO / GEO OPTIMIZATION
        # ======================================================================
        elif action == 'optimize':
            if not draft_text.strip():
                return (
                    json.dumps({"error": "No draft text provided for optimization."}),
                    400,
                    {**headers, "Content-Type": "application/json"}
                )

            current_stage = f"Stage 4: Optimizer ({FLASH_MODEL})"
            optimize_prompt = request_json.get('optimizer_prompt', 'You are an SEO specialist. Optimize this text.')
            
            full_optimize_prompt = f"{optimize_prompt}\n\n--- HUMAN-EDITED DRAFT TO OPTIMIZE ---\n<draft_text>\n{draft_text}\n</draft_text>"

            optimize_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=full_optimize_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                )
            )
            final_output = optimize_res.text.strip()

        else:
            return (
                json.dumps({"error": "Invalid action parameter"}),
                400,
                {**headers, "Content-Type": "application/json"}
            )

        # 4. Return response matching the Google Apps Script expected schema
        return (
            json.dumps({
                "status": "success",
                "action_completed": action,
                "topic": topic,
                "article": final_output
            }),
            200,
            {**headers, "Content-Type": "application/json"}
        )

    except Exception as e:
        return (
            json.dumps({
                "status": "error",
                "failed_stage": current_stage,
                "error_details": str(e)
            }),
            500,
            {**headers, "Content-Type": "application/json"}
        )
