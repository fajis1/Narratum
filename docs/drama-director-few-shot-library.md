# OpenReader Drama Director — Author Few-Shot Library & Directorial Principles

> **Source Material:** Authentic author manuscripts featuring Bethany, Dominic, Tylor, Seth, Ali, and Vistan.  
> **Purpose:** Ground the Gemini Drama Director (`gemini-3.1-flash-lite` / `gemini-3.8-flash`) in the author's real prose, teaching it how to distinguish narration, internal thought, squad-link mental communication, banter, and spoken dialogue without rewriting any text.

---

## 1. Core Directorial Principles from Author Prose

### 1.1 Formatting is Evidence, Not Sole Determination
- **Italics cannot simply mean "internal thought."** In this author's books, Bethany's private thoughts are italicized, but squad-link conversations between linked Senses are also italicized.
- **Rule:** *Formatting is evidence. Narrative context determines utterance type. Formatting alone does not.*

### 1.2 Squad-Link Mental Communication is Natural Voice, NOT Whispering
- Squad-link speech occurs telepathically between characters' linked Senses.
- It must sound like the character's natural voice and distinct personality, **not** a whisper or ghostly effect.

### 1.3 Authority $\neq$ Loudness
- True commanding presence (e.g. Vistan isolating the room) comes from certainty, deliberate pacing, and gravity—not shouting.

### 1.4 High Emotional Intensity Can Be Low Energy / Subdued
- Desperate surrender, quiet prayers, intimate confessions, or restrained fury have high emotional intensity with low physical vocal energy. Flash must not equate high intensity with shouting.

### 1.5 Performance Can Shift Within a Single Thought or Line
- A character's internal thoughts may accelerate into anxiety and then abruptly pivot into deliberate self-reassurance (e.g. Example 3).

### 1.6 Tag Restraint (The Zero-Tag Default)
- Most lines should have **0 markup tags** (`tags: []`).
- Tags (`sigh`, `laughing`, `uhm`, `sarcasm`, `robotic`, `shouting`, `whispering`, `extremely fast`, `short/medium/long pause`) are reserved strictly for localized vocal performance modifiers, never general moods.

---

## 2. Controlled Schema Additions

### Utterance Types (`DRAMA_UTTERANCE_TYPES`)
```typescript
export const DRAMA_UTTERANCE_TYPES = [
  'narration',          // Spoken by Narrator
  'spoken-dialogue',    // Spoken out loud in physical scene
  'internal-thought',   // Private internal monologue inside a character's head
  'squad-link',         // Telepathic/mental communication across linked Senses
] as const;

export type DramaUtteranceType = typeof DRAMA_UTTERANCE_TYPES[number];
```

### Social Intents (`DRAMA_SOCIAL_INTENTS`)
In addition to baseline intents (`informing`, `questioning`, `commanding`, `persuasive`, `comforting`, `challenging`, `confessing`, `reassuring`, `encouraging`), the author's prose specifically requires:
```typescript
'teasing',
'bantering',
'celebrating',
'complaining',
```

---

## 3. The 15 Author Few-Shot Examples

### Example 1 — Desperate, reflective narration
The opening autobiographical section describes a man who has lost faith but finally prays because his family is desperate.

**Target:**
> So, I prayed.

```json
{
  "speaker": "Narrator",
  "utteranceType": "narration",
  "sceneContext": "After months of social collapse and watching his wife succumb to the Weeping, the narrator finally turns to prayer despite having abandoned his faith.",
  "performance": {
    "primaryEmotion": "desperate",
    "secondaryEmotions": ["vulnerable", "hopeful"],
    "socialIntent": "confessing",
    "delivery": ["intimate", "restrained"],
    "pace": "slow",
    "energy": "low",
    "intensity": "high",
    "tags": ["long pause"],
    "nuance": "Keep this simple. The emotional weight comes from exhaustion and surrender, not theatrical grief. Allow a meaningful silence around the sentence."
  }
}
```
*Directorial Insight:* Teaches that **high emotional intensity can be quiet**.

---

### Example 2 — Bethany: controlled internal uncertainty
Bethany is physically competent and focused on archery while privately questioning whether she's pushing her friends into her plans.

**Target:**
> The paperwork should be printed out and ready, though are they going to want to do this? Or am I forcing them down my own path?

```json
{
  "speaker": "Bethany",
  "utteranceType": "internal-thought",
  "sceneContext": "Bethany is practicing archery while mentally checking preparations. Her body remains controlled while doubts about the group's decision intrude.",
  "performance": {
    "primaryEmotion": "uncertain",
    "secondaryEmotions": ["worried", "reflective"],
    "socialIntent": "questioning",
    "delivery": ["intimate", "restrained"],
    "pace": "slightly-slow",
    "energy": "low",
    "intensity": "medium",
    "tags": [],
    "nuance": "Begin like a practical checklist. Gradually let self-doubt emerge. The final question carries the most emotional weight. Do not whisper or sound frightened."
  }
}
```

---

### Example 3 — Bethany: thoughts accelerating into anxiety
Immediately afterward, her waiting for the third target becomes mixed with second thoughts about the mercenary-company decision.

**Target:**
> Is this the end? Where's the third target? Did we actually decide to go through with this, we could back out now. No, it is a good option, just like it was last night.

```json
{
  "speaker": "Bethany",
  "utteranceType": "internal-thought",
  "sceneContext": "Bethany waits for an expected third archery target while simultaneously second-guessing the major decision she and her friends have made.",
  "performance": {
    "primaryEmotion": "anxious",
    "secondaryEmotions": ["uncertain", "determined"],
    "socialIntent": "questioning",
    "delivery": ["intimate", "halting"],
    "pace": "slightly-fast",
    "energy": "elevated",
    "intensity": "building",
    "tags": [],
    "nuance": "Let the early questions tumble together. On 'No,' visibly change direction: slow slightly and make the final sentence sound like deliberate self-reassurance."
  }
}
```
*Directorial Insight:* Demonstrates **performance changing inside one thought**.

---

### Example 4 — Ali: mischievous teasing
Ali deliberately needles Bethany about entertaining two male visitors. The narration identifies the exchange as mischief between old friends.

**Target:**
> A lady such as yourself, entertaining two suitors, what would the madam say?

```json
{
  "speaker": "Ali",
  "utteranceType": "spoken-dialogue",
  "sceneContext": "Ali is teasing Bethany, exploiting their long familiarity while maintaining the surface manners of servant and noblewoman.",
  "performance": {
    "primaryEmotion": "mischievous",
    "secondaryEmotions": ["amused", "playful"],
    "socialIntent": "teasing",
    "delivery": ["soft", "sarcastic"],
    "pace": "normal",
    "energy": "low",
    "intensity": "low",
    "tags": ["sarcasm"],
    "nuance": "She deliberately speaks just loudly enough for Bethany to hear. This is affectionate provocation, not genuine disrespect."
  }
}
```
*Directorial Insight:* Requires social intent `'teasing'`.

---

### Example 5 — Dominic: genuine awe over squad link
Dominic experiences Bethany's family estate and reacts through the squad link.

**Target:**
> This place is incredible.

```json
{
  "speaker": "Dominic",
  "utteranceType": "squad-link",
  "sceneContext": "Dominic is experiencing Bethany's large family property through their linked Senses and is genuinely impressed by it.",
  "performance": {
    "primaryEmotion": "awed",
    "secondaryEmotions": ["excited", "curious"],
    "socialIntent": "informing",
    "delivery": ["natural"],
    "pace": "normal",
    "energy": "elevated",
    "intensity": "medium",
    "tags": [],
    "nuance": "This is mental communication rather than audible speech, but it should still sound unmistakably like Dominic. Do not turn squad-link speech into whispering."
  }
}
```
*Directorial Insight:* Squad-link speech must sound like Dominic's natural voice, not whispering.

---

### Example 6 — Dominic: surprised disbelief
After learning the house has seventeen rooms, Dominic immediately reacts.

**Target:**
> Seventeen! Where?

```json
{
  "speaker": "Dominic",
  "utteranceType": "squad-link",
  "sceneContext": "Dominic expected a large house, but seventeen rooms exceeds what he imagined.",
  "performance": {
    "primaryEmotion": "surprised",
    "secondaryEmotions": ["awed", "curious"],
    "socialIntent": "questioning",
    "delivery": ["stunned"],
    "pace": "fast",
    "energy": "elevated",
    "intensity": "high",
    "tags": [],
    "nuance": "The first word is spontaneous disbelief. The second sentence immediately turns into genuine curiosity."
  }
}
```

---

### Example 7 — Tylor: groggy irritation
Tylor is woken at eleven and complains over the squad link.

**Target:**
> What's so important that you would wake me up at this ungodly hour? Seriously can't you let a man sleep? I thought I set it to do not disturb.

```json
{
  "speaker": "Tylor",
  "utteranceType": "squad-link",
  "sceneContext": "Tylor has just been awakened and is genuinely tired, but his complaint also reflects his normal exaggerated personality.",
  "performance": {
    "primaryEmotion": "annoyed",
    "secondaryEmotions": ["tired", "irritated"],
    "socialIntent": "challenging",
    "delivery": ["natural"],
    "pace": "slightly-slow",
    "energy": "low",
    "intensity": "medium",
    "tags": [],
    "nuance": "Sound recently awakened and inconvenienced. The complaint can be exaggerated without sounding genuinely furious."
  }
}
```

---

### Example 8 — Bethany: serious leadership while preserving consent
Bethany wants the mercenary company but stops the meeting to make sure everyone still agrees.

**Target:**
> So, as we look over this, we need to decide if this is what we want to do. If anyone has had a change of heart, please speak up during this briefing, or forever hold your peace.

```json
{
  "speaker": "Bethany",
  "utteranceType": "spoken-dialogue",
  "sceneContext": "Bethany has organized much of the mercenary-company proposal and wants it to succeed, but deliberately gives everyone another opportunity to decline.",
  "performance": {
    "primaryEmotion": "serious",
    "secondaryEmotions": ["determined", "uncertain"],
    "socialIntent": "questioning",
    "delivery": ["measured", "authoritative"],
    "pace": "measured",
    "energy": "normal",
    "intensity": "medium",
    "tags": [],
    "nuance": "Sound like a capable organizer who genuinely wants an answer. She wants them to agree, but she is making an effort not to pressure them."
  }
}
```

---

### Example 9 — Tylor: exuberant comic excitement
Once everyone agrees, Tylor immediately escalates the idea into a joke about a battleship.

**Target:**
> Battleship Dragoons is a go!

```json
{
  "speaker": "Tylor",
  "utteranceType": "squad-link",
  "sceneContext": "The group has agreed to form the mercenary company. Tylor enthusiastically turns that agreement into his running fantasy about owning a battleship.",
  "performance": {
    "primaryEmotion": "excited",
    "secondaryEmotions": ["triumphant", "playful"],
    "socialIntent": "celebrating",
    "delivery": ["dramatic"],
    "pace": "fast",
    "energy": "high",
    "intensity": "high",
    "tags": [],
    "nuance": "Big and gleeful, but comedic rather than heroic. Tylor is intentionally having fun with the idea."
  }
}
```
*Directorial Insight:* Requires social intent `'celebrating'`.

---

### Example 10 — Bethany: restrained political calculation
Bethany explains why she should not lead the company despite being qualified.

**Target:**
> If I was to lead, I’m afraid it would send the wrong message. It was our strength and well, good luck that got us this chance.

```json
{
  "speaker": "Bethany",
  "utteranceType": "squad-link",
  "sceneContext": "Bethany believes she could lead, but understands that her family status would make outsiders dismiss the company as a Small-family project.",
  "performance": {
    "primaryEmotion": "serious",
    "secondaryEmotions": ["thoughtful", "determined"],
    "socialIntent": "persuasive",
    "delivery": ["measured", "matter-of-fact"],
    "pace": "normal",
    "energy": "low",
    "intensity": "medium",
    "tags": [],
    "nuance": "She is explaining political reality, not fishing for reassurance. Keep the reasoning practical and controlled."
  }
}
```

---

### Example 11 — Seth: childlike enthusiasm over cheesecake
After hours of bureaucracy, Seth suddenly focuses on dessert.

**Target:**
> She said we have three hours till it closes, we can wait fifteen for cheesecake.

```json
{
  "speaker": "Seth",
  "utteranceType": "spoken-dialogue",
  "sceneContext": "Dominic wants to leave immediately to submit paperwork, but Seth remembers that cheesecake was promised and argues they have plenty of time.",
  "performance": {
    "primaryEmotion": "excited",
    "secondaryEmotions": ["playful", "eager"],
    "socialIntent": "persuasive",
    "delivery": ["natural"],
    "pace": "slightly-fast",
    "energy": "elevated",
    "intensity": "medium",
    "tags": [],
    "nuance": "His logic is completely sincere even though the priority is humorous. Let his enthusiasm for the cheesecake sell the joke."
  }
}
```

---

### Example 12 — Dominic: mundane frustration
Dominic becomes increasingly irritated while waiting at the registrar.

**Target:**
> This is going to take forever.

```json
{
  "speaker": "Dominic",
  "utteranceType": "spoken-dialogue",
  "sceneContext": "Dominic has repeatedly watched the clock and queue counter barely move while he waits in the registrar's office.",
  "performance": {
    "primaryEmotion": "frustrated",
    "secondaryEmotions": ["bored", "weary"],
    "socialIntent": "complaining",
    "delivery": ["matter-of-fact"],
    "pace": "slightly-slow",
    "energy": "low",
    "intensity": "low",
    "tags": ["sigh"],
    "nuance": "This is everyday bureaucratic frustration, not anger. Sound drained and impatient."
  }
}
```
*Directorial Insight:* Requires social intent `'complaining'`.

---

### Example 13 — Dominic: private determination
Later Dominic tries to stop obsessing over the clock.

**Target:**
> You're stronger than this Dominic.

```json
{
  "speaker": "Dominic",
  "utteranceType": "internal-thought",
  "sceneContext": "Dominic is fighting the almost compulsive urge to check the time again while trapped in a long bureaucratic wait.",
  "performance": {
    "primaryEmotion": "determined",
    "secondaryEmotions": ["frustrated"],
    "socialIntent": "encouraging",
    "delivery": ["intimate", "restrained"],
    "pace": "measured",
    "energy": "low",
    "intensity": "medium",
    "tags": [],
    "nuance": "This is Dominic sternly coaching himself over something trivial. Keep both the genuine determination and the underlying humor."
  }
}
```

---

### Example 14 — Bethany: calm reassurance
When Dominic is worried about what is happening at the registrar, Bethany reasons through the situation and offers support.

**Target:**
> It's alright. I wouldn't worry about it much. Just let me know if you run into any walls, I will help.

```json
{
  "speaker": "Bethany",
  "utteranceType": "squad-link",
  "sceneContext": "Dominic has spent hours waiting on an unusual application process. Bethany sees that he is worrying about possibilities he cannot control.",
  "performance": {
    "primaryEmotion": "calm",
    "secondaryEmotions": ["caring", "confident"],
    "socialIntent": "reassuring",
    "delivery": ["comforting", "measured"],
    "pace": "normal",
    "energy": "low",
    "intensity": "low",
    "tags": [],
    "nuance": "Bethany is not dismissing Dominic's concern. She is deliberately grounding him and making it clear that she will help if a real problem appears."
  }
}
```
*Directorial Insight:* Strong **low-drama normal-supportive** example.

---

### Example 15 — Vistan: quiet authority
Vistan finally isolates the room and stops accepting surface-level answers from Dominic.

**Target:**
> I've isolated us. I need to know the truth. The real and frank reasons. Not the platitudes, the surface level. If I'm to go to bat for you, I need to know you.

```json
{
  "speaker": "Vistan",
  "utteranceType": "spoken-dialogue",
  "sceneContext": "Vistan has deliberately isolated the room and is offering to use his influence on the group's behalf, but only if Dominic gives him the real motivation behind their decision.",
  "performance": {
    "primaryEmotion": "serious",
    "secondaryEmotions": ["determined", "protective"],
    "socialIntent": "commanding",
    "delivery": ["authoritative", "restrained"],
    "pace": "measured",
    "energy": "low",
    "intensity": "high",
    "tags": [],
    "nuance": "Do not shout. His power comes from certainty and gravity. 'I need to know the truth' should make the room feel more serious without increasing volume."
  }
}
```
*Directorial Insight:* **Authority $\neq$ loudness**.

---

## 4. Prompt vs Evaluation Distribution

To optimize prompt token usage in Stage 7 while maintaining strict evaluation fidelity:

- **Director Prompt Few-Shots (11 examples):**
  - Example 1 (Quiet high-intensity narration)
  - Example 2 (Internal thought / practical to doubt)
  - Example 3 (Thought accelerating & shifting)
  - Example 4 (Mischievous teasing dialogue)
  - Example 5 (Squad-link natural voice / not whisper)
  - Example 7 (Groggy squad-link irritation)
  - Example 8 (Leadership dialogue / consent)
  - Example 9 (Squad-link comedy celebration)
  - Example 11 (Childlike dialogue enthusiasm)
  - Example 12 (Bored/frustrated complaining)
  - Example 15 (Quiet authority / no shouting)

- **Evaluation Fixtures (4 held-out test cases):**
  - Example 6 (Dominic surprised disbelief squad-link)
  - Example 10 (Bethany restrained political calculation squad-link)
  - Example 13 (Dominic private self-coaching internal-thought)
  - Example 14 (Bethany calm supportive reassurance squad-link)
