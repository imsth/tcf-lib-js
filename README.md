# Open source version of TCF library in JavaScript

TCF JavaScript library support both client and server (nodejs) configuration.

## Disclaimer
This package is under heavy development and not ready for production.
API compatibility is not guaranteed.

### Install

```
npm install
```

### generate a browser library

```
npm run build
```

### generate the JSDOC

```
npm run doc
```

### Tests

```
npm test
```

`npm test` runs ESLint (`npm run lint`) and the mocha tests. The tests in
`test/c-agent.js` need a running TCF agent and are skipped otherwise; set
`TCF_AGENT_PEER` to the agent peer url (default `TCP::1534`).

### License
This code is released under the MIT License.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```



### Usage

Description : To create a new tcf client use the following :
```js

var client = new tcf.Client();

    var tcf = require ('tcf');
    var client = new tcf.Client();
```

  The client object has the following properties :
```js
  {
    connect: function(peer, [options], onConnect, onClose, onError)
      peer is the tcf peer id of the form [TCP, WS or WSS]:[Hostname]:[Port],
        an IPv6 address is enclosed in brackets: TCP:[::1]:1534
      options : TLS options for WSS connections (optional)
      onConnect : function called when the tcf channel is established
      onClose: function called when the tcf channel is closed
      onError: function called on a connection or communication error
    connectDefered: function(peer, [options])
      returns a Promise resolved with the client once the channel is established
    close: function()
    svc: {}
      The svc object will be populated when the connection is established.
      It provides proxy function to send TCF commands for each service.
      Only services published by the remote peer are defined in the svc
      proxy i.e :

      Breakpoints: Object
        add: function (bpData) {
        addListener: function (listener) {
        change: function (bpData) {
        disable: function (bpIDList) {
        enable: function (bpIDList) {
        getCapabilities: function (ctxID) {
        getIds: function () {
        getProperties: function (bpID) {
        getStatus: function (bpID) {
        remove: function (bpIDList) {
        removeListener: function (listener) {
        set: function (bpList) {
        __proto__: Object
      LineNumbers: Object
        mapToMemory: function (ctxID, file, line, column) {
        mapToSource: function (ctxID, addr0, addr1) {
        __proto__: Object
      ...
  }
```

  Example to call a service function

  All service functions return a Promise that will resolve upon command completion.
  The result of a particular command is an object :
```js
    c.svc['Breakpoints'].add({})
    .then(function (res) {
      res = {
        err: [error object or null if successfull]
        [command specific return values]
      }
    });
```

  example :
```js
    c.svc.ProcessesV1.getChildren ("", false)
    .then (function (res) {
      //Success
    })
    .catch (function (err) {
      // Error
    });
```

  Note : all tcf transactions error result in a promise rejection.
  If you want to ignore some transaction errors without affecting the promise chain
  you'll need to wrap the service call in its own promise :

```js
    c.svc.ProcessesV1.getChildren (c, tree)
    .then (function (res) {
      // This error is expected so we encapsulate that
      // cal in a new promise that is resolved unconditionally.
      return new Promise( function (resolve, reject) {
        c.svc.ProcessesV1.detach(ctx.ID)
        .then(resolve)
        .catch(resolve);
      });
    })
    .then (function (res) {
      // Do the next thing
    })
```

  Service Events notification

    For services emitting events, you need to register an event listener as follow :
```js
    c.svc.RunControl.addListener({
      'contextAdded' : function (ev) {...},
      'contextRemoved' : function (ev) {...},
      ...
    });
```



```js
var tcf = require('tcf');

var client = new tcf.Client();

client.connectDefered('WS:127.0.0.1:1234')
.then (function (c) {
    return c.svc.ProcessesV1.getChildren ("", false);
})
.then (function (res) {
    //Success
})
.catch (function (err) {
    // Error
});
```

Note: special case to call tcf api with 64bits or floating point argument values

```js
var JSONBig = require ('json-bigint');

val = '9223372036351367728';
client.svc.Memory.get("P3896", JSONbig.parse(val), 1, 672, 3)
.then (function (res) {
    //Success
})
.catch (function (err) {
    // Error
});

```

By default, 64bits or floating point argument values are received from the TCL library
as strings that can be manipulated with the package 'json-bigint'. The TCL library
can be configured to return BigNumber objects instead (as defined by the 'bignumber.js' library):
```js
var tcf = require('tcf')({bigNumAsString: false});
```

### Legal Notices
All product names, logos, and brands are property of their respective owners. All company, product and service names used in this software are for identification purposes only. Wind River is a registered trademark of Wind River Systems. JavaScript is a registered trademark of Oracle.

Wind River does not provide support and maintenance services for this software, under Wind River's standard Software Support and Maintenance Agreement or otherwise. Unless required by applicable law, Wind River provides the software (and each contributor provides its contribution) on an "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, either express or implied, including, without limitation, any warranties of TITLE, NONINFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the software and assume any risks associated with your exercise of permissions under the license.


