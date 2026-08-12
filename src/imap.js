// A deliberately small IMAP4rev1 server: exactly the commands KyPost Server's
// client (github.com/BrianLeishman/go-imap v0.1.28) issues, plus the handful a
// human debugging with openssl s_client will reach for.
//
// ponytail: no npm IMAP server package. The only published one is unmaintained
// since 2014; the subset below is ~500 lines of stdlib and is the whole reason
// this image has zero runtime dependencies. Swap it out if the demo ever needs
// real IMAP coverage (CONDSTORE, QRESYNC, partial fetch).

import { store, canonFolder, validFolderName, addMessage, addMessageDeduped } from './store.js';

const CAPABILITIES = 'IMAP4rev1 LITERAL+ UIDPLUS MOVE ESEARCH IDLE CHILDREN NAMESPACE';
const MAX_LITERAL = 32 * 1024 * 1024;
// A whole command, literals included. Bounding each literal is not enough: with
// LITERAL+ a client can chain "{1+}" lines forever, so the command never
// terminates and the accumulated parts grow without limit.
const MAX_COMMAND = MAX_LITERAL + 1024 * 1024;
const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];
const CRLF = Buffer.from('\r\n');

// Tags are echoed into responses verbatim, and a literal-encoded tag can carry
// a CRLF. Anything outside this set is refused rather than escaped.
const validTag = (t) => typeof t === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(t);
// Same reasoning for flags, which are stored and replayed in every later FETCH.
const validFlag = (f) => typeof f === 'string' && f.length > 0 && f.length <= 64 && !/[\s()"{%*\\\x00-\x1f\x7f]/.test(f.replace(/^\\/, ''));

// ---------------------------------------------------------------- wire input

// Reassembles a command that may be split across TCP reads and may carry
// {n} literals. Emits one Buffer per complete command, literal bytes inlined
// where they appeared, so the tokenizer below sees a single flat command.
class CommandReader {
  constructor(onCommand, sendContinuation, onError) {
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.size = 0;
    this.pending = 0;
    this.onCommand = onCommand;
    this.sendContinuation = sendContinuation;
    this.onError = onError;
  }

  push(part) {
    this.parts.push(part);
    this.size += part.length;
    return this.size <= MAX_COMMAND;
  }

  feed(chunk) {
    if (this.stopped) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.pending > 0) {
        if (this.buf.length < this.pending) return;
        if (!this.push(this.buf.subarray(0, this.pending))) return this.onError('command too large');
        this.buf = this.buf.subarray(this.pending);
        this.pending = 0;
        continue;
      }
      const idx = this.buf.indexOf('\r\n');
      if (idx === -1) {
        if (this.buf.length > MAX_LITERAL) this.onError('line too long');
        return;
      }
      const line = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + 2);
      if (!this.push(line) || !this.push(CRLF)) return this.onError('command too large');

      const m = /\{(\d+)(\+?)\}$/.exec(line.toString('latin1'));
      if (m) {
        const n = Number(m[1]);
        if (n > MAX_LITERAL) return this.onError('literal too large');
        if (this.size + n > MAX_COMMAND) return this.onError('command too large');
        this.pending = n;
        if (!m[2]) this.sendContinuation();
        continue;
      }
      const cmd = Buffer.concat(this.parts);
      this.parts = [];
      this.size = 0;
      this.onCommand(cmd);
      if (this.stopped) return;
    }
  }
}

const SPECIALS = new Set([0x20, 0x28, 0x29, 0x0d, 0x0a]);

// Tokenises a complete command buffer into atoms, strings and nested lists.
function tokenize(buf) {
  let i = 0;
  const read = (nested) => {
    const out = [];
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x20 || c === 0x0d || c === 0x0a) { i++; continue; }
      if (c === 0x29) { i++; if (nested) return out; continue; }
      if (c === 0x28) { i++; out.push({ type: 'list', value: read(true) }); continue; }
      if (c === 0x22) {
        i++;
        let s = '';
        while (i < buf.length && buf[i] !== 0x22) {
          if (buf[i] === 0x5c) i++;
          s += String.fromCharCode(buf[i++]);
        }
        i++;
        out.push({ type: 'string', value: s });
        continue;
      }
      if (c === 0x7b) {
        const close = buf.indexOf(0x7d, i);
        if (close === -1) { i = buf.length; break; }
        const n = Number(buf.toString('latin1', i + 1, close).replace('+', ''));
        i = close + 1;
        if (buf[i] === 0x0d) i++;
        if (buf[i] === 0x0a) i++;
        out.push({ type: 'string', value: buf.toString('binary', i, i + n) });
        i += n;
        continue;
      }
      const s = i;
      while (i < buf.length && !SPECIALS.has(buf[i])) i++;
      out.push({ type: 'atom', value: buf.toString('binary', s, i) });
    }
    return out;
  };
  return read(false);
}

const val = (t) => (t ? t.value : undefined);
const up = (t) => String(val(t) || '').toUpperCase();

// --------------------------------------------------------------- mail syntax

function splitHead(raw) {
  const end = raw.indexOf('\r\n\r\n');
  return end === -1 ? raw : raw.slice(0, end);
}

function parseHeaders(raw) {
  const h = new Map();
  for (const line of splitHead(raw).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const k = line.slice(0, c).toLowerCase();
    if (!h.has(k)) h.set(k, []);
    h.get(k).push(line.slice(c + 1).trim());
  }
  return h;
}

function header(msg, name) {
  if (!msg._h) msg._h = parseHeaders(msg.raw);
  const v = msg._h.get(name);
  return v ? v[0] : null;
}

// Splits an address header on commas that are not inside quotes or angles.
function splitAddresses(value) {
  const out = [];
  let cur = '';
  let q = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') q = !q;
    else if (!q && ch === '<') angle = true;
    else if (!q && ch === '>') angle = false;
    if (ch === ',' && !q && !angle) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseAddress(s) {
  const m = /^(.*?)<([^>]*)>\s*$/.exec(s);
  let name = null;
  let addr = s;
  if (m) {
    name = m[1].trim().replace(/^"(.*)"$/, '$1') || null;
    addr = m[2].trim();
  }
  const at = addr.lastIndexOf('@');
  return at === -1
    ? { name, mailbox: addr, host: null }
    : { name, mailbox: addr.slice(0, at), host: addr.slice(at + 1) };
}

// --------------------------------------------------------- response encoding

function quoted(s) {
  if (s === null || s === undefined) return 'NIL';
  return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ') + '"';
}

function literal(s) {
  const b = Buffer.from(s, 'binary');
  return '{' + b.length + '}\r\n' + b.toString('binary');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

// "12-Aug-2026 10:00:00 +0000" — go-imap parses this with a hard error, so the
// layout has to match its TimeFormat exactly.
function internalDate(d) {
  return `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

// "Tue, 12 Aug 2026 10:00:00 +0000" — the ENVELOPE date layout go-imap expects.
function envelopeDate(d) {
  return `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

// Inverse of internalDate(), for the optional date argument of APPEND.
function parseInternalDate(s) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  if (month === -1) return null;
  const offset = m[7] ? (m[7] === '-' ? 1 : -1) * (Number(m[8]) * 60 + Number(m[9])) : 0;
  return new Date(Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) + offset * 60000);
}

function addressList(msg, name) {
  const v = header(msg, name);
  if (!v) return 'NIL';
  const parts = splitAddresses(v).map((s) => {
    const a = parseAddress(s);
    return `(${quoted(a.name)} NIL ${quoted(a.mailbox)} ${quoted(a.host)})`;
  });
  return parts.length ? `(${parts.join(' ')})` : 'NIL';
}

function envelope(msg) {
  const raw = header(msg, 'date');
  const parsed = raw ? new Date(raw) : null;
  const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed : msg.date;
  const from = addressList(msg, 'from');
  return [
    quoted(envelopeDate(when)),
    quoted(header(msg, 'subject') ?? ''),
    from,
    header(msg, 'sender') ? addressList(msg, 'sender') : from,
    header(msg, 'reply-to') ? addressList(msg, 'reply-to') : from,
    addressList(msg, 'to'),
    addressList(msg, 'cc'),
    addressList(msg, 'bcc'),
    quoted(header(msg, 'in-reply-to')),
    quoted(header(msg, 'message-id')),
  ].join(' ');
}

// RFC 3501: a header section, whole or filtered, ends with the blank line that
// terminates it. Without it a client parsing the literal with a MIME header
// reader hits EOF early and loses the last field.
function headerFields(msg, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const out = [];
  for (const line of splitHead(msg.raw).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const c = line.indexOf(':');
    if (c > 0 && wanted.includes(line.slice(0, c).toLowerCase())) out.push(line);
  }
  return out.length ? out.join('\r\n') + '\r\n\r\n' : '\r\n';
}

const bodyText = (raw) => raw.slice(splitHead(raw).length + 4);

// ------------------------------------------------------------ sequence sets

function inSet(set, num, max) {
  for (const part of String(set).split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    if (num >= Math.min(lo, hi) && num <= Math.max(lo, hi)) return true;
  }
  return false;
}

// --------------------------------------------------------------- SEARCH keys

// Builds a predicate from RFC 3501 search keys. Only the keys go-imap's
// SearchBuilder can emit are implemented; anything else matches nothing rather
// than silently matching everything.
function parseSearchKeys(tokens, ctx) {
  let i = 0;
  const preds = [];
  const nextStr = () => String(val(tokens[++i]) ?? '');
  const nextNum = () => Number(val(tokens[++i]));
  const hasFlag = (f) => (m) => m.flags.has(f);
  const noFlag = (f) => (m) => !m.flags.has(f);
  const contains = (get, s) => (m) => String(get(m) ?? '').toLowerCase().includes(s.toLowerCase());
  const body = (m) => m.raw.slice(splitHead(m.raw).length);

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'list') {
      preds.push(parseSearchKeys(t.value, ctx));
      i++;
      continue;
    }
    const key = String(t.value).toUpperCase();
    switch (key) {
      case 'ALL': break;
      case 'CHARSET': i++; break;
      case 'SEEN': preds.push(hasFlag('\\Seen')); break;
      case 'UNSEEN': preds.push(noFlag('\\Seen')); break;
      case 'DELETED': preds.push(hasFlag('\\Deleted')); break;
      case 'UNDELETED': preds.push(noFlag('\\Deleted')); break;
      case 'FLAGGED': preds.push(hasFlag('\\Flagged')); break;
      case 'UNFLAGGED': preds.push(noFlag('\\Flagged')); break;
      case 'ANSWERED': preds.push(hasFlag('\\Answered')); break;
      case 'UNANSWERED': preds.push(noFlag('\\Answered')); break;
      case 'DRAFT': preds.push(hasFlag('\\Draft')); break;
      case 'UNDRAFT': preds.push(noFlag('\\Draft')); break;
      case 'NEW': case 'RECENT': preds.push(noFlag('\\Seen')); break;
      case 'OLD': preds.push(() => true); break;
      case 'KEYWORD': { const f = nextStr(); preds.push(hasFlag(f)); break; }
      case 'UNKEYWORD': { const f = nextStr(); preds.push(noFlag(f)); break; }
      case 'LARGER': { const n = nextNum(); preds.push((m) => m.raw.length > n); break; }
      case 'SMALLER': { const n = nextNum(); preds.push((m) => m.raw.length < n); break; }
      case 'FROM': { const s = nextStr(); preds.push(contains((m) => header(m, 'from'), s)); break; }
      case 'TO': { const s = nextStr(); preds.push(contains((m) => header(m, 'to'), s)); break; }
      case 'CC': { const s = nextStr(); preds.push(contains((m) => header(m, 'cc'), s)); break; }
      case 'BCC': { const s = nextStr(); preds.push(contains((m) => header(m, 'bcc'), s)); break; }
      case 'SUBJECT': { const s = nextStr(); preds.push(contains((m) => header(m, 'subject'), s)); break; }
      case 'BODY': { const s = nextStr(); preds.push(contains(body, s)); break; }
      case 'TEXT': { const s = nextStr(); preds.push(contains((m) => m.raw, s)); break; }
      case 'HEADER': { const f = nextStr(); const s = nextStr(); preds.push(contains((m) => header(m, f.toLowerCase()), s)); break; }
      case 'SINCE': case 'SENTSINCE': { const d = Date.parse(nextStr()); preds.push((m) => m.date.getTime() >= d); break; }
      case 'BEFORE': case 'SENTBEFORE': { const d = Date.parse(nextStr()); preds.push((m) => m.date.getTime() < d); break; }
      case 'ON': case 'SENTON': {
        const d = new Date(Date.parse(nextStr()));
        preds.push((m) => m.date.toDateString() === d.toDateString());
        break;
      }
      case 'UID': { const set = nextStr(); preds.push((m) => inSet(set, m.uid, ctx.maxUid)); break; }
      case 'NOT': {
        const rest = parseSearchKeys(tokens.slice(i + 1, i + 2), ctx);
        preds.push((m, s) => !rest(m, s));
        i++;
        break;
      }
      case 'OR': {
        const a = parseSearchKeys(tokens.slice(i + 1, i + 2), ctx);
        const b = parseSearchKeys(tokens.slice(i + 2, i + 3), ctx);
        preds.push((m, s) => a(m, s) || b(m, s));
        i += 2;
        break;
      }
      default:
        // A bare sequence set (e.g. "1:*") is the only remaining legal key.
        if (/^[\d,:*]+$/.test(key)) {
          const set = key;
          preds.push((m, seq) => inSet(set, seq, ctx.count));
        } else {
          preds.push(() => false);
        }
    }
    i++;
  }
  return (m, seq) => preds.every((p) => p(m, seq));
}

// ------------------------------------------------------------- FETCH items

// Splits "(UID FLAGS BODY.PEEK[HEADER.FIELDS (A B)])" into its top-level items.
function splitFetchItems(spec) {
  let s = spec.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.flatMap((item) => {
    const u = item.toUpperCase();
    if (u === 'ALL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
    if (u === 'FAST') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
    // ponytail: FULL is ALL without the BODYSTRUCTURE half. No client here asks
    // for it; implement BODYSTRUCTURE the day one does.
    if (u === 'FULL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
    return [item];
  });
}

// Everything on the command's first line after the first `skip` space-separated
// words. Counting words is exact where searching for the message set is not:
// a 20-character go-imap tag can itself end in the digits of that set.
function wordsAfter(cmd, skip) {
  const line = (cmd || Buffer.alloc(0)).toString('latin1').split('\r\n')[0];
  let idx = 0;
  for (let n = 0; n < skip; n++) {
    idx = line.indexOf(' ', idx);
    if (idx === -1) return '';
    idx++;
  }
  return line.slice(idx).trim();
}

function fetchItem(msg, item) {
  const u = item.toUpperCase();
  if (u === 'UID') return `UID ${msg.uid}`;
  if (u === 'FLAGS') return `FLAGS (${[...msg.flags].join(' ')})`;
  if (u === 'INTERNALDATE') return `INTERNALDATE "${internalDate(msg.date)}"`;
  if (u === 'RFC822.SIZE') return `RFC822.SIZE ${msg.raw.length}`;
  if (u === 'ENVELOPE') return `ENVELOPE (${envelope(msg)})`;
  if (u === 'RFC822') return `RFC822 ${literal(msg.raw)}`;
  if (u === 'RFC822.TEXT') return `RFC822.TEXT ${literal(bodyText(msg.raw))}`;
  if (u === 'RFC822.HEADER') return `RFC822.HEADER ${literal(splitHead(msg.raw) + '\r\n\r\n')}`;

  const m = /^BODY(?:\.PEEK)?\[(.*)\]$/is.exec(item);
  if (m) {
    const section = m[1];
    const name = `BODY[${section}]`;
    if (section === '') return `${name} ${literal(msg.raw)}`;
    const hf = /^HEADER\.FIELDS(?:\.NOT)?\s*\((.*)\)$/is.exec(section);
    if (hf) return `${name} ${literal(headerFields(msg, hf[1].split(/\s+/).filter(Boolean)))}`;
    if (/^HEADER$/i.test(section)) return `${name} ${literal(splitHead(msg.raw) + '\r\n\r\n')}`;
    if (/^TEXT$/i.test(section)) return `${name} ${literal(bodyText(msg.raw))}`;
    return `${name} ${literal(msg.raw)}`;
  }
  return null;
}

// ------------------------------------------------------------------ session

export function createImapSession(socket, { log, allowLogin }) {
  const send = (s) => { if (!socket.destroyed) socket.write(s + '\r\n'); };
  let persona = null;
  let boxName = null;
  let box = null;
  let readOnly = false;
  let idleTag = null;

  const reader = new CommandReader(
    (cmd) => { try { handle(cmd); } catch (e) { log('command error', e.message); send('* BAD internal error'); } },
    () => send('+ Ready for literal data'),
    (why) => { send('* BYE ' + why); socket.destroy(); }
  );

  send(`* OK [CAPABILITY ${CAPABILITIES}] KyPost Demo Mail Server ready`);
  socket.on('data', (c) => reader.feed(c));

  function folder(name) {
    return persona.folders.get(canonFolder(name));
  }

  function seqOf(msg) {
    return box.messages.indexOf(msg) + 1;
  }

  function untaggedFetch(msg, items) {
    const parts = items.map((it) => fetchItem(msg, it)).filter(Boolean);
    if (!parts.some((p) => p.startsWith('UID '))) parts.unshift(`UID ${msg.uid}`);
    send(`* ${seqOf(msg)} FETCH (${parts.join(' ')})`);
  }

  function selectBox(tag, name, ro) {
    if (!validFolderName(name)) return send(`${tag} NO invalid mailbox name`);
    const target = folder(name);
    if (!target) return send(`${tag} NO [TRYCREATE] mailbox does not exist`);
    box = target;
    boxName = target.name;
    readOnly = ro;
    send(`* FLAGS (${SYSTEM_FLAGS.join(' ')})`);
    send(`* OK [PERMANENTFLAGS (${SYSTEM_FLAGS.join(' ')} \\*)] Limited`);
    send(`* ${box.messages.length} EXISTS`);
    send('* 0 RECENT');
    send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
    send(`* OK [UIDNEXT ${box.uidNext}] Predicted next UID`);
    send(`${tag} OK [${ro ? 'READ-ONLY' : 'READ-WRITE'}] ${ro ? 'EXAMINE' : 'SELECT'} completed`);
  }

  function expunge(silent) {
    const doomed = box.messages.filter((m) => m.flags.has('\\Deleted'));
    for (const m of doomed.reverse()) {
      const seq = seqOf(m);
      box.messages.splice(seq - 1, 1);
      if (!silent) send(`* ${seq} EXPUNGE`);
    }
    return doomed.length;
  }

  function handle(cmd) {
    if (idleTag !== null) {
      if (/^DONE/i.test(cmd.toString('latin1'))) {
        send(`${idleTag} OK IDLE terminated`);
        idleTag = null;
      }
      return;
    }

    const tokens = tokenize(cmd);
    const tag = val(tokens[0]);
    const name = up(tokens[1]);
    // A tag is echoed into every response for this command, and the tokenizer
    // accepts a literal-encoded one, which can carry a CRLF and forge untagged
    // responses. Refuse it instead of escaping it.
    if (!validTag(tag) || !name) return send('* BAD invalid command');
    const args = tokens.slice(2);

    // A reset rebuilds every mailbox while this session holds a reference to
    // one. Re-resolving by name each command is what makes /admin/reset visible
    // to the connection KyPost Server keeps open.
    if (boxName) {
      box = persona ? persona.folders.get(boxName) || null : null;
      if (!box) boxName = null;
    }

    if (name === 'CAPABILITY') {
      send(`* CAPABILITY ${CAPABILITIES}`);
      return send(`${tag} OK CAPABILITY completed`);
    }
    if (name === 'NOOP' || name === 'CHECK') return send(`${tag} OK ${name} completed`);
    if (name === 'LOGOUT') {
      send('* BYE KyPost Demo signing off');
      send(`${tag} OK LOGOUT completed`);
      reader.stopped = true;
      return socket.end();
    }
    if (name === 'LOGIN') {
      const user = val(args[0]);
      const pass = val(args[1]);
      if (!allowLogin(user, pass)) return send(`${tag} NO LOGIN rejected`);
      persona = store.forUser(user);
      log('login', user, '->', persona.key);
      return send(`${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed`);
    }
    if (!persona) return send(`${tag} NO Not authenticated`);

    switch (name) {
      case 'LIST':
      case 'LSUB': {
        for (const f of persona.folders.keys()) {
          const attrs = f === 'Sent Items' ? '\\HasNoChildren \\Sent'
            : f === 'Trash' ? '\\HasNoChildren \\Trash'
            : f === 'Drafts' ? '\\HasNoChildren \\Drafts'
            : f === 'Archive' ? '\\HasNoChildren \\Archive'
            : '\\HasNoChildren';
          send(`* ${name} (${attrs}) "/" ${quoted(f)}`);
        }
        return send(`${tag} OK ${name} completed`);
      }
      case 'NAMESPACE':
        send('* NAMESPACE (("" "/")) NIL NIL');
        return send(`${tag} OK NAMESPACE completed`);
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE':
        return send(`${tag} OK ${name} completed`);
      case 'STATUS': {
        const target = folder(val(args[0]));
        if (!target) return send(`${tag} NO mailbox does not exist`);
        const wanted = (args[1] && args[1].value) || [];
        const values = wanted.map((w) => {
          const k = up(w);
          if (k === 'MESSAGES') return `MESSAGES ${target.messages.length}`;
          if (k === 'UNSEEN') return `UNSEEN ${target.messages.filter((m) => !m.flags.has('\\Seen')).length}`;
          if (k === 'UIDNEXT') return `UIDNEXT ${target.uidNext}`;
          if (k === 'UIDVALIDITY') return `UIDVALIDITY ${target.uidValidity}`;
          if (k === 'RECENT') return 'RECENT 0';
          return null;
        }).filter(Boolean);
        send(`* STATUS ${quoted(target.name)} (${values.join(' ')})`);
        return send(`${tag} OK STATUS completed`);
      }
      case 'SELECT': return selectBox(tag, val(args[0]), false);
      case 'EXAMINE': return selectBox(tag, val(args[0]), true);
      case 'CREATE': {
        const n = canonFolder(val(args[0]));
        if (!validFolderName(n)) return send(`${tag} NO invalid mailbox name`);
        if (!persona.folders.has(n)) {
          persona.folders.set(n, { name: n, uidValidity: 1, uidNext: 1, messages: [] });
        }
        return send(`${tag} OK CREATE completed`);
      }
      case 'DELETE': {
        const n = canonFolder(val(args[0]));
        if (n === 'INBOX' || !persona.folders.has(n)) return send(`${tag} NO cannot delete mailbox`);
        persona.folders.delete(n);
        if (boxName === n) { box = null; boxName = null; }
        return send(`${tag} OK DELETE completed`);
      }
      case 'RENAME': {
        const from = canonFolder(val(args[0]));
        const to = canonFolder(val(args[1]));
        if (!validFolderName(to) || !persona.folders.has(from) || from === 'INBOX') {
          return send(`${tag} NO cannot rename mailbox`);
        }
        const moved = persona.folders.get(from);
        moved.name = to;
        persona.folders.delete(from);
        persona.folders.set(to, moved);
        return send(`${tag} OK RENAME completed`);
      }
      case 'APPEND': {
        const target = canonFolder(val(args[0]));
        if (!validFolderName(target)) return send(`${tag} NO invalid mailbox name`);
        if (!persona.folders.has(target)) {
          persona.folders.set(target, { name: target, uidValidity: 1, uidNext: 1, messages: [] });
        }
        const rest = args.slice(1);
        const flags = rest.find((t) => t.type === 'list');
        const dateTok = rest.find((t) => t.type === 'string' && /^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(t.value));
        const raw = rest[rest.length - 1];
        if (!raw || raw.type !== 'string') return send(`${tag} BAD APPEND expects a literal message`);
        const msg = addMessageDeduped(
          persona,
          target,
          raw.value,
          flags ? flags.value.map((f) => String(f.value)).filter(validFlag) : [],
          parseInternalDate(dateTok && dateTok.value) || new Date()
        );
        const t = persona.folders.get(target);
        return send(`${tag} OK [APPENDUID ${t.uidValidity} ${msg.uid}] APPEND completed`);
      }
      case 'IDLE':
        idleTag = tag;
        return send('+ idling');
      case 'CLOSE':
        if (box && !readOnly) expunge(true);
        box = null;
        boxName = null;
        return send(`${tag} OK CLOSE completed`);
      case 'EXPUNGE':
        if (!box) return send(`${tag} NO No mailbox selected`);
        if (readOnly) return send(`${tag} NO Mailbox is read-only`);
        expunge(false);
        return send(`${tag} OK EXPUNGE completed`);
      case 'SEARCH': return doSearch(tag, args, false);
      case 'FETCH': return doFetch(tag, args, false, cmd, 3);
      case 'STORE': return doStore(tag, args, false);
      case 'COPY': return doCopyMove(tag, args, false, false);
      case 'MOVE': return doCopyMove(tag, args, false, true);
      case 'UID': {
        const sub = up(args[0]);
        const rest = args.slice(1);
        if (sub === 'SEARCH') return doSearch(tag, rest, true);
        if (sub === 'FETCH') return doFetch(tag, rest, true, cmd, 4);
        if (sub === 'STORE') return doStore(tag, rest, true);
        if (sub === 'COPY') return doCopyMove(tag, rest, true, false);
        if (sub === 'MOVE') return doCopyMove(tag, rest, true, true);
        return send(`${tag} BAD unsupported UID command`);
      }
      default:
        return send(`${tag} BAD unsupported command ${name}`);
    }
  }

  function requireBox(tag) {
    if (!box) { send(`${tag} NO No mailbox selected`); return false; }
    return true;
  }

  function doSearch(tag, args, byUid) {
    if (!requireBox(tag)) return;
    let rest = args;
    let wantMax = false;
    if (up(rest[0]) === 'RETURN') {
      wantMax = (rest[1]?.value || []).some((t) => up(t) === 'MAX');
      rest = rest.slice(2);
    }
    const maxUid = box.messages.length ? box.messages[box.messages.length - 1].uid : 0;
    const pred = parseSearchKeys(rest, { maxUid, count: box.messages.length });
    const hits = box.messages.filter((m, i) => pred(m, i + 1));

    if (wantMax) {
      const max = hits.length ? Math.max(...hits.map((m) => m.uid)) : 0;
      send(`* ESEARCH (TAG "${tag}") UID` + (max ? ` MAX ${max}` : ''));
      return send(`${tag} OK SEARCH completed`);
    }
    const ids = hits.map((m, i) => (byUid ? m.uid : box.messages.indexOf(m) + 1));
    send(`* SEARCH${ids.length ? ' ' + ids.join(' ') : ''}`);
    send(`${tag} OK SEARCH completed`);
  }

  function doFetch(tag, args, byUid, cmd, skip) {
    if (!requireBox(tag)) return;
    const set = String(val(args[0]) ?? '');
    // The item spec is read from the raw command text: "BODY.PEEK[HEADER.FIELDS
    // (A B)]" is one FETCH item but several tokens, and re-joining tokens would
    // lose the bracket structure the section name needs.
    const items = splitFetchItems(wordsAfter(cmd, skip));
    const max = byUid
      ? (box.messages.length ? box.messages[box.messages.length - 1].uid : 0)
      : box.messages.length;
    for (const [i, msg] of box.messages.entries()) {
      if (!inSet(set, byUid ? msg.uid : i + 1, max)) continue;
      untaggedFetch(msg, items);
      if (!readOnly && items.some((it) => /^BODY\[/i.test(it) || /^RFC822$/i.test(it))) msg.flags.add('\\Seen');
    }
    send(`${tag} OK FETCH completed`);
  }

  function doStore(tag, args, byUid) {
    if (!requireBox(tag)) return;
    if (readOnly) return send(`${tag} NO Mailbox is read-only`);
    const set = String(val(args[0]) ?? '');
    const max = byUid
      ? (box.messages.length ? box.messages[box.messages.length - 1].uid : 0)
      : box.messages.length;
    const targets = box.messages.filter((m, i) => inSet(set, byUid ? m.uid : i + 1, max));

    // go-imap can put +FLAGS and -FLAGS in the same command, so every
    // item/value pair after the set is applied in order.
    const ops = [];
    for (let i = 1; i < args.length - 1; i += 2) {
      const op = up(args[i]).replace('.SILENT', '');
      const list = args[i + 1];
      if (!list || list.type !== 'list') continue;
      const names = list.value.map((t) => String(t.value));
      if (!names.every(validFlag)) return send(`${tag} BAD invalid flag name`);
      ops.push([op, names]);
    }
    if (!ops.length) return send(`${tag} BAD STORE expects a flag list`);

    const silent = args.some((t) => up(t).endsWith('.SILENT'));
    for (const msg of targets) {
      for (const [op, flags] of ops) {
        if (op === 'FLAGS') msg.flags = new Set(flags);
        else if (op === '+FLAGS') flags.forEach((f) => msg.flags.add(f));
        else if (op === '-FLAGS') flags.forEach((f) => msg.flags.delete(f));
      }
      if (!silent) untaggedFetch(msg, ['FLAGS']);
    }
    send(`${tag} OK STORE completed`);
  }

  function doCopyMove(tag, args, byUid, isMove) {
    if (!requireBox(tag)) return;
    if (isMove && readOnly) return send(`${tag} NO Mailbox is read-only`);
    const set = String(val(args[0]) ?? '');
    const destName = canonFolder(val(args[1]));
    if (!validFolderName(destName)) return send(`${tag} NO invalid mailbox name`);
    const dest = persona.folders.get(destName);
    if (!dest) return send(`${tag} NO [TRYCREATE] mailbox does not exist`);
    const max = byUid
      ? (box.messages.length ? box.messages[box.messages.length - 1].uid : 0)
      : box.messages.length;
    const targets = box.messages.filter((m, i) => inSet(set, byUid ? m.uid : i + 1, max));
    if (!targets.length) return send(`${tag} OK ${isMove ? 'MOVE' : 'COPY'} completed`);

    const src = [];
    const created = [];
    for (const msg of targets) {
      const copy = addMessage(persona, destName, msg.raw, [...msg.flags], msg.date);
      src.push(msg.uid);
      created.push(copy.uid);
    }
    send(`* OK [COPYUID ${dest.uidValidity} ${src.join(',')} ${created.join(',')}] Copied`);
    if (isMove) {
      for (const msg of targets.slice().reverse()) {
        const seq = seqOf(msg);
        box.messages.splice(seq - 1, 1);
        send(`* ${seq} EXPUNGE`);
      }
    }
    send(`${tag} OK ${isMove ? 'MOVE' : 'COPY'} completed`);
  }
}
