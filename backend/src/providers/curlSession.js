// Shared helpers for "paste a Copy-as-cURL once a day" sessions (Sensibull, Kite, …).
// Secrets are written only to data/secrets/<name>-session.json (git-ignored, owner read/write only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'secrets');
const fileFor = (name) => path.join(SECRETS_DIR, `${name}-session.json`);

/** Shell-like tokenizer for a pasted curl command: handles '…', "…", $'…', and backslash line continuations. */
export function tokenize(cmd) {
  const tokens = [];
  let cur = null;
  let i = 0;
  const push = () => {
    if (cur !== null) tokens.push(cur);
    cur = null;
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && (cmd[i + 1] === '\n' || cmd[i + 1] === '\r')) {
      i += cmd[i + 1] === '\r' && cmd[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === "'" || (c === '$' && cmd[i + 1] === "'")) {
      if (c === '$') i++;
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote in curl');
      cur = (cur ?? '') + cmd.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) j++;
        s += cmd[j++];
      }
      cur = (cur ?? '') + s;
      i = j + 1;
    } else if (c === '\\') {
      cur = (cur ?? '') + (cmd[i + 1] ?? '');
      i += 2;
    } else {
      cur = (cur ?? '') + c;
      i++;
    }
  }
  push();
  return tokens;
}

/** Extracts url, headers (lower-cased, minus cookie), cookie and body from a "Copy as cURL (bash)" string. */
export function parseCurlCommand(text) {
  const tokens = tokenize(String(text ?? '').trim());
  if (tokens[0] !== 'curl') throw new Error('that does not look like a curl command (should start with "curl")');
  const headers = {};
  let url = null;
  let cookie = null;
  let body = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    if (t === '--url') url = next();
    else if (t === '-H' || t === '--header') {
      const h = next() ?? '';
      const idx = h.indexOf(':');
      if (idx > 0) {
        const k = h.slice(0, idx).trim().toLowerCase();
        const v = h.slice(idx + 1).trim();
        if (k === 'cookie') cookie = v;
        else headers[k] = v;
      }
    } else if (t === '-b' || t === '--cookie') cookie = next();
    else if (['--data-raw', '--data', '-d', '--data-binary'].includes(t)) body = next();
    else if (/^https?:\/\//.test(t)) url = t;
  }
  for (const k of ['content-length', 'accept-encoding', 'priority']) delete headers[k];
  return { url, headers, cookie, body };
}

/** Value of one cookie from a cookie header string. */
export function cookieValue(cookie, name) {
  const m = String(cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

export const cookieNames = (cookie) => String(cookie ?? '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);

export function readSecret(name) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSecret(name, data) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(name), JSON.stringify(data, null, 1), { mode: 0o600 });
}

export function removeSecret(name) {
  fs.rmSync(fileFor(name), { force: true });
}
