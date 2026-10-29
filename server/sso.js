// Ubuntu SSO (login.ubuntu.com) sign-in via OpenID 2.0 with the SReg extension.
// Responses are verified statelessly with check_authentication against the OP.

import crypto from 'crypto';

const OP_ENDPOINT = 'https://login.ubuntu.com/+openid';
const CLAIMED_ID_PREFIX = 'https://login.ubuntu.com/+id/';
const NS_OPENID = 'http://specs.openid.net/auth/2.0';
const NS_SREG = 'http://openid.net/extensions/sreg/1.1';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

const STATE_COOKIE = 'sso_state';
const SESSION_COOKIE = 'sso_session';
const STATE_TTL_MS = 10 * 60 * 1000;
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pendingStates = new Map();
const seenNonces = new Map();
const sessions = new Map();

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  };
}

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(key);
  }
  for (const [key, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(key);
  }
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key);
  }
}

/** Only allow same-site paths; "//host" and "/\\host" would leave the site. */
function safeNextPath(next) {
  const value = String(next || '/');
  if (!value.startsWith('/') || /^\/[/\\]/.test(value) || /[\u0000-\u001f\\]/.test(value)) {
    return '/';
  }
  return value;
}

function requestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function sessionFromToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

/** Signed-in Ubuntu SSO user for an Express request, or null. */
export function getSsoUser(req) {
  return sessionFromToken(req.cookies?.[SESSION_COOKIE]);
}

/** Signed-in Ubuntu SSO user for a raw HTTP upgrade request (WebSocket), or null. */
export function getSsoUserFromHeaders(headers) {
  return sessionFromToken(parseCookieHeader(headers?.cookie)[SESSION_COOKIE]);
}

/** Redirect the browser to login.ubuntu.com. */
export function startLogin(req, res) {
  pruneExpired();
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, {
    next: safeNextPath(req.query.next),
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  res.cookie(STATE_COOKIE, state, cookieOptions(STATE_TTL_MS));

  const origin = requestOrigin(req);
  const params = new URLSearchParams({
    'openid.ns': NS_OPENID,
    'openid.mode': 'checkid_setup',
    'openid.claimed_id': IDENTIFIER_SELECT,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.return_to': `${origin}/auth/sso/callback?state=${state}`,
    'openid.realm': `${origin}/`,
    'openid.ns.sreg': NS_SREG,
    'openid.sreg.required': 'nickname,email,fullname',
  });
  res.redirect(`${OP_ENDPOINT}?${params}`);
}

function parseKeyValue(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

function nonceTimestamp(nonce) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(nonce || '');
  return match ? Date.parse(match[1]) : NaN;
}

async function verifyAssertion(query, expectedReturnTo) {
  if (query['openid.ns'] !== NS_OPENID) throw new Error('Unexpected OpenID namespace');
  if (query['openid.op_endpoint'] !== OP_ENDPOINT) throw new Error('Unexpected OpenID provider');

  const claimedId = query['openid.claimed_id'] || '';
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX) || query['openid.identity'] !== claimedId) {
    throw new Error('Identity is not an Ubuntu SSO account');
  }

  const returnTo = new URL(query['openid.return_to'] || '', 'http://invalid');
  const expected = new URL(expectedReturnTo);
  if (
    returnTo.origin !== expected.origin ||
    returnTo.pathname !== expected.pathname ||
    returnTo.searchParams.get('state') !== expected.searchParams.get('state')
  ) {
    throw new Error('Return URL mismatch');
  }

  const nonce = query['openid.response_nonce'];
  const issuedAt = nonceTimestamp(nonce);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > NONCE_MAX_AGE_MS) {
    throw new Error('Sign-in response expired');
  }
  if (seenNonces.has(nonce)) throw new Error('Sign-in response already used');

  const signed = new Set(String(query['openid.signed'] || '').split(','));
  for (const field of ['op_endpoint', 'return_to', 'response_nonce', 'assoc_handle', 'claimed_id', 'identity']) {
    if (!signed.has(field)) throw new Error(`Sign-in response did not sign ${field}`);
  }

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.')) body.set(key, String(value));
  }
  body.set('openid.mode', 'check_authentication');

  const res = await fetch(OP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Ubuntu SSO verification failed (HTTP ${res.status})`);
  const result = parseKeyValue(await res.text());
  if (result.is_valid !== 'true') throw new Error('Ubuntu SSO rejected the sign-in response');

  seenNonces.set(nonce, Date.now() + NONCE_MAX_AGE_MS * 2);

  // Only trust SReg values the provider actually signed.
  let sregAlias = null;
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.ns.') && value === NS_SREG) sregAlias = key.slice('openid.ns.'.length);
  }
  const sreg = (field) =>
    sregAlias && signed.has(`${sregAlias}.${field}`)
      ? String(query[`openid.${sregAlias}.${field}`] || '').trim()
      : '';

  return {
    id: claimedId,
    nickname: sreg('nickname'),
    email: sreg('email'),
    fullname: sreg('fullname'),
  };
}

/** Handle the return from login.ubuntu.com. */
export async function handleCallback(req, res) {
  pruneExpired();
  const state = String(req.query.state || '');
  const pending = pendingStates.get(state);
  const cookieState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE);

  if (!pending || !cookieState || cookieState !== state) {
    req.audit = { action: 'sso.login_failed', details: { reason: 'Expired or missing sign-in state' } };
    return res.redirect('/?sso_error=expired');
  }
  pendingStates.delete(state);

  const mode = req.query['openid.mode'];
  if (mode === 'cancel') {
    req.audit = { action: 'sso.login_failed', details: { reason: 'Cancelled at login.ubuntu.com' } };
    return res.redirect('/?sso_error=cancelled');
  }
  if (mode !== 'id_res') {
    req.audit = { action: 'sso.login_failed', details: { reason: `Unexpected mode ${mode}` } };
    return res.redirect('/?sso_error=failed');
  }

  try {
    const user = await verifyAssertion(
      req.query,
      `${requestOrigin(req)}/auth/sso/callback?state=${state}`
    );
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
    req.auditActor = user.email || user.nickname || user.id;
    req.audit = {
      action: 'sso.login',
      details: { name: user.fullname, email: user.email, nickname: user.nickname },
    };
    res.redirect(pending.next);
  } catch (err) {
    console.warn(`Ubuntu SSO sign-in failed: ${err.message}`);
    req.audit = { action: 'sso.login_failed', details: { reason: err.message } };
    res.redirect('/?sso_error=unverified');
  }
}

export function logout(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
}

/** Display name for a signed-in user. */
export function ssoDisplayName(user) {
  return user?.fullname || user?.nickname || user?.email || 'Ubuntu SSO user';
}
