/**
 * TCF Channel interface
 * @license
 * Copyright (c) 2016-2017 Wind River Systems
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

if (typeof global !== 'undefined') {
    if (typeof global.atob === 'undefined') global.atob = require('atob');
    if (typeof global.btoa == 'undefined') global.btoa = require('btoa');
}

var promise = Promise;
var utils = require('./utils.js');
var Timers = require('timers');

// TCF strings are UTF-8 encoded on the wire
var textEncoder = new (typeof TextEncoder !== 'undefined' ? TextEncoder : require('util').TextEncoder)();
var textDecoder = new (typeof TextDecoder !== 'undefined' ? TextDecoder : require('util').TextDecoder)('utf-8');

var channelId = 0;

var ChannelState = {
    Connected: 0,
    Disconnected: 1,
    StartWait: 2,
    Started: 3,
    HelloSent: 4,
    HelloReceived: 5,
    RedirectSent: 6,
    RedirectReceived: 7
};

exports.ChannelState = ChannelState;

var ChannelEvent = {
    onconnect: 0,
    onclose: 1,
    onerror: -1
};

exports.ChannelEvent = ChannelEvent;

var STD_ERR_BASE = 0x20000;

var TcfError = {
    ERR_PROTOCOL: STD_ERR_BASE + 3,
    ERR_CHANNEL_CLOSED: STD_ERR_BASE + 5,
    ERR_INV_COMMAND: STD_ERR_BASE + 25,
};

exports.TcfError = TcfError;

// Error raised on a malformed or unexpected message from the peer
function protocolError(message) {
    var err = new Error(message);
    err.code = TcfError.ERR_PROTOCOL;
    return err;
}

var ESC = 3;
var MARKER_EOM = -1;
var MARKER_EOS = -2;
var OBUF_SIZE = 1024 * 1024;
var IBUF_SIZE = 64 * 1024;


/**
 * TCF channel
 * @typedef {Object} Channel
 */

/*
 * TCF channel
 *
 * @class
 * @param {Protocol} protocol - definition of local services
 */

function Channel(protocol) {
    var istore = new Uint8Array(IBUF_SIZE);     // input buffer storage
    var ibuf = istore.subarray(0, 0);           // received bytes, read up to 'iread'
    var iread = 0;
    var obuf = new Uint8Array(OBUF_SIZE);
    var owrite = 0;
    var state = ChannelState.StartWait;
    var listeners = [];
    var messageCount = 0;
    var replyHandlers = [];
    var eventHandlers = [];
    var peerServices = [];
    var tokenId = 1;
    var log = false;
    var proto;
    var svcList;
    var hasZeroCopySupport = false;
    var eof = false;
    var escPending = false;

    setProtocol(protocol);

    var options = require('./options.js').get();
    var JSONbig = require('json-bigint')({
        storeAsString: options.bigNumAsString,
        // drop keys of received objects that could alter prototypes
        protoAction: 'ignore',
        constructorAction: 'ignore'
    });

    // json-bigint creates objects without prototype: return plain objects
    var parseJSON = function parseJSON(text) {
        return JSONbig.parse(text, function(key, value) {
            if (value && typeof value === 'object' && Object.getPrototypeOf(value) === null) {
                return Object.assign({}, value);
            }
            return value;
        });
    };

    var enableZeroCopy = function(enable) {
        hasZeroCopySupport = enable;
    };

    var sendEvent = function(service, name, args) {
        writeStringz("E");
        writeStringz(service);
        writeStringz(name);
        writeStringz(JSONbig.stringify(args));
        writeStream(MARKER_EOM);
    };

    var sendCommand = function(service, name, args, resParsers) {
        var pres =  new promise(function(resolve, reject) {
            var rh = {};
            var i;
            var start = owrite;

            if (state == ChannelState.Disconnected) {
                reject(TcfError.ERR_CHANNEL_CLOSED);
                return;
            }

            tokenId++;
            try {
                writeStringz("C");
                writeStringz(JSONbig.stringify(tokenId));
                writeStringz(service);
                writeStringz(name);
                for (i = 0; i < args.length; i++) {
                    /* test binary type */
                    if (args[i] && (args[i] instanceof ArrayBuffer || args[i].buffer instanceof ArrayBuffer)) {
                        writeStringz(JSONbig.stringify(utils.toBase64(args[i])));
                    }
                    else writeStringz(JSONbig.stringify(args[i]));
                }
            }
            catch (err) {
                // drop the partially written message (e.g. arguments not serializable)
                owrite = start;
                throw err;
            }
            rh.tokenId = tokenId;
            rh.resolve = resolve;
            rh.reject = reject;
            rh.progress = null;
            rh.parsers = resParsers;
            rh.service = service;
            rh.name = name;
            // register the handler before sending, a write error rejects it
            replyHandlers.push(rh);
            if (log) console.log(tokenId, service, name, args);
            writeStream(MARKER_EOM);
        });
        return pres;
    };

    // Grow the output buffer so that 'size' more bytes fit into it
    var reserveOutput = function(size) {
        if (owrite + size <= obuf.length) return;
        var nbuf = new Uint8Array(Math.max(obuf.length * 2, owrite + size));
        nbuf.set(obuf.subarray(0, owrite));
        obuf = nbuf;
    };

    var writeStream = function(ch) {
        reserveOutput(2);
        if (ch == MARKER_EOM) {
            obuf[owrite++] = ESC;
            obuf[owrite++] = 1;
            flushOutput();
        }
        else if (ch == MARKER_EOS) {
            obuf[owrite++] = ESC;
            obuf[owrite++] = 2;
        }
        else {
            obuf[owrite++] = ch;
        }

        return 0;
    };

    var writeStringz = function(str) {
        var bytes = textEncoder.encode(str);
        reserveOutput(bytes.length + 1);
        obuf.set(bytes, owrite);
        owrite += bytes.length;
        obuf[owrite++] = 0;
        return 0;
    };

    // jshint -W098
    // eslint-disable-next-line no-unused-vars
    var writeBinaryDataz = function writeBinaryDataz(buffer) {
        var i;
        if (!hasZeroCopySupport || buffer.length === 0) {
            return writeStringz(JSONbig.stringify(utils.toBase64(buffer)));
        }
        var str = buffer.toString();
        writeStream('('.charCodeAt());
        var buf_size = str.length.toString();
        for (i = 0; i < buf_size.length; i++) {
            writeStream(buf_size.charCodeAt(i));
        }
        writeStream(')'.charCodeAt());
        if (str.length > 32) {
            writeStream(3);
            writeStream(3);
            var n = str.length;
            while (true) {  
                if (n <= 0x7f) {
                    writeStream(n);
                    break;
                }
                writeStream((n & 0x7f) | 0x80);
                n >>= 7;
            }
            for (i = 0; i < str.length; i++) {
                writeStream(str.charCodeAt(i));
            }
        }
        else {
            for (i = 0; i < str.length; i++) {
                writeStream(str.charCodeAt(i));
                if (str.charCodeAt(i) == 3) writeStream(0);
            }
        }
        writeStream(0);
        return 0;
    };

    // Checks the consistency of received data
    var check = function check(condition, message) {
        if (!condition) throw protocolError(message);
    };

    var peekStream = function peekStream() {
        var ch;
        check(iread < ibuf.length, "Unexpected end of message");
        if ((ch = ibuf[iread]) == ESC) {
            check(iread < ibuf.length - 1, "Unexpected end of message");
            ch = ibuf[iread + 1];
            switch (ch) {
                case 0:
                    return ESC;
                case 1:
                    return MARKER_EOM;
                case 2:
                    return MARKER_EOS;
                case 3:
                    throw protocolError("ZeroCopy not implemented");
                default:
                    throw protocolError("Invalid escape sequence");
            }
        }
        return ch;
    };

    var readStream = function readStream() {
        var ch;
        if (iread === ibuf.length && eof) return MARKER_EOS;

        check(iread < ibuf.length, "Unexpected end of message");
        // check for escape character
        if ((ch = ibuf[iread++]) == ESC) {
            check(iread < ibuf.length, "Unexpected end of message");
            ch = ibuf[iread++];
            switch (ch) {
                case 0:
                    return ESC;
                case 1:
                    {
                        messageCount--;
                        return MARKER_EOM;
                    }
                case 2:
                    return MARKER_EOS;
                case 3:
                    throw protocolError("ZeroCopy not implemented");
                default:
                    throw protocolError("Invalid escape sequence");
            }
        }
        return ch;
    };

    var readStringz = function readStringz() {
        var start = iread;
        // returns a string from the ibuf
        while (iread < ibuf.length && ibuf[iread] !== 0) iread++;
        check(iread < ibuf.length, "Unterminated string");
        var str = textDecoder.decode(ibuf.subarray(start, iread));
        iread++; // skip the terminating zero
        return str;
    };

    var notifyChannelEvent = function notifyChannelEvent(ev, data) {
        var i;
        var handlers = listeners[ev];

        if (handlers) {
            for (i = 0; i < handlers.length; i++) {
                if (!handlers[i]) continue;
                try {
                    handlers[i](data);
                }
                catch (err) {
                    console.error('Exception in TCF channel listener:', err);
                }
            }
        }
    };

    // Reports a fatal error of the channel to the listeners and closes it
    var channelFailure = function channelFailure(err) {
        if (state === ChannelState.Disconnected) return;
        console.error('TCF channel error:', err);
        notifyChannelEvent(ChannelEvent.onerror, err);
        sendEofAndClose();
    };

    var eventLocatorHello = function eventLocatorHello() {
        peerServices = parseJSON(readStringz());
        // ZeroCopy is used only if enabled locally and supported by the peer
        hasZeroCopySupport = hasZeroCopySupport && peerServices.indexOf("ZeroCopy") >= 0;
        var eom = readStream();
        check(eom == MARKER_EOM, "Invalid Locator.Hello event");
        if (state == ChannelState.Started) {
            state = ChannelState.HelloReceived;
        }
        else {
            state = ChannelState.Connected;
            notifyChannelEvent(ChannelEvent.onconnect);
        }
    };

    var skipUntilEOM = function skipUntilEOM() {
        var ch;
        do {
            ch = readStream();
        } while (ch != MARKER_EOM);
    };

    function handleProtocolMessage() {
        var msg = {},
            arg,
            ch,
            // eslint-disable-next-line no-unused-vars
            error;

        utils.assert(messageCount > 0);
        msg.type = readStringz();

        if (msg.type.length < 1) {
            throw protocolError("Empty message type");
        }
        else if (msg.type == "C") {
            var token = readStringz();
            var svc = readStringz();
            var name = readStringz();
            var args = [];
            var res_idx = 0;

            if (!proto || !proto.hasCommandHandler(svc, name)) {
                // Unknown command: answer with a 'N' (not recognized) message
                skipUntilEOM();
                writeStringz("N");
                writeStringz(token);
                writeStream(MARKER_EOM);
                return;
            }

            var cargsParsers = proto.getCommandArgsParsers(svc, name);

            /* parse arguments */
            while (peekStream() != MARKER_EOM) {
                if (cargsParsers[res_idx] === 'binary') {
                    args.push(atob(parseJSON(readStringz())));
                }
                else args.push(parseJSON(readStringz()));
                res_idx++;
            }

            readStream(); //flush EOM

            proto.execCommandHandler(channel, svc, name, args)
            .then(function(res) {
                writeStringz("R");
                writeStringz(token);
                res.forEach(function(rarg) {
                    writeStringz(JSONbig.stringify(rarg));
                });
                writeStream(MARKER_EOM);
            })
            .catch(channelFailure);
        }
        else if ((msg.type == "R") || (msg.type == "P") || (msg.type == "N")) {
            var rargs = [];
            msg.token = readStringz();
            // get the reply handler; it is kept until the final reply ('R' or 'N')
            var rh = findReplyHandler(msg.token, msg.type != "P");

            if (!rh) {
                throw protocolError("Unknown reply token " + msg.token);
            }

            msg.res = {};
            res_idx = 0;
            // build the result object
            while ((ch = peekStream()) != MARKER_EOM) {
                if (ch === 0) {
                    rargs.push(null);
                    readStream();
                }
                else {
                    arg = readStringz();
                    if (arg === "null")
                        rargs.push(null);
                    else {
                        if (rh.parsers && rh.parsers[res_idx] === 'binary') {
                            rargs.push(atob(parseJSON(arg)));
                        }
                        else rargs.push(parseJSON(arg));
                    }
                }
                res_idx++;
            }
            // skip EOM
            readStream();
            if (msg.type == "R") {
                rh.resolve && rh.resolve(rargs);
            }
            else if (msg.type == "P") {
                rh.progress && rh.progress(rargs);
            }
            else if (rh.resolve) {
                // 'N': the command is not recognized by the peer
                rh.reject(TcfError.ERR_INV_COMMAND);
            }
        }
        else if (msg.type == "E") {
            msg.service = readStringz();
            msg.name = readStringz();
            if ((state == ChannelState.Started || state == ChannelState.HelloSent) &&
                (msg.service == "Locator" && msg.name == "Hello")) {
                eventLocatorHello();
            }
            else {
                var evhandler = findEventHandler(msg.service, msg.name);
                if (!evhandler) {
                    // fall back to the event handlers defined in the protocol
                    var protoEvHandler = proto && proto.getEventHandler(msg.service, msg.name);
                    if (!protoEvHandler) return skipUntilEOM();
                    evhandler = {
                        parsers: protoEvHandler.parsers || [],
                        handler: function(args) {
                            protoEvHandler.eh(channel, args);
                        }
                    };
                }
                var eargsParsers = evhandler.parsers;
                var eargs = [];
                var ev_idx = 0;

                while (peekStream() != MARKER_EOM) {
                    if (eargsParsers[ev_idx] === 'binary') {
                        eargs.push(atob(parseJSON(readStringz())));
                    }
                    else eargs.push(parseJSON(readStringz()));
                    ev_idx++;
                }
                skipUntilEOM();

                Promise.resolve(true).then(function() {
                    evhandler.handler(eargs);
                })
                .catch(function(err) {
                    console.error('Exception in TCF event handler ' + msg.service + '.' + msg.name + ':', err);
                });
            }
        }
        else {
            throw protocolError("Invalid message type " + msg.type);
        }

        if (log) console.log(JSONbig.stringify(msg));
    }

    function updateMessageCount(buf) {
        var i;
        for (i = 0; i < buf.byteLength; i++) {
            // markers are ESC sequences, which may be split between two chunks
            if (!escPending) {
                escPending = buf[i] == ESC;
                continue;
            }
            escPending = false;
            switch (buf[i]) {
                case 1: //EOM
                    Timers.setImmediate(() => {
                        try {
                            handleProtocolMessage();
                        }
                        catch(error) {
                            channelFailure(error);
                        }
                    });
                    messageCount++;
                    break;
                case 2: //EOS
                    // Channel closed by remote peer
                    eof = true;
                    Timers.setImmediate(sendEofAndClose);
                    break;
            }
        }
    }

    var sendHelloMessage = function sendHelloMessage() {
        utils.assert(state == ChannelState.Started || state == ChannelState.HelloReceived);
        writeStringz("E");
        writeStringz("Locator");
        writeStringz("Hello");
        writeStringz(JSONbig.stringify(svcList));
        writeStream(MARKER_EOM);
        if (state == ChannelState.Started) {
            state = ChannelState.HelloSent;
        }
        else {
            state = ChannelState.Connected;
            notifyChannelEvent(ChannelEvent.onconnect);
        }
    };

    function flushOutput() {
        try {
            channel.flushOutput(obuf.slice(0, owrite));
        }
        catch(error) {
            // the transport is broken: close the channel
            if (state != ChannelState.Disconnected) onError(error);
        }

        owrite = 0;
        // Release the memory of a buffer that was grown for a large message
        if (obuf.length > OBUF_SIZE) obuf = new Uint8Array(OBUF_SIZE);
    }

    var findReplyHandler = function findReplyHandler(token, remove) {
        var i;
        for (i = 0; i < replyHandlers.length; i++) {
            if (replyHandlers[i].tokenId == token)
                return remove ? replyHandlers.splice(i, 1)[0] : replyHandlers[i];
        }
        return null;
    };

    var findEventHandler = function findEventHandler(service, name) {
        var i;
        for (i = 0; i < eventHandlers.length; i++) {
            if ((eventHandlers[i].service == service) &&
                (eventHandlers[i].name == name))
                return eventHandlers[i];
        }
        return undefined;
    };

    function onData(typedArray) {
        // accept an ArrayBuffer or a view on it (e.g. a Node.js Buffer)
        var data = ArrayBuffer.isView(typedArray) ?
            new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength) :
            new Uint8Array(typedArray);
        var used = ibuf.length;

        updateMessageCount(data);

        if (iread == used) {
            // all received data was read: restart at the beginning of the buffer
            iread = used = 0;
            if (istore.length > IBUF_SIZE && data.length <= IBUF_SIZE) istore = new Uint8Array(IBUF_SIZE);
        }

        if (used + data.length > istore.length) {
            // make room: drop the bytes already read and grow the buffer if needed
            var remains = used - iread;
            if (remains + data.length > istore.length) {
                var nstore = new Uint8Array(Math.max(istore.length * 2, remains + data.length));
                nstore.set(istore.subarray(iread, used));
                istore = nstore;
            }
            else {
                istore.copyWithin(0, iread, used);
            }
            iread = 0;
            used = remains;
        }

        istore.set(data, used);
        ibuf = istore.subarray(0, used + data.length);
    }

    function channelClosed() {
        // Remove event handlers
        eventHandlers.length = 0;
        // Send an error to pending command handlers
        replyHandlers.forEach((replyHandler) => {
            try {
                replyHandler.reject(TcfError.ERR_CHANNEL_CLOSED);
            }
            catch(err) {
                if (log) console.error('Exception handling reply:', err);
            }
            /*
             * Keep the reply handler structure to intercept correctly the reply,
             * but do not call the handler.
             */
            replyHandler.resolve = null;
            replyHandler.progress = null;
        });
        if (state == ChannelState.Disconnected) replyHandlers.length = 0;
    }

    function onClosed() {
        state = ChannelState.Disconnected;
        channelClosed();
        notifyChannelEvent(ChannelEvent.onclose);
    }

    function onError(err) {
        state = ChannelState.Disconnected;
        channelClosed();
        notifyChannelEvent(ChannelEvent.onerror, err);
    }

    function setProtocol(protocol) {
        utils.assert(state == ChannelState.StartWait || state == ChannelState.Disconnected);
        svcList = protocol ? protocol.getServiceList() : [];
        proto = protocol;
    }

    function sendEofAndClose() {
        if (state === ChannelState.Disconnected) return;

        writeStream(MARKER_EOS);
        writeStream(0);
        writeStream(MARKER_EOM);

        state = ChannelState.Disconnected;

        channel.closeConnection();
    }

    var channel = {
        id: channelId++,

        setProtocol: setProtocol,

        start: function channel_start() {
            utils.assert(state == ChannelState.StartWait);
            state = ChannelState.Started;
            if (log) console.log("channel server connecting");
            sendHelloMessage();
        },

        onData: onData,         // Call by the transport layer
        onClosed: onClosed,     // Call by the transport layer
        onError: onError,       // Call by the transport layer

        flushOutput: null,      // set by the transport layer
        closeConnection: null,  // set by the transport layer

        close: sendEofAndClose,

        addHandler: function(ev, cb) {
            if (typeof listeners[ev] == "undefined") listeners[ev] = [];
            listeners[ev].push(cb);
        },
        sendCommand: sendCommand,
        sendEvent: sendEvent,
        enableZeroCopy: enableZeroCopy,
        getPeerServices: function() {
            return peerServices;
        },
        addEventHandler: function(service, name, eh, parsers) {
            utils.assert(!findEventHandler(service, name));
            eventHandlers.push({
                service: service,
                name: name,
                parsers: parsers || [],
                handler: eh
            });
        },
        getState: function() {
            return state;
        }
    };

    return channel;
}

exports.Channel = Channel;

var channel_transports = {};

function add_transport(transport) {
    channel_transports[transport.name.toUpperCase()] = transport;
}

function get_transport(name) {
    return channel_transports[name.toUpperCase()];
}

exports.add_transport = add_transport;
exports.get_transport = get_transport;
