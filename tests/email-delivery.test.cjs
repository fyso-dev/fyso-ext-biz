const {test} = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');

let exec;
const load = test.mock.method(childProcess, 'execFile', (...args) => exec(...args));
const {deliverEmail} = require('../extensions/biz/email-delivery.cjs');
load.mock.restore();

const mail = {
  port: '7080', bot: 'biz-bot', thread: 'mail_thread', mailbox: 'box', deliveryId: 'delivery-1',
  from: 'sender@example.test', subject: 'Question', body: 'An external message',
};

function fakeExec(t, respond) {
  exec = t.mock.fn((command, args, options, callback) => {
    const stdin = new EventEmitter();
    stdin.end = message => {
      stdin.emit('error', Error('pipe closed'));
      respond({command, args, options, message, callback, sendId: args[9]});
    };
    return {stdin};
  });
}

test('delivers untrusted mail on stdin and uses a stable, mailbox-scoped send ID', async t => {
  const messages = [];
  fakeExec(t, call => {
    messages.push(call);
    call.callback(null, JSON.stringify({
      ok: true, botId: mail.bot, threadId: mail.thread, sendId: call.sendId, messageId: 'receipt',
    }));
  });
  const attachments = [{name: 'quote.txt', path: 'stored/1'}];
  const sendId = 'mail_' + createHash('sha256').update('["box","delivery-1"]').digest('hex');
  const first = await deliverEmail({...mail, attachments});
  assert.deepEqual(first, {sendId, messageId: 'receipt', threadId: mail.thread});
  assert.deepEqual(await deliverEmail({...mail, subject: 'Retried'}), first);
  assert.notEqual((await deliverEmail({...mail, mailbox: 'box-2'})).sendId, sendId);
  assert.equal(messages[0].command, 'openmausbot');
  assert.deepEqual(messages[0].args, [
    'run', '--bot', mail.bot, '-', '--task', mail.thread, '--port', mail.port,
    '--send-id', sendId, '--wait', 'none', '--json', '--quiet',
  ]);
  assert.deepEqual(messages[0].options, {timeout: 30000, maxBuffer: 65536});
  const [warning, payload] = messages[0].message.split('\n');
  assert.match(warning, /untrusted correspondence/);
  assert.deepEqual(JSON.parse(payload), {from: mail.from, subject: mail.subject, body: mail.body, attachments});
  assert.deepEqual(JSON.parse(messages[1].message.split('\n')[1]).attachments, []);
});

test('rejects invalid destinations, ports and content before launching a process', async () => {
  exec = () => assert.fail('invalid mail must not spawn a process');
  for (const patch of [{bot: 42}, {thread: '../thread'}, {mailbox: ''}, {deliveryId: 'a'.repeat(201)}]) {
    await assert.rejects(deliverEmail({...mail, ...patch}), {message: 'invalid_mail_destination'});
  }
  for (const port of ['text', '0', '65536']) {
    await assert.rejects(deliverEmail({...mail, port}), {message: 'invalid_project_port'});
  }
  for (const field of ['from', 'subject', 'body']) {
    await assert.rejects(deliverEmail({...mail, [field]: null}), {message: 'invalid_mail_content'});
  }
});

test('rejects command failures, invalid JSON and receipts that do not confirm the delivery', async t => {
  for (const receipt of [
    Error('exec failed'), '{', 'null', {ok: false}, {botId: 'other'}, {threadId: 'other'},
    {sendId: 'other'}, {messageId: 42}, {messageId: ''},
  ]) {
    fakeExec(t, ({callback, sendId}) => {
      if (receipt instanceof Error) return callback(receipt);
      if (typeof receipt === 'string') return callback(null, receipt);
      callback(null, JSON.stringify({
        ok: true, botId: mail.bot, threadId: mail.thread, sendId, messageId: 'receipt', ...receipt,
      }));
    });
    await assert.rejects(deliverEmail(mail), {message: 'email_delivery_unconfirmed'});
  }
});
