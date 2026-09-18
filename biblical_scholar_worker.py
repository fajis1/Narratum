import asyncio
import json
import re
import os
import difflib
from nats.aio.client import Client as NATS
from google import genai
from gemini_rate_limiter import (
    call_gemini_with_capacity_fallback,
    extract_gemini_usage,
    ordered_gemini_models,
)

# --- PER-KEY/MODEL RATE LIMITER STATE ---
API_STATES = {}
MAX_DELAY = 300            
MIN_DELAY = 5              
MAX_IN_FLIGHT_DELAY = 20   # Maximum delay to sleep within a single NATS request
QUALITY_REPAIR_MODEL = "gemini-3.8-flash"

def academic_pre_clean(text, user_abbreviations, biblical_books):
    """Phase 1: Regex & Structural Expansion"""
    pt = text
    for short, full in biblical_books.items():
        pattern = rf"\b{re.escape(short)}\.?\s+(\d+):(\d+)([-–](\d+))?"
        def replace_range(match):
            chapter, verse_start, _, verse_end = match.groups()
            if verse_end:
                return f"{full} chapter {chapter} verse {verse_start} through {verse_end}"
            return f"{full} chapter {chapter} verse {verse_start}"
        pt = re.sub(pattern, replace_range, pt)
    pt = re.sub(r'\bvv\.\s*(\d+)', r'verses \1', pt)
    pt = re.sub(r'\bv\.\s*(\d+)', r'verse \1', pt)
    if user_abbreviations:
        for key in sorted(user_abbreviations.keys(), key=len, reverse=True): 
            pt = re.sub(r'(?<!\w)' + re.escape(key) + r'(?!\w)', user_abbreviations[key], pt)
    return pt

async def process_message(msg):
    data = json.loads(msg.data.decode())
    user_id = data.get("user_id", "Unknown")
    api_key = data.get("api_key")
    backup_api_key = data.get("backup_api_key")
    prompt = data.get("prompt")
    pronunciation_prompt = data.get("pronunciation_prompt", "")
    final_cleanup_rules = data.get("final_cleanup_rules", "")
    validation_feedback = data.get("validation_feedback", "")
    rejected_output = data.get("rejected_output", "")
    raw_text = data.get("raw_text")
    
    text_length = len(raw_text) if raw_text else 0
    print(f"\n[📦] INCOMING BATCH SIZE (SCHOLAR PROFILE): {text_length} characters")
    print(f"[🔍] PREVIEW: {str(raw_text)[:150]}...\n")
    
    pronunciations = data.get("pronunciations", {})
    abbreviations = data.get("abbreviations", {})
    books = data.get("books", {})
    ai_model = data.get("ai_model") or "gemini-3.5-flash"
    ai_models = ordered_gemini_models(ai_model, data.get("ai_model_fallbacks"))
    empty_response_escalated = False
    
    print(f"\n[*] New job intercepted for User: {user_id}")

    if not api_key or not raw_text:
        print("[!] Missing API Key or Text. Aborting job.")
        await msg.respond(json.dumps({"status": "error", "message": "Missing API Key"}).encode())
        return

    try:
        # PHASE 1: Pre-Clean with Regex & Abbreviations
        print("  -> Running fast pre-clean...")
        pre_cleaned_text = academic_pre_clean(raw_text, abbreviations, books)
        
        # Definitions and pronunciations are resolved once during the book
        # pre-scan and are already present in raw_text. Scholar cleanup uses
        # one semantic request, plus at most one validation-driven correction.
        enriched_text = pre_cleaned_text

        # PHASE 2: Gemini Processing
        print("  -> Initializing Gemini SDK...")
        dict_string = json.dumps(pronunciations, indent=2, ensure_ascii=False)
        dynamic_constraints = f"CRITICAL CONTINUITY RULE: Use these exact phonetic spellings:\n{dict_string}\n\n"
        title_instruction = "CHAPTER TITLE GENERATION: For narratable text, you MUST summarize the provided text into a unique 3 to 5 word descriptive title based on its actual contents. DO NOT just copy the existing chapter title (e.g. 'Foreword' or 'Chapter 1'). At the very end of your response, after the cleaned text, you MUST add exactly one blank line and then output the title wrapped in tags exactly like this: [CHAPTER_TITLE: Three Word Summary]. Do not include the chapter number or 'continued'. If the correct result is [OMIT], return only [OMIT] and do not add a chapter title.\n\n"
        
        if validation_feedback and rejected_output:
            repair_instruction = (
                "CORRECTION PASS: Reader rejected the previous cleaned output. Correct the complete output using "
                "the exact validation feedback below. Preserve all valid cleanup decisions and change only what is "
                "needed to satisfy the rules. Never explain the correction. Return the complete corrected audiobook "
                "text, not a patch or excerpt. If a pronunciation cannot be made safe, remove only its [word](/IPA/) "
                "markup and leave the corrected visible word as ordinary text. If validation says substantial source "
                "text was omitted, do not return [OMIT]; preserve every narratable sentence.\n\n"
                f"VALIDATION FEEDBACK:\n{validation_feedback}\n\n"
                f"REJECTED CLEANED OUTPUT:\n{rejected_output}\n\n"
            )
        else:
            repair_instruction = ""
        full_prompt = f"{prompt}\n\n{dynamic_constraints}{pronunciation_prompt}\n\n{title_instruction}{final_cleanup_rules}\n\n{repair_instruction}Original text to clean:\n{enriched_text}"
        final_text = ""
        
        async def request_content(active_key, active_model):
            print(f"  -> Processing text with Gemini model {active_model}...")
            return await genai.Client(api_key=active_key).aio.models.generate_content(
                model=active_model,
                contents=full_prompt,
            )

        generated = await call_gemini_with_capacity_fallback(
            api_states=API_STATES,
            api_keys=[api_key, backup_api_key],
            models=ai_models,
            request=request_content,
            min_delay=MIN_DELAY,
            max_delay=MAX_DELAY,
            max_in_flight_delay=MAX_IN_FLIGHT_DELAY,
        )
        if generated is None:
            await msg.respond(json.dumps({
                "status": "rate_limit",
                "message": "All configured Gemini cleanup models are rate limited.",
                "cooldownSeconds": MAX_DELAY,
            }).encode())
            return
        response, ai_model = generated
        if not response.text or not response.text.strip():
            if ai_model != QUALITY_REPAIR_MODEL and not empty_response_escalated:
                empty_response_escalated = True
                repaired = await call_gemini_with_capacity_fallback(
                    api_states=API_STATES,
                    api_keys=[api_key, backup_api_key],
                    models=[QUALITY_REPAIR_MODEL],
                    request=request_content,
                    min_delay=MIN_DELAY,
                    max_delay=MAX_DELAY,
                    max_in_flight_delay=MAX_IN_FLIGHT_DELAY,
                )
                if repaired is None:
                    await msg.respond(json.dumps({
                        "status": "rate_limit",
                        "message": "The Gemini quality-repair model is rate limited.",
                        "cooldownSeconds": MAX_DELAY,
                    }).encode())
                    return
                response, ai_model = repaired
            if not response.text or not response.text.strip():
                raise RuntimeError("Gemini returned no text; expected cleaned text or [OMIT]")
        final_text = response.text.strip()

        # PHASE 3: Two-Way Sync Extraction & Title
        title_match = re.search(r'\[\s*CHAPTER_TITLE\s*:\s*(.*?)\]', final_text, re.IGNORECASE)
        chapter_title = ""
        if title_match:
            chapter_title = title_match.group(1).strip()
            final_text = final_text[:title_match.start()].strip()

        outcome = "omitted" if final_text.upper() in {"[OMIT]", "[OMITTED]"} else "cleaned"
        if outcome == "omitted":
            final_text = ""
            chapter_title = ""

        # Strip out the bypass exclamation mark from heteronym tags so TTS gets valid markup
        final_text = re.sub(r'\[([^\]]+)\]\(!(/[^/]+/)\)', r'[\1](\2)', final_text)

        # PHASE 4: Changelog Generation
        diff_lines = list(difflib.unified_diff(
            raw_text.splitlines(),
            final_text.splitlines(),
            fromfile='Original',
            tofile='AI Cleaned (Scholar)',
            lineterm=''
        ))
        changelog = '\n'.join(diff_lines)

        result = {
            "status": "success",
            "outcome": outcome,
            "cleaned_text": final_text,
            "changelog": changelog,
            "chapter_title": chapter_title,
            "model_used": ai_model,
            "usage": extract_gemini_usage(response),
        }
        
        await msg.respond(json.dumps(result).encode())
        print("[*] Job finished and returned to the NATS queue.")

    except Exception as e:
        print(f"[!] Critical API Error: {e}")
        await msg.respond(json.dumps({"status": "error", "message": str(e)}).encode())

async def main():
    nc = NATS()
    try:
        nats_url = os.environ.get("NATS_URL", "nats://127.0.0.1:4222")
        await nc.connect(nats_url)
        print("==========================================")
        print("  BIBLICAL SCHOLAR WORKER IS ONLINE")
        print("  [Loaded: Regex Engine, Gemini Semantics, Auto-Sync Module]")
        print("==========================================")
        # We listen to a distinct queue to allow Next.js to route to this specific profile
        await nc.subscribe("audiobooks.scholar.clean", cb=process_message)
        
        while True:
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        print("\nShutting down worker...")
    finally:
        if nc.is_connected:
            await nc.close()

if __name__ == '__main__':
    asyncio.run(main())
