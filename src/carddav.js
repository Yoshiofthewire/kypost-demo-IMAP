// CardDAV address books plus the gated reset endpoint, over the same HTTPS
// listener. Read/write, in memory, one book per persona at /carddav/{persona}/.
//
// ponytail: XML in, XML out, by regex and template string. Node has no XML
// parser in stdlib and the request bodies here are a fixed handful of shapes
// from one known client. Reach for a real parser the day a second client shows
// up with namespace prefixes we do not expect.

import { store, PERSONAS, newUid } from './store.js';

const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/"';
const MAX_BODY = 1024 * 1024;

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Local names of every element inside the request's <prop> block.
function requestedProps(body) {
  const block = /<[^>]*:?prop\s*[^>]*>([\s\S]*?)<\/[^>]*:?prop>/i.exec(body);
  if (!block) return [];
  return [...block[1].matchAll(/<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)/g)].map((m) => m[1].toLowerCase());
}

function hrefsIn(body) {
  return [...body.matchAll(/<(?:[A-Za-z0-9_-]+:)?href\s*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/gi)]
    .map((m) => m[1].trim());
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>\n${responses.join('\n')}\n</D:multistatus>\n`;
}

function responseFor(href, found, notFound) {
  const parts = [`<D:response><D:href>${esc(href)}</D:href>`];
  if (found.length) parts.push(`<D:propstat><D:prop>${found.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
  if (notFound.length) {
    parts.push(`<D:propstat><D:prop>${notFound.map((p) => `<D:${esc(p)}/>`).join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`);
  }
  parts.push('</D:response>');
  return parts.join('');
}

// A resource is either a persona's address book or one vCard inside it.
function propsForBook(persona, wanted) {
  const home = `/carddav/${persona.key}/`;
  const table = {
    resourcetype: '<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>',
    displayname: `<D:displayname>${esc(persona.displayName)} Contacts</D:displayname>`,
    'current-user-principal': `<D:current-user-principal><D:href>${home}</D:href></D:current-user-principal>`,
    'principal-url': `<D:principal-URL><D:href>${home}</D:href></D:principal-URL>`,
    'addressbook-home-set': `<C:addressbook-home-set><D:href>${home}</D:href></C:addressbook-home-set>`,
    'addressbook-description': `<C:addressbook-description>KyPost demo contacts for ${esc(persona.address)}</C:addressbook-description>`,
    'supported-address-data': '<C:supported-address-data><C:address-data-type content-type="text/vcard" version="3.0"/><C:address-data-type content-type="text/vcard" version="4.0"/></C:supported-address-data>',
    'max-resource-size': '<C:max-resource-size>102400</C:max-resource-size>',
    getctag: `<CS:getctag>${persona.ctag}</CS:getctag>`,
    'sync-token': `<D:sync-token>urn:kypost-demo:${persona.key}:${persona.ctag}</D:sync-token>`,
    'supported-report-set': '<D:supported-report-set><D:supported-report><D:report><C:addressbook-multiget/></D:report></D:supported-report><D:supported-report><D:report><C:addressbook-query/></D:report></D:supported-report></D:supported-report-set>',
    'current-user-privilege-set': '<D:current-user-privilege-set><D:privilege><D:all/></D:privilege><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>',
  };
  return pick(table, wanted);
}

function propsForCard(persona, card, wanted, includeData) {
  const table = {
    resourcetype: '<D:resourcetype/>',
    getetag: `<D:getetag>${esc(card.etag)}</D:getetag>`,
    getcontenttype: '<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>',
    getcontentlength: `<D:getcontentlength>${Buffer.byteLength(card.vcard)}</D:getcontentlength>`,
    displayname: `<D:displayname>${esc(card.uid)}</D:displayname>`,
    'address-data': `<C:address-data>${esc(card.vcard)}</C:address-data>`,
  };
  if (includeData && !wanted.includes('address-data')) wanted = [...wanted, 'address-data'];
  return pick(table, wanted);
}

function pick(table, wanted) {
  const found = [];
  const notFound = [];
  for (const p of wanted) {
    if (p === 'prop' || p === 'propfind') continue;
    const v = table[p];
    if (v) found.push(v);
    else notFound.push(p);
  }
  return { found, notFound };
}

const cardHref = (persona, uid) => `/carddav/${persona.key}/${encodeURIComponent(uid)}.vcf`;

// Pulls UID out of a vCard body so PUTs land on a stable key even when the
// client's filename and the card's UID disagree.
function uidFromVcard(body, fallback) {
  const m = /^UID:(.+)$/im.exec(body);
  return (m ? m[1].trim() : '') || fallback;
}

export function createDavHandler({ log, resetEnabled, resetToken }) {
  return function handle(req, res) {
    const reply = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(body ?? '');
    };
    const xml = (code, body, headers = {}) =>
      reply(code, body, { 'content-type': 'application/xml; charset=utf-8', ...headers });

    // An HTTP request listener that throws takes the whole process with it via
    // uncaughtException, and this one shares a process with IMAP and SMTP.
    // `GET /%` alone used to be enough: decodeURIComponent throws URIError on a
    // malformed escape, and restarting wipes every mailbox.
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'https://kypost-demo-mail').pathname);
    } catch {
      return reply(400, 'malformed request path');
    }

    if (path === '/healthz') return reply(200, 'ok');

    if (path === '/admin/reset') {
      if (req.method !== 'POST') return reply(405, 'reset requires POST');
      if (!resetEnabled) return reply(403, 'reset mode is disabled (RESET_ENABLED=false)');
      const auth = req.headers.authorization || '';
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!resetToken || supplied !== resetToken) return reply(401, 'invalid reset token');
      const n = store.reset();
      log('reset performed', { generation: n });
      return reply(200, JSON.stringify({ ok: true, reset: true, generation: n, personas: PERSONAS }) + '\n', {
        'content-type': 'application/json',
      });
    }

    if (req.method === 'OPTIONS') {
      return reply(200, '', {
        dav: '1, 2, 3, addressbook',
        allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT',
      });
    }

    // Discovery: both well-known paths and the bare root point at /carddav/.
    if (path === '/.well-known/carddav' || path === '/' || path === '/carddav' || path === '/carddav/') {
      if (req.method === 'PROPFIND') {
        const first = store.get(PERSONAS[0]);
        const { found, notFound } = propsForBook(first, ['current-user-principal', 'principal-url', 'addressbook-home-set']);
        return xml(207, multistatus([responseFor('/carddav/', found, notFound)]));
      }
      return reply(301, '', { location: `/carddav/${PERSONAS[0]}/` });
    }

    const m = /^\/carddav\/([^/]+)\/(.*)$/.exec(path);
    if (!m) return reply(404, 'not found');
    const persona = store.get(m[1].toLowerCase());
    if (!persona) return reply(404, 'unknown persona');
    const resource = m[2];

    readBody(req, (err, body) => {
      if (err) return reply(413, err.message);
      try {
        route(persona, resource, body);
      } catch (e) {
        log('carddav error', e.message);
        reply(500, 'internal error');
      }
    });

    function route(persona, resource, body) {
      // --- collection ---
      if (resource === '') {
        if (req.method === 'PROPFIND') {
          const wanted = requestedProps(body);
          const props = wanted.length ? wanted : ['resourcetype', 'displayname', 'getctag'];
          const depth = String(req.headers.depth ?? '0');
          const book = propsForBook(persona, props);
          const out = [responseFor(`/carddav/${persona.key}/`, book.found, book.notFound)];
          if (depth !== '0') {
            for (const card of persona.contacts.values()) {
              const c = propsForCard(persona, card, props, false);
              out.push(responseFor(cardHref(persona, card.uid), c.found, c.notFound));
            }
          }
          return xml(207, multistatus(out));
        }
        if (req.method === 'REPORT') {
          const wanted = requestedProps(body);
          const hrefs = hrefsIn(body);
          const cards = hrefs.length
            ? hrefs.map((h) => persona.contacts.get(uidFromHref(h))).filter(Boolean)
            : [...persona.contacts.values()];
          const out = cards.map((card) => {
            const c = propsForCard(persona, card, wanted.length ? wanted : ['getetag'], true);
            return responseFor(cardHref(persona, card.uid), c.found, c.notFound);
          });
          return xml(207, multistatus(out));
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const all = [...persona.contacts.values()].map((c) => c.vcard).join('');
          return reply(200, req.method === 'HEAD' ? '' : all, { 'content-type': 'text/vcard; charset=utf-8' });
        }
        return reply(405, 'method not allowed on collection');
      }

      // --- single card ---
      const uid = uidFromHref(resource);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const card = persona.contacts.get(uid);
        if (!card) return reply(404, 'no such contact');
        return reply(200, req.method === 'HEAD' ? '' : card.vcard, {
          'content-type': 'text/vcard; charset=utf-8',
          etag: card.etag,
        });
      }
      if (req.method === 'PUT') {
        if (!body.includes('BEGIN:VCARD')) return reply(400, 'body is not a vCard');
        const realUid = uidFromVcard(body, uid || newUid());
        const existed = persona.contacts.has(realUid);
        const etag = store.putContact(persona, realUid, body);
        log('carddav put', { persona: persona.key, uid: realUid, created: !existed });
        return reply(existed ? 204 : 201, '', { etag, location: cardHref(persona, realUid) });
      }
      if (req.method === 'DELETE') {
        if (!store.deleteContact(persona, uid)) return reply(404, 'no such contact');
        log('carddav delete', { persona: persona.key, uid });
        return reply(204, '');
      }
      if (req.method === 'PROPFIND') {
        const card = persona.contacts.get(uid);
        if (!card) return reply(404, 'no such contact');
        const wanted = requestedProps(body);
        const c = propsForCard(persona, card, wanted.length ? wanted : ['getetag', 'getcontenttype'], false);
        return xml(207, multistatus([responseFor(cardHref(persona, uid), c.found, c.notFound)]));
      }
      return reply(405, 'method not allowed');
    }
  };

  function uidFromHref(href) {
    const last = String(href).split('/').filter(Boolean).pop() || '';
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      // Malformed escape: match on the raw segment rather than throwing.
    }
    return decoded.replace(/\.vcf$/i, '');
  }

  function readBody(req, cb) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return cb(null, '');
    let size = 0;
    const chunks = [];
    // Aborting fires 'error' after the oversize callback, and a second callback
    // means a second res.writeHead — which throws where nothing can catch it.
    let done = false;
    const once = (err, body) => {
      if (done) return;
      done = true;
      cb(err, body);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        once(new Error('request body too large'));
        return req.destroy();
      }
      chunks.push(c);
    });
    req.on('end', () => once(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => once(e));
  }
}
