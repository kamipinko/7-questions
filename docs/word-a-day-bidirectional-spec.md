# Word-a-Day — Bidirectional Language Learning (Two-Way, Swappable)

**Status:** Proposed
**Author:** Lulu
**Files touched:** `public/word-a-day/index.html`, `data/word-a-day/words/*.json`, user records under `data/word-a-day/users/`, study/progress API handlers.

---

## 1. Goal

Turn Word-a-Day from a one-way tool (**English speaker → learns a target language**) into a **two-way, swappable** tool. The same bilingual dataset should serve either speaker of the pair:

- A **Chinese** speaker learning **English**, or
- An **English** speaker learning **Chinese**.

Same for Vietnamese↔English, Spanish↔English, Japanese↔English, Swahili↔English, Kikuyu↔English.

At **account creation we ask one question — "What language do you speak?" via a dropdown** — set that as the user's native language, and tailor every prompt, hint, example, and quiz to it. A **swap toggle** lets the learner flip the direction of any pair at any time.

---

## 2. Current behavior & the key constraint

Today the direction is hard-coded: English is always the *known* side, the chosen language is always the *learned* side.

**Data shape** (`data/word-a-day/words/<code>.json`):
```json
{
  "language": "Vietnamese", "code": "vi", "flag": "🇻🇳",
  "tts_lang": "vi-VN", "recognition_lang": "vi-VN", "has_romanization": false,
  "words": [
    { "id": "vi-1-1-1-1", "tier":1,"week":1,"day":1,"slot":1,
      "english": "I want", "target": "Tôi muốn", "phonetic": "toy moo-on",
      "example_en": "I want water.", "example_target": "Tôi muốn nước." }
  ]
}
```

**Catalog** (`index.html`, `const LANGS`): `es, zh, ja, vi, sw, ki` — English is implicit and not listed.

**User record** (`data/word-a-day/users/<id>.json`):
```json
{ "userId":"…","email":null,"anon":true,"authTokens":["…"],
  "languages": { "es": { "tier":1,"week":1,"day":2,"streak":1,"completedWords":[…],"wordStats":{…},"exams":[] } } }
```

**Key constraint that makes this easy:** every dataset is an **English↔X bilingual pair**. English is always one member. So "direction" for any pair is just a **binary flip** of which member is the *prompt* (known) and which is the *answer* (being learned). We do not need new datasets — only a rendering flip plus a stored preference.

---

## 3. Data model changes

### 3.1 Language catalog — make English a first-class member
Add English to `LANGS` so it can be a native language **and** a learnable target (for non-English natives):

```js
const LANGS = [
  {code:'en', name:'English',   flag:'🇬🇧', sub:'Global lingua franca'},
  {code:'es', name:'Spanish',   flag:'🇪🇸', sub:'6 months to survival'},
  {code:'zh', name:'Chinese',   flag:'🇨🇳', sub:'Mandarin · Pinyin included'},
  {code:'ja', name:'Japanese',  flag:'🇯🇵', sub:'Romaji included'},
  {code:'vi', name:'Vietnamese',flag:'🇻🇳', sub:'Southeast Asia ready'},
  {code:'sw', name:'Swahili',   flag:'🇰🇪', sub:'East African foundation'},
  {code:'ki', name:'Kikuyu',    flag:'🇰🇪', sub:'Gĩkũyũ · East African'},
];
const ENGLISH_META = { code:'en', name:'English', flag:'🇬🇧', tts_lang:'en-US', recognition_lang:'en-US', has_romanization:false };
```
> The **learnable-target** grid is filtered per user: never offer someone their own native language as a course. See §7.

### 3.2 User record — add top-level `nativeLanguage`
```json
{ "userId":"…", "nativeLanguage":"vi", "languages": { … } }
```
- Set from the signup dropdown (§4). ISO code, may be `'en'`.
- Defaults to `'en'` for any legacy record missing the field (back-compat, §8).

### 3.3 Per-language progress — add `focus`
Inside each `languages[code]` progress object, store which language is currently being **learned** (the answer side):

```json
"languages": {
  "en": { "focus":"en",  "tier":1,"week":1,"day":1, … },   // vi-native learning English (dataset: vi.json… see §7.2)
  "zh": { "focus":"zh",  "tier":1,"week":1,"day":1, … }     // en-native learning Chinese
}
```
- `focus` = the code of the language on the **answer** side. The **other** member of the pair is the prompt side.
- The swap toggle flips `focus` between the two members of the pair and persists it.
- Default on first start: `focus = the member of the pair that is NOT the user's nativeLanguage` (see §7 for the derivation, incl. the third-language case).

No change to `streak / completedWords / wordStats / exams` — those stay keyed by word `id`, which is stable regardless of direction.

---

## 4. Signup question — the language dropdown

At account creation (before the first lesson, in the auth/onboarding flow), show:

> **What language do you speak?** / *Ngôn ngữ của bạn là gì?*
> `[ ▼ Select your language ]`

**Dropdown options** (native language — one per offered language):

| value | label |
|-------|-------|
| `en` | 🇬🇧 English |
| `es` | 🇪🇸 Español (Spanish) |
| `zh` | 🇨🇳 中文 (Chinese) |
| `ja` | 🇯🇵 日本語 (Japanese) |
| `vi` | 🇻🇳 Tiếng Việt (Vietnamese) |
| `sw` | 🇰🇪 Kiswahili (Swahili) |
| `ki` | 🇰🇪 Gĩkũyũ (Kikuyu) |

**Behavior**
- Selection is **required**; the "Continue" button stays disabled until chosen.
- On submit: persist `nativeLanguage` on the user record (send with the auth/create call).
- Then show the **learnable-target** grid (§3.1) with the user's own native language filtered out, and each card's default direction set so they learn the *other* language.
- **Label the direction** on each course card, e.g. *"English → Chinese"* vs *"Chinese → English"*, so the flip is visible from the start.

**Guest/anonymous users:** default `nativeLanguage='en'` but surface the same dropdown in Settings so they can change it without losing progress.

---

## 5. The swap toggle

A control on the lesson screen (near "Switch Language", `index.html:548`) that flips the active pair's direction.

**UI**
```
[ 🇬🇧 English ⇄ 🇨🇳 中文 ]      ← tap to swap which side you're learning
```
- Shows both members with the **answer/learning** side emphasized.
- Tapping flips `state.progress.focus` between the two codes and re-renders the current card.

**Persistence**
- Update `languages[activePairKey].focus` locally, then PATCH to the study endpoint using the existing `studyBody()` helper (`index.html:821`) so accounts sync; legacy token users persist via their token.
- New optional field on the progress-save payload: `focus`. Server stores it verbatim on the progress object.

**Rules**
- Swapping does **not** reset streak/progress — the word `id`s and their stats are shared across both directions of the same pair.
- Swapping mid-session re-renders the current word immediately (prompt/answer sides trade places).

---

## 6. Rendering changes (direction-aware)

Introduce one helper that resolves the two sides for any word given the active `focus`, and route **all** display / TTS / speech-recognition / exam logic through it.

```js
// meta = active dataset header; word = a row; focus = code being learned (answer side)
function sides(word, meta, focus) {
  const learningEnglish = (focus === 'en');
  return learningEnglish
    ? { prompt: word.target,  promptLang: meta.tts_lang,   // known = the non-English language
        answer: word.english, answerLang: 'en-US',
        answerRecog: 'en-US',
        example: word.example_target, exampleAnswer: word.example_en,
        phonetic: null }                                    // phonetic is for the non-English word; not shown when answering in English
    : { prompt: word.english, promptLang: 'en-US',          // known = English
        answer: word.target,  answerLang: meta.tts_lang,
        answerRecog: meta.recognition_lang,
        example: word.example_en, exampleAnswer: word.example_target,
        phonetic: word.phonetic };                          // show phonetic for the target word
}
```

**Touchpoints to convert** (all currently assume english=prompt / target=answer):
- Flashcard front/back, "Listen" audio button, "Say it aloud" recognition, and the four exam sections (`EXAM_SECTIONS`, `index.html:853`: listen / choose / type / speak).
- **TTS voice** must follow the side being spoken (English → `en-US`; other → dataset `tts_lang`).
- **Speech recognition** language must match the answer side (`answerRecog`).
- **Phonetic / romanization** (`phonetic`, `has_romanization`) only render when the **answer** is the non-English language — a native English speaker doesn't need phonetics for English.

---

## 7. Edge cases

1. **Native == the only other member (English pairs):** an English native never sees "English" as a course; a Vietnamese native never sees "Vietnamese" as a course. Filter the target grid by `code !== nativeLanguage`.
2. **Third-language native (e.g., a Vietnamese speaker who wants the *Chinese* course):** datasets are English↔X only, so there is no Vietnamese↔Chinese data. Resolution: fall back to **English as the prompt side** for that course (`focus = 'zh'`, prompt in English) and show a small note *"prompts shown in English for this course."* Do **not** offer a swap that would require nonexistent native↔target data.
3. **`nativeLanguage='en'`:** behaves exactly like today (learn X, prompts in English) — this is the safe default and the migration target.
4. **Examples:** `example_en` / `example_target` swap prompt/answer roles via `sides()`; no data change.
5. **Romanization/phonetic direction:** only meaningful when learning the non-English side; suppress otherwise.

---

## 8. Migration & back-compat

- Legacy user records have no `nativeLanguage` → treat as `'en'` on load (no write needed until they change it).
- Legacy progress objects have no `focus` → default `focus = code` (i.e., learning the non-English member = today's behavior).
- No dataset migration required. Word `id`s unchanged, so existing `completedWords` / `wordStats` / `exams` keep working in both directions.
- The `_migrated.json` marker pattern already in `data/word-a-day/users/` can gate a one-time backfill if we later want to write `nativeLanguage:'en'` explicitly.

---

## 9. Acceptance criteria

- [ ] Account creation shows a **required language dropdown**; choice is saved as `nativeLanguage`.
- [ ] Target-course grid excludes the user's native language and shows the direction (e.g., "Chinese → English").
- [ ] English is a valid **native** language and a valid **target** language.
- [ ] A **swap toggle** on the lesson screen flips prompt/answer, updates TTS voice, speech-recognition language, and phonetic visibility, and **persists** across reloads.
- [ ] Swapping preserves streak and per-word stats (shared `id`s).
- [ ] Legacy accounts (no `nativeLanguage`/`focus`) load unchanged, behaving as English-native learners.
- [ ] Exam sections (listen/choose/type/speak) respect the active direction.
