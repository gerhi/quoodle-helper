// js/generate.js — Generation pipeline
// Builds prompts, chunks if needed, calls LLM, parses and validates JSON, deduplicates.

import { callLLM, PROVIDERS } from './providers.js';

/**
 * Generate questions from source text.
 *
 * @param {object} opts
 * @param {string} opts.combinedText — concatenated raw text of all sources
 * @param {object} opts.config — GenerationConfig
 * @param {AbortSignal} opts.signal
 * @param {(phase: object) => void} opts.onPhase — progress callback
 *
 * @returns {Promise<{questions: Array, usage: {input_tokens, output_tokens}}>}
 */
export async function generateQuestions({ combinedText, config, signal, onPhase }) {
  onPhase({ phase: 'prepare' });

  const providerCfg = PROVIDERS[config.provider];
  const threshold = providerCfg.chunkCharThreshold;

  // Chunking?
  const chunks = combinedText.length > threshold
    ? chunkText(combinedText, threshold)
    : [combinedText];

  if (chunks.length > 1) onPhase({ phase: 'chunking', totalChunks: chunks.length });

  // Distribute question count proportionally (minimum 1 per chunk)
  const totalChars = chunks.reduce((a, c) => a + c.length, 0);
  let counts = chunks.map(c => Math.max(1, Math.round(config.question_count * c.length / totalChars)));
  // Adjust rounding drift
  let drift = config.question_count - counts.reduce((a, n) => a + n, 0);
  for (let i = 0; i < chunks.length && drift !== 0; i++) {
    counts[i] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
  }
  counts = counts.map(n => Math.max(1, n));

  const systemPrompt = buildSystemPrompt(config);
  const allQuestions = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onPhase({ phase: 'calling', current: i + 1, total: chunks.length });

    const chunkPrompt = buildChunkPrompt(chunks[i], counts[i], chunks.length, i + 1, config.output_language);
    let text, u;
    let attempt = 0;
    let lastError = null;

    while (attempt < 2) {
      try {
        const result = await callLLM({
          provider: config.provider,
          baseUrl: config.base_url,
          model: config.model,
          apiKey: config.api_key,
          systemPrompt: attempt === 0 ? systemPrompt : systemPrompt + '\n\nIMPORTANT: Your previous response was not valid JSON or did not match the schema. Output ONLY the JSON object with a top-level "questions" array. No markdown, no prose.',
          userPrompt: chunkPrompt,
          signal,
        });
        text = result.text;
        u = result.usage;

        onPhase({ phase: 'parsing', current: i + 1, total: chunks.length });
        const parsed = parseAndValidate(text, counts[i]);
        allQuestions.push(...parsed);
        if (u) {
          usage.input_tokens += u.input_tokens || 0;
          usage.output_tokens += u.output_tokens || 0;
        }
        break;
      } catch (err) {
        lastError = err;
        attempt++;
        if (err.code === 'auth' || err.code === 'no_key' || err.code === 'no_url' || err.code === 'timeout' || err.name === 'AbortError') {
          throw err;
        }
        if (attempt >= 2) {
          const e = new Error(err.message);
          e.code = err.code || 'llm_json';
          e.phase = 'chunk ' + (i + 1);
          e.raw = (text || '').slice(0, 500);
          throw e;
        }
      }
    }
  }

  onPhase({ phase: 'validating' });
  const deduped = deduplicate(allQuestions);
  onPhase({ phase: 'done', produced: deduped.length });
  return { questions: deduped, usage };
}

// ---------- Prompts ----------

const DIFFICULTY_HINTS = {
  easy:     'Target early undergraduate level. Test understanding of core definitions and terminology, but phrase questions so they probe comprehension, not mere word-matching.',
  medium:   'Target advanced undergraduate level. Require learners to connect concepts, explain mechanisms, or choose the correct application of a principle to a simple situation.',
  hard:     'Target upper-level undergraduate or graduate level. Require multi-step reasoning, integration across several concepts, or discrimination between closely related ideas. Distractors should reflect subtle but common misunderstandings, not obvious mistakes.',
  mixed:    'Vary difficulty across the set: a minority of questions may test straightforward comprehension, most should require understanding relationships between concepts, and some should require inference or application.',
};

const STYLE_HINTS = {
  factual:     'Emphasize precise understanding of definitions, classifications, and terminology — but phrase questions so they test whether the learner grasps the concept, not whether they memorized a sentence.',
  conceptual:  'Emphasize questions about relationships between concepts: how does A relate to B, what distinguishes X from Y, why does phenomenon P occur, under what conditions does mechanism M apply.',
  applied:     'Emphasize questions that give a short scenario or example and ask the learner to identify which principle applies, predict an outcome, or choose the correct action.',
  mixed:       'Balance the set across three types: conceptual-relational questions (how concepts connect, differ, or cause each other), application questions (apply a principle to a short scenario), and a minority of precise-definition questions. Avoid pure rote recall.',
};

const LANG_NAMES = {
  de: 'German',
  en: 'English',
  auto: 'the same language as the source material',
};

// Concrete example of a correctly-formatted question in the target language.
// This anchors the model's output language more reliably than abstract rules.
const LANG_EXAMPLES = {
  de: `Example of one correctly-formatted German question (for style and language only — do NOT include this in your output):

{
  "question": "Welche Bedingung muss erfüllt sein, damit ein chemisches Gleichgewicht sich zu den Produkten verschiebt?",
  "correct_answer": "Die Konzentration eines Edukts wird erhöht.",
  "wrong_answers": [
    "Die Temperatur wird ohne Rücksicht auf die Reaktionsenthalpie gesenkt.",
    "Ein Katalysator wird hinzugefügt.",
    "Das Volumen wird bei gleichbleibender Stoffmenge halbiert."
  ],
  "explanation": "Nach dem Prinzip von Le Chatelier weicht ein Gleichgewicht einer Störung aus. Eine erhöhte Edukt-Konzentration wird durch verstärkte Hinreaktion abgebaut. Ein Katalysator beschleunigt beide Richtungen gleich und verschiebt das Gleichgewicht nicht.",
  "source_hint": "Kapitel 4.2"
}`,
  en: `Example of one correctly-formatted English question (for style and language only — do NOT include this in your output):

{
  "question": "Under which condition does a chemical equilibrium shift toward the products?",
  "correct_answer": "The concentration of a reactant is increased.",
  "wrong_answers": [
    "The temperature is lowered regardless of the reaction enthalpy.",
    "A catalyst is added.",
    "The volume is halved while the amount of substance stays constant."
  ],
  "explanation": "By Le Chatelier's principle, an equilibrium counteracts a disturbance. An increased reactant concentration is consumed by an enhanced forward reaction. A catalyst accelerates both directions equally and does not shift the equilibrium.",
  "source_hint": "Chapter 4.2"
}`,
  auto: `If the source material is in German, write in German. If it is in English, write in English. Match the language of the material exactly.`,
};

/**
 * Default system prompt template. Placeholders in {braces} are replaced
 * at request time via buildSystemPrompt(config). The user may override this
 * template via the Advanced panel on the Configure step.
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are an experienced university instructor designing multiple-choice exam items from course material.

Your goal is to write questions that test whether a student UNDERSTANDS the concepts, not whether they memorized specific sentences.

## Core rules

1. Each question has exactly one correct answer and exactly three plausible distractors.
2. Distractors must be topically related and reflect common misconceptions, plausible errors in reasoning, or easily-confused neighbouring concepts. Never use nonsense, joke, or obviously wrong options.
3. The correct answer and the distractors must be of comparable length and specificity. Do not make the correct answer the longest or most detailed option.
4. Include a concise explanation (2–4 sentences) that says WHY the correct answer is correct AND why the most tempting distractor is wrong. The explanation should teach, not merely assert.
5. Avoid duplicate or near-duplicate questions.

## Style and difficulty

- Difficulty: {difficulty}. {difficulty_hint}
- Style emphasis: {style}. {style_hint}

## Critical phrasing rules — read carefully

These rules exist because multiple-choice questions often accidentally test text-memory instead of understanding. Follow all of them:

- **Never refer to the source.** Do not use phrases like "according to the text", "as stated in the lecture", "the author claims", "the script mentions", "im Text", "laut Vorlesung", "im Skript". Questions must stand on their own as domain questions.
- **Test the concept, not the wording.** Do not ask which sentence, phrase, or exact formulation appeared in the material. Ask what something IS, HOW it works, WHY it happens, or WHEN it applies.
- **Prefer questions about relationships.** Good question stems include: "What is the relationship between X and Y?", "Which of the following best explains why X leads to Y?", "Under which condition does X apply rather than Y?", "What distinguishes X from Y?", "Which factor most strongly influences X?".
- **Use short scenarios where appropriate.** A one- or two-sentence concrete situation followed by "Which principle explains this?" or "What would happen next?" produces much stronger items than bare factual recall.
- **Avoid 'all of the above' and 'none of the above'.**
- **Avoid negations** in the stem ("Which of the following is NOT ...") unless clearly necessary; when used, emphasize the negation visibly.

## Output format

Output VALID JSON ONLY, matching exactly this schema. No prose, no markdown, no code fences outside the JSON.

{
  "questions": [
    {
      "question": "string — the full question stem",
      "correct_answer": "string",
      "wrong_answers": ["string", "string", "string"],
      "explanation": "string — 2–4 sentences; explain why the correct answer is right and address the strongest distractor",
      "source_hint": "string (optional, e.g. 'Slide 12' or the section title)"
    }
  ]
}

## Language of the output — THIS IS CRITICAL

Write EVERY field of EVERY question — \`question\`, \`correct_answer\`, \`wrong_answers\`, \`explanation\`, \`source_hint\` — entirely in {output_language}.

{language_example}

This rule overrides any tendency to default to English. Even though these instructions are written in English, your output MUST be in {output_language}. If {output_language} is German, every word of your questions and answers must be German. Do not mix languages within a single field.`;

export function buildSystemPrompt(config) {
  const template = (config.custom_prompt && config.custom_prompt.trim())
    ? config.custom_prompt
    : DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  const values = {
    difficulty: config.difficulty,
    difficulty_hint: DIFFICULTY_HINTS[config.difficulty] || DIFFICULTY_HINTS.medium,
    style: config.question_style,
    style_hint: STYLE_HINTS[config.question_style] || STYLE_HINTS.mixed,
    output_language: LANG_NAMES[config.output_language] || LANG_NAMES.auto,
    language_example: LANG_EXAMPLES[config.output_language] || LANG_EXAMPLES.auto,
  };
  // Only interpolate known placeholders. Any {something} that we don't
  // recognize is left as-is so that the JSON schema's `{ "questions": [...] }`
  // is not touched — its inner braces aren't words.
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

function buildChunkPrompt(chunkText, count, totalChunks, chunkNum, outputLanguage) {
  const prefix = totalChunks > 1
    ? `The following is part ${chunkNum} of ${totalChunks} of the course material. Treat the union of all parts as the knowledge domain.\n\n`
    : '';
  const langName = LANG_NAMES[outputLanguage] || LANG_NAMES.auto;
  const langReminder = outputLanguage === 'de'
    ? `\n\nErinnerung: Schreibe alle Fragen, Antworten und Erläuterungen vollständig auf Deutsch. Return JSON only.`
    : outputLanguage === 'en'
    ? `\n\nReminder: write all questions, answers, and explanations entirely in English. Return JSON only.`
    : `\n\nReminder: write everything in ${langName}. Return JSON only.`;
  return `${prefix}Below is the course material for this question-generation task. Use it as the domain knowledge from which to derive ${count} multiple-choice question(s). Do not reference the material as "the text" or "the source" in your questions — write them as stand-alone domain questions.${langReminder}

---

${chunkText}`;
}

// ---------- Chunking ----------

export function chunkText(text, targetSize) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > targetSize) {
    // Try to split at paragraph boundary near targetSize
    let splitAt = remaining.lastIndexOf('\n\n', targetSize);
    if (splitAt < targetSize * 0.5) {
      // Fallback: sentence
      splitAt = remaining.lastIndexOf('. ', targetSize);
      if (splitAt < targetSize * 0.5) {
        // Last resort: hard cut
        splitAt = targetSize;
      } else {
        splitAt += 2; // include period
      }
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------- Parse + validate ----------

export function parseAndValidate(rawText, expectedCount) {
  // Strip code fences if present
  let cleaned = rawText.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the outermost JSON object if there's prose around it
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch (err) {
    const e = new Error('Response is not valid JSON.');
    e.code = 'llm_json';
    throw e;
  }

  const arr = Array.isArray(obj) ? obj : obj.questions;
  if (!Array.isArray(arr)) {
    const e = new Error('Response does not contain a "questions" array.');
    e.code = 'llm_schema';
    throw e;
  }

  const valid = [];
  for (const q of arr) {
    if (typeof q?.question !== 'string' || q.question.trim().length === 0) continue;
    if (typeof q?.correct_answer !== 'string' || q.correct_answer.trim().length === 0) continue;
    if (!Array.isArray(q?.wrong_answers) || q.wrong_answers.length !== 3) continue;
    if (q.wrong_answers.some(w => typeof w !== 'string' || w.trim().length === 0)) continue;
    if (typeof q?.explanation !== 'string' || q.explanation.trim().length === 0) continue;
    valid.push({
      question: q.question.trim(),
      correct_answer: q.correct_answer.trim(),
      wrong_answers: q.wrong_answers.map(w => w.trim()),
      explanation: q.explanation.trim(),
      source_hint: typeof q.source_hint === 'string' ? q.source_hint.trim() : '',
    });
  }
  if (valid.length === 0) {
    const e = new Error('No questions matched the required schema.');
    e.code = 'llm_schema';
    throw e;
  }
  return valid;
}

// ---------- Dedupe ----------

export function deduplicate(questions) {
  const seen = new Set();
  const out = [];
  for (const q of questions) {
    const key = q.question.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}
