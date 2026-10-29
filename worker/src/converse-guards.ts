// The guards shared by the conversation front door (converse-moonshot.ts): what may never be shown, what is never left to a model, and the one fixed sentence. Extracted verbatim from the tested spike (CONVERSATIONAL_LAYER.md).
export const CONVERSE_FALLBACK = "I'm having trouble responding right now. You can try again in a moment.";

// WORK IS NEVER LEFT TO THE MODEL'S JUDGEMENT. First real-model run on staging (2026-10-28): asked "Bought diesel for R650" the model chatted back instead of calling hand_to_office, so an instruction would have been lost. A message that carries
// a figure, opens with a doing word ("invoice", "remind me", "add"...) or says something was paid or bought goes straight to the existing pipeline with NO model call here. It fails safe: a read with a digit in it simply takes the old path.
export const LOOKS_LIKE_WORK = /\d|^\s*(?:please\s+|can you\s+|could you\s+)?(?:invoice|quote|remind|schedule|add|record|create|book|cancel|order|send|pay|log)\b|\b(?:paid|bought)\b/i;
const MAX_MODEL_CALLS = 4;   // three tool steps and the answer; the last call gets no tools

// What may never be shown is a claim that THIS conversation did something. Round 2 refused correct readings ("R1,000 paid against it", "no scheduled date") with a bare word list, so the check is about who did what: a first-person
// "I've recorded", a passive about the thing just asked ("has been saved", "is now recorded"), "that is confirmed", or a bare "done". A past participle inside a reading ("paid against it", "was sent on the 3rd") passes.
const DONE = "recorded|saved|created|logged|confirmed|scheduled|booked|issued|deleted|updated|sent|added|noted|paid|invoiced|quoted|raised|captured|filed";
export const CLAIMS_DONE = new RegExp(`\\b(?:i|we)(?:['\u2019]ve|['\u2019]ll have| have| just| already)?\\s+(?:\\w+\\s+){0,2}(?:${DONE})\\b|\\b(?:has|have|had|was|were|is|are)\\s+(?:(?:now|just|been|already)\\s+)+(?:${DONE})\\b|\\b(?:that|this)(?:['\u2019]s| is| has been)\\s+(?:now\\s+)?(?:${DONE}|done)\\b|\\b(?:all set|consider it done|done and dusted)\\b|^\\s*done\\b`, "i");


const figures = (text: string): string[] => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((t) => String(Number(t.replace(/,/g, ""))));
export function ungroundedFigures(reply: string, sources: string[], said: string): string[] {
  const known = new Set<string>([...sources.flatMap(figures), ...figures(said)]);
  return [...new Set(figures(reply).filter((f) => !known.has(f)))];
}
export function groundedIn(reply: string, sources: string[], said: string): boolean {
  return ungroundedFigures(reply, sources, said).length === 0;
}
