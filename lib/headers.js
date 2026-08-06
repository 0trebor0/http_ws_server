'use strict';

const cookie = require('cookie');
const crypto = require('crypto');

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_COOKIE_BYTES = 4096;

function deriveKey(secret) {
    if (Buffer.isBuffer(secret)) {
        if (secret.length !== 32) throw new Error('Cookie key buffers must be exactly 32 bytes');
        return Buffer.from(secret);
    }
    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('cookieSecret values must contain at least 32 characters');
    }
    return crypto.scryptSync(secret, 'simple-http/aes-256-gcm-cookie/v1', 32);
}

function encode(name, value, key) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(`${VERSION}:${name}`, 'utf8'));

    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

function decode(name, token, keys) {
    if (typeof token !== 'string' || !token.startsWith(`${VERSION}.`)) return undefined;

    let payload;
    try {
        payload = Buffer.from(token.slice(VERSION.length + 1), 'base64url');
    } catch (_) {
        return undefined;
    }
    if (payload.length < IV_LENGTH + TAG_LENGTH + 1) return undefined;

    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);

    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
                authTagLength: TAG_LENGTH
            });
            decipher.setAAD(Buffer.from(`${VERSION}:${name}`, 'utf8'));
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return JSON.parse(plaintext.toString('utf8'));
        } catch (_) {
            // Try an older key to support safe key rotation.
        }
    }
    return undefined;
}

function keysFromOptions(options) {
    const secrets = options.cookieSecrets || (options.cookieSecret ? [options.cookieSecret] : []);
    return secrets.map(deriveKey);
}

function applyCookieHeaders(req, res, keys) {
    const rawCookie = req.headers && req.headers.cookie;

    try {
        req.cookies = rawCookie ? cookie.parse(rawCookie) : {};
    } catch (_) {
        req.cookies = {};
    }

    req.encryptedCookies = {};
    req.invalidEncryptedCookies = [];
    for (const [name, token] of Object.entries(req.cookies)) {
        if (!String(token).startsWith(`${VERSION}.`)) continue;
        const value = decode(name, token, keys);
        if (value === undefined) req.invalidEncryptedCookies.push(name);
        else req.encryptedCookies[name] = value;
    }

    if (res) {
        res.cookieSerialize = cookie.serialize;
        res.encryptedCookieSerialize = (name, value, cookieOptions = {}) => {
            if (keys.length === 0) {
                throw new Error('cookieSecret is required to create encrypted cookies');
            }
            const token = encode(name, value, keys[0]);
            const serialized = cookie.serialize(name, token, {
                httpOnly: true,
                sameSite: 'lax',
                path: '/',
                ...cookieOptions
            });
            if (Buffer.byteLength(serialized) > MAX_COOKIE_BYTES) {
                throw new Error(`Encrypted cookie ${name} exceeds ${MAX_COOKIE_BYTES} bytes`);
            }
            return serialized;
        };
    }
}

function headers(req, res = null, options = {}) {
    return applyCookieHeaders(req, res, keysFromOptions(options));
}

headers.create = (options = {}) => {
    const keys = keysFromOptions(options);
    return (req, res = null) => applyCookieHeaders(req, res, keys);
};

module.exports = headers;
