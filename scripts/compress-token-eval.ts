/**
 * Token-estimator eval — validate `@shrkcrft/compress`'s deterministic
 * `estimateTokens` against per-content-type fixtures, and (when a real
 * tokenizer is installed) against ground truth.
 *
 *   bun run scripts/compress-token-eval.ts
 *
 * The engine stays model-free and dependency-light, so no tokenizer is bundled.
 * To get real ground-truth error %, install one as a dev dep first:
 *   bun add -d gpt-tokenizer        # pure JS, no native build
 * The script auto-detects it via dynamic import and degrades gracefully when
 * absent (reporting the estimator's own ch/tok ratios, which it always checks).
 */
import { estimateTokens, EContentType } from '../packages/compress/src/index.ts';

interface IFixture {
  name: string;
  type: EContentType;
  text: string;
}

const FIXTURES: IFixture[] = [
  {
    name: 'json-array',
    type: EContentType.JsonArray,
    text: JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({ id: `node-${i}`, kind: 'rule', title: `Rule number ${i}` })),
    ),
  },
  {
    name: 'source-code',
    type: EContentType.SourceCode,
    text: Array.from({ length: 30 }, (_, i) => `  const value${i} = compute(input${i}, options);`).join('\n'),
  },
  {
    name: 'markdown',
    type: EContentType.Markdown,
    text: Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\nProse paragraph describing section ${i} at some length.`).join('\n\n'),
  },
  {
    name: 'plain-text',
    type: EContentType.PlainText,
    text: Array.from({ length: 30 }, () => 'the quick brown fox jumps over the lazy dog repeatedly').join(' '),
  },
];

async function loadEncoder(): Promise<((s: string) => number) | null> {
  for (const mod of ['gpt-tokenizer', 'js-tiktoken']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = await import(mod);
      if (typeof m.encode === 'function') return (s: string) => m.encode(s).length;
      if (typeof m.countTokens === 'function') return (s: string) => m.countTokens(s) as number;
    } catch {
      /* not installed — fall through */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const encode = await loadEncoder();
  const rows: Array<Record<string, string | number>> = [];
  let worstErr = 0;
  for (const fx of FIXTURES) {
    const typed = estimateTokens(fx.text, fx.type);
    const untyped = estimateTokens(fx.text);
    const row: Record<string, string | number> = {
      fixture: fx.name,
      chars: fx.text.length,
      'est(typed)': typed,
      'est(untyped)': untyped,
      'ch/tok': (fx.text.length / typed).toFixed(2),
    };
    if (encode) {
      const real = encode(fx.text);
      const errPct = real > 0 ? Math.round((Math.abs(typed - real) / real) * 100) : 0;
      row.real = real;
      row['err%'] = errPct;
      worstErr = Math.max(worstErr, errPct);
    }
    rows.push(row);
  }
  // eslint-disable-next-line no-console
  console.table(rows);
  if (encode) {
    // eslint-disable-next-line no-console
    console.log(`worst typed-vs-real error: ${worstErr}%`);
  } else {
    // eslint-disable-next-line no-console
    console.log('No tokenizer found — reporting estimator ratios only. `bun add -d gpt-tokenizer` to enable ground-truth error %.');
  }
}

void main();
