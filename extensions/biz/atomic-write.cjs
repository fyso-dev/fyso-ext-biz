const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {threadId} = require('node:worker_threads');

const cleaned = new Set();
const temporaryName = /^.+\.[1-9]\d*\.\d+\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
const DAY = 24 * 60 * 60 * 1000;

function cleanTemporaryFiles(dir) {
  if (cleaned.has(dir)) return;
  const cutoff = Date.now() - DAY;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isFile() || !temporaryName.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat?.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, {force: true});
  }
  cleaned.add(dir);
}

function writePrivate(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  cleanTemporaryFiles(dir);
  const temporary = `${file}.${process.pid}.${threadId}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
}

module.exports = {writePrivate};
