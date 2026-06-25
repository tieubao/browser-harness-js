/**
 * yt-solver — n-signature + signature decipher for YouTube player JS.
 *
 * Wraps the EJS challenge solver (yt-dlp/ejs, Unlicense) with a Bun-native
 * loader for the vendored meriyah (ISC) parser + astring (MIT) code generator.
 * Runs entirely in-process — no browser page, no external process.
 *
 * The solver is AST-based: it parses the player's base.js, locates the
 * n-transform and signature functions by structural signature (not regex),
 * and calls them. Robust across player-version rotations; the preprocessed
 * player form is cached so repeated solves for one video skip re-parsing.
 */
import * as meriyah from './meriyah.min.mjs';
import { generate } from './astring.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const astring = { generate };

const coreSrc = readFileSync(fileURLToPath(new URL('./core.js', import.meta.url)), 'utf8');
// core.js is an IIFE: `var jsc = (function(meriyah, astring){ ...; return main; })(...)`.
// Re-eval it with the vendored parsers bound in, and pull out `main` (called as `jsc`).
const factory = new Function('meriyah', 'astring', coreSrc + '\n; return jsc;');
const solveMain: any = factory(meriyah, astring);

// Preprocessing base.js (~2.4 MB) is the expensive step. Cache the preprocessed
// player form so repeated n/sig solves for the same video skip re-parsing.
let _cache: { playerJs: string; preprocessed: string } | null = null;

function getPreprocessed(playerJs: string): string {
  if (_cache?.playerJs === playerJs) return _cache.preprocessed;
  const out = solveMain({
    type: 'player',
    player: playerJs,
    output_preprocessed: true,
    requests: [],
  });
  if (!out.preprocessed_player) throw new Error('yt-solver: preprocessing produced no preprocessed player');
  _cache = { playerJs, preprocessed: out.preprocessed_player };
  return _cache.preprocessed;
}

function run(playerJs: string, type: 'n' | 'sig', challenges: string[]): Record<string, string> {
  const preprocessed = getPreprocessed(playerJs);
  const out = solveMain({
    type: 'preprocessed',
    preprocessed_player: preprocessed,
    requests: [{ type, challenges }],
  });
  const r = out.responses?.[0];
  if (!r || r.type === 'error') throw new Error(`yt-solver: ${type} solve failed: ${r?.error ?? 'no response'}`);
  return r.data as Record<string, string>;
}

/** Decipher a single n-signature value. Returns the transformed n. */
export function solveNsig(playerJs: string, n: string): string {
  const res = run(playerJs, 'n', [n]);
  const out = res[n];
  if (!out) throw new Error(`yt-solver: no n result for ${n}`);
  return out;
}

/** Decipher a single signature value. Returns the transformed signature. */
export function solveSig(playerJs: string, s: string): string {
  const res = run(playerJs, 'sig', [s]);
  const out = res[s];
  if (!out) throw new Error(`yt-solver: no sig result for ${s}`);
  return out;
}
