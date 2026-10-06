// Normalising LaTeX/text so that two readings of the same ink can be compared: spacing, braces
// around single tokens, \left/\right, \text{} wrappers and synonyms (\leq/\le ...) do not count as
// differences. Used by the test set (exact match) and by the board (do two readings agree?).

export function norm(s) {
  let t = String(s || '')
    .replace(/\$/g, '')
    .replace(/\\(left|right|displaystyle|big|Big|bigl|bigr)\b/g, '')
    .replace(/\\[,;:! ]/g, '').replace(/\\q?quad/g, '')
    .replace(/\\mathrm\{([^{}]*)\}/g, '$1').replace(/\\text\{([^{}]*)\}/g, '$1').replace(/\\operatorname\{([^{}]*)\}/g, '$1')
    .replace(/\\[dt]frac/g, '\\frac')
    .replace(/\\varepsilon/g, '\\epsilon').replace(/\\varphi/g, '\\phi')
    .replace(/\\to\b/g, '\\rightarrow').replace(/\\leq\b/g, '\\le').replace(/\\geq\b/g, '\\ge')
    .replace(/\\begin\{aligned\}|\\end\{aligned\}|&/g, '')
    .replace(/\s+/g, '')
    .replace(/\{(\?+)\}/g, '$1')       // "= {?}" is "= ?"
    .replace(/(\\?[.,;:])+$/, '');     // a full stop or comma at the very end is not part of the maths
  // {x} -> x for single tokens, repeated until stable
  for (let i = 0; i < 5; i++) {
    const u = t.replace(/\{(\\?[A-Za-z]|\d|\\[A-Za-z]+)\}/g, '$1');
    if (u === t) break;
    t = u;
  }
  return t;
}

// what a transcription result says, as one string (LaTeX for math, text otherwise)
export const readingOf = r => (!r ? '' : r.kind === 'math' ? r.latex : r.kind === 'empty' ? '' : r.text);

// do two transcription results say the same thing? Figures and empty regions agree on their kind
// alone (their descriptions are free prose and always differ).
export function sameReading(a, b) {
  if (!a || !b) return false;
  if (a.kind === 'figure' || b.kind === 'figure' || a.kind === 'empty' || b.kind === 'empty') return a.kind === b.kind;
  return norm(readingOf(a)) === norm(readingOf(b));
}
