'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent, parseKeys, blockedCombo, tools, pruneImages } = require('../app/agent.cjs');

test('parseKeys presses in order and releases in reverse, extended keys flagged', () => {
  assert.deepEqual(parseKeys('ctrl+shift+t'), [
    { vk: 0x11, ext: false }, { vk: 0x10, ext: false }, { vk: 0x54, ext: false },
    { vk: 0x54, up: true, ext: false }, { vk: 0x10, up: true, ext: false }, { vk: 0x11, up: true, ext: false },
  ]);
  assert.equal(parseKeys('Down')[0].ext, true);
  assert.throws(() => parseKeys('ctrl+banana'), /Unknown key/);
  assert.throws(() => parseKeys(''), /one to five keys/);
});

test('Win+L and Ctrl+Alt+Delete are blocked', () => {
  assert.ok(blockedCombo(parseKeys('win+l')));
  assert.ok(blockedCombo(parseKeys('ctrl+alt+delete')));
  assert.ok(!blockedCombo(parseKeys('ctrl+l')));
});

test('run_command is only offered when commands are allowed', () => {
  const names = (o) => tools(o).map((t) => t.function.name);
  assert.ok(names({ allowCommands: true }).includes('run_command'));
  assert.ok(!names({ allowCommands: false }).includes('run_command'));
});

test('only the newest screenshots stay in the conversation', () => {
  const img = () => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] });
  const msgs = pruneImages([img(), img(), img(), img(), img()]);
  assert.equal(msgs.filter((m) => m.content[0].type === 'image_url').length, 3);
  assert.equal(msgs[0].content[0].text, '(older screenshot removed)');
});

function fakeIo(log) {
  return {
    window: () => ({ title: 'Untitled - Notepad', exe: 'notepad.exe' }),
    screenshot: async () => { log.push('shot'); return { width: 100, height: 50, dataUrl: 'data:image/jpeg;base64,AA' }; },
    click: async (x, y, b, n) => log.push(`click ${x},${y} ${b} ${n}`),
    typeText: async (t) => log.push(`type ${t}`),
    keys: async (k) => log.push(`keys ${k.length}`),
    scroll: async () => log.push('scroll'),
    wait: async () => log.push('wait'),
    run: async (c) => { log.push(`run ${c}`); return 'exit code 0\nhi'; },
    write: async (t) => { log.push(`write ${t}`); return 'Pasted.'; },
  };
}
const call = (name, args) => ({ message: { content: '', tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, cost: 0.01 });

test('agent loop runs tools, returns a screenshot after actions, and stops on done', async () => {
  const log = [];
  const replies = [call('click', { x: 10, y: 20 }), call('click', { x: 500, y: 20 }), call('press_keys', { keys: 'win+l' }), call('run_command', { command: 'echo hi' }), call('done', { summary: 'All set.', success: true })];
  const seen = [];
  const r = await runAgent({
    chat: async ({ messages }) => { seen.push(messages.at(-1)); return replies.shift(); },
    task: 'do it', io: fakeIo(log), allowCommands: true,
  });
  assert.deepEqual(r, { success: true, summary: 'All set.', written: '', steps: 4, cost: 0.05 });
  assert.deepEqual(log, ['shot', 'click 10,20 left 1', 'shot', 'run echo hi']);
  // The off-screen click and the blocked combo come back to the model as errors.
  assert.match(seen[2].content, /outside the 100x50/);
  assert.match(seen[3].content, /lock or sign out/);
  assert.equal(seen[4].content, 'exit code 0\nhi');
});

test('text-only tasks are written where the user was typing', async () => {
  const log = [];
  const replies = [call('write_text', { text: 'Hello Sam' }), call('done', { summary: 'Wrote it.', success: true })];
  const r = await runAgent({ chat: async () => replies.shift(), task: 'say hello to Sam', io: fakeIo(log) });
  assert.equal(r.written, 'Hello Sam');
  assert.deepEqual(log, ['shot', 'write Hello Sam']);
});

test('a cancelled run stops before the next model call', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(runAgent({
    chat: async () => { calls++; ac.abort(); return call('wait', { seconds: 1 }); },
    task: 'x', io: fakeIo([]), signal: ac.signal,
  }), /Cancelled/);
  assert.equal(calls, 1);
});
