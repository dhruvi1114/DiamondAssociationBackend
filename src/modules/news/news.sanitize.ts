import sanitizeHtml from 'sanitize-html';

/**
 * Clean an article body before it is stored.
 *
 * On the way IN, not on the way out. The body is served to logged-out browsers
 * on a page the association links to from its homepage, so the markup has to be
 * safe in the database — sanitising at render time means every future reader of
 * that column (an export, a PDF, an email digest, a second frontend) has to
 * remember to do it too, and one of them will not.
 *
 * The allowlist is deliberately small. It covers what the admin editor can
 * produce and nothing else: paragraphs, headings, emphasis, lists, quotes,
 * links, images, tables. Everything unlisted is dropped rather than escaped, so
 * a paste out of Word leaves text behind instead of a wall of `<o:p>` markup.
 *
 * Three things are removed that are easy to overlook:
 *  - `<script>` and `<style>` contents, not just their tags. Dropping the tag
 *    and keeping the text would print the script body as visible page copy.
 *  - every `on*` attribute, by never allowing one through the allowlist.
 *  - `javascript:` and `data:` URLs on both links and images, by naming the
 *    schemes that ARE permitted rather than the ones that are not.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'h2',
    'h3',
    'h4',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'figure',
    'figcaption',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    /*
      `class` is allowed on images alone, and only the three size classes below.
      An image's width has to survive the round trip — the writer chose it — and
      a `style` attribute would be a far wider door than a fixed vocabulary of
      three names. `width`/`height` are gone with it: they take pixels, and a
      pixel width chosen on a desktop is wrong on every phone.
    */
    img: ['src', 'alt', 'title', 'class'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  /*
    `https` and `mailto` only. `data:` is absent on purpose: a data URL is how an
    inline SVG — a script container — gets past an image allowlist, and it is
    also how a multi-megabyte picture ends up inside a text column instead of in
    storage where it can be served, cached and deleted.
  */
  /** The only classes any element may carry. Anything else is dropped. */
  allowedClasses: {
    img: ['news-img-sm', 'news-img-md', 'news-img-full'],
  },
  allowedSchemes: ['https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  // Contents dropped with the tag, not left as visible text.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
  /*
    An external link opened in a new tab can reach back through `window.opener`
    unless it is told not to. The editor cannot be relied on to add this, so the
    sanitiser does it for every link that opens away from the page.
  */
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target
        ? { ...attribs, target: '_blank', rel: 'noopener noreferrer' }
        : attribs,
    }),
  },
};

/** The cleaned markup. Returns an empty string for empty or markup-only input. */
export const sanitiseArticleBody = (html: string): string => sanitizeHtml(html, OPTIONS);

/**
 * Is there anything left once the markup is gone?
 *
 * `<p><br></p>` is what an empty rich-text editor submits, and it is not an
 * article. Publishing one would put a card on the homepage that leads to a blank
 * page, so the publish path asks this question rather than trusting the length
 * of the HTML.
 */
export const hasReadableText = (html: string): boolean =>
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .trim().length > 0;
