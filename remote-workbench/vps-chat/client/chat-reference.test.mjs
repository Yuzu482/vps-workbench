import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationLink, parseConversationLink, quotedPrompt, readQuotedPrompt } from './chat-reference.js';

const route = { location: 'ssh-vps', provider: 'claude-sdk', targetId: 'a'.repeat(64),
  sessionId: '00000000-0000-4000-8000-000000000001', turnId: '00000000-0000-4000-8000-000000000002' };

test('conversation links contain only route and record identifiers and reject extra URL components', () => {
  const link = conversationLink({ ...route, prompt: 'private text', host: 'example.test' });
  assert.deepEqual(parseConversationLink(link), route);
  assert.deepEqual(parseConversationLink(' ' + link + '\n'), route);
  for (const bad of [link + '?text=example', link + '#fragment', link + '/', link.replace('://conversation/', '://user@conversation/'),
    link.replace('conversation/v1', 'conversation/v2'), link.replace(route.sessionId, '%2e%2e')]) {
    assert.equal(parseConversationLink(bad), null);
  }
  assert.equal(conversationLink({ ...route, location: 'local-sdk', provider: 'claude' }), null);
});

test('plain prompts round trip and quotation keeps Unicode, newlines and its own apparent delimiter', () => {
  const prompt = '总结这段资料，保留原意。';
  const quote = '🌿 第一行\n\n引用资料（仅供参考）\n"第二行"';
  assert.deepEqual(readQuotedPrompt(quotedPrompt(prompt, quote)), { prompt, quote });
  assert.deepEqual(readQuotedPrompt(quotedPrompt(prompt)), { prompt });
});
