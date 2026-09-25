import asyncio
import json
import re
import os
from nats.aio.client import Client as NATS
from google import genai
from pydantic import BaseModel, Field
from gemini_rate_limiter import (
    call_gemini_with_capacity_fallback,
    extract_gemini_usage,
    ordered_gemini_models,
)

# --- PER-KEY RATE LIMITER STATE ---
# Maps (api_key, model) -> per-capacity-pool cooldown state.
API_STATES = {}
MAX_DELAY = 300            # 5 minutes (in seconds)
MIN_DELAY = 5              # The starting penalty
MAX_IN_FLIGHT_DELAY = 20   # Maximum delay to sleep within a single NATS request
QUALITY_REPAIR_MODEL = "gemini-3.8-flash"

def academic_pre_clean(text, user_abbreviations, biblical_books):
    """Phase 1: Regex & Structural Expansion"""
    pt = text
    
    # 1. Structural Biblical Reference Handler (The Regex Pass)
    # This matches [Book] [Chapter]:[Verse] or [Book] [Chapter]:[Verse]-[Verse]
    for short, full in biblical_books.items():
        # Pattern matches: "1 Sam 1:2" or "1 Sam 1:2-5"
        # \b ensures "1 Sam" matches but not "1 Samuel"
        pattern = rf"\b{re.escape(short)}\.?\s+(\d+):(\d+)([-–](\d+))?"
        
        def replace_range(match):
            chapter, verse_start, _, verse_end = match.groups()
            if verse_end:
                return f"{full} chapter {chapter} verse {verse_start} through {verse_end}"
            return f"{full} chapter {chapter} verse {verse_start}"
        
        pt = re.sub(pattern, replace_range, pt)

    # 2. Universal Numbering Fixes
    pt = re.sub(r'\bvv\.\s*(\d+)', r'verses \1', pt)
    pt = re.sub(r'\bv\.\s*(\d+)', r'verse \1', pt)
    
    # 3. Static Abbreviation Pass (Direct Swap)
    if user_abbreviations:
        for key in sorted(user_abbreviations.keys(), key=len, reverse=True): 
            pt = re.sub(r'(?<!\w)' + re.escape(key) + r'(?!\w)', user_abbreviations[key], pt)
            
    return pt

async def process_message(msg):
    """Triggered when a NATS job arrives"""
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
    
    # --- ADD THESE 3 LINES RIGHT HERE ---
    text_length = len(raw_text) if raw_text else 0
    print(f"\n[📦] INCOMING BATCH SIZE: {text_length} characters")
    print(f"[🔍] PREVIEW: {str(raw_text)[:150]}...\n")
    # ------------------------------------
    
    # The new dynamic ledgers sent from Next.js
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
        full_prompt = f"{prompt}\n\n{dynamic_constraints}{pronunciation_prompt}\n\n{title_instruction}{final_cleanup_rules}\n\n{repair_instruction}Original text to clean:\n{pre_cleaned_text}"
        final_text = ""
        
        async def request_content(active_key, active_model):
            print(f"  -> Processing text with AI model {active_model}...")
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
        # PHASE 3: Option B - Two-Way Sync Extraction & Title
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
        import difflib
        diff_lines = list(difflib.unified_diff(
            raw_text.splitlines(),
            final_text.splitlines(),
            fromfile='Original',
            tofile='AI Cleaned',
            lineterm=''
        ))
        changelog = '\n'.join(diff_lines)

        # Package it all up to send back to Next.js
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


class Character(BaseModel):
    name: str = Field(description="Exact character name, or Narrator")
    description: str = Field(description="Brief age, personality, and speaking-style description")
    sample_text: str = Field(description="A short direct quote spoken by this character")
    importance: str = Field(
        default="minor",
        description="'main' if this character is a primary protagonist, central antagonist, or frequent core speaker (Narrator is always main); 'minor' if they are secondary, incidental, or background speakers"
    )


class CharacterExtractionResult(BaseModel):
    characters: list[Character]


class VoiceSegment(BaseModel):
    speaker: str = Field(description="Exact primary character or alias name from the supplied cast")
    voice_id: str = Field(description="Exact voice ID assigned to that character")
    text: str = Field(description="Complete narration or dialogue for this consecutive speaker segment")
    omit_from_audio: bool = Field(default=False, description="True only for a redundant attribution retained for review but skipped by TTS")


class VoiceAssignmentResult(BaseModel):
    segments: list[VoiceSegment]
    continuity_state: str = Field(description="Brief scene and final-speaker context for the next chunk")
    chapter_title: str = Field(description="A unique three-to-five-word descriptive title")


async def generate_multivoice_content(msg, api_key, backup_api_key, model, model_fallbacks, contents, response_schema):
    """Use the standard worker's per-key cooldown state for Audio Drama calls."""
    async def request_content(active_key, active_model):
        return await genai.Client(api_key=active_key).aio.models.generate_content(
                    model=active_model,
                    contents=contents,
                    config=genai.types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=response_schema,
                    ),
                )

    generated = await call_gemini_with_capacity_fallback(
        api_states=API_STATES,
        api_keys=[api_key, backup_api_key],
        models=ordered_gemini_models(model, model_fallbacks),
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
        return None
    response, active_model = generated
    if not response.text or not response.text.strip():
        if active_model != QUALITY_REPAIR_MODEL:
            generated = await call_gemini_with_capacity_fallback(
                api_states=API_STATES,
                api_keys=[api_key, backup_api_key],
                models=[QUALITY_REPAIR_MODEL],
                request=request_content,
                min_delay=MIN_DELAY,
                max_delay=MAX_DELAY,
                max_in_flight_delay=MAX_IN_FLIGHT_DELAY,
            )
            if generated is None:
                await msg.respond(json.dumps({
                    "status": "rate_limit",
                    "message": "The Gemini quality-repair model is rate limited.",
                    "cooldownSeconds": MAX_DELAY,
                }).encode())
                return None
            response, active_model = generated
        if not response.text or not response.text.strip():
            raise RuntimeError("Gemini returned an empty structured Audio Drama response")
    return response, active_model


async def process_multivoice_extract(msg):
    """Extract a reviewable cast from canonical, evenly sampled book text."""
    try:
        data = json.loads(msg.data.decode())
        raw_text = data.get("raw_text") or ""
        api_key = data.get("api_key") or ""
        if not api_key or not raw_text.strip():
            await msg.respond(json.dumps({"status": "error", "message": "Missing API key or document text"}).encode())
            return
        prompt = (
            "You are casting a LitRPG audiobook. Extract every distinct speaking character visible in the supplied "
            "chapter excerpts. Always include one character named Narrator. Merge obvious spelling variants only when "
            "they clearly identify the same person; otherwise keep them separate so the user can review aliases. "
            "Do not treat chapter headings, stat names, classes, skills, monsters without dialogue, footnotes, authors, "
            "or publishers as speakers. Preserve exact character-name spelling and provide one real short quote when available. "
            "Classify each character's importance as 'main' (for central protagonists, major antagonists, Narrator, or frequent core speakers) "
            "or 'minor' (for secondary, incidental, single-scene, or background speakers).\n\n"
            f"BOOK EXCERPTS:\n{raw_text}"
        )
        generated = await generate_multivoice_content(
            msg,
            api_key,
            data.get("backup_api_key") or "",
            data.get("ai_model") or "gemini-3.1-flash-lite",
            data.get("ai_model_fallbacks"),
            prompt,
            CharacterExtractionResult,
        )
        if generated is None:
            return
        response, model_used = generated
        parsed = json.loads(response.text)
        await msg.respond(json.dumps({
            "status": "success",
            "characters": parsed.get("characters", []),
            "model_used": model_used,
            "usage": extract_gemini_usage(response),
        }, ensure_ascii=False).encode())
    except Exception as error:
        print(f"[!] Audio Drama character extraction error: {error}")
        await msg.respond(json.dumps({"status": "error", "message": str(error)}).encode())


async def process_multivoice_assign(msg):
    """Return structured, server-validated speaker segments for one audiobook chunk."""
    try:
        data = json.loads(msg.data.decode())
        raw_text = data.get("raw_text") or ""
        api_key = data.get("api_key") or ""
        characters = data.get("characters") or []
        if not api_key or not raw_text.strip() or not characters:
            await msg.respond(json.dumps({"status": "error", "message": "Missing API key, text, or reviewed cast"}).encode())
            return
        cast_json = json.dumps(characters, indent=2, ensure_ascii=False)
        pronunciations = json.dumps(data.get("pronunciations") or {}, indent=2, ensure_ascii=False)
        validation_feedback = data.get("validation_feedback") or ""
        rejected_output = data.get("rejected_output") or ""
        repair_context = ""
        if validation_feedback and rejected_output:
            repair_context = (
                "\n\nCORRECTION PASS: Reader rejected the previous structured response. Return the complete corrected "
                "response using the same schema. Preserve valid speaker assignments and text; change only what the "
                "validation feedback requires. If pronunciation markup cannot be made safe, remove only that markup "
                "and keep the corrected visible word as ordinary text. If validation says substantial source text "
                "was omitted, preserve every narratable sentence.\n\n"
                f"VALIDATION FEEDBACK:\n{validation_feedback}\n\n"
                f"REJECTED STRUCTURED OUTPUT:\n{rejected_output}\n"
            )
        prompt = (
            "You are assigning speakers for a LitRPG audiobook. Return structured JSON only. Split the supplied text "
            "into consecutive speaker segments. Use only exact primary names or aliases from REVIEWED CAST, and copy "
            "that cast member's exact voiceId into voice_id. Narrative prose belongs to Narrator. Preserve every "
            "narratable sentence and its order: do not summarize, omit, invent, or duplicate text, with ONE strictly narrow exception:\n"
            "You may set omit_from_audio=true for a Narrator segment ONLY if it meets ALL of the following criteria:\n"
            "1. It is a very short, redundant speech attribution (like 'he said', 'she replied').\n"
            "2. It is wedged DIRECTLY between two speech turns spoken by the EXACT SAME character (e.g., \"Hello,\" he said, \"taco taco.\").\n"
            "3. It contains ZERO action, setting description, or internal thoughts.\n"
            "FORBIDDEN: You must NEVER omit attributions when transitioning between different characters (e.g., 'Rina said. Charles replied.'). "
            "You must NEVER omit attributions that contain narrative action (e.g., 'Rina said harshly. A pause followed.'). "
            "These MUST remain intact and be spoken by the TTS.\n"
            "You may make only minor punctuation changes for speaking cadence. Never emit XML, HTML, bracketed control markers, stage "
            "directions, or commentary. Apply pronunciation overrides using Kokoro markup only where supplied.\n\n"
            f"REVIEWED CAST:\n{cast_json}\n\n"
            f"CONTINUITY FROM PREVIOUS CHUNK:\n{data.get('continuity_state') or 'Beginning of book.'}\n\n"
            f"PRONUNCIATION OVERRIDES:\n{pronunciations}\n"
            f"{data.get('pronunciation_prompt') or ''}\n\n"
            f"{data.get('final_cleanup_rules') or ''}\n\n"
            f"{repair_context}"
            f"TEXT TO ASSIGN:\n{raw_text}"
        )
        generated = await generate_multivoice_content(
            msg,
            api_key,
            data.get("backup_api_key") or "",
            data.get("ai_model") or "gemini-3.1-flash-lite",
            data.get("ai_model_fallbacks"),
            prompt,
            VoiceAssignmentResult,
        )
        if generated is None:
            return
        response, model_used = generated
        parsed = json.loads(response.text)
        await msg.respond(json.dumps({
            "status": "success",
            "segments": parsed.get("segments", []),
            "continuity_state": parsed.get("continuity_state", ""),
            "chapter_title": parsed.get("chapter_title", ""),
            "model_used": model_used,
            "usage": extract_gemini_usage(response),
        }, ensure_ascii=False).encode())
    except Exception as error:
        print(f"[!] Audio Drama voice assignment error: {error}")
        await msg.respond(json.dumps({"status": "error", "message": str(error)}).encode())

async def main():
    nc = NATS()
    try:
        nats_url = os.environ.get("NATS_URL", "nats://127.0.0.1:4222")
        await nc.connect(nats_url)
        print("==========================================")
        print("  PYTHON AUDIOBOOK WORKER IS ONLINE")
        print("  [Loaded: Standard Cleaner + LitRPG Audio Drama]")
        print("==========================================")
        await nc.subscribe("audiobooks.gemini.clean", cb=process_message)
        await nc.subscribe("audiobooks.multivoice.extract", cb=process_multivoice_extract)
        await nc.subscribe("audiobooks.multivoice.assign", cb=process_multivoice_assign)
        
        while True:
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        print("\nShutting down worker...")
    finally:
        if nc.is_connected:
            await nc.close()

if __name__ == '__main__':
    asyncio.run(main())
