from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import random
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any
from xml.sax import saxutils

import flask
import functions_framework
import google.auth
from google.auth.transport.requests import Request as GoogleAuthRequest
import requests
from google import genai
from google.genai import types

PRO_MODEL = os.environ.get("GEMINI_PRO_MODEL", "gemini-3.1-pro-preview")
FLASH_MODEL = os.environ.get("GEMINI_FLASH_MODEL", "gemini-3.8-flash")

DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files"

DOC_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{10,128}$")
PRIVATE_USE_CHARS_RE = re.compile(r"[\uE000-\uF8FF]")
LEADING_SCRATCHPAD_RE = re.compile(
    r"^\s*<scratchpad\b[^>]*>.*?</scratchpad>\s*",
    flags=re.DOTALL | re.IGNORECASE,
)
OPEN_SCRATCHPAD_RE = re.compile(r"<scratchpad\b[^>]*>", flags=re.IGNORECASE)

VALID_ACTIONS = frozenset({"research", "plan", "write", "optimize"})
TRANSIENT_STATUS_CODES = frozenset({429, 503})
MAX_GENERATION_ATTEMPTS = 3
INITIAL_BACKOFF_SECONDS = 1.5

STAGE_PROMPT_KEYS = {
    "research": "researcher",
    "plan": "planner",
    "write": "writer",
    "optimize": "optimizer",
}


class ConfigurationError(RuntimeError):
    """Raised when required server configuration or secrets are missing."""


class PromptAccessError(PermissionError):
    """Raised when a prompt document fails Drive allowlist or read checks."""


class InputValidationError(ValueError):
    """Raised when caller inputs fail validation or an agent emits INPUT ERROR:."""


class StageExecutionError(ValueError):
    """Raised when Gemini returns non-STOP finish_reason, empty text, or malformed scratchpad."""


def log_event(severity: str, message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "severity": severity.upper(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": message,
    }
    payload.update(fields)
    line = json.dumps(payload, default=str)
    print(line, file=sys.stdout, flush=True)


_GENAI_CLIENT: genai.Client | None = None
_GENAI_CLIENT_KEY_HASH: str | None = None


def _build_genai_client(api_key: str) -> genai.Client:
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1beta"),
    )


def _init_module_genai_client() -> None:
    global _GENAI_CLIENT, _GENAI_CLIENT_KEY_HASH
    api_key = (
        os.environ.get("GOOGLE_API_KEY_ARTICLE")
        or os.environ.get("GOOGLE_API_KEY")
        or ""
    ).strip()
    if api_key:
        _GENAI_CLIENT = _build_genai_client(api_key)
        _GENAI_CLIENT_KEY_HASH = hashlib.sha256(api_key.encode("utf-8")).hexdigest()


# Cache genai.Client at module load when configured in the environment.
_init_module_genai_client()


def get_genai_client() -> genai.Client:
    global _GENAI_CLIENT, _GENAI_CLIENT_KEY_HASH
    api_key = (
        os.environ.get("GOOGLE_API_KEY_ARTICLE")
        or os.environ.get("GOOGLE_API_KEY")
        or ""
    ).strip()
    if not api_key:
        raise ConfigurationError("Missing Gemini API key configuration.")

    key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    if _GENAI_CLIENT is None or _GENAI_CLIENT_KEY_HASH != key_hash:
        _GENAI_CLIENT = _build_genai_client(api_key)
        _GENAI_CLIENT_KEY_HASH = key_hash
    return _GENAI_CLIENT


def json_response(payload: dict[str, Any], status_code: int = 200):
    return (
        json.dumps(payload),
        status_code,
        {"Content-Type": "application/json"},
    )


def verify_webhook_secret(request: Any) -> bool:
    expected = os.environ.get("WEBHOOK_SHARED_SECRET", "")
    provided = request.headers.get("X-Webhook-Secret", "")
    if not expected or not provided:
        return False
    return hmac.compare_digest(
        provided.encode("utf-8"),
        expected.encode("utf-8"),
    )


def sanitize_prompt_text(text: str) -> str:
    return PRIVATE_USE_CHARS_RE.sub("", text or "").strip()


def escape_xml(value: str) -> str:
    return saxutils.escape(str(value or ""))


def build_xml_inputs(
    topic: str,
    core_focus: str = "",
    description: str = "",
    extra_tags: list[tuple[str, str]] | None = None,
) -> str:
    lines = [
        "<inputs>",
        f"  <topic>{escape_xml(topic)}</topic>",
        f"  <core_focus>{escape_xml(core_focus)}</core_focus>",
        f"  <description>{escape_xml(description)}</description>",
    ]
    for tag_name, tag_value in extra_tags or []:
        lines.append(f"  <{tag_name}>\n{escape_xml(tag_value)}\n  </{tag_name}>")
    lines.append("</inputs>")
    return "\n".join(lines)


def strip_scratchpad(text: str) -> str:
    if not text:
        return ""
    cleaned = LEADING_SCRATCHPAD_RE.sub("", text, count=1)
    if OPEN_SCRATCHPAD_RE.search(cleaned):
        raise StageExecutionError("Unclosed <scratchpad> tag detected in model output.")
    return cleaned.strip()


def _normalize_finish_reason(finish_reason: Any) -> str:
    if finish_reason is None:
        return ""
    name = getattr(finish_reason, "name", None)
    if isinstance(name, str) and name:
        return name.upper()
    value = getattr(finish_reason, "value", None)
    if isinstance(value, str) and value:
        return value.upper()
    raw = str(finish_reason).upper()
    if "." in raw:
        raw = raw.rsplit(".", 1)[-1]
    return raw


def validate_and_clean_output(response: Any, stage_name: str) -> str:
    candidates = getattr(response, "candidates", None)
    if not candidates:
        raise StageExecutionError(f"{stage_name} returned no candidates.")

    finish_reason = _normalize_finish_reason(
        getattr(candidates[0], "finish_reason", None)
    )
    if finish_reason != "STOP":
        raise StageExecutionError(
            f"{stage_name} did not finish cleanly (finish_reason={finish_reason or 'UNKNOWN'})."
        )

    raw_text = getattr(response, "text", None) or ""
    cleaned = strip_scratchpad(raw_text)

    if cleaned.lstrip().startswith("INPUT ERROR:"):
        first_line = cleaned.lstrip().splitlines()[0].strip()
        raise InputValidationError(f"{stage_name} rejected inputs: {first_line[:400]}")

    if not cleaned:
        raise StageExecutionError(f"{stage_name} returned empty output.")

    return cleaned


def _extract_usage_metrics(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage_metadata", None)
    if usage is None:
        return {
            "input_tokens": 0,
            "output_tokens": 0,
            "thoughts_tokens": 0,
            "total_tokens": 0,
        }
    return {
        "input_tokens": int(getattr(usage, "prompt_token_count", 0) or 0),
        "output_tokens": int(getattr(usage, "candidates_token_count", 0) or 0),
        "thoughts_tokens": int(getattr(usage, "thoughts_token_count", 0) or 0),
        "total_tokens": int(getattr(usage, "total_token_count", 0) or 0),
    }


def _is_transient_error(exc: Exception) -> tuple[bool, int | None]:
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if isinstance(code, int) and code in TRANSIENT_STATUS_CODES:
        return True, code
    if isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError)):
        return True, None
    return False, code if isinstance(code, int) else None


def fetch_prompt_from_drive(
    doc_id: str,
    allowed_folder_id: str | None = None,
) -> str:
    clean_doc_id = (doc_id or "").strip()
    if not DOC_ID_PATTERN.match(clean_doc_id):
        raise InputValidationError("Invalid prompt_doc_id format.")

    expected_folder = (
        allowed_folder_id
        if allowed_folder_id is not None
        else os.environ.get("ALLOWED_PROMPT_FOLDER_ID", "")
    ).strip()
    if not expected_folder:
        raise ConfigurationError("ALLOWED_PROMPT_FOLDER_ID is not configured.")

    credentials, _ = google.auth.default(scopes=[DRIVE_READONLY_SCOPE])
    if not credentials.valid or not credentials.token:
        credentials.refresh(GoogleAuthRequest())

    headers = {"Authorization": f"Bearer {credentials.token}"}

    meta_resp = requests.get(
        f"{DRIVE_FILES_API}/{clean_doc_id}",
        params={
            "fields": "id,name,mimeType,parents,trashed",
            "supportsAllDrives": "true",
        },
        headers=headers,
        timeout=15,
    )
    if meta_resp.status_code in (401, 403, 404):
        raise PromptAccessError("Prompt document not found or access denied.")
    meta_resp.raise_for_status()

    metadata = meta_resp.json()
    if metadata.get("trashed"):
        raise PromptAccessError("Prompt document is trashed and cannot be used.")

    parents = metadata.get("parents") or []
    if expected_folder not in parents:
        log_event(
            "WARNING",
            "Rejected prompt document outside ALLOWED_PROMPT_FOLDER_ID",
            doc_id=clean_doc_id,
            expected_folder=expected_folder,
        )
        raise PromptAccessError(
            "Prompt document parent does not match ALLOWED_PROMPT_FOLDER_ID."
        )

    export_resp = requests.get(
        f"{DRIVE_FILES_API}/{clean_doc_id}/export",
        params={"mimeType": "text/plain"},
        headers=headers,
        timeout=30,
    )
    if export_resp.status_code in (401, 403, 404):
        raise PromptAccessError("Failed to export prompt document.")
    export_resp.raise_for_status()

    decoded = export_resp.content.decode("utf-8-sig")
    sanitized = sanitize_prompt_text(decoded)
    if not sanitized:
        raise PromptAccessError("Exported prompt document is empty.")

    return sanitized


def call_gemini_stage(
    *,
    client: genai.Client,
    stage_name: str,
    action: str,
    model: str,
    system_instruction: str,
    contents: str,
    thinking_level: str,
    use_search: bool = False,
) -> tuple[str, dict[str, Any]]:
    config_kwargs: dict[str, Any] = {
        "system_instruction": system_instruction,
        "max_output_tokens": 65536,
        "thinking_config": types.ThinkingConfig(thinking_level=thinking_level),
    }
    if use_search:
        config_kwargs["tools"] = [{"google_search": {}}]

    config = types.GenerateContentConfig(**config_kwargs)

    start_ns = time.monotonic_ns()
    last_exc: Exception | None = None

    for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=contents,
                config=config,
            )
            cleaned_output = validate_and_clean_output(response, stage_name)
            duration_ms = int((time.monotonic_ns() - start_ns) / 1_000_000)
            usage = _extract_usage_metrics(response)
            metrics = {
                "model": model,
                "duration_ms": duration_ms,
                "attempts": attempt,
                **usage,
            }
            log_event(
                "INFO",
                "Stage completed successfully",
                stage=stage_name,
                action=action,
                **metrics,
            )
            return cleaned_output, metrics
        except (InputValidationError, StageExecutionError):
            raise
        except Exception as exc:
            last_exc = exc
            is_transient, status_code = _is_transient_error(exc)
            if is_transient and attempt < MAX_GENERATION_ATTEMPTS:
                backoff = INITIAL_BACKOFF_SECONDS * (2 ** (attempt - 1)) + random.uniform(
                    0.0, 0.25
                )
                log_event(
                    "WARNING",
                    "Transient Gemini error; retrying stage",
                    stage=stage_name,
                    action=action,
                    attempt=attempt,
                    max_attempts=MAX_GENERATION_ATTEMPTS,
                    status_code=status_code,
                    backoff_seconds=round(backoff, 3),
                )
                time.sleep(backoff)
                continue
            if is_transient:
                raise StageExecutionError(
                    f"{stage_name} failed after {MAX_GENERATION_ATTEMPTS} attempts due to transient upstream error ({status_code or 'network'})."
                ) from exc
            raise

    raise StageExecutionError(f"{stage_name} failed unexpectedly.") from last_exc


def _resolve_prompt_doc_id(request_json: dict[str, Any], action: str) -> str:
    direct_id = str(request_json.get("prompt_doc_id") or "").strip()
    if direct_id:
        return direct_id

    doc_ids = request_json.get("prompt_doc_ids")
    if isinstance(doc_ids, dict):
        stage_key = STAGE_PROMPT_KEYS.get(action, "")
        candidate = str(doc_ids.get(action) or doc_ids.get(stage_key) or "").strip()
        if candidate:
            return candidate

    return ""


@functions_framework.http
def generate_blog_post(request: Any):
    path = (getattr(request, "path", "/") or "/").rstrip("/") or "/"

    if request.method == "GET" and path == "/health":
        return json_response({"status": "ok"}, 200)

    if request.method != "POST":
        return json_response(
            {"status": "error", "error_details": "Method Not Allowed."},
            405,
        )

    if path not in ("/", "/stage"):
        return json_response(
            {"status": "error", "error_details": "Not Found."},
            404,
        )

    if not verify_webhook_secret(request):
        log_event(
            "WARNING",
            "Rejected unauthenticated webhook request",
            method=request.method,
            path=path,
        )
        return json_response(
            {"status": "error", "error_details": "Unauthorized."},
            401,
        )

    current_stage = "Validation"

    try:
        request_json = request.get_json(silent=True)
        if not isinstance(request_json, dict) or not request_json:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": "Missing or invalid JSON request body.",
                },
                400,
            )

        action = str(request_json.get("action") or "").strip().lower()
        if action not in VALID_ACTIONS:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": (
                        "Missing or invalid 'action'. Expected one of: "
                        "research, plan, write, optimize."
                    ),
                },
                400,
            )

        topic = str(request_json.get("topic") or "").strip()
        if not topic:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": "Missing required field: 'topic'.",
                },
                400,
            )

        prompt_doc_id = _resolve_prompt_doc_id(request_json, action)
        if not prompt_doc_id:
            return json_response(
                {
                    "status": "error",
                    "failed_stage": current_stage,
                    "error_details": "Missing required field: 'prompt_doc_id'.",
                },
                400,
            )

        core_focus = str(request_json.get("core_focus") or "").strip()
        description = str(request_json.get("description") or "").strip()

        extra_tags: list[tuple[str, str]] = []
        if action == "research":
            stage_name = f"Stage 1: Researcher ({PRO_MODEL})"
            model = PRO_MODEL
            thinking_level = "HIGH"
            use_search = True
        elif action == "plan":
            stage_name = f"Stage 2: Planner ({FLASH_MODEL})"
            research_dossier = str(request_json.get("research_dossier") or "").strip()
            if not research_dossier:
                return json_response(
                    {
                        "status": "error",
                        "failed_stage": current_stage,
                        "error_details": "Missing required field for 'plan': 'research_dossier'.",
                    },
                    400,
                )
            extra_tags.append(("research_dossier", research_dossier))
            model = FLASH_MODEL
            thinking_level = "MEDIUM"
            use_search = False
        elif action == "write":
            stage_name = f"Stage 3: Writer ({PRO_MODEL})"
            research_dossier = str(request_json.get("research_dossier") or "").strip()
            editorial_blueprint = str(
                request_json.get("editorial_blueprint")
                or request_json.get("plan_blueprint")
                or ""
            ).strip()
            if not research_dossier or not editorial_blueprint:
                return json_response(
                    {
                        "status": "error",
                        "failed_stage": current_stage,
                        "error_details": (
                            "Missing required fields for 'write': "
                            "'research_dossier' and 'editorial_blueprint'."
                        ),
                    },
                    400,
                )
            extra_tags.append(("research_dossier", research_dossier))
            extra_tags.append(("editorial_blueprint", editorial_blueprint))
            model = PRO_MODEL
            thinking_level = "HIGH"
            use_search = False
        else:  # optimize
            stage_name = f"Stage 4: Optimizer ({FLASH_MODEL})"
            draft_text = str(request_json.get("draft_text") or "").strip()
            if not draft_text:
                return json_response(
                    {
                        "status": "error",
                        "failed_stage": current_stage,
                        "error_details": "Missing required field for 'optimize': 'draft_text'.",
                    },
                    400,
                )
            extra_tags.append(("draft_text", draft_text))
            model = FLASH_MODEL
            thinking_level = "MEDIUM"
            use_search = False

        current_stage = f"Prompt Fetch ({action})"
        prompt_instruction = fetch_prompt_from_drive(prompt_doc_id)

        current_stage = stage_name
        client = get_genai_client()
        xml_inputs = build_xml_inputs(
            topic=topic,
            core_focus=core_focus,
            description=description,
            extra_tags=extra_tags,
        )

        final_output, metrics = call_gemini_stage(
            client=client,
            stage_name=stage_name,
            action=action,
            model=model,
            system_instruction=prompt_instruction,
            contents=xml_inputs,
            thinking_level=thinking_level,
            use_search=use_search,
        )

        return json_response(
            {
                "status": "success",
                "action_completed": action,
                "topic": topic,
                "output": final_output,
                "article": final_output,
                "metrics": metrics,
            },
            200,
        )

    except InputValidationError as exc:
        log_event(
            "WARNING",
            "Input validation failed",
            stage=current_stage,
            error=str(exc),
        )
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": str(exc),
            },
            400,
        )
    except PromptAccessError as exc:
        log_event(
            "WARNING",
            "Prompt access check failed",
            stage=current_stage,
            error=str(exc),
        )
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": str(exc),
            },
            403,
        )
    except StageExecutionError as exc:
        log_event(
            "ERROR",
            "Model stage execution failed",
            stage=current_stage,
            error=str(exc),
        )
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": str(exc),
            },
            502,
        )
    except ConfigurationError as exc:
        log_event(
            "ERROR",
            "Server configuration error",
            stage=current_stage,
            error=str(exc),
        )
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": "Server configuration error.",
            },
            500,
        )
    except Exception:
        log_event(
            "ERROR",
            "Unhandled exception during stage execution",
            stage=current_stage,
            traceback=traceback.format_exc(),
        )
        return json_response(
            {
                "status": "error",
                "failed_stage": current_stage,
                "error_details": "Internal server error during stage execution.",
            },
            500,
        )


def create_wsgi_app() -> flask.Flask:
    wsgi_app = flask.Flask(__name__)
    all_methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]

    @wsgi_app.route("/", methods=all_methods, provide_automatic_options=False)
    @wsgi_app.route("/<path:subpath>", methods=all_methods, provide_automatic_options=False)
    def _dispatch(subpath: str = ""):
        return generate_blog_post(flask.request)

    return wsgi_app


app = create_wsgi_app()
