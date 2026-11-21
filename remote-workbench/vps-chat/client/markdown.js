import { Lexer } from 'marked';
import { decodeHTMLStrict } from 'entities';
import { isClosedHtmlFence } from './design-preview.js';

const maxDepth = 32;
const streamingWorkerThreshold = 4096;

function safeWebUrl(href) {
  const destination = decodeHTMLStrict(href);
  if (!/^https?:\/\//i.test(destination) || /[\u0000-\u0020\u007f]/.test(destination)) return null;
  try {
    const url = new URL(destination);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

export function createMarkdownReply(React, CodeBlock, parseStreamingMarkdown) {
  const h = React.createElement;

  function renderTokens(tokens, depth = 0) {
    if (depth > maxDepth) throw new Error('Markdown nesting is too deep.');
    return tokens.map((token, key) => renderToken(token, key, depth));
  }

  function renderCells(cells, tag, depth) {
    return cells.map((cell, key) => h(tag, {
      key, style: cell.align ? { textAlign: cell.align } : undefined,
    }, renderTokens(cell.tokens, depth)));
  }

  function renderToken(token, key, depth) {
    const childDepth = depth + 1;
    switch (token.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        return h(`h${token.depth}`, { key }, renderTokens(token.tokens, childDepth));
      case 'paragraph':
        return h('p', { key }, renderTokens(token.tokens, childDepth));
      case 'blockquote':
        return h('blockquote', { key }, renderTokens(token.tokens, childDepth));
      case 'strong':
      case 'em':
      case 'del':
        return h(token.type, { key }, renderTokens(token.tokens, childDepth));
      case 'codespan':
        return h('code', { key }, token.text);
      case 'code':
        return h(CodeBlock, {
          key, code: token.text, lang: token.lang?.trim().split(/\s+/, 1)[0],
          className: 'vc-code-block', copyLabel: '复制代码', copiedLabel: '已复制',
        });
      case 'list':
        return h(token.ordered ? 'ol' : 'ul', { key, start: token.ordered ? token.start : undefined },
          token.items.map((item, index) => h('li', { key: index }, renderTokens(item.tokens, childDepth))));
      case 'checkbox':
        return h(React.Fragment, { key }, h('input', { type: 'checkbox', checked: token.checked, disabled: true }), ' ');
      case 'table':
        return h('div', { key, className: 'vc-markdown-table' },
          h('table', null,
            h('thead', null, h('tr', null, renderCells(token.header, 'th', childDepth))),
            h('tbody', null,
              token.rows.map((row, index) => h('tr', { key: index }, renderCells(row, 'td', childDepth))))));
      case 'link': {
        const href = safeWebUrl(token.href);
        const children = renderTokens(token.tokens, childDepth);
        return href ? h('a', { key, href, target: '_blank', rel: 'noopener noreferrer' }, children)
          : h(React.Fragment, { key }, children);
      }
      case 'image':
        return decodeHTMLStrict(token.text);
      case 'escape':
        return token.text;
      case 'html':
        return token.block ? h('div', { key, className: 'vc-text' }, token.raw) : token.raw;
      case 'text':
        if (token.tokens) return h(React.Fragment, { key }, renderTokens(token.tokens, childDepth));
        return token.escaped ? token.text : decodeHTMLStrict(token.text);
      case 'hr':
      case 'br':
        return h(token.type, { key });
      default:
        return token.raw;
    }
  }

  return React.memo(function MarkdownReply({ source, collapseHtml = false, streaming = false, onStreamingRender }) {
    const useWorker = Boolean(streaming && parseStreamingMarkdown && source.length >= streamingWorkerThreshold);
    const [parsed, setParsed] = React.useState(null);
    const lastFormatted = React.useRef(null);
    React.useEffect(() => {
      if (!useWorker) return undefined;
      return parseStreamingMarkdown(source, (tokens) => {
        React.startTransition(() => setParsed({ source, tokens }));
      });
    }, [source, useWorker]);

    // While parsing an append, keep the markup that was already visible.
    // A late result for an older prefix must not replace more recent text.
    const previous = lastFormatted.current;
    const matching = parsed?.source === source;
    const keepPrevious = !matching && useWorker && previous && source.startsWith(previous.source);
    const ready = matching && parsed.tokens ? parsed : keepPrevious ? previous : null;
    const visibleSource = ready?.source ?? source;
    const tokens = ready?.tokens;
    const waiting = useWorker && !ready && !matching;
    const content = React.useMemo(() => {
      try {
        if (waiting) return h('div', { className: 'vc-text' }, visibleSource);
        const blocks = tokens ?? Lexer.lex(visibleSource, { gfm: true });
        if (!collapseHtml) return renderTokens(blocks);
        const artboards = blocks.filter(isClosedHtmlFence);
        if (!artboards.length) return renderTokens(blocks);
        return [
          ...renderTokens(blocks.filter(token => !artboards.includes(token))),
          h('details', { key: 'design-source', className: 'vc-design-source vc-details-motion' },
            h('summary', null, 'HTML 源码'), renderTokens(artboards)),
        ];
      } catch {
        return h('div', { className: 'vc-text' }, visibleSource);
      }
    }, [visibleSource, tokens, collapseHtml, waiting]);
    React.useLayoutEffect(() => {
      lastFormatted.current = useWorker ? ready : null;
      if (useWorker) onStreamingRender?.();
    }, [content, useWorker, ready, onStreamingRender]);
    return h('div', { className: 'vc-markdown' }, content);
  });
}
