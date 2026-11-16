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
            research_prompt = request_json.get('research_prompt', 'You are a researcher. Identify industry status quo.')
            research_prompt = research_prompt.replace('{topic}', topic)\
                                             .replace('{core_focus}', core_focus)\
                                             .replace('{core\\_focus}', core_focus)\
                                             .replace('{description}', description)

            if topic not in research_prompt:
                research_prompt += f"\n\n--- ASSIGNMENT INPUTS ---\nTopic: {topic}\nCore Focus: {core_focus}\nContext: {description}"

            research_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=research_prompt,
                config=types.GenerateContentConfig(
                    tools=[{"google_search": {}}],
                    temperature=1.0,
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                )
            )
            research_notes = research_res.text

            # --- STAGE 2: Editorial Architect / Planner (Flash) ---
            current_stage = f"Stage 2: Planner ({FLASH_MODEL})"
            plan_prompt = request_json.get('plan_prompt', 'You are an Editorial Architect. Build an outline.')
            plan_prompt = plan_prompt.replace('{topic}', topic)\
                                     .replace('{core_focus}', core_focus)\
                                     .replace('{core\\_focus}', core_focus)\
                                     .replace('{description}', description)\
                                     .replace('{research_notes}', research_notes)\
                                     .replace('{research\\_notes}', research_notes)

            if research_notes not in plan_prompt:
                plan_prompt += f"\n\n--- RESEARCH DOSSIER ---\n{research_notes}"

            plan_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=plan_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                )
            )
            outline = plan_res.text

            # --- STAGE 3: Master Creative Writer (Pro) ---
            current_stage = f"Stage 3: Writer ({PRO_MODEL})"
            writer_prompt = request_json.get('writer_prompt', 'You are a B2B writer. Write a draft.')
            writer_prompt = writer_prompt.replace('{topic}', topic)\
                                         .replace('{core_focus}', core_focus)\
                                         .replace('{core\\_focus}', core_focus)\
                                         .replace('{research_notes}', research_notes)\
                                         .replace('{research\\_notes}', research_notes)\
                                         .replace('{outline}', outline)

            if outline not in writer_prompt:
                writer_prompt += f"\n\n--- ASSIGNMENT DATA ---\nTopic: {topic}\nResearch Dossier:\n{research_notes}\n\nEditorial Blueprint:\n{outline}"

            writer_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=writer_prompt,
                config=types.GenerateContentConfig(
                    temperature=1.0,
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                )
            )
            final_output = writer_res.text

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
            optimize_prompt = optimize_prompt.replace('{draft_text}', draft_text)\
                                             .replace('{draft\\_text}', draft_text)

            if draft_text not in optimize_prompt:
                optimize_prompt += f"\n\n--- HUMAN-EDITED DRAFT TO OPTIMIZE ---\n{draft_text}"

            optimize_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=optimize_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                )
            )
            final_output = optimize_res.text

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
        