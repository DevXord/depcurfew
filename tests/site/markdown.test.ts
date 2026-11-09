// The Markdown renderer of the documentation site (decision D-132): exactly the subset README.md and
// docs/knowledge.md use, everything else escaped.
import { describe, expect, it } from 'vitest';
import { createSlugger, escapeHtml, renderMarkdown, slugify, splitSections } from '../../scripts/site/markdown.ts';

const html = (markdown: string, options?: Parameters<typeof renderMarkdown>[1]) => renderMarkdown(markdown, options).html;

describe('headings', () => {
  it('renders ATX headings with GitHub ids', () => {
    expect(html('# depcurfew\n## Five-minute start\n### `invalid-policy`')).toBe(
      '<h1 id="depcurfew">depcurfew</h1>\n<h2 id="five-minute-start">Five-minute start</h2>\n<h3 id="invalid-policy"><code>invalid-policy</code></h3>\n',
    );
  });

  it('builds ids as GitHub does: lower case, punctuation and symbols dropped, spaces as hyphens', () => {
    expect(slugify('doctor --user rules')).toBe('doctor---user-rules');
    expect(slugify('What depcurfew does not do')).toBe('what-depcurfew-does-not-do');
    expect(slugify('npm · installScripts.allowList.format ❓ uncertain')).toBe('npm--installscriptsallowlistformat--uncertain');
    expect(slugify('Yarn (Berry) · cooldown.default ⚠️ disputed')).toBe('yarn-berry--cooldowndefault--disputed');
    expect(slugify('snake_case and Zürich')).toBe('snake_case-and-zürich');
  });

  it('numbers repeated ids', () => {
    expect(html('### npm\n### npm\n### npm')).toBe('<h3 id="npm">npm</h3>\n<h3 id="npm-1">npm</h3>\n<h3 id="npm-2">npm</h3>\n');
    const slug = createSlugger(['content']);
    expect([slug('Content'), slug('Content'), slug('Other')]).toEqual(['content-1', 'content-2', 'other']);
  });

  it('takes ids from the caller and reports every heading', () => {
    const rendered = renderMarkdown('## A\ntext\n### B *b*', { slug: (text) => `id-${text.length}` });
    expect(rendered.html).toBe('<h2 id="id-1">A</h2>\n<p>text</p>\n<h3 id="id-3">B <em>b</em></h3>\n');
    expect(rendered.headings).toEqual([
      { level: 2, id: 'id-1', text: 'A' },
      { level: 3, id: 'id-3', text: 'B b' },
    ]);
  });

  it('strips closing hashes and needs a space after the hashes', () => {
    expect(html('## Title ##\n#hashtag')).toBe('<h2 id="title">Title</h2>\n<p>#hashtag</p>\n');
  });
});

describe('paragraphs', () => {
  it('joins the lines of a paragraph and ends it at a blank line', () => {
    expect(html('one\n  two\n\nthree')).toBe('<p>one\ntwo</p>\n<p>three</p>\n');
  });

  it('ends a paragraph at a heading, a fence, a list or a table', () => {
    expect(html('text\n## H')).toBe('<p>text</p>\n<h2 id="h">H</h2>\n');
    expect(html('text\n```\ncode\n```')).toBe('<p>text</p>\n<pre><code>code\n</code></pre>\n');
    expect(html('text\n- item')).toBe('<p>text</p>\n<ul>\n<li>item</li>\n</ul>\n');
    expect(html('text\n| a |\n| --- |\n| 1 |')).toBe(
      '<p>text</p>\n<div class="table"><table>\n<thead>\n<tr><th>a</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td></tr>\n</tbody>\n</table></div>\n',
    );
  });
});

describe('block quotes', () => {
  it('renders consecutive > lines as one quoted paragraph with inline content', () => {
    expect(html('> One **sentence**\n> on two lines.\n\nAfter.')).toBe('<blockquote>\n<p>One <strong>sentence</strong>\non two lines.</p>\n</blockquote>\n<p>After.</p>\n');
  });

  it('ends a paragraph at a quote and takes > with or without a space', () => {
    expect(html('Text\n>quoted')).toBe('<p>Text</p>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n');
  });
});

describe('lists', () => {
  it('renders bullet lists with inline content and lazy continuation lines', () => {
    expect(html('- **On your machine:** run `npm ci`\n- second\n  continued\n* other')).toBe(
      '<ul>\n<li><strong>On your machine:</strong> run <code>npm ci</code></li>\n<li>second\ncontinued</li>\n</ul>\n<ul>\n<li>other</li>\n</ul>\n',
    );
  });

  it('renders ordered lists and keeps their first number', () => {
    expect(html('1. one\n2. two')).toBe('<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n');
    expect(html('3. three\n4. four')).toBe('<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>\n');
  });

  it('ends a list at a blank line', () => {
    expect(html('- a\n\ntext')).toBe('<ul>\n<li>a</li>\n</ul>\n<p>text</p>\n');
  });
});

describe('tables', () => {
  it('renders header, alignment and body rows', () => {
    expect(html('| Tool | Unit | Since |\n| :--- | :---: | ---: |\n| npm | days | 11.10.0 |')).toBe(
      [
        '<div class="table"><table>',
        '<thead>',
        '<tr><th class="align-left">Tool</th><th class="align-center">Unit</th><th class="align-right">Since</th></tr>',
        '</thead>',
        '<tbody>',
        '<tr><td class="align-left">npm</td><td class="align-center">days</td><td class="align-right">11.10.0</td></tr>',
        '</tbody>',
        '</table></div>',
        '',
      ].join('\n'),
    );
  });

  it('keeps escaped pipes in cells, also in code, and line breaks', () => {
    expect(html('| Command | Note |\n| --- | --- |\n| `doctor [--json \\| --sarif]` | a<br>b |')).toBe(
      '<div class="table"><table>\n<thead>\n<tr><th>Command</th><th>Note</th></tr>\n</thead>\n<tbody>\n<tr><td><code class="words"><span>doctor</span> <span>[--json</span> <span>|</span> <span>--sarif]</span></code></td><td>a<br>b</td></tr>\n</tbody>\n</table></div>\n',
    );
  });

  // Code in a table wraps only between its words, which never break at a hyphen (decision D-145).
  it('splits code with spaces in a table cell into words, and leaves other code as it is', () => {
    expect(html('| `a b` x | `min-release-age` |\n| --- | --- |\n| **`npm  ci <name>`** | [`c d`](#e) |')).toBe(
      [
        '<div class="table"><table>',
        '<thead>',
        '<tr><th><code class="words"><span>a</span> <span>b</span></code> x</th><th><code>min-release-age</code></th></tr>',
        '</thead>',
        '<tbody>',
        '<tr><td><strong><code class="words"><span>npm</span>  <span>ci</span> <span>&lt;name&gt;</span></code></strong></td><td><a href="#e"><code class="words"><span>c</span> <span>d</span></code></a></td></tr>',
        '</tbody>',
        '</table></div>',
        '',
      ].join('\n'),
    );
    expect(html('run `npm ci <name>` and `min-release-age`')).toBe('<p>run <code>npm ci &lt;name&gt;</code> and <code>min-release-age</code></p>\n');
  });

  it('marks a table of five or more columns as wide', () => {
    expect(html('| a | b | c | d |\n| - | - | - | - |\n| 1 | 2 | 3 | 4 |')).toContain('<div class="table"><table>');
    expect(html('| a | b | c | d | e |\n| - | - | - | - | - |\n| 1 | 2 | 3 | 4 | 5 |')).toContain('<div class="table wide"><table>');
  });

  it('keeps a date in a table cell whole, with the dash of a range after it', () => {
    expect(html('| Verified |\n| --- |\n| 2026-10-28 – 2026-11-02 |\n\nOn 2026-11-02.')).toBe(
      '<div class="table"><table>\n<thead>\n<tr><th>Verified</th></tr>\n</thead>\n<tbody>\n<tr><td><span class="date">2026-10-28 –</span> <span class="date">2026-11-02</span></td></tr>\n</tbody>\n</table></div>\n<p>On 2026-11-02.</p>\n',
    );
  });

  it('lets a long word of table code wrap after a dot or a slash, never at a hyphen', () => {
    expect(html('| a |\n| --- |\n| `install.minimumReleaseAgeExcludes` `~/Library/Application Support/pypoetry/config.toml` `solver.min-release-age` `a.b/c` `https://github.com/org/*` |')).toBe(
      [
        '<div class="table"><table>',
        '<thead>',
        '<tr><th>a</th></tr>',
        '</thead>',
        '<tbody>',
        '<tr><td><code class="words"><span>install.</span><wbr><span>minimumReleaseAgeExcludes</span></code> ' +
          '<code class="words"><span>~/</span><wbr><span>Library/</span><wbr><span>Application</span> <span>Support/</span><wbr><span>pypoetry/</span><wbr><span>config.</span><wbr><span>toml</span></code> ' +
          '<code class="words"><span>solver.</span><wbr><span>min-release-age</span></code> <code>a.b/c</code> ' +
          '<code class="words"><span>https://</span><wbr><span>github.</span><wbr><span>com/</span><wbr><span>org/</span><wbr><span>*</span></code></td></tr>',
        '</tbody>',
        '</table></div>',
        '',
      ].join('\n'),
    );
  });

  it('fills missing cells and drops extra ones', () => {
    expect(html('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')).toBe(
      '<div class="table"><table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td></td></tr>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>\n',
    );
  });

  it('is no table without a matching delimiter row', () => {
    expect(html('| a | b |\n| --- |')).toBe('<p>| a | b |\n| --- |</p>\n');
  });
});

describe('code blocks', () => {
  it('escapes the content and names the language', () => {
    expect(html('```json\n{"a": "<b> & c"}\n```')).toBe('<pre><code class="language-json">{&quot;a&quot;: &quot;&lt;b&gt; &amp; c&quot;}\n</code></pre>\n');
  });

  it('keeps headings, lists and comments inside the block as text', () => {
    expect(html('```yaml\n# comment\n- run: npm ci\n<!-- x -->\n```\n## After')).toBe(
      '<pre><code class="language-yaml"># comment\n- run: npm ci\n&lt;!-- x --&gt;\n</code></pre>\n<h2 id="after">After</h2>\n',
    );
  });

  it('closes only with a fence at least as long, and runs to the end when unclosed', () => {
    expect(html('````\n```\n````')).toBe('<pre><code>```\n</code></pre>\n');
    expect(html('```\nopen')).toBe('<pre><code>open\n</code></pre>\n');
    expect(html('~~~ text\nx\n~~~')).toBe('<pre><code class="language-text">x\n</code></pre>\n');
  });

  it('keeps only a safe language name', () => {
    expect(html('```js" onload="x\ny\n```')).toBe('<pre><code>y\n</code></pre>\n');
  });
});

describe('inline code', () => {
  it('escapes HTML and keeps backslashes and stars', () => {
    expect(html('`<script>` and `\\x1b` and `*a*`')).toBe('<p><code>&lt;script&gt;</code> and <code>\\x1b</code> and <code>*a*</code></p>\n');
  });

  it('matches backtick runs of the same length and strips one padding space', () => {
    expect(html('``a ` b`` and `` `x` ``')).toBe('<p><code>a ` b</code> and <code>`x`</code></p>\n');
  });

  it('leaves an unmatched backtick as text', () => {
    expect(html('a ` b')).toBe('<p>a ` b</p>\n');
  });
});

describe('links', () => {
  it('renders links with inline content in their text', () => {
    expect(html('[`yaml`](https://github.com/eemeli/yaml) and [GitHub Action](#github-action)')).toBe(
      '<p><a href="https://github.com/eemeli/yaml"><code>yaml</code></a> and <a href="#github-action">GitHub Action</a></p>\n',
    );
  });

  it('lets the caller rewrite targets', () => {
    expect(html('[a](#x) [b](https://example.com/doc.md)', { href: (target) => (target === '#x' ? 'page.html#x' : target) })).toBe(
      '<p><a href="page.html#x">a</a> <a href="https://example.com/doc.md">b</a></p>\n',
    );
  });

  it('keeps the text of a link whose target the caller drops (decision D-139)', () => {
    expect(html('[a](#x) and [**b**](#y)', { href: (target) => (target === '#x' ? undefined : target) })).toBe('<p>a and <a href="#y"><strong>b</strong></a></p>\n');
  });

  it('keeps parentheses in targets, ignores a title and escapes the target', () => {
    expect(html('[w](https://example.com/a_(b)?q="1"&r=2 "Title")')).toBe('<p><a href="https://example.com/a_(b)?q=&quot;1&quot;&amp;r=2">w</a></p>\n');
  });

  it('renders autolinks', () => {
    expect(html('index (<https://pypi.org/simple>)')).toBe('<p>index (<a href="https://pypi.org/simple">https://pypi.org/simple</a>)</p>\n');
  });

  it('drops the link of a target with an unsafe scheme', () => {
    expect(html('[click](javascript:alert(1)) [mail](mailto:a@example.com) [data](data:text/html,x)')).toBe(
      '<p>click <a href="mailto:a@example.com">mail</a> data</p>\n',
    );
  });

  it('drops the link of a target with control characters or spaces, which the URL parser removes before it reads the scheme', () => {
    // The WHATWG URL parser strips leading C0 controls and spaces and removes tabs and newlines anywhere, so each of
    // these is javascript: in a browser.
    for (const target of ['\u0001javascript:alert(1)', '\u0000javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'javascript\r:alert(1)', '\u001fdata:text/html,x', '\u007fjavascript:x', ' javascript:alert(1)']) {
      expect(html(`[x](${target})`), JSON.stringify(target)).not.toContain('<a');
    }
    expect(html('[x](\u0001javascript:alert(document.domain))')).toBe('<p>x</p>\n');
    expect(html('[ok](docs/a.md) [ok](#anchor) [ok](https://example.com/a?b=c)')).toBe('<p><a href="docs/a.md">ok</a> <a href="#anchor">ok</a> <a href="https://example.com/a?b=c">ok</a></p>\n');
  });

  it('shows images and broken links as text', () => {
    expect(html('![logo](https://example.com/logo.png) [text] [a](b c)')).toBe('<p>![logo](https://example.com/logo.png) [text] [a](b c)</p>\n');
  });
});

describe('emphasis', () => {
  it('renders strong and emphasis with stars', () => {
    expect(html('**error** · *note*')).toBe('<p><strong>error</strong> · <em>note</em></p>\n');
  });

  it('never takes underscores for emphasis, so Python names stay as they are', () => {
    expect(html('Lib/venv/__init__.py, and __pypackages__ [env] and _x_')).toBe('<p>Lib/venv/__init__.py, and __pypackages__ [env] and _x_</p>\n');
  });

  it('nests emphasis and links', () => {
    expect(html('**see [the *rules*](#rules)**')).toBe('<p><strong>see <a href="#rules">the <em>rules</em></a></strong></p>\n');
  });

  it('leaves stars and underscores inside words and around punctuation as text', () => {
    expect(html('A release-age exception such as "*" (or "@*/*") and lts/* and package*, snake_case_name')).toBe(
      '<p>A release-age exception such as &quot;*&quot; (or &quot;@*/*&quot;) and lts/* and package*, snake_case_name</p>\n',
    );
    expect(html('** not bold ** and *open')).toBe('<p>** not bold ** and *open</p>\n');
    expect(html('platformdirs _xdg.py and (_normalize_name: name.replace("_", "-") and \'_\')')).toBe(
      '<p>platformdirs _xdg.py and (_normalize_name: name.replace(&quot;_&quot;, &quot;-&quot;) and &#39;_&#39;)</p>\n',
    );
  });

  it('closes emphasis at the nearest opener, as CommonMark does', () => {
    expect(html('*a *b* c*')).toBe('<p><em>a <em>b</em> c</em></p>\n');
    expect(html('***both***')).toBe('<p><em><strong>both</strong></em></p>\n');
    expect(html('*one **two** three*')).toBe('<p><em>one <strong>two</strong> three</em></p>\n');
  });
});

describe('escaping', () => {
  it('escapes raw HTML and entities, and keeps only line breaks', () => {
    expect(html('<script>alert(1)</script> <img src=x onerror=y> &amp; <ParamField path="--cwd"> a<br/>b<br />c')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=y&gt; &amp;amp; &lt;ParamField path=&quot;--cwd&quot;&gt; a<br>b<br>c</p>\n',
    );
  });

  it('escapes a raw HTML block', () => {
    expect(html('<div onclick="x">\nhi\n</div>')).toBe('<p>&lt;div onclick=&quot;x&quot;&gt;\nhi\n&lt;/div&gt;</p>\n');
  });

  it('drops HTML comments, also over several lines', () => {
    expect(html('<!-- BEGIN GENERATED: tools -->\ntext\n<!-- a\nb -->\n<!-- END GENERATED: tools -->')).toBe('<p>text</p>\n');
  });

  it('turns backslash escapes into the character', () => {
    expect(html('\\*not em\\* and a\\|b and C:\\path')).toBe('<p>*not em* and a|b and C:\\path</p>\n');
  });

  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('reads CRLF line endings', () => {
    expect(html('## A\r\ntext\r\n')).toBe('<h2 id="a">A</h2>\n<p>text</p>\n');
  });
});

describe('sections', () => {
  it('splits a document at its headings, outside code blocks, with GitHub ids', () => {
    const { preamble, sections } = splitSections('<!-- note -->\n# Title\nintro\n## `a-b` rule\n```bash\n# not a heading\n```\n### Sub\ntext\n## Sub\n');
    expect(preamble).toBe('<!-- note -->\n');
    expect(sections.map(({ level, id, text }) => ({ level, id, text }))).toEqual([
      { level: 1, id: 'title', text: 'Title' },
      { level: 2, id: 'a-b-rule', text: 'a-b rule' },
      { level: 3, id: 'sub', text: 'Sub' },
      { level: 2, id: 'sub-1', text: 'Sub' },
    ]);
    expect(sections[1]?.heading).toBe('`a-b` rule');
    expect(sections[1]?.body).toBe('```bash\n# not a heading\n```\n');
    expect(sections[0]?.body).toBe('intro\n');
  });
});
