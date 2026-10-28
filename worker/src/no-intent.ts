// The one place the "nothing to act on" text lives. The reply builder (reply.ts) says it, and the conversational layer (converse.ts) recognises it, without importing the reply builder and everything it can write.
export const NO_INTENT_MESSAGE = "I didn't catch anything there I could act on.";
