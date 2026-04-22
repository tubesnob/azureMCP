/* Minimal SSE wiring for the log panes and the auth stream.
 * Looks for any [data-sse] element on page load and opens an EventSource. */

(function () {
  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      return d.toTimeString().slice(0, 8);
    } catch {
      return '';
    }
  }

  function appendLogLine(container, entry) {
    const wrap = document.createElement('div');
    wrap.className = 'line ' + (entry.stream || 'stdout');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(entry.ts);
    const text = document.createElement('span');
    text.textContent = entry.line;
    wrap.appendChild(ts);
    wrap.appendChild(text);
    container.appendChild(wrap);
    while (container.childElementCount > 4000) {
      container.removeChild(container.firstElementChild);
    }
    container.scrollTop = container.scrollHeight;
  }

  function appendMeta(container, text) {
    const wrap = document.createElement('div');
    wrap.className = 'line meta';
    wrap.textContent = text;
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  }

  function connectLogStream(el) {
    const url = el.dataset.sse;
    if (!url) return;
    const es = new EventSource(url);
    es.addEventListener('log', (ev) => {
      try {
        appendLogLine(el, JSON.parse(ev.data));
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('state', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        appendMeta(el, `-- state: ${s.state}${s.pid ? ' pid=' + s.pid : ''}`);
      } catch {
        // ignore
      }
    });
    es.addEventListener('clear', () => {
      el.innerHTML = '';
    });
    es.addEventListener('status', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        appendMeta(el, s.signedIn ? `-- signed in as ${s.user} (tenant ${s.tenantId})` : '-- not signed in');
      } catch {
        // ignore
      }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; surface once.
      appendMeta(el, '-- stream interrupted, reconnecting…');
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-sse]').forEach(connectLogStream);
  });
})();
