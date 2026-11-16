import os
import json
import functions_framework
from google import genai
from google.genai import types

PRO_MODEL = "gemini-3.1-pro-preview"
FLASH_MODEL = "gemini-3.8-flash"

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
}


def json_response(payload: dict, status_code: int = 200):
    return (
        json.dumps(payload),
        status_code,
        {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
    )


def strip_scratchpad(text: str) -> str:
    if "</scratchpad>" in text:
        return text.split("</scratchpad>")[-1].strip()
    return text.strip()


@functions_framework.http
def generate_blog_post(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS_HEADERS)

    current_stage = "Initialization"

    try:
        request_json = request.get_json(silent=True) or {}

        action = request_json.get("action", "draft")
        topic = request_json.get("topic", "B2B Content")
        core_focus = request_json.get("core_focus", "")
        description = request_json.get("description", "")
        draft_text = request_json.get("draft_text", "")

        xml_base_inputs = (
            f"<topic>{topic}</topic>\n"
            f"<core_focus>{core_focus}</core_focus>\n"
            f"<description>{description}</description>"
        )

        api_key = os.environ.get("GOOGLE_API_KEY_ARTICLE") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": "Missing GOOGLE_API_KEY_ARTICLE environment variable.",
                },
                500,
            )

        client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(api_version="v1beta"),
        )

        # ======================================================================
        # PHASE 1: AUTOMATED DRAFTING (Researcher -> Planner -> Writer)
        # ======================================================================
        if action == "draft":
            # Stage 1: Intelligence Researcher (Pro + Google Search)
            current_stage = f"Stage 1: Researcher ({PRO_MODEL})"
            research_prompt = request_json.get("research_prompt", "You are a researcher.")
            full_research_prompt = f"{research_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}"

            research_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=full_research_prompt,
                config=types.GenerateContentConfig(
                    tools=[{"google_search": {}}],
                    temperature=0.7,
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                ),
            )
            research_dossier = research_res.text or ""

            if "INPUT ERROR:" in research_dossier:
                raise ValueError(f"Researcher Aborted: {research_dossier.strip()}")

            # Stage 2: Editorial Architect / Planner (Flash)
            current_stage = f"Stage 2: Planner ({FLASH_MODEL})"
            plan_prompt = request_json.get("plan_prompt", "You are an Editorial Architect.")
            full_plan_prompt = (
                f"{plan_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}\n"
                f"<research_dossier>\n{research_dossier}\n</research_dossier>"
            )

            plan_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=full_plan_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                ),
            )
            editorial_blueprint = plan_res.text or ""

            if "INPUT ERROR:" in editorial_blueprint:
                raise ValueError(f"Planner Aborted: {editorial_blueprint.strip()}")

            # Stage 3: Senior B2B Writer (Pro)
            current_stage = f"Stage 3: Writer ({PRO_MODEL})"
            writer_prompt = request_json.get("writer_prompt", "You are a B2B writer.")
            full_writer_prompt = (
                f"{writer_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}\n"
                f"<research_dossier>\n{research_dossier}\n</research_dossier>\n"
                f"<editorial_blueprint>\n{editorial_blueprint}\n</editorial_blueprint>"
            )

            writer_res = client.models.generate_content(
                model=PRO_MODEL,
                contents=full_writer_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.7,
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
                ),
            )
            raw_writer_output = writer_res.text or ""

            if "INPUT ERROR:" in raw_writer_output:
                raise ValueError(f"Writer Aborted: {raw_writer_output.strip()}")

            final_output = strip_scratchpad(raw_writer_output)

        # ======================================================================
        # PHASE 2: SEO / GEO OPTIMIZATION (Optimizer)
        # ======================================================================
        elif action == "optimize":
            current_stage = f"Stage 4: Optimizer ({FLASH_MODEL})"

            if not draft_text.strip():
                return json_response(
                    {
                        "status": "error",
                        "failed_stage": current_stage,
                        "error_details": "No draft_text provided for optimization.",
                    },
                    400,
                )

            optimize_prompt = request_json.get(
                "optimizer_prompt", "You are an SEO/GEO specialist. Optimize this text."
            )
            full_optimize_prompt = (
                f"{optimize_prompt}\n\n--- ASSIGNMENT INPUTS ---\n{xml_base_inputs}\n"
                f"<draft_text>\n{draft_text}\n</draft_text>"
            )

            optimize_res = client.models.generate_content(
                model=FLASH_MODEL,
                contents=full_optimize_prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    thinking_config=types.ThinkingConfig(thinking_level="MEDIUM"),
                ),
            )
            raw_optimize_output = optimize_res.text or ""

            if "INPUT ERROR:" in raw_optimize_output:
                raise ValueError(f"Optimizer Aborted: {raw_optimize_output.strip()}")

            final_output = strip_scratchpad(raw_optimize_output)

        else:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": f"Invalid action parameter: '{action}'. Expected 'draft' or 'optimize'.",
                },
                400,
            )

        return json_response(
            {
                "status": "success",
                "action_completed": action,
                "topic": topic,
                "article": final_output,
            },
            200,
        )

    except Exception as e:
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": str(e),
            },
            500,
        )
