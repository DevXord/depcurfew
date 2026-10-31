// JSON for stdout that carries text from files and the environment. JSON.stringify escapes C0 controls but leaves C1
// controls (U+0080 to U+009F, which some terminals read as escape sequences) and the bidirectional formatting
// characters (Trojan Source) as they are; here they are written as \uXXXX too, so `cat`-ing the output is safe.

/** C1 controls and the Unicode bidirectional formatting characters: ALM, LRM, RLM, LRE to RLO, LRI to PDI. */
const UNSAFE = /[\u0080-\u009f؜‎‏‪-‮⁦-⁩]/gu;

/** JSON.stringify(value, null, space) with C1 and bidi characters escaped; the text parses to the same value. */
export function safeJson(value: unknown, space?: string | number): string {
  // These characters can only occur inside JSON strings, where \uXXXX means the same character.
  return (JSON.stringify(value, null, space) ?? 'null').replace(UNSAFE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
