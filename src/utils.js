/**
 * Copyright (c) 2016 Wind River Systems
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var nodeCrypto = require('crypto');     // empty object in the browser build

// Returns a random (version 4) UUID
function randomUUID() {
    if (nodeCrypto.randomUUID) return nodeCrypto.randomUUID();

    // Browser: crypto.randomUUID() is only available in secure contexts
    var bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.from(bytes, b => (b + 0x100).toString(16).slice(1)).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' + hex.slice(20);
}

var agent_id = randomUUID();

function get_agent_id() {
    return agent_id;
}

function assert(condition, message) {
    if (!condition) {
        console.error(message || "Assertion failed");
    }
}

/*
 * Encode binary data to base64. Accepts a binary string (one char per byte),
 * an ArrayBuffer or a typed array (Uint8Array, Buffer, ...).
 */
function toBase64(data) {
    if (data === null || data === undefined) return data;
    if (typeof data === 'string') return btoa(data);

    var bytes = data instanceof ArrayBuffer ?
        new Uint8Array(data) :
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    var str = '';
    var i;
    // convert by chunks to stay below the maximum number of call arguments
    for (i = 0; i < bytes.length; i += 0x8000) {
        str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(str);
}

// Returns the host part of a URL: IPv6 addresses are enclosed in brackets
function urlHost(host) {
    return host && host.indexOf(':') >= 0 ? '[' + host + ']' : host;
}

module.exports = {
    get_agent_id: get_agent_id,
    assert: assert,
    toBase64: toBase64,
    randomUUID: randomUUID,
    urlHost: urlHost
};
