import { Lexer } from 'marked';

self.addEventListener('message', ({ data: { id, source } }) => {
  try {
    self.postMessage({ id, tokens: Lexer.lex(source, { gfm: true }) });
  } catch {
    self.postMessage({ id, tokens: null });
  }
});
