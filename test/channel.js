/**
 * TCF channel regression tests
 */

/* global describe, before, after, it */

"use strict";

var chai = require("chai");
var expect = chai.expect;
var net = require('net');

var tcf = require('../src/tcf');
var channel = require('../src/channel');
var ChannelState = channel.ChannelState;

var ERR_PROTOCOL = 0x20000 + 3;
var ERR_CHANNEL_CLOSED = 0x20000 + 5;
var ERR_INV_COMMAND = 0x20000 + 25;
var EOM = Buffer.from([3, 1]);

// Connects a client to 'url' and resolves once the TCF channel is up.
// 'configure' is called with the client before connecting.
function connectClient(url, protocol, configure) {
    return new Promise((resolve, reject) => {
        var client = new tcf.Client(undefined, protocol);
        if (configure) configure(client);
        client.connect(url,
            () => { resolve(client); },
            () => {},
            (err) => { reject(err); }
        );
    });
}

// Builds a raw TCF message: zero terminated fields followed by EOM
function rawMessage(fields) {
    var parts = fields.map(f => Buffer.concat([Buffer.from(f, 'utf8'), Buffer.from([0])]));
    parts.push(EOM);
    return Buffer.concat(parts);
}

// Starts a raw TCP peer that answers the client Hello and passes each received
// command to onCommand(socket, fields, raw). Resolves to {server, client}.
// opts.services: services announced by the peer, opts.configure: see connectClient
function startRawPeer(onCommand, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        var server = net.createServer(socket => {
            var data = Buffer.alloc(0);
            socket.write(rawMessage(['E', 'Locator', 'Hello', JSON.stringify(opts.services || [])]));
            socket.on('data', chunk => {
                var end;
                data = Buffer.concat([data, chunk]);
                while ((end = data.indexOf(EOM)) >= 0) {
                    var msg = data.slice(0, end);
                    data = data.slice(end + EOM.length);
                    if (msg[0] === 'C'.charCodeAt(0)) {
                        onCommand(socket, msg.toString('utf8').split('\0'), msg);
                    }
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            connectClient('TCP:127.0.0.1:' + server.address().port, undefined, opts.configure)
                .then(client => resolve({server: server, client: client}))
                .catch(reject);
        });
    });
}

// Creates a channel without transport; sent data is collected in 'sent'
function createChannel(protocol) {
    var c = new channel.Channel(protocol);
    c.sent = [];
    c.closed = false;
    c.flushOutput = buf => { c.sent.push(Buffer.from(buf)); };
    c.closeConnection = () => { c.closed = true; };
    return c;
}

// Runs fn with console.error captured, resolves to the captured calls
function captureConsoleError(fn) {
    var calls = [];
    var consoleError = console.error;
    console.error = function () { calls.push(Array.from(arguments)); };
    return Promise.resolve()
        .then(fn)
        .then(() => calls, err => { throw err; })
        .finally(() => { console.error = consoleError; });
}

function nextTick() {
    return new Promise(resolve => { setTimeout(resolve, 10); });
}

describe('tcf-channel', function () {
    var server;
    var wsurl = 'WS::20011';

    before(function () {
        var protocol = new tcf.Protocol();
        protocol.addCommandHandler('Pong', 'echo', function (c, args) {
            return ([0, args[0]]);
        });
        protocol.addCommandHandler('Pong', 'delay', function (c, args) {
            return new Promise((resolve) => {
                setTimeout(() => { resolve([0]); }, +args[0]);
            });
        });
        protocol.addCommandHandler('Pong', 'echoBinary', function (c, args) {
            // binary arguments are handed over as binary strings
            return ([0, Buffer.from(args[0], 'latin1').toString('base64')]);
        }, ['binary']);
        server = new tcf.Server(wsurl, protocol);
    });

    after(function () {
        server.serv.server.close();
    });

    it('should reject all pending commands when the channel is closed', function () {
        this.timeout(5000);
        return connectClient(wsurl).then(client => {
            var pending = [1, 2, 3, 4].map(() => client.sendCommand('Pong', 'delay', [500]));
            client.close();
            return Promise.allSettled(pending);
        })
        .then(results => {
            results.forEach(r => {
                expect(r.status).to.equal('rejected');
                expect(r.reason).to.equal(ERR_CHANNEL_CLOSED);
            });
        });
    });

    it('should transfer messages larger than the output buffer', function () {
        this.timeout(10000);
        var big = 'x'.repeat(3 * 1024 * 1024) + 'ü'.repeat(512 * 1024);
        return connectClient(wsurl).then(client => {
            return client.sendCommand('Pong', 'echo', [big])
                .then(res => {
                    client.close();
                    expect(res[0]).to.equal(0);
                    expect(res[1].length).to.equal(big.length);
                    expect(res[1] === big).to.equal(true);
                });
        });
    });

    it('should round-trip non ASCII strings', function () {
        var text = 'Grüße aus Köln: 10 € 🚀';
        return connectClient(wsurl).then(client => {
            return client.sendCommand('Pong', 'echo', [text])
                .then(res => {
                    client.close();
                    expect(res[1]).to.equal(text);
                });
        });
    });

    it('should encode and decode strings as UTF-8 on the wire', function () {
        var text = 'Grüße €';
        var reply = 'Größe ✓';
        var peer;

        return startRawPeer((socket, fields, raw) => {
            expect(raw.indexOf(Buffer.from(JSON.stringify(text), 'utf8'))).to.be.above(0);
            socket.write(rawMessage(['R', fields[1], JSON.stringify(reply)]));
        })
        .then(p => {
            peer = p;
            return peer.client.sendCommand('Test', 'echo', [text]);
        })
        .then(res => {
            expect(res[0]).to.equal(reply);
        })
        .finally(() => {
            peer.client.close();
            peer.server.close();
        });
    });

    it('should only remove the given listener with off()', function () {
        var removed = 0;
        var kept = 0;
        var onRemoved = () => { removed++; };
        var onKept = () => { kept++; };

        return new Promise((resolve, reject) => {
            var client = new tcf.Client();
            client.on('closed', onRemoved);
            client.on('closed', onKept);
            client.off('closed', onRemoved);
            client.off('closed', () => {});      // not registered
            client.connect(wsurl,
                () => { client.close(); },
                () => { setTimeout(resolve, 10); },
                (err) => { reject(err); }
            );
        })
        .then(() => {
            expect(removed).to.equal(0);
            expect(kept).to.equal(1);
        });
    });

    it('should keep the reply handler on progress messages', function () {
        var peer;

        return startRawPeer((socket, fields) => {
            socket.write(rawMessage(['P', fields[1], '"50%"']));
            socket.write(rawMessage(['R', fields[1], '0', '"done"']));
        })
        .then(p => {
            peer = p;
            return peer.client.sendCommand('Test', 'run', []);
        })
        .then(res => {
            expect(res).to.deep.equal([0, 'done']);
            expect(peer.client.getChannel().getState()).to.equal(ChannelState.Connected);
        })
        .finally(() => {
            peer.client.close();
            peer.server.close();
        });
    });

    it('should reject a command answered with N', function () {
        var peer;

        return startRawPeer((socket, fields) => {
            socket.write(rawMessage(['N', fields[1]]));
        })
        .then(p => {
            peer = p;
            return peer.client.sendCommand('Test', 'unknown', []);
        })
        .then(() => { throw new Error('command should be rejected'); },
              err => { expect(err).to.equal(ERR_INV_COMMAND); })
        .finally(() => {
            peer.client.close();
            peer.server.close();
        });
    });

    it('should answer unknown commands with N and keep the channel open', function () {
        return connectClient(wsurl).then(client => {
            return client.sendCommand('Pong', 'unknown', [])
                .then(() => { throw new Error('command should be rejected'); },
                      err => { expect(err).to.equal(ERR_INV_COMMAND); })
                .then(() => client.sendCommand('NoSuchService', 'echo', []))
                .then(() => { throw new Error('command should be rejected'); },
                      err => { expect(err).to.equal(ERR_INV_COMMAND); })
                .then(() => client.sendCommand('Pong', 'echo', ['still alive']))
                .then(res => {
                    client.close();
                    expect(res[1]).to.equal('still alive');
                });
        });
    });

    it('should dispatch events to the protocol event handlers', function () {
        var protocol = new tcf.Protocol();
        var received = new Promise(resolve => {
            protocol.addEventHandler('Test', 'hello', (c, args) => { resolve(args); });
        });

        server.once('channelConnected', c => {
            c.sendEvent('Test', 'hello', 'Grüße');
        });

        return connectClient(wsurl, protocol)
            .then(client => received.then(args => {
                client.close();
                expect(args).to.deep.equal(['Grüße']);
            }));
    });

    it('should encode binary command arguments', function () {
        var itf = new tcf.Interface({
            name: 'Pong',
            cmds: [{
                name: 'echoBinary',
                args: [{ type: 'binary' }],
                results: [{ title: 'err', type: 'number' }, { title: 'data', type: 'binary' }]
            }]
        });

        return new Promise((resolve, reject) => {
            var client = new tcf.Client([itf]);
            client.connect(wsurl, () => { resolve(client); }, () => {}, reject);
        })
        .then(client => {
            return Promise.all([
                client.svc.Pong.echoBinary(new Uint8Array([0, 1, 2, 255])),
                client.svc.Pong.echoBinary(Buffer.from([3, 128])),
                client.svc.Pong.echoBinary('\x00\xff')
            ])
            .then(res => {
                client.close();
                expect(res[0].data).to.equal('\x00\x01\x02\xff');
                expect(res[1].data).to.equal('\x03\x80');
                expect(res[2].data).to.equal('\x00\xff');
            });
        });
    });

    it('should detect message boundaries only on escape sequences', function () {
        var peer;

        return startRawPeer((socket, fields) => {
            // raw 0x01 and 0x02 bytes outside of ESC sequences are no markers
            socket.write(rawMessage(['E', 'Test', 'ev\x01\x02', '0']));
            // an EOM split between two chunks
            var reply = rawMessage(['R', fields[1], '"ok"']);
            socket.write(reply.slice(0, reply.length - 1));
            setTimeout(() => { socket.write(reply.slice(reply.length - 1)); }, 20);
        })
        .then(p => {
            peer = p;
            return peer.client.sendCommand('Test', 'run', []);
        })
        .then(res => {
            expect(res).to.deep.equal(['ok']);
            expect(peer.client.getChannel().getState()).to.equal(ChannelState.Connected);
        })
        .finally(() => {
            peer.client.close();
            peer.server.close();
        });
    });

    it('should query the peer attributes with queryAttrs', function () {
        var peer;

        return startRawPeer((socket, fields) => {
            if (fields[3] === 'getAgentID') {
                socket.write(rawMessage(['R', fields[1], 'null', '"agent-1"']));
            }
            else if (fields[3] === 'getPeers') {
                socket.write(rawMessage(['R', fields[1], 'null',
                    '[{"ID":"other","AgentID":"agent-2"},{"ID":"p1","AgentID":"agent-1"}]']));
            }
        }, {
            services: ['Locator'],
            configure: client => { client.queryAttrs = true; }
        })
        .then(p => {
            peer = p;
            expect(peer.client.attrs).to.deep.equal({ID: 'p1', AgentID: 'agent-1'});
        })
        .finally(() => {
            peer.client.close();
            peer.server.close();
        });
    });

    it('should report connection errors for invalid urls', function () {
        var client = new tcf.Client();
        return Promise.all([
            client.connectDefered('').then(() => { throw new Error('should fail'); }, err => err),
            client.connectDefered('FOO:localhost:1').then(() => { throw new Error('should fail'); }, err => err),
            new Promise(resolve => {
                expect(client.connect('', () => {}, () => {}, resolve)).to.equal(-1);
            })
        ])
        .then(errors => {
            errors.forEach(err => { expect(err).to.be.instanceOf(Error); });
            expect(errors[1].message).to.contain('FOO');
        });
    });

    it('should reject commands sent on a closed channel', function () {
        var client = new tcf.Client();
        return new Promise((resolve, reject) => {
            client.connect(wsurl, () => { client.close(); }, resolve, reject);
        })
        .then(() => {
            // the transport is closed: the command must not wait for a reply
            return client.sendCommand('Pong', 'echo', ['late'])
                .then(() => { throw new Error('command should be rejected'); },
                      err => { expect(err).to.equal(ERR_CHANNEL_CLOSED); });
        });
    });

    it('should not send a partial message if the arguments cannot be serialized', function () {
        var c = createChannel();
        var bad = { toJSON: () => { throw new Error('not serializable'); } };

        return c.sendCommand('Test', 'run', [bad])
            .then(() => { throw new Error('command should be rejected'); },
                  err => { expect(err.message).to.equal('not serializable'); })
            .then(() => {
                c.sendCommand('Test', 'run', ['ok']);
                expect(c.sent).to.have.length(1);
                expect(c.sent[0].toString('latin1').split('\0').slice(0, 5))
                    .to.deep.equal(['C', '3', 'Test', 'run', '"ok"']);
            });
    });

    it('should report protocol errors and close the channel', function () {
        var c = createChannel();
        var errors = [];
        c.addHandler(channel.ChannelEvent.onerror, err => { errors.push(err); });
        c.sendCommand('Test', 'run', []).catch(() => {});

        return captureConsoleError(() => {
            // reply with an invalid escape sequence
            c.onData(Buffer.concat([Buffer.from('R\x002\x00'), Buffer.from([3, 9]), EOM]));
            return nextTick();
        })
        .then(logged => {
            expect(errors).to.have.length(1);
            expect(errors[0]).to.be.instanceOf(Error);
            expect(errors[0].code).to.equal(ERR_PROTOCOL);
            expect(errors[0].message).to.equal('Invalid escape sequence');
            expect(logged).to.have.length(1);
            expect(c.closed).to.equal(true);
            expect(c.getState()).to.equal(ChannelState.Disconnected);
        });
    });

    it('should isolate exceptions thrown by event handlers', function () {
        var c = createChannel();
        var calls = 0;
        var unhandled = [];
        var onUnhandled = reason => { unhandled.push(reason); };

        c.addEventHandler('Test', 'ev', () => {
            calls++;
            throw new Error('listener failure');
        });
        process.on('unhandledRejection', onUnhandled);

        return captureConsoleError(() => {
            c.onData(rawMessage(['E', 'Test', 'ev', '1']));
            c.onData(rawMessage(['E', 'Test', 'ev', '2']));
            return nextTick();
        })
        .then(logged => {
            expect(calls).to.equal(2);
            expect(logged).to.have.length(2);
            expect(unhandled).to.be.empty;
            expect(c.closed).to.equal(false);
        })
        .finally(() => {
            process.removeListener('unhandledRejection', onUnhandled);
        });
    });

    it('should receive a large message split into small chunks efficiently', function () {
        this.timeout(2000);
        var c = createChannel();
        var text = 'x'.repeat(4 * 1024 * 1024);
        var reply = c.sendCommand('Test', 'run', []);
        var msg = rawMessage(['R', '2', JSON.stringify(text)]);
        var i;

        for (i = 0; i < msg.length; i += 1024) {
            c.onData(msg.subarray(i, i + 1024));
        }
        return reply.then(res => {
            expect(res[0] === text).to.equal(true);
        });
    });
});
