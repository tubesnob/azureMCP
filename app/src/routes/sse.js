function writeSse(reply, event, data) {
  if (event) reply.raw.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split('\n')) {
    reply.raw.write(`data: ${line}\n`);
  }
  reply.raw.write('\n');
}

function initStream(reply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function register(app, { supervisor, auth }) {
  app.get('/api/servers/:id/logs', (req, reply) => {
    const s = supervisor.get(req.params.id);
    if (!s) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const tailCount = Number(req.query.tail) || 500;
    initStream(reply);

    for (const entry of s.buffer.tail(tailCount)) {
      writeSse(reply, 'log', entry);
    }

    const onLine = (entry) => writeSse(reply, 'log', entry);
    const onClear = () => writeSse(reply, 'clear', {});
    const onState = () => writeSse(reply, 'state', s.snapshot());
    s.buffer.on('line', onLine);
    s.buffer.on('clear', onClear);
    s.on('state', onState);

    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(ping);
      s.buffer.off('line', onLine);
      s.buffer.off('clear', onClear);
      s.off('state', onState);
    });
  });

  app.get('/api/servers/stream', (req, reply) => {
    initStream(reply);

    const send = async () => {
      const rows = [];
      for (const s of supervisor.list()) {
        const snap = s.snapshot();
        snap.stats = await s.stats();
        rows.push(snap);
      }
      writeSse(reply, 'snapshot', { servers: rows });
    };

    send();
    const poll = setInterval(send, 2000);
    const handlers = new Map();
    for (const s of supervisor.list()) {
      const h = () => send();
      s.on('state', h);
      handlers.set(s, h);
    }

    req.raw.on('close', () => {
      clearInterval(poll);
      for (const [s, h] of handlers) s.off('state', h);
    });
  });

  app.get('/api/auth/stream', (req, reply) => {
    initStream(reply);
    writeSse(reply, 'state', auth.deviceLogin.snapshot());
    (async () => {
      writeSse(reply, 'status', await auth.status());
    })();

    const onUpdate = async (snap) => {
      writeSse(reply, 'state', snap);
      if (snap.finished && snap.success) {
        writeSse(reply, 'status', await auth.status());
      }
    };
    auth.deviceLogin.on('update', onUpdate);

    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(ping);
      auth.deviceLogin.off('update', onUpdate);
    });
  });
}

module.exports = { register };
