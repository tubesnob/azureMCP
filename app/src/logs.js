const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const rfs = require('rotating-file-stream');

const LOGS_DIR = process.env.BUNDLE_LOGS_DIR || '/logs';

function logsDirWritable() {
  try {
    fs.accessSync(LOGS_DIR, fs.constants.W_OK);
    return fs.statSync(LOGS_DIR).isDirectory();
  } catch {
    return false;
  }
}

class RingBuffer extends EventEmitter {
  constructor(maxLines = 10000) {
    super();
    this.setMaxListeners(0);
    this.max = maxLines;
    this.lines = [];
    this.seq = 0;
  }

  push(line, stream = 'stdout') {
    const entry = {
      seq: ++this.seq,
      ts: Date.now(),
      stream,
      line,
    };
    this.lines.push(entry);
    if (this.lines.length > this.max) {
      this.lines.splice(0, this.lines.length - this.max);
    }
    this.emit('line', entry);
    return entry;
  }

  tail(n = 500) {
    return this.lines.slice(-n);
  }

  clear() {
    this.lines = [];
    this.emit('clear');
  }
}

function createFileSink(name) {
  if (!logsDirWritable()) return null;
  const stream = rfs.createStream(`${name}.log`, {
    path: LOGS_DIR,
    size: '10M',
    maxFiles: 5,
    compress: false,
  });
  return stream;
}

function attachProcessStreams(child, buffer, fileSink) {
  const onChunk = (chunk, stream) => {
    const text = chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (i === parts.length - 1 && line === '') continue;
      buffer.push(line, stream);
      if (fileSink) fileSink.write(`[${new Date().toISOString()}] [${stream}] ${line}\n`);
    }
  };
  if (child.stdout) child.stdout.on('data', (c) => onChunk(c, 'stdout'));
  if (child.stderr) child.stderr.on('data', (c) => onChunk(c, 'stderr'));
}

module.exports = {
  LOGS_DIR,
  logsDirWritable,
  RingBuffer,
  createFileSink,
  attachProcessStreams,
};
