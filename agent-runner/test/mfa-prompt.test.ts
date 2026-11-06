/**
 * The two-step sign-in prompt of debug.ts (`npm test`): the terminal prompt over in-memory streams, the envelope
 * reader, the code check.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { askCodeOnTty, codePromptText, loginStep, normalizeCode } from '../mfa-prompt';

/** Run the prompt with `typed` as the user's input; answers the result and everything written to the "terminal". */
async function prompt(method: 'totp' | 'email', typed: string, note?: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', chunk => (written += chunk));
    const answer = askCodeOnTty(method, note, input, output);
    input.end(typed);
    return { answer: await answer, written };
}

test('the app code: the prompt names the authenticator app; "123 456" → 123456', async () => {
    const { answer, written } = await prompt('totp', '123 456\n');
    assert.deepEqual(answer, { code: '123456' });
    assert.match(written, /^Enter the code from your authenticator app: /);
    assert.ok(!written.includes('r + Enter'), 'no resend for an app code');
});

test('the e-mailed code: r + Enter = a new code; the note is shown first', async () => {
    const { answer, written } = await prompt('email', 'r\n', 'A new code is on its way.');
    assert.deepEqual(answer, { resend: true });
    assert.match(written, /^A new code is on its way\.\nEnter the code we e-mailed to you \(r \+ Enter = send a new code\): /);
});

test('a value that is not 6 digits is asked again; the code is never echoed by the prompt', async () => {
    const { answer, written } = await prompt('totp', '12345\n654321\n');
    assert.deepEqual(answer, { code: '654321' });
    assert.match(written, /The code is 6 digits\./);
    assert.ok(!written.includes('654321'));
});

test('an empty line, the end of input, or three bad values → cancelled; r on an app code is a bad value', async () => {
    assert.equal((await prompt('totp', '\n')).answer, undefined);
    assert.equal((await prompt('email', '')).answer, undefined);
    assert.equal((await prompt('totp', 'r\nabc\n1\n')).answer, undefined);
});

test('loginStep reads the envelope; normalizeCode; the prompt texts', () => {
    assert.deepEqual(loginStep({ success: true, status: 200, statusCode: 201, message: 'Verify', result: { challenge: 'c', method: 'email' } }), { kind: 'verify', challenge: 'c', method: 'email' });
    assert.deepEqual(loginStep({ success: true, status: 200, statusCode: 202, message: 'Enroll', result: { challenge: 'c', methods: ['totp', 'email'] } }), { kind: 'enroll' });
    assert.equal(loginStep({ success: true, status: 200, result: { access_token: 'a' } }).kind, 'pair');
    assert.equal(loginStep({ statusCode: 201, result: {} }).kind, 'pair', 'a Verify without a challenge is no code step');
    assert.equal(normalizeCode(' 482 915 '), '482915');
    assert.equal(normalizeCode('48291'), null);
    assert.equal(normalizeCode('4829155'), null);
    assert.equal(codePromptText('totp'), 'Enter the code from your authenticator app');
    assert.equal(codePromptText('email'), 'Enter the code we e-mailed to you');
});
