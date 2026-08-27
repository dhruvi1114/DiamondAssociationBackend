import { describe, expect, it } from 'vitest';
import { hasReadableText, sanitiseArticleBody } from '@modules/news/news.sanitize';

/**
 * The article body is the one field on this platform whose contents are written
 * by staff and rendered, as markup, to logged-out strangers. These tests are the
 * proof that what reaches the database is safe — cleaning happens on the way in,
 * so a failure here is a stored XSS on the association's public homepage.
 */
describe('article body sanitiser', () => {
  it('drops a script tag and its contents, not just the tag', () => {
    const clean = sanitiseArticleBody('<p>Before</p><script>alert(1)</script><p>After</p>');

    expect(clean).not.toContain('script');
    // The tag going but its text staying would print the payload as page copy.
    expect(clean).not.toContain('alert(1)');
    expect(clean).toContain('Before');
    expect(clean).toContain('After');
  });

  it('strips event handler attributes', () => {
    const clean = sanitiseArticleBody('<p onclick="steal()">Read this</p>');

    expect(clean).not.toContain('onclick');
    expect(clean).toContain('Read this');
  });

  it('refuses a javascript: link', () => {
    const clean = sanitiseArticleBody('<a href="javascript:alert(1)">Click</a>');

    expect(clean).not.toContain('javascript:');
  });

  it('refuses a data: image, which is how an inline SVG gets past an allowlist', () => {
    const clean = sanitiseArticleBody(
      '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==" alt="x" />',
    );

    expect(clean).not.toContain('data:');
  });

  it('keeps an https image, which is what an uploaded picture is', () => {
    const clean = sanitiseArticleBody('<img src="https://example.org/a.jpg" alt="A photo" />');

    expect(clean).toContain('https://example.org/a.jpg');
    expect(clean).toContain('A photo');
  });

  it('keeps the relative URL an uploaded inline image is served at', () => {
    const clean = sanitiseArticleBody('<img src="/api/v1/public/news/media/8a7b" alt="Seminar" />');

    expect(clean).toContain('/api/v1/public/news/media/8a7b');
  });

  it('keeps the formatting the editor produces', () => {
    const clean = sanitiseArticleBody(
      '<h2>Heading</h2><p><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li></ul>',
    );

    expect(clean).toContain('<h2>Heading</h2>');
    expect(clean).toContain('<strong>Bold</strong>');
    expect(clean).toContain('<li>One</li>');
  });

  it('adds rel=noopener to a link that opens in a new tab', () => {
    const clean = sanitiseArticleBody('<a href="https://example.org" target="_blank">Out</a>');

    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('drops an iframe outright', () => {
    const clean = sanitiseArticleBody('<iframe src="https://evil.example"></iframe>');

    expect(clean).not.toContain('iframe');
  });
});

describe('hasReadableText', () => {
  it('treats the empty editor as empty', () => {
    // What a rich-text editor submits when nobody has typed anything.
    expect(hasReadableText('<p><br></p>')).toBe(false);
    expect(hasReadableText('<p>&nbsp;</p>')).toBe(false);
    expect(hasReadableText('')).toBe(false);
  });

  it('sees text that is there', () => {
    expect(hasReadableText('<p>The association met on Tuesday.</p>')).toBe(true);
  });
});

describe('image size classes', () => {
  it('keeps the three size classes the editor can set', () => {
    for (const size of ['news-img-sm', 'news-img-md', 'news-img-full']) {
      const clean = sanitiseArticleBody(`<img src="/api/v1/x.jpg" class="${size}" alt="a" />`);

      expect(clean).toContain(size);
    }
  });

  it('drops any other class', () => {
    // A class allowlist, not a filter: an unknown name is not a smaller version
    // of a known one, it is somebody else's stylesheet reaching into the page.
    const clean = sanitiseArticleBody('<img src="/api/v1/x.jpg" class="evil-overlay" alt="a" />');

    expect(clean).not.toContain('evil-overlay');
  });

  it('drops a style attribute outright', () => {
    const clean = sanitiseArticleBody(
      '<img src="/api/v1/x.jpg" style="position:fixed;top:0" alt="a" />',
    );

    expect(clean).not.toContain('position');
  });
});
