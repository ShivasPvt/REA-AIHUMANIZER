// Daily word allowance per visitor, kept in memory and reset at UTC midnight.
const DAILY_WORDS = Number(process.env.DAILY_WORD_ALLOWANCE || 50000);

let day = today();
const used = new Map();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rollover() {
  const now = today();
  if (now !== day) {
    day = now;
    used.clear();
  }
}

export function remaining(visitor) {
  rollover();
  return Math.max(0, DAILY_WORDS - (used.get(visitor) || 0));
}

// Returns false (and charges nothing) when the request would exceed the allowance.
export function charge(visitor, words) {
  rollover();
  const spent = used.get(visitor) || 0;
  if (spent + words > DAILY_WORDS) return false;
  used.set(visitor, spent + words);
  return true;
}

// Gives words back when a job fails, so visitors only pay for results.
export function refund(visitor, words) {
  rollover();
  used.set(visitor, Math.max(0, (used.get(visitor) || 0) - words));
}

export { DAILY_WORDS };
