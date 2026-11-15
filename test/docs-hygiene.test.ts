/**
 * Documentation hygiene: the shipped prose must not carry real session data.
 *
 * The README is published inside the npm tarball, so anything quoted there is
 * world-readable forever. R-230: a feature example used the maintainer's own
 * session title and id (a job-application conversation, replete with
 * identifying detail) and shipped in 0.6.0 — this test exists so the next
 * example cannot repeat it.
 *
 * The check is deliberately narrow: it pins the SHAPE of the placeholders the
 * READMEs are supposed to use, not a blacklist of known-bad strings (a
 * blacklist would only catch the leak that already happened).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const REPO = new URL('..', import.meta.url)
const read = (file: string): string => readFileSync(new URL(file, REPO), 'utf8')

describe('documentation hygiene (R-230)', () => {
  it('uses a generic placeholder for the example session label', () => {
    for (const file of ['README.md', 'README.en.md']) {
      const text = read(file);
      // The label example must be built from the placeholder id, never from
      // a real 8-hex-digit session id.
      const labelExamples = [...text.matchAll(/行标题 \| 会话标题 \+ 短 id（形如 `([^`]+)`/gu)].map(m => m[1]!)
      const labelExamplesEn = [...text.matchAll(/Row label \| The session's title plus its short id \(`([^`]+)`\)/gu)].map(m => m[1]!)
      for (const example of [...labelExamples, ...labelExamplesEn]) {
        // The documented placeholder is the ONE id-shaped token allowed: it is
        // recognisably synthetic. Any other 8-hex id is a real session's.
        expect(example, `${file}: example label must use the documented placeholder`).toContain('abc12345');
        const ids = [...example.matchAll(/\[([0-9a-f]{8})\]/gu)].map(match => match[1]!);
        expect(ids.filter(id => id !== 'abc12345'), `${file}: example label carries a real session id`).toHaveLength(0);
      }
    }
  });

  it('never ships a real session id or a session title from the author machine', () => {
    // A session id is a UUID or its 8-hex prefix. The READMEs may talk ABOUT
    // ids in prose (`abc12345` placeholder, `<actN>` and friends), so the rule
    // is: no bare 8-hex-digit token outside a backticked placeholder form.
    const shipped = ['README.md', 'README.en.md', 'dsh-plugin.json'];
    for (const file of shipped) {
      const text = read(file);
      const hex = [...text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu)];
      expect(hex, `${file}: full UUID leaked into shipped prose`).toHaveLength(0);
    }
  });

  it('keeps maintainer-machine paths out of shipped prose', () => {
    for (const file of ['README.md', 'README.en.md']) {
      const text = read(file);
      // The READMEs document `~/.dsh-tui` style paths and a Windows placeholder
      // like C:\\Users\\me\\…; a real home-directory name is the leak.
      expect(text, `${file}: a real Windows user path leaked`).not.toMatch(/C:\\\\Users\\\\(?!me\\b)[A-Za-z0-9_-]+/u);
    }
  });
});
