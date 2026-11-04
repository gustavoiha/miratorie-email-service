import { useEffect, useMemo, useRef, useState } from 'react';

/** Remote resources an HTML body would load: images and CSS backgrounds over http(s). */
const REMOTE_CONTENT_RE = /\b(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

export function hasRemoteContent(html: string): boolean {
  return REMOTE_CONTENT_RE.test(html);
}

const FRAME_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #1d2129; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 15px; line-height: 1.45;
         padding: 12px; overflow-wrap: break-word; display: flow-root; }
  body > :first-child { margin-top: 0; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 0 0 0 0.5em; padding-left: 0.75em; border-left: 3px solid #dde1e6; color: #4a505b; }
  pre { white-space: pre-wrap; }
`;

/**
 * The document shown in the frame. Its own Content-Security-Policy adds to the one the frame
 * inherits from the app: nothing remote loads except, when allowed, https images.
 */
function frameDocument(html: string, showImages: boolean): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `img-src data:${showImages ? ' https:' : ''}`, 'font-src data:'].join('; ');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    `<style>${FRAME_CSS}</style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}

/**
 * Renders a (server-sanitised) HTML body in a sandboxed iframe: no scripts, forms or top-level
 * navigation; links open in a new tab. `allow-same-origin` (without `allow-scripts`) only lets
 * this page measure the content to size the frame.
 */
export function HtmlBody({ html, showImages }: { html: string; showImages: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => frameDocument(html, showImages), [html, showImages]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const root = frame.contentDocument?.documentElement;
      // Plus the frame's own borders, so the content never needs a scrollbar.
      if (root) setHeight(Math.ceil(root.getBoundingClientRect().height) + frame.offsetHeight - frame.clientHeight);
    };
    const onLoad = () => {
      measure();
      // Images change the height as they arrive.
      frame.contentDocument?.querySelectorAll('img').forEach((image) => image.addEventListener('load', measure));
    };
    // The content reflows when the frame gets narrower or wider.
    const resize = new ResizeObserver(measure);
    resize.observe(frame);
    frame.addEventListener('load', onLoad);
    return () => {
      resize.disconnect();
      frame.removeEventListener('load', onLoad);
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={frameRef}
      className="html-body"
      title="Message content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}
