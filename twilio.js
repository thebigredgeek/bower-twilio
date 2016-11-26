(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
Twilio = (function(loadedTwilio) {
var Twilio = loadedTwilio || function Twilio() { };
function extend(M) { for (var k in M) Twilio[k] = M[k] }
extend((function(){
    var util = require('./twilio/util');
    // Hack for determining asset path.
    var TWILIO_ROOT = typeof TWILIO_ROOT != "undefined" ?  TWILIO_ROOT : (function(){
        var prot = location.protocol || "http:",
            uri = "//media.twiliocdn.com/sdk/js/client/",
            scripts = document.getElementsByTagName("script"),
            re = RegExp("(\\w+:)?(\/\/.*)v" + util.getPStreamVersion() + "/(twilio.min.js|twilio.js)");
        for (var i = 0; i < scripts.length; i++) {
            var match = scripts[i].src.match(re);
            if (match) {
                prot = (match[1] || prot);
                uri = match[2];
                break;
            }
        }
        return prot + uri;
    })();

    // Needed for sounds.
    util.setTwilioRoot(TWILIO_ROOT);

    // Fin.
    var exports = require("./twilio");
    return exports;
})());
return Twilio;
})(typeof Twilio !== 'undefined' ? Twilio : null);

},{"./twilio":2,"./twilio/util":19}],2:[function(require,module,exports){
exports.Device = require("./twilio/device").Device;
exports.PStream = require("./twilio/pstream").PStream;
exports.Connection = require("./twilio/connection").Connection;

},{"./twilio/connection":3,"./twilio/device":4,"./twilio/pstream":9}],3:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var Exception = require('./util').Exception;
var log = require('./log');
var Publisher = require('./eventpublisher');
var rtc = require('./rtc');
var RTCMonitor = require('./rtc/monitor');
var twutil = require('./util');
var util = require('util');

var DTMF_INTER_TONE_GAP = 70;
var DTMF_PAUSE_DURATION = 500;
var DTMF_TONE_DURATION = 160;

var METRICS_BATCH_SIZE = 10;
var SAMPLES_TO_IGNORE = 20;

var FEEDBACK_SCORES = [1, 2, 3, 4, 5];
var FEEDBACK_ISSUES = [
  'one-way-audio',
  'choppy-audio',
  'dropped-call',
  'audio-latency',
  'noisy-call',
  'echo'
];

var WARNING_NAMES = {
  audioOutputLevel: 'audio-output-level',
  audioInputLevel: 'audio-input-level',
  packetsLostFraction: 'packet-loss',
  jitter: 'jitter',
  rtt: 'rtt',
  mos: 'mos'
};

var WARNING_PREFIXES = {
  min: 'low-',
  max: 'high-',
  maxDuration: 'constant-'
};

/**
 * Constructor for Connections.
 *
 * @exports Connection as Twilio.Connection
 * @memberOf Twilio
 * @borrows EventEmitter#addListener as #addListener
 * @borrows EventEmitter#emit as #emit
 * @borrows EventEmitter#removeListener as #removeListener
 * @borrows EventEmitter#hasListener as #hasListener
 * @borrows Twilio.mixinLog-log as #log
 * @constructor
 * @param {object} device The device associated with this connection
 * @param {object} message Data to send over the connection
 * @param {Connection.Options} [options]
 *//**
 * @typedef {Object} Connection.Options
 * @property {string} [chunder="chunder.prod.twilio.com"] Hostname of chunder server
 * @property {boolean} [debug=false] Enable debugging
 * @property {boolean} [encrypt=false] Encrypt media
 * @property {MediaStream} [mediaStream] Use this MediaStream object
 * @property {string} [token] The Twilio capabilities JWT
 * @property {string} [callParameters] The call parameters, if this is an incoming
 *   connection.
 */
function Connection(device, message, options) {
    if (!(this instanceof Connection)) {
        return new Connection(device, message, options);
    }
    twutil.monitorEventEmitter('Twilio.Connection', this);
    this.device = device;
    this.message = message || {};

    options = options || {};
    var defaults = {
        logPrefix: "[Connection]",
        mediaStreamFactory: rtc.PeerConnection,
        offerSdp: null,
        callParameters: { },
        debug: false,
        encrypt: false,
        audioConstraints: device.options['audioConstraints'],
        rtcConstraints: device.options['rtcConstraints'],
        iceServers: device.options['iceServers']
    };
    for (var prop in defaults) {
        if (prop in options) continue;
        options[prop] = defaults[prop];
    }

    this.options = options;
    this.parameters = options.callParameters;
    this._status = this.options["offerSdp"] ? "pending" : "closed";
    this._direction = this.parameters.CallSid ? 'INCOMING' : 'OUTGOING';

    this.sendHangup = true;
    log.mixinLog(this, this.options["logPrefix"]);
    this.log.enabled = this.options["debug"];
    this.log.warnings = this.options['warnings'];

    // These are event listeners we need to remove from PStream.
    function noop(){}
    this._onCancel = noop;
    this._onHangup = noop;
    this._onAnswer = function(payload) {
        if (typeof payload.callsid !== 'undefined') {
            self.parameters.CallSid = payload.callsid;
            self.mediaStream.callSid = payload.callsid;
        }
    };

    var self = this;
    function createDefaultPayload() {
      var payload = {
        client_name: device._clientName,
        platform: rtc.getMediaEngine(),
        sdk_version: twutil.getReleaseVersion(),
        selected_region: device.options.region
      };

      if (self.parameters.CallSid && !(/^TJ/.test(self.parameters.CallSid))) {
        payload.call_sid = self.parameters.CallSid;
      }

      if (self.outboundConnectionId) {
        payload.temp_call_sid = self.outboundConnectionId;
      }

      if (device.stream) {
        if (device.stream.gateway) {
          payload.gateway = device.stream.gateway;
        }

        if (device.stream.region) {
          payload.region = device.stream.region;
        }
      }

      if (self._direction) {
        payload.direction = self._direction;
      }

      return payload;
    }

    var publisher = this._publisher = new Publisher('twilio-js-sdk', device.token, {
      host: device.options.eventgw,
      defaultPayload: createDefaultPayload
    });

    if (options.publishEvents === false) {
      publisher.disable();
    }

    if (this._direction === 'INCOMING') {
      publisher.info('connection', 'incoming');
    }

    var monitor = this._monitor = new RTCMonitor();

    // First 10 seconds or so are choppy, so let's not bother with these warnings.
    monitor.disableWarnings();

    var samples = [];

    function createMetricPayload() {
      var payload = {
        call_sid: self.parameters.CallSid,
        client_name: device._clientName,
        sdk_version: twutil.getReleaseVersion(),
        selected_region: device.options.region
      };

      if (device.stream) {
        if (device.stream.gateway) {
          payload.gateway = device.stream.gateway;
        }

        if (device.stream.region) {
          payload.region = device.stream.region;
        }
      }

      if (self._direction) {
        payload.direction = self._direction;
      }

      return payload;
    }

    function publishMetrics() {
      if (samples.length === 0) {
        return;
      }

      publisher.postMetrics(
        'quality-metrics-samples', 'metrics-sample', samples.splice(0), createMetricPayload()
      );
    }

    var samplesIgnored = 0;
    monitor.on('sample', function(sample) {
      // Enable warnings after we've ignored the an initial amount. This is to
      // avoid throwing false positive warnings initially.
      if (samplesIgnored < SAMPLES_TO_IGNORE) {
        samplesIgnored++;
      } else if (samplesIgnored === SAMPLES_TO_IGNORE) {
        monitor.enableWarnings();
      }

      samples.push(sample);
      if (samples.length >= METRICS_BATCH_SIZE) {
        publishMetrics();
      }
    });

    function formatPayloadForEA(warningData) {
      var payloadData = { threshold: warningData.threshold.value };

      if (warningData.values) {
        payloadData.values = warningData.values.map(function(value) {
          if (typeof value === 'number') {
            return Math.round(value * 100) / 100;
          }

          return value;
        });
      } else if (warningData.value) {
        payloadData.value = warningData.value;
      }

      return { data: payloadData };
    }

    function reemitWarning(wasCleared, warningData) {
      var groupPrefix = /^audio/.test(warningData.name) ?
        'audio-level-' : 'network-quality-';
      var groupSuffix = wasCleared ? '-cleared' : '-raised';
      var groupName = groupPrefix + 'warning' + groupSuffix;

      var warningPrefix = WARNING_PREFIXES[warningData.threshold.name];
      var warningName = warningPrefix + WARNING_NAMES[warningData.name];

      // Ignore constant input if the Connection is muted (Expected)
      if (warningName === 'constant-audio-input-level' && self.isMuted()) {
        return;
      }

      var level = wasCleared ? 'info' : 'warning';
      publisher.post(level, groupName, warningName, formatPayloadForEA(warningData));
    }

    monitor.on('warning-cleared', reemitWarning.bind(null, true));
    monitor.on('warning', reemitWarning.bind(null, false));

    /**
     * Reference to the Twilio.MediaStream object.
     * @type Twilio.MediaStream
     */
    this.mediaStream = new this.options["mediaStreamFactory"](
        this.options["encrypt"],
        this.device);

    this.mediaStream.oniceconnectionstatechange = function(state) {
      var level = state === 'failed' ? 'error' : 'debug';
      publisher.post(level, 'ice-connection-state', state);
    };

    this.mediaStream.onicegatheringstatechange = function(state) {
      publisher.debug('signaling-state', state);
    };

    this.mediaStream.onsignalingstatechange = function(state) {
      publisher.debug('signaling-state', state);
    };

    this.mediaStream.onerror = function(e) {
        if (e.disconnect === true) {
            self._disconnect(e.info && e.info.message);
        }
        var error = {
            code: e.info.code,
            message: e.info.message || "Error with mediastream",
            info: e.info,
            connection: self
        };

        self.log("Received an error from MediaStream:", e);
        self.emit("error", error);
    };

    this.mediaStream.onopen = function() {
        // NOTE(mroberts): While this may have been happening in previous
        // versions of Chrome, since Chrome 45 we have seen the
        // PeerConnection's onsignalingstatechange handler invoked multiple
        // times in the same signalingState "stable". When this happens, we
        // invoke this onopen function. If we invoke it twice without checking
        // for _status "open", we'd accidentally close the PeerConnection.
        //
        // See <https://code.google.com/p/webrtc/issues/detail?id=4996>.
        if (self._status === "open") {
            return;
        } else if (self._status === "connecting") {
            self._status = "open";
            self.mediaStream.attachAudio();
            self.emit("accept", self);
        } else {
            // call was probably canceled sometime before this
            self.mediaStream.close();
        }
    };

    this.mediaStream.onclose = function() {
        self._status = "closed";
        if (self.device.sounds.disconnect()) {
            self.device.soundcache.play("disconnect");
        }

        monitor.disable();
        publishMetrics();

        self.emit("disconnect", self);
    };

    // temporary call sid to be used for outgoing calls
    this.outboundConnectionId = twutil.generateConnectionUUID();

    this.pstream = this.device.stream;

    this._onCancel = function(payload) {
        var callsid = payload.callsid;
        if (self.parameters.CallSid == callsid) {
            self._status = "closed";
            self.emit("cancel");
            self.pstream.removeListener("cancel", self._onCancel);
        }
    };

    // NOTE(mroberts): The test "#sendDigits throws error" sets this to `null`.
    if (this.pstream)
        this.pstream.addListener("cancel", this._onCancel);

    this.on('error', function(error) {
        publisher.error('connection', 'error', {
          code: error.code, message: error.message
        });

        if (self.pstream && self.pstream.status === 'disconnected') {
            cleanupEventListeners(self);
        }
    });

    this.on('disconnect', function() {
        cleanupEventListeners(self);
    });

    return this;
}

util.inherits(Connection, EventEmitter);

/**
 * @return {string}
 */
Connection.toString = function() {
    return "[Twilio.Connection class]";
};

    /**
     * @return {string}
     */
Connection.prototype.toString = function() {
        return "[Twilio.Connection instance]";
};
Connection.prototype.sendDigits = function(digits) {
        if (digits.match(/[^0-9*#w]/)) {
            throw new Exception(
                "Illegal character passed into sendDigits");
        }

        var sequence = [];
        for(var i = 0; i < digits.length; i++) {
            var dtmf = digits[i] != "w" ? "dtmf" + digits[i] : "";
            if (dtmf == "dtmf*") dtmf = "dtmfs";
            if (dtmf == "dtmf#") dtmf = "dtmfh";
            sequence.push([dtmf, 200, 20]);
        }
        this.device.soundcache.playseq(sequence);

        var dtmfSender = this.mediaStream.getOrCreateDTMFSender();

        function insertDTMF(dtmfs) {
          if (!dtmfs.length) { return; }
          var dtmf = dtmfs.shift();

          if (dtmf.length) {
            dtmfSender.insertDTMF(dtmf, DTMF_TONE_DURATION, DTMF_INTER_TONE_GAP);
          }

          setTimeout(insertDTMF.bind(null, dtmfs), DTMF_PAUSE_DURATION);
        }

        if (dtmfSender) {
            if (dtmfSender.canInsertDTMF) {
              this.log('Sending digits using RTCDTMFSender');
              // NOTE(mroberts): We can't just map "w" to "," since
              // RTCDTMFSender's pause duration is 2 s and Twilio's is more
              // like 500 ms. Instead, we will fudge it with setTimeout.
              return insertDTMF(digits.split('w'));
            }
            this.log('RTCDTMFSender cannot insert DTMF');
        }

        // send pstream message to send DTMF
        this.log('Sending digits over PStream');
        if (this.pstream != null && this.pstream.status != "disconnected") {
            var payload = { dtmf: digits, callsid: this.parameters.CallSid };
            this.pstream.publish("dtmf", payload);
        } else {
            var payload = { error: {} };
            var error = {
                code: payload.error.code || 31000,
                message: payload.error.message || "Could not send DTMF: Signaling channel is disconnected",
                connection: this
            };
            this.emit("error", error);
        }
};
Connection.prototype.status = function() {
        return this._status;
};
    /**
     * Mute incoming audio.
     */
Connection.prototype.mute = function(muteParam) {
        if (arguments.length === 0) {
          this.log.deprecated('.mute() is deprecated. Please use .mute(true) or .mute(false) to mute or unmute a call instead.');
        }

        if (typeof muteParam == "function") {
            // if handler, register listener
            return this.addListener("mute",muteParam);
        }

        // change state if call results in transition
        var wasMuted = this.isMuted();
        var self = this;
        var callback = function() {
            var isMuted = self.isMuted();
            if (wasMuted != isMuted) {
                self._publisher.info('connection', isMuted ? 'muted' : 'unmuted');
                self.emit("mute",isMuted,self);
            }
        }

        if (muteParam == false) {
            // if explicitly false, unmute connection
            this.mediaStream.attachAudio(callback);
        } else {
            // if undefined or true, mute connection
            this.mediaStream.detachAudio(callback);
        }
};
    /**
     * Check if connection is muted
     */
Connection.prototype.isMuted = function() {
        return !this.mediaStream.isAudioAttached();
};
    /**
     * Unmute (Deprecated)
     */
Connection.prototype.unmute = function() {
        this.log.deprecated('.unmute() is deprecated. Please use .mute(false) to unmute a call instead.');
        this.mute(false);
};
Connection.prototype.accept = function(handler) {
        if (typeof handler == "function") {
            return this.addListener("accept", handler);
        }
        var audioConstraints = handler || this.options.audioConstraints;
        var self = this;
        this._status = "connecting";

        var connect_ = function(err) {
            if (self._status != "connecting") {
                // call must have been canceled
                cleanupEventListeners(self);
                self.mediaStream.close();
                return;
            }

            if (err) {
                if (err.code === 31208) {
                    self._publisher.error('get-user-media', 'denied', {
                      data: {
                        audioConstraints: audioConstraints,
                        error: err.error
                      }
                    });
                } else {
                    self._publisher.error('get-user-media', 'failed', {
                      data: {
                        audioConstraints: audioConstraints,
                        error: err.error
                      }
                    });
                }

                return self._die(err.message, err.code);
            }

            self._publisher.info('get-user-media', 'succeeded', {
              data: { audioConstraints: audioConstraints }
            });

            var pairs = [];
            for (var key in self.message) {
                pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(self.message[key]));
            }

            function onLocalAnswer(pc) {
              self._publisher.info('connection', 'accepted-by-local');
              self._monitor.enable(pc);
            }

            function onRemoteAnswer(pc) {
              self._publisher.info('connection', 'accepted-by-remote');
              self._monitor.enable(pc);
            }

            var params = pairs.join("&");
            if (self._direction === 'INCOMING') {
                self.mediaStream.answerIncomingCall.call(self.mediaStream, self.parameters.CallSid, self.options["offerSdp"], self.options.rtcConstraints, self.options.iceServers, onLocalAnswer);
            } else {
                self.pstream.once("answer", self._onAnswer);
                self.mediaStream.makeOutgoingCall.call(self.mediaStream, params, self.outboundConnectionId, self.options.rtcConstraints, self.options.iceServers, onRemoteAnswer);
            }

            self._onHangup = function(payload) {
                /**
                 *  see if callsid passed in message matches either callsid or outbound id
                 *  connection should always have either callsid or outbound id
                 *  if no callsid passed hangup anyways
                 */
                if (payload.callsid && (self.parameters.CallSid || self.outboundConnectionId)) {
                    if (payload.callsid != self.parameters.CallSid && payload.callsid != self.outboundConnectionId) {
                        return;
                    }
                } else if (payload.callsid) {
                    // hangup is for another connection
                    return;
                }

                self.log("Received HANGUP from gateway");
                if (payload.error) {
                    var error = {
                        code: payload.error.code || 31000,
                        message: payload.error.message || "Error sent from gateway in HANGUP",
                        connection: self
                    };
                    self.log("Received an error from the gateway:", error);
                    self.emit("error", error);
                }
                self.sendHangup = false;
                self._publisher.info('connection', 'disconnected-by-remote');
                self._disconnect();
                cleanupEventListeners(self);
            };
            self.pstream.addListener("hangup", self._onHangup);
        };
        this.mediaStream.openHelper(connect_, audioConstraints);
};
Connection.prototype.reject = function(handler) {
        if (typeof handler == "function") {
            return this.addListener("reject", handler);
        }
        if (this._status == "pending") {
            var payload = { callsid: this.parameters.CallSid }
            this.pstream.publish("reject", payload);
            this.emit("reject");
            this.mediaStream.reject(this.parameters.CallSid);
            this._publisher.info('connection', 'rejected-by-local');
        }
};
Connection.prototype.ignore = function(handler) {
        if (typeof handler == "function") {
            return this.addListener("cancel", handler);
        }
        if (this._status == "pending") {
            this._status = "closed";
            this.emit("cancel");
            this.mediaStream.ignore(this.parameters.CallSid);
            this._publisher.info('connection', 'ignored-by-local');
        }
};
Connection.prototype.cancel = function(handler) {
        this.log.deprecated('.cancel() is deprecated. Please use .ignore() instead.');
        this.ignore(handler);
};
Connection.prototype.disconnect = function(handler) {
    if (typeof handler === "function") {
        return this.addListener("disconnect", handler);
    }
    this._publisher.info('connection', 'disconnected-by-local');
    this._disconnect();
};
Connection.prototype._disconnect = function(message) {
        message = typeof message === 'string' ? message : null;
        if (this._status == "open" || this._status == "connecting") {
            this.log("Disconnecting...");

            // send pstream hangup message
            if (this.pstream != null && this.pstream.status != "disconnected" && this.sendHangup) {
                var callId = this.parameters.CallSid || this.outboundConnectionId;
                if (callId) {
                    var payload = { callsid: callId };
                    if (message) {
                        payload.message = message;
                    }
                    this.pstream.publish("hangup", payload);
                }
            }

            cleanupEventListeners(this);

            this.mediaStream.close();
        }
};
Connection.prototype.error = function(handler) {
        if (typeof handler == "function") {
            return this.addListener("error", handler);
        }
};
Connection.prototype._die = function(message,code) {
        this.emit("error", { message: message, code: code });
        this._disconnect();
};

function cleanupEventListeners(connection) {
  function cleanup() {
      connection.pstream.removeListener('answer', connection._onAnswer);
      connection.pstream.removeListener('cancel', connection._onCancel);
      connection.pstream.removeListener('hangup', connection._onHangup);
  }
  cleanup();
  // This is kind of a hack, but it lets us avoid rewriting more code.
  // Basically, there's a sequencing problem with the way PeerConnection raises
  // the
  //
  //   Cannot establish connection. Client is disconnected
  //
  // error in Connection#accept. It calls PeerConnection#onerror, which emits
  // the error event on Connection. An error handler on Connection then calls
  // cleanupEventListeners, but then control returns to Connection#accept. It's
  // at this point that we add a listener for the answer event that never gets
  // removed. setTimeout will allow us to rerun cleanup again, _after_
  // Connection#accept returns.
  setTimeout(cleanup, 0);
}

exports.Connection = Connection;

},{"./eventpublisher":5,"./log":7,"./rtc":11,"./rtc/monitor":12,"./util":19,"events":25,"util":29}],4:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var log = require("./log");
var twutil = require("./util");
var rtc = require("./rtc");
var Options = require("./options").Options;
var Sound = require("./sound").Sound;
var SoundCache = require('./soundcache').SoundCache;
var Connection = require('./connection').Connection;
var PStream = require('./pstream').PStream;

var REG_INTERVAL = 30000;

/**
 * Constructor for Device objects.
 *
 * @exports Device as Twilio.Device
 * @memberOf Twilio
 * @borrows EventEmitter#addListener as #addListener
 * @borrows EventEmitter#emit as #emit
 * @borrows EventEmitter#hasListener #hasListener
 * @borrows EventEmitter#removeListener as #removeListener
 * @borrows Twilio.mixinLog-log as #log
 * @constructor
 * @param {string} token The Twilio capabilities token
 * @param {object} [options]
 * @config {boolean} [debug=false]
 */
function Device(token, options) {
    if (!rtc.enabled()) {
        throw new twutil.Exception('twilio.js 1.3 requires WebRTC/ORTC browser support. '
            + 'For more information, see <https://www.twilio.com/docs/api/client/twilio-js>. '
            + 'If you have any questions about this announcement, please contact ' 
            + 'Twilio Support at <help@twilio.com>.');
    }

    if (!(this instanceof Device)) {
        return new Device(token, options);
    }
    twutil.monitorEventEmitter('Twilio.Device', this);
    if (!token) {
        throw new twutil.Exception("Capability token is not valid or missing.");
    }

    // copy options
    var origOptions = {};
    for (i in options) {
        origOptions[i] = options[i];
    }

    var defaults = {
        logPrefix: "[Device]",
        chunderw: "chunderw-vpc-gll.twilio.com",
        eventgw: "eventgw.twilio.com",
        soundCacheFactory: SoundCache,
        soundFactory: Sound,
        connectionFactory: Connection,
        pStreamFactory: PStream,
        noRegister: false,
        encrypt: false,
        closeProtection: false,
        secureSignaling: true,
        warnings: true,
        audioConstraints: true,
        iceServers: [],
        region: "gll",
        dscp: true,
        sounds: { }
    };
    options = options || {};
    var chunderw = options['chunderw'];
    for (var prop in defaults) {
        if (prop in options) continue;
        options[prop] = defaults[prop];
    }

    if (options.dscp) {
      options.rtcConstraints = {
        optional: [
          {
            googDscp: true
          }
        ]
      };
    } else {
      options.rtcConstraints = {};
    }

    var objectized = twutil.objectize(token);
    this._accountSid = objectized.iss;
    // TODO: Update _clientName when we add support for it in Twilio.Device.setup
    this._clientName = objectized.scope["client:incoming"]
      ? objectized.scope["client:incoming"].params.clientName : null;
    this.options = options;
    this.token = token;
    this._status = "offline";
    this._region = "offline";
    this.connections = [];
    this.sounds = new Options({
        incoming: true,
        outgoing: true,
        disconnect: true
    });

    log.mixinLog(this, this.options["logPrefix"]);
    this.log.enabled = this.options["debug"];

    var regions = {
        'gll': 'chunderw-vpc-gll.twilio.com',
        'au1': 'chunderw-vpc-gll-au1.twilio.com',
        'br1': 'chunderw-vpc-gll-br1.twilio.com',
        'ie1': 'chunderw-vpc-gll-ie1.twilio.com',
        'jp1': 'chunderw-vpc-gll-jp1.twilio.com',
        'sg1': 'chunderw-vpc-gll-sg1.twilio.com',
        'us1': 'chunderw-vpc-gll-us1.twilio.com'
    };
    var deprecatedRegions = {
        'au': 'au1',
        'br': 'br1',
        'ie': 'ie1',
        'jp': 'jp1',
        'sg': 'sg1',
        'us-va': 'us1',
        'us-or': 'us1'
    };
    var region = options['region'].toLowerCase();
    if (region in deprecatedRegions) {
        this.log.deprecated('Region ' + region + ' is deprecated, please use ' + deprecatedRegions[region] + '.');
        region = deprecatedRegions[region];
    }
    if (!(region in regions)) {
        throw new twutil.Exception('Region ' + options['region'] + ' is invalid. ' +
                                   'Valid values are: ' + Object.keys(regions).join(', '));
    }
    options['chunderw'] = chunderw || regions[region];

    this.soundcache = this.options["soundCacheFactory"]();

    // NOTE(mroberts): Node workaround.
    if (typeof document === 'undefined')
        var a = {};
    else
        var a = document.createElement("audio");
    canPlayMp3 = false;
    try {
       canPlayMp3 = !!(a.canPlayType && a.canPlayType('audio/mpeg').replace(/no/, ''));
    }
    catch (e) {
    }
    canPlayVorbis = false;
    try {
       canPlayVorbis = !!(a.canPlayType && a.canPlayType('audio/ogg;codecs="vorbis"').replace(/no/, ''));
    }
    catch (e) {
    }
    var ext = "mp3";
    if (canPlayVorbis && !canPlayMp3) {
       ext = "ogg";
    }

    var defaultSounds = {
      incoming: { filename: 'incoming', loop: true },
      outgoing: { filename: 'outgoing', maxDuration: 3000 },
      disconnect: { filename: 'disconnect', maxDuration: 3000 },
      dtmf1: { filename: 'dtmf-1', maxDuration: 1000 },
      dtmf2: { filename: 'dtmf-2', maxDuration: 1000 },
      dtmf3: { filename: 'dtmf-3', maxDuration: 1000 },
      dtmf4: { filename: 'dtmf-4', maxDuration: 1000 },
      dtmf5: { filename: 'dtmf-5', maxDuration: 1000 },
      dtmf6: { filename: 'dtmf-6', maxDuration: 1000 },
      dtmf7: { filename: 'dtmf-7', maxDuration: 1000 },
      dtmf8: { filename: 'dtmf-8', maxDuration: 1000 },
      dtmf9: { filename: 'dtmf-9', maxDuration: 1000 },
      dtmf0: { filename: 'dtmf-0', maxDuration: 1000 },
      dtmfs: { filename: 'dtmf-star', maxDuration: 1000 },
      dtmfh: { filename: 'dtmf-hash', maxDuration: 1000 }
    };

    var base = twutil.getTwilioRoot() + 'sounds/releases/' + twutil.getSoundVersion() + '/';
    for (var name in defaultSounds) {
      var soundDef = defaultSounds[name];
      var sound = this.options.soundFactory(soundDef);

      var defaultUrl = base + soundDef.filename + '.' + ext;
      sound.load(defaultUrl);

      this.soundcache.add(name, sound);
    }

    // Minimum duration for incoming ring
    this.soundcache.envelope("incoming", { release: 2000 });

    var device = this;
    this.addListener("incoming", function(connection) {
        connection.once("accept", function() {
            device.soundcache.stop("incoming");
        });
        connection.once("cancel", function() {
            device.soundcache.stop("incoming");
        });
        connection.once("error", function() {
            device.soundcache.stop("incoming");
        });
        connection.once("reject", function() {
            device.soundcache.stop("incoming");
        });
        if (device.sounds.incoming()) {
            device.soundcache.play("incoming", 0, 1000);
        }
    });

    // setup flag for allowing presence for media types
    this.mediaPresence = { audio: !this.options["noRegister"] };

    // setup stream
    this.register(this.token);

    var self = this;
    var closeProtection = this.options["closeProtection"];
    if (closeProtection) {
        var confirmClose = function(event) {
            if (device._status == "busy" || self.connections[0]) {
                var defaultMsg = "A call is currently in-progress. Leaving or reloading this page will end the call.";
                var confirmationMsg = closeProtection == true ? defaultMsg : closeProtection;
                (event || window.event).returnValue = confirmationMsg;
                return confirmationMsg;
            }
        };
        if (typeof window !== 'undefined') {
            if (window.addEventListener) {
                window.addEventListener("beforeunload", confirmClose);
            } else if (window.attachEvent) {
                window.attachEvent("onbeforeunload", confirmClose);
            }
        }
    }

    // close connections on unload
    var onClose = function() {
        device.disconnectAll();
    }
    if (typeof window !== 'undefined') {
        if (window.addEventListener) {
            window.addEventListener("unload", onClose);
        } else if (window.attachEvent) {
            window.attachEvent("onunload", onClose);
        }
    }

    // NOTE(mroberts): EventEmitter requires that we catch all errors.
    this.on('error', function(){});

    return this;
}

util.inherits(Device, EventEmitter);

function makeConnection(device, params, options) {
    var defaults = {
        publishEvents: device.options.publishEvents,
        debug: device.options.debug,
        encrypt: device.options.encrypt,
        warnings: device.options.warnings
    };

    options = options || {};
    for (var prop in defaults) {
        if (prop in options) continue;
        options[prop] = defaults[prop];
    }

    var connection = device.options["connectionFactory"](device, params, options);

    connection.once("accept", function() {
        device._status = "busy";
        device.emit("connect", connection);
    });
    connection.addListener("error", function(error) {
        device.emit("error", error);
        // Only drop connection from device if it's pending
        if (connection.status() != "pending" || connection.status() != "connecting") return;
        device._removeConnection(connection);
    });
    connection.once("cancel", function() {
        device.log("Canceled: " + connection.parameters["CallSid"]);
        device._removeConnection(connection);
        device.emit("cancel", connection);
    });
    connection.once("disconnect", function() {
        if (device._status == "busy") device._status = "ready";
        device.emit("disconnect", connection);
        device._removeConnection(connection);
    });
    connection.once("reject", function() {
        device.log("Rejected: " + connection.parameters["CallSid"]);
        device._removeConnection(connection);
    });

    return connection;
}

/**
 * @return {string}
 */
Device.toString = function() {
    return "[Twilio.Device class]";
};

    /**
     * @return {string}
     */
Device.prototype.toString = function() {
        return "[Twilio.Device instance]";
};
Device.prototype.register = function(token) {
        if (this.stream && this.stream.status != "disconnected") {
            this.stream.setToken(token);
        } else {
            this._setupStream();
        }
};
Device.prototype.registerPresence = function() {
        if (!this.token) {
            return;
        }

        // check token, if incoming capable then set mediaPresence capability to true
        var tokenIncomingObject = twutil.objectize(this.token).scope["client:incoming"];
        if (tokenIncomingObject) {
            this.mediaPresence.audio = true;
        }

        this._sendPresence();
};
Device.prototype.unregisterPresence = function() {
        this.mediaPresence.audio = false;
        this._sendPresence();
};
Device.prototype.connect = function(params, audioConstraints) {
        if (typeof params == "function") {
            return this.addListener("connect", params);
        }
        params = params || {};
        audioConstraints = audioConstraints || this.options.audioConstraints;
        var connection = makeConnection(this, params);
        this.connections.push(connection);
        if (this.sounds.outgoing()) {
            var self = this;
            connection.accept(function() {
                self.soundcache.play("outgoing");
            });
        }
        connection.accept(audioConstraints);
        return connection;
};
Device.prototype.disconnectAll = function() {
        // Create a copy of connections before iterating, because disconnect
        // will trigger callbacks which modify the connections list. At the end
        // of the iteration, this.connections should be an empty list.
        var connections = [].concat(this.connections);
        for (var i = 0; i < connections.length; i++) {
            connections[i].disconnect();
        }
        if (this.connections.length > 0) {
            this.log("Connections left pending: " + this.connections.length);
        }
};
Device.prototype.destroy = function() {
        this._stopRegistrationTimer();
        if (this.stream) {
            this.stream.destroy();
            this.stream = null;
        }
};
Device.prototype.disconnect = function(handler) {
        this.addListener("disconnect", handler);
};
Device.prototype.incoming = function(handler) {
        this.addListener("incoming", handler);
};
Device.prototype.offline = function(handler) {
        this.addListener("offline", handler);
};
Device.prototype.ready = function(handler) {
        this.addListener("ready", handler);
};
Device.prototype.error = function(handler) {
        this.addListener("error", handler);
};
Device.prototype.status = function() {
        return this._status;
};
Device.prototype.activeConnection = function() {
        // TODO: fix later, for now just pass back first connection
        return this.connections[0];
};
Device.prototype.region = function() {
        return this._region;
};
Device.prototype._sendPresence = function() {
        this.stream.register(this.mediaPresence);
        if (this.mediaPresence.audio) {
            this._startRegistrationTimer();
        } else {
            this._stopRegistrationTimer();
        }
};
Device.prototype._startRegistrationTimer = function() {
        clearTimeout(this.regTimer);
        var self = this;
        this.regTimer = setTimeout( function() {
            self._sendPresence();
        },REG_INTERVAL);
};
Device.prototype._stopRegistrationTimer = function() {
        clearTimeout(this.regTimer);
};
Device.prototype._setupStream = function() {
        var device = this;
        this.log("Setting up PStream");
        var streamOptions = {
            chunderw: this.options["chunderw"],
            debug: this.options["debug"],
            secureSignaling: this.options["secureSignaling"]
        };
        this.stream = this.options["pStreamFactory"](this.token, streamOptions);
        this.stream.addListener("connected", function(payload) {
            var regions = {
                'US_EAST_VIRGINIA': 'us1',
                'US_WEST_OREGON': 'us2',
                'ASIAPAC_SYDNEY': 'au1',
                'SOUTH_AMERICA_SAO_PAULO': 'br1',
                'EU_IRELAND': 'ie1',
                'ASIAPAC_TOKYO': 'jp1',
                'ASIAPAC_SINGAPORE': 'sg1'
            };
            device._region = regions[payload["region"]] || payload["region"];
            device._sendPresence();
        });
        this.stream.addListener("ready", function() {
            device.log("Stream is ready");
            if (device._status == "offline") device._status = "ready";
            device.emit("ready", device);
        });
        this.stream.addListener("offline", function() {
            device.log("Stream is offline");
            device._status = "offline";
            device._region = "offline";
            device.emit("offline", device);
        });
        this.stream.addListener("error", function(payload) {
            var error = payload.error;
            if (error) {
                if (payload.callsid) {
                    error.connection = device._findConnection(payload.callsid);
                }
                // Stop trying to register presence after token expires
                if (error.code === 31205) {
                    device._stopRegistrationTimer();
                }
                device.log("Received error: ",error);
                device.emit("error", error);
            }
        });
        this.stream.addListener("invite", function(payload) {
            if (device._status == "busy") {
                device.log("Device busy; ignoring incoming invite");
                return;
            }

            if (!payload["callsid"] || !payload["sdp"]) {
                device.emit("error", { message: "Malformed invite from gateway" });
                return;
            }

            var params = payload.parameters || { };
            params.CallSid = params.CallSid || payload.callsid;

            var connection = makeConnection(device, {}, {
              offerSdp: payload.sdp,
              callParameters: params
            });

            device.connections.push(connection);
            device.emit("incoming", connection);
        });
};
Device.prototype._removeConnection = function(connection) {
        for (var i = this.connections.length - 1; i >= 0; i--) {
            if (connection == this.connections[i]) {
                this.connections.splice(i, 1);
            }
        }
};
Device.prototype._findConnection = function(callsid) {
        for (var i = 0; i < this.connections.length; i++) {
            var conn = this.connections[i];
            if (conn.parameters.CallSid == callsid || conn.outboundConnectionId == callsid) {
                return conn;
            }
        }
};

function singletonwrapper(cls) {
    var afterSetup = [];
    var tasks = [];
    var queue = function(task) {
        if (cls.instance) return task();
        tasks.push(task);
    };
    var defaultErrorHandler = function(error) {
        var err_msg = (error.code ? error.code + ": " : "") + error.message;
        if (cls.instance) {
            // The defaultErrorHandler throws an Exception iff there are no
            // other error handlers registered on a Device instance. To check
            // this, we need to count up the number of error handlers
            // registered, excluding our own defaultErrorHandler.
            var n = 0;
            var listeners = cls.instance.listeners('error');
            for (var i = 0; i < listeners.length; i++) {
                if (listeners[i] !== defaultErrorHandler) {
                    n++;
                }
            }
            // Note that there is always one default, noop error handler on
            // each of our EventEmitters.
            if (n > 1) {
                return;
            }
            cls.instance.log(err_msg);
        }
        throw new twutil.Exception(err_msg);
    };
    var members = /** @lends Twilio.Device */ {
        /**
         * Instance of Twilio.Device.
         *
         * @type Twilio.Device
         */
        instance: null,
        /**
         * @param {string} token
         * @param {object} [options]
         * @return {Twilio.Device}
         */
        setup: function(token, options) {
            if (cls.instance) {
                cls.instance.log("Found existing Device; using new token but ignoring options");
                cls.instance.token = token;
                cls.instance.register(token);
            } else {
                cls.instance = new Device(token, options);
                cls.error(defaultErrorHandler);
                cls.sounds = cls.instance.sounds;
                for (var i = 0; i < tasks.length; i++) {
                    tasks[i]();
                }
                tasks = [];
            }
            for (var i = 0; i < afterSetup.length; i++) {
                afterSetup[i](token, options);
            }
            afterSetup = [];
            return cls;
        },

        /**
         * Connects to Twilio.
         *
         * @param {object} parameters
         * @return {Twilio.Connection}
         */
        connect: function(parameters, audioConstraints) {
            if (typeof parameters == "function") {
                queue(function() {
                    cls.instance.addListener("connect", parameters);
                });
                return;
            }
            if (!cls.instance) {
                throw new twutil.Exception("Run Twilio.Device.setup()");
            }
            if (cls.instance.connections.length > 0) {
                cls.instance.emit("error",
                    { message: "A connection is currently active" });
                return;
            }
            return cls.instance.connect(parameters, audioConstraints);
        },

        /**
         * @return {Twilio.Device}
         */
        disconnectAll: function() {
            queue(function() {
                cls.instance.disconnectAll();
            });
            return cls;
        },
        /**
         * @param {function} handler
         * @return {Twilio.Device}
         */
        disconnect: function(handler) {
            queue(function() {
                cls.instance.addListener("disconnect", handler);
            });
            return cls;
        },
        status: function() {
            if (!cls.instance) {
                throw new twutil.Exception("Run Twilio.Device.setup()");
            }
            return cls.instance.status();
        },
        region: function() {
            if (!cls.instance) {
                throw new twutil.Exception("Run Twilio.Device.setup()");
            }
            return cls.instance.region();
        },
        /**
         * @param {function} handler
         * @return {Twilio.Device}
         */
        ready: function(handler) {
            queue(function() {
                cls.instance.addListener("ready", handler);
            });
            return cls;
        },

        /**
         * @param {function} handler
         * @return {Twilio.Device}
         */
        error: function(handler) {
            queue(function() {
                if (handler != defaultErrorHandler) {
                    cls.instance.removeListener("error", defaultErrorHandler);
                }
                cls.instance.addListener("error", handler);
            });
            return cls;
        },

        /**
         * @param {function} handler
         * @return {Twilio.Device}
         */
        offline: function(handler) {
            queue(function() {
                cls.instance.addListener("offline", handler);
            });
            return cls;
        },

        /**
         * @param {function} handler
         * @return {Twilio.Device}
         */
        incoming: function(handler) {
            queue(function() {
                cls.instance.addListener("incoming", handler);
            });
            return cls;
        },

        /**
         * @return {Twilio.Device}
         */
        destroy: function() {
            if (cls.instance) cls.instance.destroy();
            return cls;
        },

        /**
         * @return {Twilio.Device}
         */
        cancel: function(handler) {
            queue(function() {
                cls.instance.addListener("cancel", handler);
            });
            return cls;
        },

        activeConnection: function() {
            if (!cls.instance) {
                return null;
            }
            return cls.instance.activeConnection();
        }
    };

    for (var method in members) {
        cls[method] = members[method];
    }

    return cls;
}

Device = singletonwrapper(Device);

exports.Device = Device;

},{"./connection":3,"./log":7,"./options":8,"./pstream":9,"./rtc":11,"./sound":16,"./soundcache":17,"./util":19,"events":25,"util":29}],5:[function(require,module,exports){
'use strict';

var request = require('./request');

/**
 * Builds Endpoint Analytics (EA) event payloads and sends them to
 *   the EA server.
 * @constructor
 * @param {String} productName - Name of the product publishing events.
 * @param {String} token - The JWT token to use to authenticate with
 *   the EA server.
 * @param {EventPublisher.Options} options
 * @property {Boolean} isEnabled - Whether or not this publisher is publishing
 *   to the server. Currently ignores the request altogether, in the future this
 *   may store them in case publishing is re-enabled later. Defaults to true.
 *//**
 * @typedef {Object} EventPublisher.Options
 * @property {String} [host='eventgw.twilio.com'] - The host address of the EA
 *   server to publish to.
 * @property {Object|Function} [defaultPayload] - A default payload to extend
 *   when creating and sending event payloads. Also takes a function that
 *   should return an object representing the default payload. This is
 *   useful for fields that should always be present when they are
 *   available, but are not always available.
 */
function EventPublisher(productName, token, options) {
  if (!(this instanceof EventPublisher)) {
    return new EventPublisher(productName, token, options);
  }

  // Apply default options
  options = Object.assign({
    defaultPayload: function() { return { }; },
    host: 'eventgw.twilio.com'
  }, options);

  var defaultPayload = options.defaultPayload;

  if (typeof defaultPayload !== 'function') {
    defaultPayload = function() { return Object.assign({ }, options.defaultPayload); }
  }

  var isEnabled = true;
  Object.defineProperties(this, {
    _defaultPayload: { value: defaultPayload },
    _isEnabled: {
      get: function() { return isEnabled; },
      set: function(_isEnabled) { isEnabled = _isEnabled; }
    },
    _host: { value: options.host },
    isEnabled: {
      enumerable: true,
      get: function() { return isEnabled },
    },
    productName: { enumerable: true, value: productName },
    token: { enumerable: true, value: token }
  });
}

/**
 * Post to an EA server.
 * @private
 * @param {String} endpointName - Endpoint to post the event to
 * @param {String} level - ['debug', 'info', 'warning', 'error']
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @param {?Boolean} [force=false] - Whether or not to send this even if
 *    publishing is disabled.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype._post = function _post(endpointName, level, group, name, payload, force) {
  if (!this.isEnabled && !force) { return Promise.resolve(); }

  var event = {
    publisher: this.productName,
    group: group,
    name: name,
    timestamp: (new Date()).toISOString(),
    level: level.toUpperCase(),
    payload_type: 'application/json',
    private: false,
    payload: (payload && payload.forEach) ?
      payload.slice(0) : Object.assign(this._defaultPayload(), payload)
  };

  var requestParams = {
    url: 'https://' + this._host + '/v2/' + endpointName,
    body: event,
    headers: {
      'Content-Type': 'application/json',
      'X-Twilio-Token': this.token
    }
  };

  return new Promise(function(resolve, reject) {
    request.post(requestParams, function(err) {
      if (err) { reject(err); }
      else { resolve(); }
    });
  });
};

/**
 * Post an event to the EA server. Use this method when the level
 *  is dynamic. Otherwise, it's better practice to use the sugar
 *  methods named for the specific level.
 * @param {String} level - ['debug', 'info', 'warning', 'error']
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.post = function post(level, group, name, payload, force) {
  return this._post('EndpointEvents', level, group, name, payload, force);
};

/**
 * Post a debug-level event to the EA server.
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.debug = function debug(group, name, payload) {
  return this.post('debug', group, name, payload);
};

/**
 * Post an info-level event to the EA server.
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.info = function info(group, name, payload) {
  return this.post('info', group, name, payload);
};

/**
 * Post a warning-level event to the EA server.
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.warn = function warn(group, name, payload) {
  return this.post('warning', group, name, payload);
};

/**
 * Post an error-level event to the EA server.
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {?Object} [payload=null] - The payload to pass. This will be extended
 *    onto the default payload object, if one exists.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.error = function error(group, name, payload) {
  return this.post('error', group, name, payload);
};

/**
 * Post a metrics event to the EA server.
 * @param {String} group - The name of the group the event belongs to.
 * @param {String} name - The designated event name.
 * @param {Array<Object>} metrics - The metrics to post.
 * @param {?Object} [customFields] - Custom fields to append to each payload.
 * @returns {Promise} Fulfilled if the HTTP response is 20x.
 */
EventPublisher.prototype.postMetrics = function postMetrics(group, name, metrics, customFields) {
  var samples = metrics
    .map(formatMetric)
    .map(function(sample) {
      return Object.assign(sample, customFields);
    });
  return this._post('EndpointMetrics', 'info', group, name, samples);
};

/**
 * Enable the publishing of events.
 */
EventPublisher.prototype.enable = function enable() {
  this._isEnabled = true;
};

/**
 * Disable the publishing of events.
 */
EventPublisher.prototype.disable = function disable() {
  this._isEnabled = false;
};

function formatMetric(sample) {
  return {
    timestamp: (new Date(sample.timestamp)).toISOString(),
    total_packets_received: sample.totals.packetsReceived,
    total_packets_lost: sample.totals.packetsLost,
    total_packets_sent: sample.totals.packetsSent,
    total_bytes_received: sample.totals.bytesReceived,
    total_bytes_sent: sample.totals.bytesSent,
    packets_received: sample.packetsReceived,
    packets_lost: sample.packetsLost,
    packets_lost_fraction: sample.packetsLostFraction &&
      (Math.round(sample.packetsLostFraction * 100) / 100),
    audio_level_in: sample.audioInputLevel,
    audio_level_out: sample.audioOutputLevel,
    codec_name: sample.codecName,
    local_candidate_address: sample.candidatePair.localAddress,
    local_candidate_id: sample.candidatePair.localCandidateId,
    local_candidate_type: sample.candidatePair.localCandidateType,
    remote_candidate_address: sample.candidatePair.remoteAddress,
    remote_candidate_id: sample.candidatePair.remoteCandidateId,
    remote_candidate_type: sample.candidatePair.remoteCandidateType,
    candidate_transport_type: sample.candidatePair.transportType,
    jitter: sample.jitter,
    rtt: sample.rtt,
    mos: sample.mos && (Math.round(sample.mos * 100) / 100)
  };
}

module.exports = EventPublisher;

},{"./request":10}],6:[function(require,module,exports){
/**
 * Heartbeat just wants you to call <code>beat()</code> every once in a while.
 *
 * <p>It initializes a countdown timer that expects a call to
 * <code>Hearbeat#beat</code> every n seconds. If <code>beat()</code> hasn't
 * been called for <code>#interval</code> seconds, it emits a
 * <code>onsleep</code> event and waits. The next call to <code>beat()</code>
 * emits <code>onwakeup</code> and initializes a new timer.</p>
 *
 * <p>For example:</p>
 *
 * @example
 *
 *     >>> hb = new Heartbeat({
 *     ...   interval: 10,
 *     ...   onsleep: function() { console.log('Gone to sleep...Zzz...'); },
 *     ...   onwakeup: function() { console.log('Awake already!'); },
 *     ... });
 *
 *     >>> hb.beat(); # then wait 10 seconds
 *     Gone to sleep...Zzz...
 *     >>> hb.beat();
 *     Awake already!
 *
 * @exports Heartbeat as Twilio.Heartbeat
 * @memberOf Twilio
 * @constructor
 * @param {object} opts Options for Heartbeat
 * @config {int} [interval=10] Seconds between each call to <code>beat</code>
 * @config {function} [onsleep] Callback for sleep events
 * @config {function} [onwakeup] Callback for wakeup events
 */
function Heartbeat(opts) {
    if (!(this instanceof Heartbeat)) return new Heartbeat(opts);
    opts = opts || {};
    /** @ignore */
    var noop = function() { };
    var defaults = {
        interval: 10,
        now: function() { return new Date().getTime() },
        repeat: function(f, t) { return setInterval(f, t) },
        stop: function(f, t) { return clearInterval(f, t) },
        onsleep: noop,
        onwakeup: noop
    };
    for (var prop in defaults) {
        if (prop in opts) continue;
        opts[prop] = defaults[prop];
    }
    /**
     * Number of seconds with no beat before sleeping.
     * @type number
     */
    this.interval = opts.interval;
    this.lastbeat = 0;
    this.pintvl = null;

    /**
     * Invoked when this object has not received a call to <code>#beat</code>
     * for an elapsed period of time greater than <code>#interval</code>
     * seconds.
     *
     * @event
     */
    this.onsleep = opts.onsleep;

    /**
     * Invoked when this object is sleeping and receives a call to
     * <code>#beat</code>.
     *
     * @event
     */
    this.onwakeup = opts.onwakeup;

    this.repeat = opts.repeat;
    this.stop = opts.stop;
    this.now = opts.now;
}

/**
 * @return {string}
 */
Heartbeat.toString = function() {
    return "[Twilio.Heartbeat class]";
};

    /**
     * @return {string}
     */
Heartbeat.prototype.toString = function() {
        return "[Twilio.Heartbeat instance]";
};
    /**
     * Keeps the instance awake (by resetting the count down); or if asleep,
     * wakes it up.
     */
Heartbeat.prototype.beat = function() {
        this.lastbeat = this.now();
        if (this.sleeping()) {
            if (this.onwakeup) {
                this.onwakeup();
            }
            var self = this;
            this.pintvl = this.repeat.call(
                null,
                function() { self.check() },
                this.interval * 1000
            );
        }
};
    /**
     * Goes into a sleep state if the time between now and the last heartbeat
     * is greater than or equal to the specified <code>interval</code>.
     */
Heartbeat.prototype.check = function() {
        var timeidle = this.now() - this.lastbeat;
        if (!this.sleeping() && timeidle >= this.interval * 1000) {
            if (this.onsleep) {
                this.onsleep();
            }
            this.stop.call(null, this.pintvl);

            this.pintvl = null;
        }
};
    /**
     * @return {boolean} True if sleeping
     */
Heartbeat.prototype.sleeping = function() {
        return this.pintvl == null;
};
exports.Heartbeat = Heartbeat;

},{}],7:[function(require,module,exports){
/**
 * Bestow logging powers.
 *
 * @exports mixinLog as Twilio.mixinLog
 * @memberOf Twilio
 *
 * @param {object} object The object to bestow logging powers to
 * @param {string} [prefix] Prefix log messages with this
 *
 * @return {object} Return the object passed in
 */
function mixinLog(object, prefix) {
    /**
     * Logs a message or object.
     *
     * <p>There are a few options available for the log mixin. Imagine an object
     * <code>foo</code> with this function mixed in:</p>
     *
     * <pre><code>var foo = {};
     * Twilio.mixinLog(foo);
     *
     * </code></pre>
     *
     * <p>To enable or disable the log: <code>foo.log.enabled = true</code></p>
     *
     * <p>To modify the prefix: <code>foo.log.prefix = "Hello"</code></p>
     *
     * <p>To use a custom callback instead of <code>console.log</code>:
     * <code>foo.log.handler = function() { ... };</code></p>
     *
     * @param *args Messages or objects to be logged
     */
    function log() {
        if (!log.enabled) {
            return;
        }
        var format = log.prefix ? log.prefix + " " : "";
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            log.handler(
                typeof arg == "string"
                ? format + arg
                : arg
            );
        }
    };

    function defaultWarnHandler(x) {
      if (typeof console !== 'undefined') {
        if (typeof console.warn === 'function') {
          console.warn(x);
        } else if (typeof console.log === 'function') {
          console.log(x);
        }
      }
    }

    function deprecated() {
        if (!log.warnings) {
            return;
        }
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            log.warnHandler(arg);
        }
    };

    log.enabled = true;
    log.prefix = prefix || "";
    /** @ignore */
    log.defaultHandler = function(x) { typeof console !== 'undefined' && console.log(x); };
    log.handler = log.defaultHandler;
    log.warnings = true;
    log.defaultWarnHandler = defaultWarnHandler;
    log.warnHandler = log.defaultWarnHandler;
    log.deprecated = deprecated;

    object.log = log;
}
exports.mixinLog = mixinLog;

},{}],8:[function(require,module,exports){
var Options = (function() {
    function Options(defaults, assignments) {
        if (!(this instanceof Options)) {
            return new Options(defaults);
        }
        this.__dict__ = {};
        defaults = defaults || {};
        assignments = assignments || {};
        for (var name in defaults) {
            this[name] = makeprop(this.__dict__, name);
            this[name](defaults[name]);
        }
        for (var name in assignments) {
            this[name](assignments[name]);
        }
    }

    function makeprop(__dict__, name) {
        return function(value) {
            return typeof value == "undefined"
                ? __dict__[name]
                : __dict__[name] = value;
        };
    }
    return Options;
})();

exports.Options = Options;

},{}],9:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var log = require("./log");
var twutil = require("./util");
var rtc = require("./rtc");

var Heartbeat = require("./heartbeat").Heartbeat;
var WSTransport = require('./wstransport').WSTransport;

/**
 * Constructor for PStream objects.
 *
 * @exports PStream as Twilio.PStream
 * @memberOf Twilio
 * @borrows EventEmitter#addListener as #addListener
 * @borrows EventEmitter#removeListener as #removeListener
 * @borrows EventEmitter#emit as #emit
 * @borrows EventEmitter#hasListener as #hasListener
 * @constructor
 * @param {string} token The Twilio capabilities JWT
 * @param {object} [options]
 * @config {boolean} [options.debug=false] Enable debugging
 */
function PStream(token, options) {
    if (!(this instanceof PStream)) {
        return new PStream(token, options);
    }
    twutil.monitorEventEmitter('Twilio.PStream', this);
    var defaults = {
        logPrefix: "[PStream]",
        chunderw: "chunderw-vpc-gll.twilio.com",
        secureSignaling: true,
        transportFactory: WSTransport,
        debug: false
    };
    options = options || {};
    for (var prop in defaults) {
        if (prop in options) continue;
        options[prop] = defaults[prop];
    }
    this.options = options;
    this.token = token || "";
    this.status = "disconnected";
    this.host = this.options["chunderw"];
    this.gateway = null;
    this.region = null;

    log.mixinLog(this, this.options["logPrefix"]);
    this.log.enabled = this.options["debug"];

    // NOTE(mroberts): EventEmitter requires that we catch all errors.
    this.on('error', function(){});

    /*
    *events used by device
    *"invite",
    *"ready",
    *"error",
    *"offline",
    *
    *"cancel",
    *"presence",
    *"roster",
    *"answer",
    *"candidate",
    *"hangup"
    */

    var self = this;

    this.addListener("ready", function() {
        self.status = "ready";
    });
    this.addListener("offline", function() {
        self.status = "offline";
    });
    this.addListener("close", function() {
        self.destroy();
    });

    var opt = {
        host: this.host,
        debug: this.options["debug"],
        secureSignaling: this.options["secureSignaling"]
    };
    this.transport = this.options["transportFactory"](opt);
    this.transport.onopen = function() {
        self.status = "connected";
        self.setToken(self.token);
    };
    this.transport.onclose = function() {
        if (self.status != "disconnected") {
            if (self.status != "offline") {
                self.emit("offline", self);
            }
            self.status = "disconnected";
        }
    };
    this.transport.onerror = function(err) {
        self.emit("error", err);
    };
    this.transport.onmessage = function(msg) {
        var objects = twutil.splitObjects(msg.data);
        for (var i = 0; i < objects.length; i++) {
            var obj = JSON.parse(objects[i]);
            var event_type = obj["type"];
            var payload = obj["payload"] || {};

            if (payload['gateway']) {
                self.gateway = payload['gateway'];
            }

            if (payload['region']) {
                self.region  = payload['region'];
            }

            // emit event type and pass the payload
            self.emit(event_type, payload);
        }
    };
    this.transport.open();

    return this;
}

util.inherits(PStream, EventEmitter);

/**
 * @return {string}
 */
PStream.toString = function() {
    return "[Twilio.PStream class]";
};

PStream.prototype.toString = function() {
                  return "[Twilio.PStream instance]";
};
PStream.prototype.setToken = function(token) {
                  this.log("Setting token and publishing listen");
                  this.token = token;
                  var payload = {
                      "token": token,
                      "browserinfo": twutil.getSystemInfo()
                  };
                  this.publish("listen", payload);
};
PStream.prototype.register = function(mediaCapabilities) {
                  var regPayload = {
                      media: mediaCapabilities
                  };
                  this.publish("register", regPayload);
};
PStream.prototype.destroy = function() {
                 this.log("Closing PStream");
                 this.transport.close();
                 return this;
};
PStream.prototype.publish = function (type, payload) {
                      var msg = JSON.stringify(
                              {
                                "type": type,
                                "version": twutil.getPStreamVersion(),
                                "payload": payload
                              });
                      this.transport.send(msg);
};

exports.PStream = PStream;

},{"./heartbeat":6,"./log":7,"./rtc":11,"./util":19,"./wstransport":20,"events":25,"util":29}],10:[function(require,module,exports){
'use strict';

var XHR = typeof XMLHttpRequest === 'undefined'
        ? require('xmlhttprequest').XMLHttpRequest
        /* istanbul ignore next: external dependency */
        : XMLHttpRequest;

function request(method, params, callback) {
        var options = {};
        options.xmlHttpRequestFactory = options.xmlHttpRequestFactory || XHR;
        var xhr = new options.xmlHttpRequestFactory();

        xhr.open(method, params.url, true);
        xhr.onreadystatechange = function onreadystatechange() {
          if (xhr.readyState !== 4) { return; }

          if (200 <= xhr.status && xhr.status < 300) {
            callback(null, xhr.responseText);
          } else {
            callback(new Error(xhr.responseText));
          }
        };

        for (var headerName in params.headers) {
          xhr.setRequestHeader(headerName, params.headers[headerName]);
        }

        xhr.send(JSON.stringify(params.body));
}
/**
 * Use XMLHttpRequest to get a network resource.
 * @param {String} method - HTTP Method
 * @param {Object} params - Request parameters
 * @param {String} params.url - URL of the resource
 * @param {Array}  params.headers - An array of headers to pass [{ headerName : headerBody }]
 * @param {Object} params.body - A JSON body to send to the resource
 * @returns {response}
 **/
var Request = request;

/**
 * Sugar function for request('GET', params, callback);
 * @param {Object} params - Request parameters
 * @param {Request~get} callback - The callback that handles the response.
 */
Request.get = function get(params, callback) {
    return new this('GET', params, callback);
};

/**
 * Sugar function for request('POST', params, callback);
 * @param {Object} params - Request parameters
 * @param {Request~post} callback - The callback that handles the response.
 */
Request.post = function post(params, callback) {
    return new this('POST', params, callback);
};

module.exports = Request;

},{"xmlhttprequest":44}],11:[function(require,module,exports){
var PeerConnection = require('./peerconnection');

function enabled(set) {
  if (typeof set !== 'undefined') {
    PeerConnection.enabled = set;
  }
  return PeerConnection.enabled;
}

function getMediaEngine() {
   return typeof RTCIceGatherer !== 'undefined' ? 'ORTC' : 'WebRTC';
}

module.exports = {
  enabled: enabled,
  getMediaEngine: getMediaEngine,
  PeerConnection: PeerConnection
}

},{"./peerconnection":14}],12:[function(require,module,exports){
'use strict';

var EventEmitter = require('events').EventEmitter;
var getStatistics = require('./stats');
var inherits = require('util').inherits;
var Mos = require('./mos');

// How many samples we use when testing metric thresholds
var SAMPLE_COUNT_METRICS = 5;

// How many samples that need to cross the threshold to
// raise or clear a warning.
var SAMPLE_COUNT_CLEAR = 0;
var SAMPLE_COUNT_RAISE = 3;

var SAMPLE_INTERVAL = 1000;
var WARNING_TIMEOUT = 5 * 1000;

/**
 * @typedef {Object} RTCMonitor.ThresholdOptions
 * @property {RTCMonitor.ThresholdOption} [audioInputLevel] - Rules to apply to sample.audioInputLevel
 * @property {RTCMonitor.ThresholdOption} [audioOutputLevel] - Rules to apply to sample.audioOutputLevel
 * @property {RTCMonitor.ThresholdOption} [packetsLostFraction] - Rules to apply to sample.packetsLostFraction
 * @property {RTCMonitor.ThresholdOption} [jitter] - Rules to apply to sample.jitter
 * @property {RTCMonitor.ThresholdOption} [rtt] - Rules to apply to sample.rtt
 * @property {RTCMonitor.ThresholdOption} [mos] - Rules to apply to sample.mos
 *//**
 * @typedef {Object} RTCMonitor.ThresholdOption
 * @property {?Number} [min] - Warning will be raised if tracked metric falls below this value.
 * @property {?Number} [max] - Warning will be raised if tracked metric rises above this value.
 * @property {?Number} [maxDuration] - Warning will be raised if tracked metric stays constant for
 *   the specified number of consequent samples.
 */
var DEFAULT_THRESHOLDS = {
  audioInputLevel: { maxDuration: 10 },
  audioOutputLevel: { maxDuration: 10 },
  packetsLostFraction: { max: 1 },
  jitter: { max: 30 },
  rtt: { max: 400 },
  mos: { min: 3 }
};

/**
 * RTCMonitor polls a peerConnection via PeerConnection.getStats
 * and emits warnings when stats cross the specified threshold values.
 * @constructor
 * @param {RTCMonitor.Options} [options] - Config options for RTCMonitor.
 *//**
 * @typedef {Object} RTCMonitor.Options
 * @property {PeerConnection} [peerConnection] - The PeerConnection to monitor.
 * @property {RTCMonitor.ThresholdOptions} [thresholds] - Optional custom threshold values.
 */
function RTCMonitor(options) {
  if (!(this instanceof RTCMonitor)) {
    return new RTCMonitor(options);
  }

  options = options || { };
  var thresholds = Object.assign({ }, DEFAULT_THRESHOLDS, options.thresholds);

  Object.defineProperties(this, {
    _activeWarnings: { value: new Map() },
    _currentStreaks: { value: new Map() },
    _peerConnection: { value: options.peerConnection, writable: true },
    _sampleBuffer: { value: [] },
    _sampleInterval: { value: null, writable: true },
    _thresholds: { value: thresholds },
    _warningsEnabled: { value: true, writable: true }
  });

  if (options.peerConnection) {
    this.enable();
  }

  EventEmitter.call(this);
}

inherits(RTCMonitor, EventEmitter);

/**
 * Create a sample object from a stats object using the previous sample,
 *   if available.
 * @param {Object} stats - Stats retrieved from getStatistics
 * @param {?Object} [previousSample=null] - The previous sample to use to calculate deltas.
 * @returns {Promise<RTCSample>}
 */
RTCMonitor.createSample = function createSample(stats, previousSample) {
  var previousPacketsSent = previousSample && previousSample.totals.packetsSent || 0;
  var previousPacketsReceived = previousSample && previousSample.totals.packetsReceived || 0;
  var previousPacketsLost = previousSample && previousSample.totals.packetsLost || 0;

  var currentPacketsSent = stats.packetsSent - previousPacketsSent;
  var currentPacketsReceived = stats.packetsReceived - previousPacketsReceived;
  var currentPacketsLost = stats.packetsLost - previousPacketsLost;
  var currentInboundPackets = currentPacketsReceived + currentPacketsLost;
  var currentPacketsLostFraction = (currentInboundPackets > 0) ?
    (currentPacketsLost / currentInboundPackets) * 100 : 100;

  var totalInboundPackets = stats.packetsReceived + stats.packetsLost;
  var totalPacketsLostFraction = (totalInboundPackets > 0) ?
    (stats.packetsLost / totalInboundPackets) * 100 : 100;

  return {
    timestamp: stats.timestamp,
    totals: {
      packetsReceived: stats.packetsReceived,
      packetsLost: stats.packetsLost,
      packetsSent: stats.packetsSent,
      packetsLostFraction: totalPacketsLostFraction,
      bytesReceived: stats.bytesReceived,
      bytesSent: stats.bytesSent
    },
    candidatePair: {
      localAddress: stats.localAddress,
      localCandidateId: stats.localCandidateId,
      localCandidateType: stats.localCandidateType,
      remoteAddress: stats.remoteAddress,
      remoteCandidateId: stats.remoteCandidateId,
      remoteCandidateType: stats.remoteCandidateType,
      transportType: stats.transportType
    },
    packetsSent: currentPacketsSent,
    packetsReceived: currentPacketsReceived,
    packetsLost: currentPacketsLost,
    packetsLostFraction: currentPacketsLostFraction,
    audioInputLevel: stats.audioInputLevel,
    audioOutputLevel: stats.audioOutputLevel,
    codecName: stats.codecName,
    jitter: stats.jitter,
    rtt: stats.rtt,
    mos: Mos.calculate(stats, previousSample && currentPacketsLostFraction)
  };
};

/**
 * Start sampling RTC statistics for this {@link RTCMonitor}.
 * @param {PeerConnection} [peerConnection] - A PeerConnection to monitor.
 * @throws {Error} Attempted to replace an existing PeerConnection in RTCMonitor.enable
 * @throws {Error} Can not enable RTCMonitor without a PeerConnection
 * @returns {RTCMonitor} This RTCMonitor instance.
 */
RTCMonitor.prototype.enable = function enable(peerConnection) {
  if (peerConnection) {
    if (this._peerConnection && peerConnection !== this._peerConnection) {
      throw new Error('Attempted to replace an existing PeerConnection in RTCMonitor.enable');
    }

    this._peerConnection = peerConnection;
  }

  if (!this._peerConnection) {
    throw new Error('Can not enable RTCMonitor without a PeerConnection');
  }

  this._sampleInterval = this._sampleInterval ||
    setInterval(this._fetchSample.bind(this), SAMPLE_INTERVAL);

  return this;
};

/**
 * Stop sampling RTC statistics for this {@link RTCMonitor}.
 * @returns {RTCMonitor} This RTCMonitor instance.
 */
RTCMonitor.prototype.disable = function disable() {
  clearInterval(this._sampleInterval);
  this._sampleInterval = null;

  return this;
};

/**
 * Get stats from the PeerConnection.
 * @returns {Promise<RTCSample>} A universally-formatted version of RTC stats.
 */
RTCMonitor.prototype.getSample = function getSample() {
  var pc = this._peerConnection;

  var self = this;
  return new Promise(function(resolve, reject) {
    getStatistics(pc, function(error, stats) {
      if (error) {
        reject(error);
      } else {
        var previousSample = self._sampleBuffer.length &&
          self._sampleBuffer[self._sampleBuffer.length - 1];

        resolve(RTCMonitor.createSample(stats, previousSample));
      }
    });
  });
};

/**
 * Get stats from the PeerConnection and add it to our list of samples.
 * @private
 * @returns {Promise<Object>} A universally-formatted version of RTC stats.
 */
RTCMonitor.prototype._fetchSample = function _fetchSample(sample) {
  var self = this;

  return this.getSample().then(
    function addSample(sample) {
      self._addSample(sample);
      self._raiseWarnings();
      self.emit('sample', sample);
      return sample;
    },
    function getSampleFailed(error) {
      self.disable();
      self.emit('error', error);
    }
  );
};

/**
 * Add a sample to our sample buffer and remove the oldest if
 *   we are over the limit.
 * @private
 * @param {Object} sample - Sample to add
 */
RTCMonitor.prototype._addSample = function _addSample(sample) {
  var samples = this._sampleBuffer;
  samples.push(sample);

  // We store 1 extra sample so that we always have (current, previous)
  // available for all {sampleBufferSize} threshold validations.
  if (samples.length > SAMPLE_COUNT_METRICS) {
    samples.splice(0, samples.length - SAMPLE_COUNT_METRICS);
  }
};

/**
 * Apply our thresholds to our array of RTCStat samples.
 * @private
 */
RTCMonitor.prototype._raiseWarnings = function _raiseWarnings() {
  if (!this._warningsEnabled) { return; }

  for (var name in this._thresholds) {
    this._raiseWarningsForStat(name);
  }
};

/**
 * Enable warning functionality.
 * @returns {RTCMonitor}
 */
RTCMonitor.prototype.enableWarnings = function enableWarnings() {
  this._warningsEnabled = true;
  return this;
};

/**
 * Disable warning functionality.
 * @returns {RTCMonitor}
 */
RTCMonitor.prototype.disableWarnings = function disableWarnings() {
  if (this._warningsEnabled) {
    this._activeWarnings.clear();
  }

  this._warningsEnabled = false;
  return this;
};

/**
 * Apply thresholds for a given stat name to our array of
 *   RTCStat samples and raise or clear any associated warnings.
 * @private
 * @param {String} statName - Name of the stat to compare.
 */
RTCMonitor.prototype._raiseWarningsForStat = function _raiseWarningsForStat(statName) {
  var samples = this._sampleBuffer;
  var limits = this._thresholds[statName];

  var relevantSamples = samples.slice(-SAMPLE_COUNT_METRICS);
  var values = relevantSamples.map(function(sample) {
    return sample[statName];
  });

  // (rrowland) If we have a bad or missing value in the set, we don't
  // have enough information to throw or clear a warning. Bail out.
  var containsNull = values.some(function(value) {
    return typeof value === 'undefined' || value === null;
  });

  if (containsNull) {
    return;
  }

  if (typeof limits.max === 'number') {
    var count = countHigh(limits.max, values);
    if (count >= SAMPLE_COUNT_RAISE) {
      this._raiseWarning(statName, 'max', { values: values });
    } else if (count <= SAMPLE_COUNT_CLEAR) {
      this._clearWarning(statName, 'max', { values: values });
    }
  }

  if (typeof limits.min === 'number') {
    var count = countLow(limits.min, values);
    if (count >= SAMPLE_COUNT_RAISE) {
      this._raiseWarning(statName, 'min', { values: values });
    } else if (count <= SAMPLE_COUNT_CLEAR) {
      this._clearWarning(statName, 'min', { values: values });
    }
  }

  if (typeof limits.maxDuration === 'number' && samples.length > 1) {
    relevantSamples = samples.slice(-2);
    var prevValue = relevantSamples[0][statName];
    var curValue = relevantSamples[1][statName];

    var prevStreak = this._currentStreaks.get(statName) || 0;
    var streak = (prevValue === curValue) ? prevStreak + 1 : 0;

    this._currentStreaks.set(statName, streak);

    if (streak >= limits.maxDuration) {
      this._raiseWarning(statName, 'maxDuration', { value: streak });
    } else if (streak === 0) {
      this._clearWarning(statName, 'maxDuration', { value: prevStreak });
    }
  }
};

/**
 * Count the number of values that cross the min threshold.
 * @private
 * @param {Number} min - The minimum allowable value.
 * @param {Array<Number>} values - The values to iterate over.
 * @returns {Number} The amount of values in which the stat
 *   crossed the threshold.
 */
function countLow(min, values) {
  return values.reduce(function(lowCount, value) {
    return lowCount += (value < min) ? 1 : 0;
  }, 0);
}

/**
 * Count the number of values that cross the max threshold.
 * @private
 * @param {Number} max - The max allowable value.
 * @param {Array<Number>} values - The values to iterate over.
 * @returns {Number} The amount of values in which the stat
 *   crossed the threshold.
 */
function countHigh(max, values) {
  return values.reduce(function(highCount, value) {
    return highCount += (value > max) ? 1 : 0;
  }, 0);
}

/**
 * Clear an active warning.
 * @param {String} statName - The name of the stat to clear.
 * @param {String} thresholdName - The name of the threshold to clear
 * @param {?Object} [data] - Any relevant sample data.
 * @private
 */
RTCMonitor.prototype._clearWarning = function _clearWarning(statName, thresholdName, data) {
  var warningId = statName + ':' + thresholdName;
  var activeWarning = this._activeWarnings.get(warningId);

  if (!activeWarning || Date.now() - activeWarning.timeRaised < WARNING_TIMEOUT) { return; }
  this._activeWarnings.delete(warningId);

  this.emit('warning-cleared', Object.assign({
    name: statName,
    threshold: {
      name: thresholdName,
      value: this._thresholds[statName][thresholdName]
    }
  }, data));
};

/**
 * Raise a warning and log its raised time.
 * @param {String} statName - The name of the stat to raise.
 * @param {String} thresholdName - The name of the threshold to raise
 * @param {?Object} [data] - Any relevant sample data.
 * @private
 */
RTCMonitor.prototype._raiseWarning = function _raiseWarning(statName, thresholdName, data) {
  var warningId = statName + ':' + thresholdName;

  if (this._activeWarnings.has(warningId)) { return; }
  this._activeWarnings.set(warningId, { timeRaised: Date.now() });

  this.emit('warning', Object.assign({
    name: statName,
    threshold: {
      name: thresholdName,
      value: this._thresholds[statName][thresholdName]
    }
  }, data));
};

module.exports = RTCMonitor;

},{"./mos":13,"./stats":15,"events":25,"util":29}],13:[function(require,module,exports){
var rfactorConstants = {
  r0: 94.768,
  is: 1.42611
};

/**
 * Calculate the mos score of a stats object
 * It will go through rtt, jitter, packetsLost and packetsReceived
 * @param {object} sample - Sample
 * @return {Number} mos - Calculated MOS
 */
function calcMos(sample, fractionLost) {
  if (!sample ||
    typeof sample.rtt !== 'number' ||
    typeof sample.jitter !== 'number' ||
    typeof sample.packetsLost !== 'number' ||
    typeof fractionLost !== 'number') {
      return null;
  }

  var rFactor = calculateRFactor(sample.rtt, sample.jitter, fractionLost);

  var mos = 1 + (0.035 * rFactor) + (0.000007 * rFactor) *
    (rFactor - 60) * (100 - rFactor);

  // Make sure MOS is in range
  var isValid = (mos >= 1.0 && mos < 4.6);
  return isValid ? mos : null;
}

function calculateRFactor(rtt, jitter, fractionLost) {
  var effectiveLatency = rtt + (jitter * 2) + 10;
  var rFactor = 0;

  switch (true) {
    case effectiveLatency < 160 :
      rFactor = rfactorConstants.r0 - (effectiveLatency / 40);
      break;
    case effectiveLatency < 1000 :
      rFactor = rfactorConstants.r0 - ((effectiveLatency - 120) / 10);
      break;
    case effectiveLatency >= 1000 :
      rFactor = rfactorConstants.r0 - ((effectiveLatency) / 100 );
      break;
  }

  var multiplier = .01;
  switch (true) {
    case fractionLost === -1:
      multiplier = 0;
      rFactor = 0;
      break;
    case fractionLost <= (rFactor / 2.5):
      multiplier = 2.5;
      break;
    case fractionLost > (rFactor / 2.5) && fractionLost < 100 :
      multiplier = .25;
      break;
  }

  rFactor = rFactor - (fractionLost * multiplier);
  return rFactor;
}

module.exports = {
  calculate: calcMos
};

},{}],14:[function(require,module,exports){
var log = require('../log');
var ortcAdapter = require('ortc-adapter');
var stackTrace = require('stacktrace-js');
var StateMachine = require('../statemachine');
var util = require('../util');

// Refer to <http://www.w3.org/TR/2015/WD-webrtc-20150210/#rtciceconnectionstate-enum>.
var ICE_CONNECTION_STATES = {
  'new': [
    'checking',
    'closed'
  ],
  'checking': [
    'new',
    'connected',
    'failed',
    'closed',
    // Not in the spec, but Chrome can go to completed.
    'completed'
  ],
  'connected': [
    'new',
    'disconnected',
    'completed',
    'closed'
  ],
  'completed': [
    'new',
    'disconnected',
    'closed',
    // Not in the spec, but Chrome can go to completed.
    'completed'
  ],
  'failed': [
    'new',
    'disconnected',
    'closed'
  ],
  'disconnected': [
    'connected',
    'completed',
    'failed',
    'closed'
  ],
  'closed': []
};

var INITIAL_ICE_CONNECTION_STATE = 'new';

// These differ slightly from the normal WebRTC state transitions: since we
// never expect the "have-local-pranswer" or "have-remote-pranswer" states, we
// filter them out.
var SIGNALING_STATES = {
  'stable': [
    'have-local-offer',
    'have-remote-offer',
    'closed'
  ],
  'have-local-offer': [
    'stable',
    'closed'
  ],
  'have-remote-offer': [
    'stable',
    'closed'
  ],
  'closed': []
};

var INITIAL_SIGNALING_STATE = 'stable';

function PeerConnection(encrypt, device) {
    if (!(this instanceof PeerConnection))
      return new PeerConnection(encrypt, device);
    var noop = function() { };
    this.onopen = noop;
    this.onerror = noop;
    this.onclose = noop;
    this.onsignalingstatechange = noop;
    this.oniceconnectionstatechange = noop;
    this.onicecandidate = noop;
    this.version = null;
    this.pstream = device.stream;
    this.stream = null;
    this.video = typeof document !== 'undefined' && document.createElement("video");
    this.video.autoplay = "autoplay";
    this.device = device;
    this.status = "connecting";
    this.callSid = null;
    this._dtmfSender = null;
    this._dtmfSenderUnsupported = false;
    this._callEvents = [];
    this._nextTimeToPublish = Date.now();
    this._onAnswer = noop;
    log.mixinLog(this, '[Twilio.PeerConnection]');
    this.log.enabled = this.device.options['debug'];
    this.log.warnings = this.device.options['warnings'];

    this._iceConnectionStateMachine = new StateMachine(ICE_CONNECTION_STATES,
      INITIAL_ICE_CONNECTION_STATE);
    this._signalingStateMachine = new StateMachine(SIGNALING_STATES,
      INITIAL_SIGNALING_STATE);

    return this;
}

PeerConnection.prototype.uri = function() {
    return this._uri;
};
PeerConnection.prototype.openHelper = function(next, audioConstraints) {
    var self = this;

    function onSuccess(stream) {
        self.stream = stream;
        next();
    }

    function onFailure(error) {
        if (error.code && error.code === error.PERMISSION_DENIED ||
            error.name && error.name === 'PermissionDeniedError') {
            next({
              error: error,
              message: 'User denied access to microphone, or the web browser did not allow microphone access at this address.',
              code: 31208
            });
        } else {
            next({
              error: error,
              message: 'Error occurred while accessing microphone: ' + error.name + (error.message ? ' (' + error.message + ')' : ''),
              code: 31201
            });
        }
    }

    PeerConnection.getUserMedia({ audio: audioConstraints }, onSuccess, onFailure);
};
PeerConnection.prototype._setupPeerConnection = function(rtcConstraints, iceServers) {
        var version = PeerConnection.protocol;
        version.create(this.log, rtcConstraints, iceServers);
        version.pc.addStream(this.stream);
        var self = this;
        version.pc.onaddstream = function(ev) {
            if (typeof self.video.srcObject !== 'undefined') {
                self.video.srcObject = ev.stream;
            }
            else if (typeof self.video.mozSrcObject !== 'undefined') {
                self.video.mozSrcObject = ev.stream;
            }
            else if (typeof self.video.src !== 'undefined') {
                var url = window.URL || window.webkitURL;
                self.video.src = url.createObjectURL(ev.stream);
            }
            else {
                self.log('Error attaching stream to element.');
            }
        };
        return version;
    };
PeerConnection.prototype._setupChannel = function() {
        var self = this;
        var pc = this.version.pc;

        //Chrome 25 supports onopen
        self.version.pc.onopen = function() {
            self.status = "open";
            self.onopen();
        };

        //Chrome 26 doesn't support onopen so must detect state change
        self.version.pc.onstatechange = function(stateEvent) {
            if (self.version.pc && self.version.pc.readyState == "stable") {
                self.status = "open";
                self.onopen();
            }
        };

        //Chrome 27 changed onstatechange to onsignalingstatechange
        self.version.pc.onsignalingstatechange = function(signalingEvent) {
            var state = pc.signalingState;
            self.log('signalingState is "' + state + '"');

            // Update our internal state machine.
            try {
              self._signalingStateMachine.transition(state);
            } catch (error) { }

            if (self.version.pc && self.version.pc.signalingState == "stable") {
                self.status = "open";
                self.onopen();
            }

            self.onsignalingstatechange(pc.signalingState);
        };

        pc.onicecandidate = function onicecandidate(event) {
            self.onicecandidate(event.candidate);
        };

        pc.oniceconnectionstatechange = function() {
            var state = pc.iceConnectionState;
            var logMessage = 'iceConnectionState is "' + state + '"';

            // Update our internal state machine.
            try {
              self._iceConnectionStateMachine.transition(state);
            } catch (error) { }

            var errorMessage = null;
            switch (state) {
                case 'disconnected':
                    errorMessage = 'ICE liveness checks failed. May be having '
                                 + 'trouble connecting to Twilio.';
                case 'failed':
                    var disconnect = state === 'failed';
                    self.log(logMessage + (disconnect ? '; disconnecting' : ''));
                    errorMessage = errorMessage
                                || 'ICE negotiation with Twilio failed. '
                                 + 'Call will terminate.';
                    self.onerror({
                       info: {
                          code: 31003,
                          message: errorMessage
                       },
                       disconnect: disconnect
                    });
                    break;
                default:
                    self.log(logMessage);
            }

            self.oniceconnectionstatechange(state);
        };
    };
PeerConnection.prototype._initializeMediaStream = function(rtcConstraints, iceServers) {
        // if mediastream already open then do nothing
        if (this.status == "open") {
            return false;
        }
        if (this.pstream.status == "disconnected") {
            this.onerror({ info: { code: 31000, message: "Cannot establish connection. Client is disconnected" } });
            this.close();
            return false;
        }
        this.version = this._setupPeerConnection(rtcConstraints, iceServers);
        this._setupChannel();
        return true;
};
PeerConnection.prototype.makeOutgoingCall = function(params, callsid, rtcConstraints, iceServers, onMediaStarted) {
        if (!this._initializeMediaStream(rtcConstraints, iceServers)) {
            return;
        }

        var self = this;
        this.callSid = callsid;
        var onAnswerSuccess = function() {
            onMediaStarted(self.version.pc);
        };
        var onAnswerError = function(err) {
            var errMsg = err.message || err;
            self.onerror({ info: { code: 31000, message: "Error processing answer: " + errMsg } });
        }
        this._onAnswer = function(payload) {
            if (self.status != "closed") {
                self.version.processAnswer(payload.sdp, onAnswerSuccess, onAnswerError);
            }
        };
        this.pstream.once("answer", this._onAnswer);

        var onOfferSuccess = function() {
            if (self.status != "closed") {
                self.pstream.publish("invite", {
                    sdp: self.version.getSDP(),
                    callsid: self.callSid,
                    twilio: {
                        params: params
                    }
                });
            }
        };
        var onOfferError = function(err) {
            var errMsg = err.message || err;
            self.onerror({ info: { code: 31000, message: "Error creating the offer: " + errMsg } });
        };
        this.version.createOffer({ audio: true }, onOfferSuccess, onOfferError);
};
PeerConnection.prototype.answerIncomingCall = function(callSid, sdp, rtcConstraints, iceServers, onMediaStarted) {
        if (!this._initializeMediaStream(rtcConstraints, iceServers)) {
            return;
        }
        this.callSid = callSid;
        var self = this;
        var onAnswerSuccess = function() {
            if (self.status != "closed") {
                self.pstream.publish("answer", {
                    callsid: callSid,
                    sdp: self.version.getSDP()
                });
                onMediaStarted(self.version.pc);
            }
        };
        var onAnswerError = function(err) {
            var errMsg = err.message || err;
            self.onerror({ info: { code: 31000, message: "Error creating the answer: " + errMsg } });
        };
        this.version.processSDP(sdp, { audio: true }, onAnswerSuccess, onAnswerError);
};
PeerConnection.prototype.close = function() {
        if (this.version && this.version.pc) {
            if (this.version.pc.signalingState !== 'closed') {
                this.version.pc.close();
            }

            this.version.pc = null;
        }
        if (this.stream) {
            stopStream(this.stream);
            this.stream = null;
        }
        if (this.pstream) {
            this.pstream.removeListener('answer', this._onAnswer);
        }
        this.video.src = "";
        this.status = "closed";
        this.onclose();
};
PeerConnection.prototype.reject = function(callSid) {
        this.callSid = callSid;
};
PeerConnection.prototype.ignore = function(callSid) {
        this.callSid = callSid;
};
PeerConnection.prototype.attachAudio = function(callback) {
        if (this.stream) {
            var audioTracks = typeof this.stream.getAudioTracks === 'function'
              ? this.stream.getAudioTracks() : this.stream.audioTracks;
            audioTracks[0].enabled = true;
        }
        if (callback && typeof callback == "function") {
            callback();
        }
};
PeerConnection.prototype.detachAudio = function(callback) {
        if (this.stream) {
            var audioTracks = typeof this.stream.getAudioTracks === 'function'
              ? this.stream.getAudioTracks() : this.stream.audioTracks;
            audioTracks[0].enabled = false;
        }
        if (callback && typeof callback == "function") {
            callback();
        }
};
PeerConnection.prototype.isAudioAttached = function() {
        if (this.stream) {
            var audioTracks = typeof this.stream.getAudioTracks === 'function'
              ? this.stream.getAudioTracks() : this.stream.audioTracks;
            return audioTracks[0].enabled;
        }
        return false;
};

PeerConnection.getUserMedia = function getUserMedia(constraints, successCallback, errorCallback) {
    if (typeof navigator == "undefined") return;
    if (typeof navigator.webkitGetUserMedia == "function") {
        navigator.webkitGetUserMedia(constraints, successCallback, errorCallback);
    }
    else if (typeof navigator.mozGetUserMedia == "function") {
        navigator.mozGetUserMedia(constraints, successCallback, errorCallback);
    }
    else if (typeof navigator.getUserMedia === 'function') {
        navigator.getUserMedia(constraints, successCallback, errorCallback);
    }
    else {
        this.log("No getUserMedia() implementation available");
    }
};

/**
 * Get or create an RTCDTMFSender for the first local audio MediaStreamTrack
 * we can get from the RTCPeerConnection. Return null if unsupported.
 * @instance
 * @returns ?RTCDTMFSender
 */
PeerConnection.prototype.getOrCreateDTMFSender =
  function getOrCreateDTMFSender()
{
  if (this._dtmfSender) {
    return this._dtmfSender;
  } else if (this._dtmfSenderUnsupported) {
    return null;
  }

  var pc = this.version.pc;
  if (!pc) {
    this.log('No RTCPeerConnection available to call createDTMFSender on');
    return null;
  }

  if (typeof pc.createDTMFSender !== 'function') {
    this.log('RTCPeerConnection does not support createDTMFSender');
    this._dtmfSenderUnsupported = true;
    return null;
  }

  // Select a local audio MediaStreamTrack.
  var streams = pc.getLocalStreams();
  var stream;
  var tracks;
  var track;
  for (var i = 0; i < streams.length; i++) {
    stream = streams[i];
    tracks = typeof stream.getAudioTracks === 'function'
      ? stream.getAudioTracks() : stream.audioTracks;
    if (tracks.length) {
      track = tracks[0];
      break;
    }
  }
  if (!track) {
    this.log('No local audio MediaStreamTrack available on the ' +
             'RTCPeerConnection to pass to createDTMFSender');
    return null;
  }

  this.log('Creating RTCDTMFSender');
  var dtmfSender = pc.createDTMFSender(track);
  this._dtmfSender = dtmfSender;
  return dtmfSender;
};

var RTCPC = function() {
    if (typeof window == "undefined") return;
    if (typeof window.webkitRTCPeerConnection == "function") {
        this.RTCPeerConnection = webkitRTCPeerConnection;
    } else if (typeof window.mozRTCPeerConnection == "function") {
        this.RTCPeerConnection = mozRTCPeerConnection;
        RTCSessionDescription = mozRTCSessionDescription;
        RTCIceCandidate = mozRTCIceCandidate;
    // FIXME(mroberts): Use better criteria for identifying Edge/ORTC.
    } else if (typeof RTCIceGatherer !== 'undefined') {
        this.RTCPeerConnection = ortcAdapter.RTCPeerConnection;
        RTCSessionDescription = ortcAdapter.RTCSessionDescription;
        RTCIceCandidate = ortcAdapter.RTCIceCandidate;
    } else {
        this.log("No RTCPeerConnection implementation available");
    }
};

RTCPC.prototype.create = function(log, rtcConstraints, iceServers) {
    this.log = log;
    this.pc = new this.RTCPeerConnection({ iceServers: iceServers }, rtcConstraints);
};
RTCPC.prototype.createModernConstraints = function(c) {
    // createOffer differs between Chrome 23 and Chrome 24+.
    // See https://groups.google.com/forum/?fromgroups=#!topic/discuss-webrtc/JBDZtrMumyU
    // Unfortunately I haven't figured out a way to detect which format
    // is required ahead of time, so we'll first try the old way, and
    // if we get an exception, then we'll try the new way.
    if (typeof c === "undefined") {
        return null;
    }
    // NOTE(mroberts): As of Chrome 38, Chrome still appears to expect
    // constraints under the "mandatory" key, and with the first letter of each
    // constraint capitalized. Firefox, on the other hand, has deprecated the
    // "mandatory" key and does not expect the first letter of each constraint
    // capitalized.
    var nc = {};
    if (typeof webkitRTCPeerConnection !== 'undefined') {
        nc.mandatory = {};
        if (typeof c.audio !== "undefined") {
            nc.mandatory.OfferToReceiveAudio = c.audio;
        }
        if (typeof c.video !== "undefined") {
            nc.mandatory.OfferToReceiveVideo = c.video;
        }
    } else {
        if (typeof c.audio !== "undefined") {
            nc.offerToReceiveAudio = c.audio;
        }
        if (typeof c.video !== "undefined") {
            nc.offerToReceiveVideo = c.video;
        }
    }
    return nc;
};
RTCPC.prototype.createOffer = function(constraints, onSuccess, onError) {
    var self = this;

    var success = function(sd) {
        if (self.pc) {
            self.pc.setLocalDescription(new RTCSessionDescription(sd), onSuccess, onError);
        }
    }
    this.pc.createOffer(success, onError, this.createModernConstraints(constraints));
};
RTCPC.prototype.createAnswer = function(constraints, onSuccess, onError) {
    var self = this;

    var success = function(sd) {
        if (self.pc) {
            self.pc.setLocalDescription(new RTCSessionDescription(sd), onSuccess, onError);
        }
    }
    this.pc.createAnswer(success, onError, this.createModernConstraints(constraints));
};
RTCPC.prototype.processSDP = function(sdp, constraints, onSuccess, onError) {
    var self = this;

    var success = function() {
        self.createAnswer(constraints, onSuccess, onError);
    };
    this.pc.setRemoteDescription(new RTCSessionDescription({ sdp: sdp, type: "offer" }), success, onError);
};
RTCPC.prototype.getSDP = function() {
    return this.pc.localDescription.sdp;
};
RTCPC.prototype.processAnswer = function(sdp, onSuccess, onError) {
    if (!this.pc) {
        return;
    }
    this.pc.setRemoteDescription(
        new RTCSessionDescription({ sdp: sdp, type: "answer" }), onSuccess, onError);
};
/* NOTE(mroberts): Firefox 18 through 21 include a `mozRTCPeerConnection`
   object, but attempting to instantiate it will throw the error

       Error: PeerConnection not enabled (did you set the pref?)

   unless the `media.peerconnection.enabled` pref is enabled. So we need to test
   if we can actually instantiate `mozRTCPeerConnection`; however, if the user
   *has* enabled `media.peerconnection.enabled`, we need to perform the same
   test that we use to detect Firefox 24 and above, namely:

       typeof (new mozRTCPeerConnection()).getLocalStreams === 'function'

 */
RTCPC.test = function() {
    if (typeof navigator == 'object') {
        if (navigator.webkitGetUserMedia &&
            typeof window.webkitRTCPeerConnection == 'function') {
            return true;
        } else if (navigator.mozGetUserMedia &&
                   typeof window.mozRTCPeerConnection == 'function') {
            try {
                var test = new window.mozRTCPeerConnection();
                if (typeof test.getLocalStreams !== 'function')
                    return false;
            } catch (e) {
                return false;
            }
            return true;
        // FIXME(mroberts): Use better criteria for identifying Edge/ORTC.
        } else if (typeof RTCIceGatherer !== 'undefined') {
          return true;
        }
    }
};

PeerConnection.protocol = (function() {
    if (RTCPC.test()) return new RTCPC();
    else return null;
})();

PeerConnection.enabled = !!PeerConnection.protocol;

function stopStream(stream) {
  if (typeof MediaStreamTrack.prototype.stop === 'function') {
    var audioTracks = typeof stream.getAudioTracks === 'function'
      ? stream.getAudioTracks() : stream.audioTracks;
    audioTracks.forEach(function(track) {
      track.stop();
    });
  }
  // NOTE(mroberts): This is just a fallback to any ancient browsers that may
  // not implement MediaStreamTrack.stop.
  else {
    stream.stop();
  }
}

module.exports = PeerConnection;

},{"../log":7,"../statemachine":18,"../util":19,"ortc-adapter":30,"stacktrace-js":42}],15:[function(require,module,exports){
/**
 * Collect any WebRTC statistics for the given {@link PeerConnection} and pass
 * them to an error-first callback.
 * @param {PeerConnection} peerConnection - The {@link PeerConnection}
 * @param {function} callback - The callback
 */
function getStatistics(peerConnection, callback) {
  var error = new Error('WebRTC statistics are unsupported');
  if (!peerConnection) {
    callback(new Error('PeerConnection is null'));
  } else if (typeof navigator === 'undefined' || typeof peerConnection.getStats !== 'function') {
    callback(error);
  } else if (navigator.webkitGetUserMedia) {
    peerConnection.getStats(chainCallback(withStats, callback), callback);
  } else if (navigator.mozGetUserMedia) {
    peerConnection.getStats(null, chainCallback(mozWithStats, callback), callback);
  } else {
    callback(error);
  }
}

/**
 * Handle any WebRTC statistics for Google Chrome and pass them to an error-
 * first callback.
 * @param {RTCStatsResponse} response - WebRTC statistics for Google Chrome
 * @param {function} callback - The callback
 */
function withStats(response, callback) {
  var knownStats = [];
  var unknownStats = [];
  var results = response.result();
  results.forEach(function(report) {
    var processedReport = null;
    switch (report.type) {
      case 'googCandidatePair':
        processedReport = processCandidatePair(report);
        break;
      case 'ssrc':
        processedReport = processSSRC(report);
        break;
      // Unknown
      default:
        unknownStats.push(report);
    }
    if (processedReport) {
      knownStats.push(processedReport);
    }
  });
  if (knownStats.length === 0 || (knownStats = filterKnownStats(knownStats)).length === 0) {
    return callback(null, {});
  }
  var mergedStats = knownStats.reduceRight(function(mergedStat, knownStat) {
    for (var name in knownStat) {
      mergedStat[name] = knownStat[name];
    }
    return mergedStat;
  }, {});
  callback(null, mergedStats);
}

function processCandidatePair(report) {
  var knownStats = {};
  var unknownStats = {};
  var names = report.names();
  var timestamp = report.timestamp ? Number(report.timestamp) : null;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var value = report.stat(name);
    switch (name) {
      // If the connection represented by this report is inactive, bail out.
      case 'googActiveConnection':
        if (value !== 'true') {
          return null;
        }
        break;
      // Rename "goog"-prefixed stats.
      case 'googLocalAddress':
        knownStats['localAddress'] = value;
        break;
      case 'googRemoteAddress':
        knownStats['remoteAddress'] = value;
        break;
      case 'googLocalCandidateType':
        knownStats['localCandidateType'] = value;
        break;
      case 'googRemoteCandidateType':
        knownStats['remoteCandidateType'] = value;
        break;
      case 'googTransportType':
        knownStats['transportType'] = value;
        break;
      case 'localCandidateId':
        knownStats['localCandidateId'] = value;
        break;
      case 'remoteCandidateId':
        knownStats['remoteCandidateId'] = value;
        break;
      case 'googRtt':
        knownStats['rtt'] = Number(value);
        break;
      // Ignore empty stat names (annoying, I know).
      case '':
        break;
      // Unknown
      default:
        unknownStats[name] = value;
    }
  }
  knownStats.timestamp = timestamp;
  return packageStats(knownStats, unknownStats);
}

function processSSRC(report) {
  var knownStats = {};
  var unknownStats = {};
  var names = report.names();
  var timestamp = report.timestamp ? Number(report.timestamp) : null;
  names.forEach(function(name) {
    var value = report.stat(name);
    switch (name) {
      // Rename "goog"-prefixed stats.
      case 'googCodecName':
        // Filter out the empty case.
        var codecName = value;
        if (codecName !== '') {
          knownStats['codecName'] = value;
        }
        break;
      case 'googJitterBufferMs':
        knownStats['googJitterBufferMs'] = Number(value);
        break;
      case 'googJitterReceived':
        // Filter out the -1 case.
        var jitterReceived = Number(value);
        if (jitterReceived !== -1) {
          knownStats['jitter'] = jitterReceived;
        }
        break;
      // Pass these stats through unmodified.
      case 'bytesReceived':
      case 'bytesSent':
      case 'packetsReceived':
      case 'packetsSent':
      case 'timestamp':
      case 'audioInputLevel':
      case 'audioOutputLevel':
        knownStats[name] = Number(value);
        break;
      case 'packetsLost':
        // Filter out the -1 case.
        var packetsLost = Number(value);
        if (packetsLost !== -1) {
          knownStats[name] = packetsLost;
        }
        break;
      // Unknown
      default:
        unknownStats[name] = value;
    }
  });
  knownStats.timestamp = timestamp;
  return packageStats(knownStats, unknownStats);
}

/**
 * Handle any WebRTC statistics for Mozilla Firefox and pass them to an error-
 * first callback.
 * @param {RTCStatsReport} reports - WebRTC statistics for Mozilla Firefox
 * @param {function} callback - The callback
 */
function mozWithStats(reports, callback) {
  var knownStats = [];
  var unknownStats = []
  reports.forEach(function(report) {
    var processedReport = null;
    switch (report.type) {
      case 'inboundrtp':
        processedReport = processInbound(report);
        break;
      case 'outboundrtp':
        if (report.isRemote === false) {
          processedReport = processOutbound(report);
        }
        break;
      // Unknown
      default:
        unknownStats.push(report);
    }
    if (processedReport) {
      knownStats.push(processedReport);
    }
  });
  if (knownStats.length === 0 || (knownStats = filterKnownStats(knownStats)).length === 0) {
    return callback(null, {});
  }
  var mergedStats = knownStats.reduceRight(function(mergedStat, knownStat) {
    for (var name in knownStat) {
      mergedStat[name] = knownStat[name];
    }
    return mergedStat;
  }, {});
  callback(null, mergedStats);
}

function processOutbound(report) {
  var knownStats = {};
  var unknownStats = {};
  for (var name in report) {
    var value = report[name];
    switch (name) {
      // Convert to UNIX timestamp.
      case 'timestamp':
        knownStats.timestamp = value ? Number(value) : null;
      // Pass these stats through unmodified.
      case 'bytesSent':
      case 'packetsSent':
        knownStats[name] = value;
        break;
      // Unknown
      default:
        unknownStats[name] = value;
    }
  }
  return packageStats(knownStats, unknownStats);
}

function processInbound(report) {
  var knownStats = {};
  var unknownStats = {};
  for (var name in report) {
    var value = report[name];
    switch (name) {
      // Rename "moz"-prefixed stats.
      case 'mozRtt':
        knownStats['rtt'] = value;
        break;
      // Convert to UNIX timestamp.
      case 'timestamp':
        knownStats.timestamp = value ? Number(value) : null;
        break;
      // Convert to milliseconds.
      case 'jitter':
        knownStats[name] = value * 1000;
        break;
      // Pass these stats through unmodified.
      case 'bytesReceived':
      case 'packetsLost':
      case 'packetsReceived':
        knownStats[name] = value;
        break;
      // Unknown
      default:
        unknownStats[name] = value;
    }
  }
  return packageStats(knownStats, unknownStats);
}

/**
 * Given two objects containing known and unknown WebRTC statistics, include
 * each in an object keyed by "known" or "unkown" if they are non-empty. If
 * both are empty, return null.
 * @param {?object} knownStats - Known WebRTC statistics
 * @param {?object} unknownStats - Unkown WebRTC statistics
 * @returns ?object
 */
function packageStats(knownStats, unknownStats) {
  var stats = null;
  if (!empty(knownStats)) {
    stats = stats || {};
    stats.known = knownStats;
  }
  if (!empty(unknownStats)) {
    stats = stats || {};
    stats.unknown = unknownStats;
  }
  return stats;
}

/**
 * Given a list of objects containing known and/or unknown WebRTC statistics,
 * return only the known statistics.
 * @param {Array} stats - A list of objects containing known and/or unknown
 *                        WebRTC statistics
 * @returns Array
 */
function filterKnownStats(stats) {
  var knownStats = [];
  for (var i = 0; i < stats.length; i++) {
    var stat = stats[i];
    if (stat.known) {
      knownStats.push(stat.known);
    }
  }
  return knownStats;
}

/**
 * Check if an object is "empty" in the sense that it contains no keys.
 * @param {?object} obj - The object to check
 * @returns boolean
 */
function empty(obj) {
  if (!obj) {
    return true;
  }
  for (var key in obj) {
    return false;
  }
  return true;
}

/**
 * Given a function that takes a callback as its final argument, fix that final
 * argument to the provided callback.
 * @param {function} function - The function
 * @param {function} callback - The callback
 * @returns function
 */
function chainCallback(func, callback) {
  return function() {
    var args = Array.prototype.slice.call(arguments);
    args.push(callback);
    return func.apply(null, args);
  };
}

module.exports = getStatistics;

},{}],16:[function(require,module,exports){
function Sound(options) {
    if (!(this instanceof Sound)) {
      return new Sound(options);
    }

    this.id = Sound.nextId++;
    this.maxDuration = options.maxDuration;
    Sound.items[this.id] = this;
    this.create(!!options.loop);
    return this;
}

var audioBackend = {
    create: function(shouldLoop) {
        this.audio = document.createElement("audio");
        this.audio.loop = shouldLoop;
        this.playing = false;

        var self = this;
        this.audio.addEventListener('ended', function() {
          self.playing = false;
        });
    },
    buffer: function() { },
    play: function() {
        if (this.playing) { return; }
        var audio = this.audio;
        this.rewind();

        var self = this;
        var maxDuration = this.maxDuration;
        if (maxDuration && maxDuration < audio.duration * 1000) {
          setTimeout(function() {
            audio.pause();
            self.playing = false;
          }, maxDuration);
        }

        this.playing = true;
        audio.play();
    },
    load: function(url) {
        this.audio.src = url;
    },
    stop: function() {
        this.playing = false;
        this.audio.pause();
        this.rewind();
    },
    destroy: function() {
        this.audio.src = "";
        delete this.audio;
    },
    rewind: function() {
      this.audio.currentTime = 0;
      // HACK Can't rewind. More info: stackoverflow.com/a/11004658
      if (this.audio.currentTime) {
        this.audio.load();
      }
    }
};

var dummyBackend = {
    create: function() {},
    buffer: function(bytes) {},
    play: function() {},
    load: function(url) {},
    stop: function() {},
    destroy: function() {}
}

if (typeof window === 'undefined') {
    for (var key in dummyBackend) {
        Sound.prototype[key] = dummyBackend[key];
    }
} else {
    Sound.prototype =  audioBackend;
}

Sound.nextId = 0;
Sound.debug = false;
Sound.tasks = [];
Sound.items = {};
exports.Sound = Sound;

},{}],17:[function(require,module,exports){
function not(expr) { return !expr; }
function bind(ctx, fn) {
    return function() {
        var args = Array.prototype.slice(arguments);
        fn.apply(ctx, args);
    };
}

function SoundCache() {
    if (not(this instanceof SoundCache)) {
        return new SoundCache();
    }
    this.cache = {};
}

SoundCache.prototype.add = function(name, sounds, envelope) {
        envelope = envelope || {};
        if (not(envelope instanceof Object)) {
            throw new TypeError(
              "Bad envelope type; expected Object");
        }
        if (not(sounds instanceof Array)) {
            sounds = [sounds];
        }
        this.cache[name] = {
            starttime: null,
            sounds: sounds,
            envelope: envelope
        };
};
SoundCache.prototype.play = function(name, position, loop) {
        position = position || 0;
        loop = loop || 1;
        if (not(name in this.cache)) {
            return;
        }
        var voice = this.cache[name];
        for (var i = 0; i < voice.sounds.length; i++) {
            voice.sounds[i].play(position, loop);
        }
        voice.starttime = new Date().getTime();
};
SoundCache.prototype.stop = function(name) {
        if (not(name in this.cache)) {
            return;
        }
        var voice = this.cache[name];
        var release = voice.envelope.release || 0;
        var pauseFn = function() {
            for (var i = 0; i < voice.sounds.length; i++) {
                voice.sounds[i].stop();
            }
        };
        var now = new Date().getTime();
        var hold = Math.max(0, release - (now - voice.starttime));
        var _ = (release == 0) ? pauseFn() : setTimeout(pauseFn, hold);
};
SoundCache.prototype.envelope = function(name, update) {
        if (not(name in this.cache)) {
            return;
        }
        var voice = this.cache[name];
        for (var prop in update) {
            voice.envelope[prop] = update[prop];
        }
};
SoundCache.prototype.playseq = (function() {
        var timer = null;
        var queue = [];
        var playFn = function() {
            var tuple = queue.shift();
            if (!tuple) {
                timer = null;
                return;
            }
            var name = tuple[0],
                duration = tuple[1] || 0,
                pause = tuple[2] || 0;
            if (name in this.cache) {
                this.play(name);
            }
            timer = setTimeout(bind(this, playFn), duration + pause);
        };
        return function (sequence) {
            for (var i = 0; i < sequence.length; i++) {
                queue.push(sequence[i]);
            }
            if (timer == null) {
                timer = setTimeout(bind(this, playFn), 0);
            }
        };
})();

exports.SoundCache = SoundCache;

},{}],18:[function(require,module,exports){
'use strict';

var inherits = require('util').inherits;

/**
 * Construct a {@link StateMachine}.
 * @class
 * @classdesc A {@link StateMachine} is defined by an object whose keys are
 *   state names and whose values are arrays of valid states to transition to.
 *   All state transitions, valid or invalid, are recorded.
 * @param {?string} initialState
 * @param {object} states
 * @property {string} currentState
 * @proeprty {object} states
 * @property {Array<StateTransition>} transitions
 */
function StateMachine(states, initialState) {
  if (!(this instanceof StateMachine)) {
    return new StateMachine(states, initialState);
  }
  var currentState = initialState;
  Object.defineProperties(this, {
    _currentState: {
      get: function() {
        return currentState;
      },
      set: function(_currentState) {
        currentState = _currentState;
      }
    },
    currentState: {
      enumerable: true,
      get: function() {
        return currentState;
      }
    },
    states: {
      enumerable: true,
      value: states
    },
    transitions: {
      enumerable: true,
      value: []
    }
  });
  Object.freeze(this);
}

/**
 * Transition the {@link StateMachine}, recording either a valid or invalid
 * transition. If the transition was valid, we complete the transition before
 * throwing the {@link InvalidStateTransition}.
 * @param {string} to
 * @throws {InvalidStateTransition}
 * @returns {this}
 */
StateMachine.prototype.transition = function transition(to) {
  var from = this.currentState;
  var valid = this.states[from];
  var transition = valid && valid.indexOf(to) !== -1
    ? new StateTransition(from, to)
    : new InvalidStateTransition(from, to);
  this.transitions.push(transition);
  this._currentState = to;
  if (transition instanceof InvalidStateTransition) {
    throw transition;
  }
  return this;
};

/**
 * Construct a {@link StateTransition}.
 * @class
 * @param {?string} from
 * @param {string} to
 * @property {?string} from
 * @property {string} to
 */
function StateTransition(from, to) {
  Object.defineProperties(this, {
    from: {
      enumerable: true,
      value: from
    },
    to: {
      enumerable: true,
      value: to
    }
  });
}

/**
 * Construct an {@link InvalidStateTransition}.
 * @class
 * @augments Error
 * @augments StateTransition
 * @param {?string} from
 * @param {string} to
 * @property {?string} from
 * @property {string} to
 * @property {string} message
 */
function InvalidStateTransition(from, to) {
  if (!(this instanceof InvalidStateTransition)) {
    return new InvalidStateTransition(from, to);
  }
  Error.call(this);
  StateTransition.call(this, from, to);
  var errorMessage = 'Invalid transition from ' +
    (typeof from === 'string' ? '"' + from + '"' : 'null') + ' to "' + to + '"';
  Object.defineProperties(this, {
    message: {
      enumerable: true,
      value: errorMessage
    }
  });
  Object.freeze(this);
}

inherits(InvalidStateTransition, Error);

module.exports = StateMachine;

},{"util":29}],19:[function(require,module,exports){
(function (Buffer){
var EventEmitter = require('events').EventEmitter;

function getPStreamVersion() {
  // NOTE(mroberts): Set by `Makefile'.
  return "1.3" || '1.0';
}

function getSDKHash() {
  // NOTE(mroberts): Set by `Makefile'.
  return "d3dfa69";
}

function getReleaseVersion() {
  // NOTE(jvass): Set by `Makefile`.
  return "1.3.15";
}

function getSoundVersion() {
  // NOTE(rrowland): Set by `Makefile`.
  return "1.0.0" || '1.0.0';
}

/**
 * Exception class.
 *
 * @name Exception
 * @exports _Exception as Twilio.Exception
 * @memberOf Twilio
 * @constructor
 * @param {string} message The exception message
 */
function _Exception(message) {
    if (!(this instanceof _Exception)) return new _Exception(message);
    this.message = message;
}

/**
 * Returns the exception message.
 *
 * @return {string} The exception message.
 */
_Exception.prototype.toString = function() {
    return "Twilio.Exception: " + this.message;
}

function memoize(fn) {
    return function() {
        var args = Array.prototype.slice.call(arguments, 0);
        fn.memo = fn.memo || {};
        return fn.memo[args]
            ? fn.memo[args]
            : fn.memo[args] = fn.apply(null, args);
    };
}

function decodePayload(encoded_payload) {
    var remainder = encoded_payload.length % 4;
    if (remainder > 0) {
        var padlen = 4 - remainder;
        encoded_payload += new Array(padlen + 1).join("=");
    }
    encoded_payload = encoded_payload.replace(/-/g, "+")
                                     .replace(/_/g, "/");
    var decoded_payload = _atob(encoded_payload);
    return JSON.parse(decoded_payload);
}

var memoizedDecodePayload = memoize(decodePayload);

/**
 * Decodes a token.
 *
 * @name decode
 * @exports decode as Twilio.decode
 * @memberOf Twilio
 * @function
 * @param {string} token The JWT
 * @return {object} The payload
 */
function decode(token) {
    var segs = token.split(".");
    if (segs.length != 3) {
        throw new _Exception("Wrong number of segments");
    }
    var encoded_payload = segs[1];
    var payload = memoizedDecodePayload(encoded_payload);
    return payload;
}

function makedict(params) {
    if (params == "") return {};
    if (params.indexOf("&") == -1 && params.indexOf("=") == -1) return params;
    var pairs = params.split("&");
    var result = {};
    for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].split("=");
        result[decodeURIComponent(pair[0])] = makedict(decodeURIComponent(pair[1]));
    }
    return result;
}

function makescope(uri) {
    var parts = uri.match(/^scope:(\w+):(\w+)\??(.*)$/);
    if (!(parts && parts.length == 4)) {
        throw new _Exception("Bad scope URI");
    }
    return {
        service: parts[1],
        privilege: parts[2],
        params: makedict(parts[3])
    };
}

/**
* Encodes a Javascript object into a query string.
* Based on python's urllib.urlencode.
* @name urlencode
* @memberOf Twilio
* @function
* @param {object} params_dict The key-value store of params
* @param {bool} do_seq If True, look for values as lists for multival params
*/
function urlencode(params_dict, doseq) {
    var parts = [];
    doseq = doseq || false;
    for (var key in params_dict) {
        if (doseq && (params_dict[key] instanceof Array)) {
            for(var index in params_dict[key]) {
                var value = params_dict[key][index];
                parts.push(
                    encodeURIComponent(key) + "=" + encodeURIComponent(value)
                );
            }
        } else {
            var value = params_dict[key];
            parts.push(
                encodeURIComponent(key) + "=" + encodeURIComponent(value)
            );
        }
    }
    return parts.join("&");
}

function objectize(token) {
    var jwt = decode(token);
    var scopes = (jwt.scope.length === 0 ? [] : jwt.scope.split(" "));
    var newscopes = {};
    for (var i = 0; i < scopes.length; i++) {
        var scope = makescope(scopes[i]);
        newscopes[scope.service + ":" + scope.privilege] = scope;
    }
    jwt.scope = newscopes;
    return jwt;
}

var memoizedObjectize = memoize(objectize);

/**
 * Wrapper for btoa.
 *
 * @name btoa
 * @exports _btoa as Twilio.btoa
 * @memberOf Twilio
 * @function
 * @param {string} message The decoded string
 * @return {string} The encoded string
 */
function _btoa(message) {
    try {
        return btoa(message);
    } catch (e) {
        return new Buffer(message).toString("base64");
    }
}

/**
 * Wrapper for atob.
 *
 * @name atob
 * @exports _atob as Twilio.atob
 * @memberOf Twilio
 * @function
 * @param {string} encoded The encoded string
 * @return {string} The decoded string
 */
function _atob(encoded) {
    try {
        return atob(encoded);
    } catch (e) {
        try {
            return new Buffer(encoded, "base64").toString("ascii");
        } catch (e) {
            return base64.decode(encoded);
        }
    }
}

/**
 * Generates JWT tokens. For simplicity, only the payload segment is viable;
 * the header and signature are garbage.
 *
 * @param object payload The payload
 * @return string The JWT
 */
function dummyToken(payload) {
    var token_defaults = {
        "iss": "AC1111111111111111111111111111111",
        "exp": 1400000000
    }
    for (var k in token_defaults) {
        payload[k] = payload[k] || token_defaults[k];
    }
    var encoded_payload = _btoa(JSON.stringify(payload));
    encoded_payload = encoded_payload.replace(/=/g, "")
                                     .replace(/\+/g, "-")
                                     .replace(/\//g, "_");
    return ["*", encoded_payload, "*"].join(".");
}

function encodescope(service, privilege, params) {
    var capability = ["scope", service, privilege].join(":");
    var empty = true;
    for (var _ in params) { empty = false; break; }
    return empty ? capability : capability + "?" + buildquery(params);
}

function buildquery(params) {
    var pairs = [];
    for (var name in params) {
        var value = typeof params[name] == "object"
            ? buildquery(params[name])
            : params[name];
        pairs.push(encodeURIComponent(name) + "=" +
                   encodeURIComponent(value));
    }
    return pairs.join("&");
}

var bind = function(fn, ctx) {
    var applied = Array.prototype.slice.call(arguments, 2);
    return function() {
        var extra = Array.prototype.slice.call(arguments);
        return fn.apply(ctx, applied.concat(extra));
    };
};

var Set = (function() {
    function Set() { this.set = {} }
    Set.prototype.clear = function() { this.set = {} };
    Set.prototype.put = function(elem) { return this.set[elem] = Set.DUMMY };
    Set.prototype.del = function(elem) { return delete this.set[elem] };
    Set.prototype.map = function(fn, this_) {
        var results = [];
        for (var item in this.set) {
            results.push(fn.call(this_, item));
        }
        return results;
    };
    Set.DUMMY = {};
    return Set;
})();

var getSystemInfo = function() {
    var rtc = require("./rtc"),
        version = getPStreamVersion(),
        hash = getSDKHash(),
        nav = typeof navigator != "undefined" ? navigator : {};
    
    var info = {
        p: "browser",
        v: version,
        h: hash,
        browser: {
            userAgent: nav.userAgent || "unknown",
            platform: nav.platform || "unknown"
        },
        plugin: "rtc"
    };

    return info;
};

function trim(str) {
    if (typeof str != "string") return "";
    return str.trim
        ? str.trim()
        : str.replace(/^\s+|\s+$/g, "");
}

/**
 * Splits a concatenation of multiple JSON strings into a list of JSON strings.
 *
 * @param string json The string of multiple JSON strings
 * @param boolean validate If true, thrown an error on invalid syntax
 *
 * @return array A list of JSON strings
 */
function splitObjects(json, validate) {
    var trimmed = trim(json);
    return trimmed.length == 0 ? [] : trimmed.split("\n");
}

function generateConnectionUUID() {
    return 'TJSxxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
}

var TWILIO_ROOT = "";

function getTwilioRoot() {
  return TWILIO_ROOT;
}

function setTwilioRoot(twilioRoot) {
  TWILIO_ROOT = twilioRoot;
}

function monitorEventEmitter(name, object) {
  object.setMaxListeners(0);
  var MAX_LISTENERS = 10;
  function monitor(event) {
    var n = EventEmitter.listenerCount(object, event);
    var warning = 'The number of ' + event + ' listeners on ' + name + ' ' +
                  'exceeds the recommended number of ' + MAX_LISTENERS + '. ' +
                  'While twilio.js will continue to function normally, this ' +
                  'may be indicative of an application error. Note that ' +
                  event + ' listeners exist for the lifetime of the ' +
                  name + '.';
    if (n >= MAX_LISTENERS) {
      if (typeof console !== 'undefined') {
        if (console.warn) {
          console.warn(warning);
        } else if (console.log) {
          console.log(warning);
        }
      }
      object.removeListener('newListener', monitor);
    }
  }
  object.on('newListener', monitor);
}

// This definition of deepEqual is adapted from Node's deepEqual.
function deepEqual(a, b) {
  if (a === b) {
    return true;
  } else if (typeof a !== typeof b) {
    return false;
  } else if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  } else if (typeof a !== 'object' && typeof b !== 'object') {
    return a == b;
  } else {
    return objectDeepEqual(a, b);
  }
}

var objectKeys = typeof Object.keys === 'function' ? Object.keys : function(obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }
  return keys;
};

function isUndefinedOrNull(a) {
  return a === undefined || a === null;
}

function objectDeepEqual(a, b) {
  if (isUndefinedOrNull(a) || isUndefinedOrNull(b)) {
    return false;
  } else if (a.prototype !== b.prototype) {
    return false;
  } else {
    try {
      var ka = objectKeys(a);
      var kb = objectKeys(b);
    } catch (e) {
      return false;
    }
    if (ka.length !== kb.length) {
      return false;
    }
    ka.sort();
    kb.sort();
    for (var i = ka.length - 1; i >= 0; i--) {
      var k = ka[i];
      if (!deepEqual(a[k], b[k])) {
        return false;
      }
    }
    return true;
  }
}

exports.getPStreamVersion = getPStreamVersion;
exports.getReleaseVersion = getReleaseVersion;
exports.getSoundVersion = getSoundVersion;
exports.encodescope = encodescope;
exports.dummyToken = dummyToken;
exports.Exception = _Exception;
exports.decode = decode;
exports.btoa = _btoa;
exports.atob = _atob;
exports.objectize = memoizedObjectize;
exports.urlencode = urlencode;
exports.Set = Set;
exports.bind = bind;
exports.getSystemInfo = getSystemInfo;
exports.splitObjects = splitObjects;
exports.generateConnectionUUID = generateConnectionUUID;
exports.getTwilioRoot = getTwilioRoot;
exports.setTwilioRoot = setTwilioRoot;
exports.monitorEventEmitter = monitorEventEmitter;
exports.deepEqual = deepEqual;

}).call(this,require("buffer").Buffer)
},{"./rtc":11,"buffer":21,"events":25}],20:[function(require,module,exports){
var Heartbeat = require("./heartbeat").Heartbeat;
var log = require("./log");

var WebSocket = require('ws');

/*
 * WebSocket transport class
 */
function WSTransport(options) { 
    var self = this instanceof WSTransport ? this : new WSTransport(options);
    self.sock = null;
    var noop = function() {};
    self.onopen = noop;
    self.onclose = noop;
    self.onmessage = noop;
    self.onerror = noop;

    var defaults = {
        logPrefix:  "[WSTransport]",
        chunderw:   "chunderw-vpc-gll.twilio.com",
        reconnect:  true,
        debug:      false,
        secureSignaling: true
    };
    options = options || {};
    for (var prop in defaults) {
        if (prop in options) continue;
        options[prop] = defaults[prop];
    }
    self.options = options;

    log.mixinLog(self, self.options["logPrefix"]);
    self.log.enabled = self.options["debug"];

    self.defaultReconnect = self.options["reconnect"];

    var scheme = self.options["secureSignaling"] ? "wss://" : "ws://";
    self.uri = scheme + self.options["host"] + "/signal";
    return self;
}

WSTransport.prototype.msgQueue = [];
WSTransport.prototype.open = function(attempted) {
        this.log("Opening socket");
        if (this.sock && this.sock.readyState < 2) {
            this.log("Socket already open.");
            return;
        }

        this.options["reconnect"] = this.defaultReconnect;

        // cancel out any previous heartbeat
        if (this.heartbeat) {
            this.heartbeat.onsleep = function() {};
        }
        this.heartbeat = new Heartbeat({ "interval": 15 });
        this.sock = this._connect(attempted);
};
WSTransport.prototype.send = function(msg) {
        if (this.sock) {
            if (this.sock.readyState == 0) {
                this.msgQueue.push(msg);
                return;
            }

            try {
                this.sock.send(msg);
            } catch (error) {
                this.log("Error while sending. Closing socket: " + error.message);
                this.sock.close();
            }
        }
};
WSTransport.prototype.close = function() {
        this.log("Closing socket");
        this.options["reconnect"] = false;
        if (this.sock) {
            this.sock.close();
            this.sock = null;
        }
        this.heartbeat.onsleep = function() {};
};
WSTransport.prototype._cleanupSocket = function(socket) {
        if (socket) {
            this.log("Cleaning up socket");
            var noop = function() {};
            socket.onopen = function() { socket.close(); };
            socket.onmessage = noop;
            socket.onerror = noop;
            socket.onclose = noop;

            if (socket.readyState < 2) {
                socket.close();
            }
        }
};
WSTransport.prototype._connect = function(attempted) {
        var attempt = ++attempted || 1;

        this.log("attempting to connect");
        var sock = null;
        try {
            sock = new WebSocket(this.uri);
        }
        catch (e) {
            this.onerror({ code: 31000, message: e.message || "Could not connect to " + this.uri});
            this.close(); //close connection for good
            return;
        }

        var self = this;

        // clean up old socket to avoid any race conditions with the callbacks
        var oldSocket = this.sock;
        var getTime = function() { return new Date().getTime(); };
        var timeOpened = null;

        var connectTimeout = setTimeout(function() {
            self.log("connection attempt timed out");
            sock.onclose = function() {};
            sock.close();
            self.onclose();
            self._tryReconnect(attempt);
        }, 5000);

        sock.onopen = function() {
            clearTimeout(connectTimeout);
            self._cleanupSocket(oldSocket);
            timeOpened = getTime();
            self.log("Socket opened");

            // setup heartbeat onsleep and beat it once to get timer started
            self.heartbeat.onsleep = function() {
                // treat it like the socket closed because when network drops onclose does not get called right away
                self.log("Heartbeat timed out. closing socket");
                self.sock.onclose = function() {};
                self.sock.close();
                self.onclose();
                self._tryReconnect(attempt);
            }
            self.heartbeat.beat();

            self.onopen();

            // send after onopen to preserve order
            for (var i = 0; i < self.msgQueue.length; i++) {
                self.sock.send(self.msgQueue[i]);
            }
            self.msgQueue = [];
        };
        sock.onclose = function() {
            clearTimeout(connectTimeout);
            self._cleanupSocket(oldSocket);

            // clear the heartbeat onsleep callback
            self.heartbeat.onsleep = function() {};

            // reset backoff counter if connection was open for enough time to be considered successful
            if (timeOpened) {
                var socketDuration = (getTime() - timeOpened)/1000;
                if (socketDuration > 10) {
                    attempt = 1;
                }
            }

            self.log("Socket closed");
            self.onclose();
            self._tryReconnect(attempt);
        };
        sock.onerror = function(e) {
            self.log("Socket received error: " + e.message);
            self.onerror({ code: 31000, message: e.message || "WSTransport socket error"});
        };
        sock.onmessage = function(message) {
            self.heartbeat.beat();
            if (message.data == "\n") {
                self.send("\n");
                return;
            }

            //TODO check if error passed back from gateway is 5XX error
            // if so, retry connection with exponential backoff
            self.onmessage(message);
        };

        return sock;
};
WSTransport.prototype._tryReconnect = function(attempted) {
        attempted = attempted || 0;
        if (this.options["reconnect"]) {
            this.log("Attempting to reconnect.");
            var self = this;
            var backoff = 0;
            if (attempted < 5) {
                // setup exponentially random backoff
                var minBackoff = 30;
                var backoffRange = Math.pow(2,attempted)*50;
                backoff = minBackoff + Math.round(Math.random()*backoffRange);
            } else {
                // continuous reconnect attempt
                backoff = 3000;
            }
            setTimeout( function() {
                self.open(attempted);
            }, backoff);
        }
};

exports.WSTransport = WSTransport;

},{"./heartbeat":6,"./log":7,"ws":43}],21:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = Buffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var kMaxLength = 0x3fffffff

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Note:
 *
 * - Implementation must support adding new properties to `Uint8Array` instances.
 *   Firefox 4-29 lacked support, fixed in Firefox 30+.
 *   See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *  - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *  - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *    incorrect length in some situations.
 *
 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they will
 * get the Object implementation, which is slower but will work correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = (function () {
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return 42 === arr.foo() && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        new Uint8Array(1).subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding, noZero) {
  if (!(this instanceof Buffer))
    return new Buffer(subject, encoding, noZero)

  var type = typeof subject

  // Find the length
  var length
  if (type === 'number')
    length = subject > 0 ? subject >>> 0 : 0
  else if (type === 'string') {
    if (encoding === 'base64')
      subject = base64clean(subject)
    length = Buffer.byteLength(subject, encoding)
  } else if (type === 'object' && subject !== null) { // assume object is array-like
    if (subject.type === 'Buffer' && isArray(subject.data))
      subject = subject.data
    length = +subject.length > 0 ? Math.floor(+subject.length) : 0
  } else
    throw new TypeError('must start with number, buffer, array or string')

  if (this.length > kMaxLength)
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
      'size: 0x' + kMaxLength.toString(16) + ' bytes')

  var buf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    buf = Buffer._augment(new Uint8Array(length))
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    buf = this
    buf.length = length
    buf._isBuffer = true
  }

  var i
  if (Buffer.TYPED_ARRAY_SUPPORT && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    buf._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++)
        buf[i] = subject.readUInt8(i)
    } else {
      for (i = 0; i < length; i++)
        buf[i] = ((subject[i] % 256) + 256) % 256
    }
  } else if (type === 'string') {
    buf.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer.TYPED_ARRAY_SUPPORT && !noZero) {
    for (i = 0; i < length; i++) {
      buf[i] = 0
    }
  }

  return buf
}

Buffer.isBuffer = function (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b))
    throw new TypeError('Arguments must be Buffers')

  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function (list, totalLength) {
  if (!isArray(list)) throw new TypeError('Usage: Buffer.concat(list[, length])')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.byteLength = function (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    case 'hex':
      ret = str.length >>> 1
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    default:
      ret = str.length
  }
  return ret
}

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

// toString(encoding, start=0, end=buffer.length)
Buffer.prototype.toString = function (encoding, start, end) {
  var loweredCase = false

  start = start >>> 0
  end = end === undefined || end === Infinity ? this.length : end >>> 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase)
          throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.equals = function (b) {
  if(!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max)
      str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b)
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var byte = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(byte)) throw new Error('Invalid hex string')
    buf[offset + i] = byte
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string), buf, offset, length, 2)
  return charsWritten
}

Buffer.prototype.write = function (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0
  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new TypeError('Unknown encoding: ' + encoding)
  }
  return ret
}

Buffer.prototype.toJSON = function () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function binarySlice (buf, start, end) {
  return asciiSlice(buf, start, end)
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len;
    if (start < 0)
      start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0)
      end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start)
    end = start

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    return Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    var newBuf = new Buffer(sliceLen, undefined, true)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
    return newBuf
  }
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0)
    throw new RangeError('offset is not uint')
  if (offset + ext > length)
    throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
      ((this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3])
}

Buffer.prototype.readInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80))
    return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      (this[offset + 3])
}

Buffer.prototype.readFloatLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

Buffer.prototype.writeUInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = value
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = value
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

Buffer.prototype.writeInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = value
  return offset + 1
}

Buffer.prototype.writeInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function (target, target_start, start, end) {
  var source = this

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (!target_start) target_start = 0

  // Copy 0 bytes; we're done
  if (end === start) return
  if (target.length === 0 || source.length === 0) return

  // Fatal error conditions
  if (end < start) throw new TypeError('sourceEnd < sourceStart')
  if (target_start < 0 || target_start >= target.length)
    throw new TypeError('targetStart out of bounds')
  if (start < 0 || start >= source.length) throw new TypeError('sourceStart out of bounds')
  if (end < 0 || end > source.length) throw new TypeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length)
    end = this.length
  if (target.length - target_start < end - start)
    end = target.length - target_start + start

  var len = end - start

  if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new TypeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new TypeError('start out of bounds')
  if (end < 0 || end > this.length) throw new TypeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array get/set methods before overwriting
  arr._get = arr.get
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-z]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    var b = str.charCodeAt(i)
    if (b <= 0x7F) {
      byteArray.push(b)
    } else {
      var start = i
      if (b >= 0xD800 && b <= 0xDFFF) i++
      var h = encodeURIComponent(str.slice(start, i+1)).substr(1).split('%')
      for (var j = 0; j < h.length; j++) {
        byteArray.push(parseInt(h[j], 16))
      }
    }
  }
  return byteArray
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(str)
}

function blitBuffer (src, dst, offset, length, unitSize) {
  if (unitSize) length -= length % unitSize;
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length))
      break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

},{"base64-js":22,"ieee754":23,"is-array":24}],22:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS)
			return 62 // '+'
		if (code === SLASH)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],23:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],24:[function(require,module,exports){

/**
 * isArray
 */

var isArray = Array.isArray;

/**
 * toString
 */

var str = Object.prototype.toString;

/**
 * Whether or not the given `val`
 * is an array.
 *
 * example:
 *
 *        isArray([]);
 *        // > true
 *        isArray(arguments);
 *        // > false
 *        isArray('');
 *        // > false
 *
 * @param {mixed} val
 * @return {bool}
 */

module.exports = isArray || function (val) {
  return !! val && '[object Array]' == str.call(val);
};

},{}],25:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],26:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],27:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],28:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],29:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":28,"_process":27,"inherits":26}],30:[function(require,module,exports){
'use strict';

module.exports.RTCIceCandidate = require('./rtcicecandidate');
module.exports.RTCPeerConnection = require('./rtcpeerconnection');
module.exports.RTCSessionDescription = require('./rtcsessiondescription');

},{"./rtcicecandidate":33,"./rtcpeerconnection":34,"./rtcsessiondescription":36}],31:[function(require,module,exports){
'use strict';

/**
 * Construct a {@link MediaSection}.
 * @class
 * @classdesc
 * @param {?string} [address="0.0.0.0"]
 * @param {?Array<RTCIceCandidate>} [candidates=[]]
 * @param {object} capabilities
 * @param {string} direction - one of "sendrecv", "sendonly", "recvonly", or "inactive"
 * @param {string} kind - one of "audio" or "video"
 * @param {string} mid
 * @param {?number} [port=9]
 * @param {?boolean} [rtcpMux=true]
 * @param {?string} streamId
 * @param {?MediaStreamTrack} track
 * @property {Array<RTCIceCandidate>} candidates
 * @property {object} capabilities
 * @property {?RTCIceCandidate} defaultCandidate
 * @property {string} direction - one of "sendrecv", "sendonly", "recvonly", or "inactive"
 * @property {string} kind - one of "audio" or "video"
 * @property {string} mid
 * @property {number} port
 * @property {boolean} rtcpMux
 * @property {?string} streamId
 * @property {?MediaStreamTrack} track
 */
function MediaSection(address, _candidates, capabilities, direction, kind, mid, port, rtcpMux, streamId, track) {
  if (!(this instanceof MediaSection)) {
    return new MediaSection(address, _candidates, capabilities, direction, kind,
      mid, port, rtcpMux, streamId, track);
  }
  var rejected = false;
  address = address || '0.0.0.0';
  port = typeof port === 'number' ? port : 9;
  rtcpMux = typeof rtcpMux === 'boolean' ? rtcpMux : true;
  streamId = streamId || null;
  track = track || null;
  Object.defineProperties(this, {
    _address: {
      get: function() {
        return address;
      },
      set: function(_address) {
        address = _address;
      }
    },
    _candidates: {
      value: []
    },
    _port: {
      get: function() {
        return port;
      },
      set: function(_port) {
        port = _port;
      }
    },
    _rejected: {
      get: function() {
        return rejected;
      },
      set: function(_rejected) {
        rejected = _rejected;
      }
    },
    _streamId: {
      get: function() {
        return streamId;
      },
      set: function(_streamId) {
        streamId = _streamId;
      }
    },
    _track: {
      get: function() {
        return track;
      },
      set: function(_track) {
        track = _track;
      }
    },
    _triples: {
      value: new Set()
    },
    candidates: {
      enumerable: true,
      get: function() {
        return this._candidates.slice();
      }
    },
    capabilities: {
      enumerable: true,
      value: capabilities
    },
    defaultCandidate: {
      enumerable: true,
      get: function() {
        return this._candidates.length ? this._candidates[0] : null;
      }
    },
    direction: {
      enumerable: true,
      value: direction
    },
    kind: {
      enumerable: true,
      value: kind
    },
    port: {
      enumerable: true,
      get: function() {
        return port;
      }
    },
    rtcpMux: {
      enumerable: true,
      value: rtcpMux
    },
    streamId: {
      enumerable: true,
      get: function() {
        return streamId;
      }
    },
    track: {
      enumerable: true,
      get: function() {
        return track;
      }
    }
  });
  if (_candidates) {
    _candidates.forEach(this.addCandidate, this);
  }
}

/**
 * Add an RTCIceCandidate to the {@link MediaSection}.
 * @param {RTCIceCandidate} candidate
 * @returns {boolean}
 */
MediaSection.prototype.addCandidate = function addCandidate(candidate) {
  var triple = [
    candidate.ip,
    candidate.port,
    candidate.protocol
  ].join(' ');
  if (!this._triples.has(triple)) {
    this._triples.add(triple);
    this._candidates.push(candidate);
    return true;
  }
  return false;
};

/**
 * Copy the {@link MediaSection}.
 * @param {?string} address - if unsupplied, use the {@link MediaSection} defaults
 * @param {?Array<RTCIceCandidates> candidates - if unsupplied, use the {@link MediaSection} defaults
 * @param {?string} capabilities - if unsupplied, copy the existing capabilities
 * @param {?string} direction - if unsupplied, copy the existing direction
 * @param {?number} port - if unsupplied, use the {@link MediaSection} defaults
 * @param {?string} streamId - if unsupplied, set to null
 * @param {?MediaStreamTrack} track - if unsupplied, set to null
 * @returns {MediaSection}
 */
MediaSection.prototype.copy = function copy(address, candidates, capabilities, direction, port, streamId, track) {
  return new MediaSection(this.address, candidates,
    capabilities || this.capabilities, direction || this.direction, this.kind,
    this.mid, port, this.rtcpMux, streamId, track);
};

/**
 * Copy and reject the {@link MediaSection}.
 * @returns {MediaSection}.
 */
MediaSection.prototype.copyAndReject = function copyAndReject() {
  var mediaSection = new MediaSection(null, this.candidates, this.capabilities,
    this.direction, this.kind, this.mid, null, this.rtcpMux);
  return mediaSection.reject();
};

/**
 * Reject the {@link MediaSection}.
 * @returns {MediaSection}
 */
MediaSection.prototype.reject = function reject() {
  // RFC 3264, Section 6:
  //
  //     To reject an offered stream, the port number in the corresponding
  //     stream in the answer MUST be set to zero. Any media formats listed
  //     are ignored. At least one MUST be present, as specified by SDP.
  //
  this.setPort(0);
  return this;
};

/**
 * Set the {@link MediaSection}'s address.
 * @param {string} address
 * @returns {MediaSection}
 */
MediaSection.prototype.setAddress = function setAddress(address) {
  this._address = address;
  return this;
};

/**
 * Set the {@link MediaSection}'s port.
 * @param {number} port
 * @returns {MediaSection}
 */
MediaSection.prototype.setPort = function setPort(port) {
  this._port = port;
  return this;
};

/* MediaSection.prototype.setStreamId = function setStreamId(streamId) {
  this._streamId = streamId;
  return this;
};

MediaSection.prototype.setTrack = function setTrack(track) {
  this._track = track;
  return this;
}; */

module.exports = MediaSection;

},{}],32:[function(require,module,exports){
'use strict';

/**
 * Construct a {@link MediaStreamEvent}.
 * @class
 * @classdesc
 * @extends Event
 * @param {string} type - one of "addstream" or "removestream"
 * @param {object} init
 * @property {MediaStream} stream
 */
function MediaStreamEvent(type, init) {
  if (!(this instanceof MediaStreamEvent)) {
    return new MediaStreamEvent(type, init);
  }
  Event.call(this, type, init);
  Object.defineProperties(this, {
    stream: {
      enumerable: true,
      value: init.stream
    }
  });
}

module.exports = MediaStreamEvent;

},{}],33:[function(require,module,exports){
'use strict';

/**
 * Construct an {@link RTCIceCandidate}.
 * @class
 * @classdesc
 * @param {object} candidate
 * @property {string} candidate
 * @property {number} sdpMLineIndex
 */
function RTCIceCandidate(candidate) {
  if (!(this instanceof RTCIceCandidate)) {
    return new RTCIceCandidate(candidate);
  }
  Object.defineProperties(this, {
    candidate: {
      enumerable: true,
      value: candidate.candidate
    },
    sdpMLineIndex: {
      enumerable: true,
      value: candidate.sdpMLineIndex
    }
  });
}

module.exports = RTCIceCandidate;

},{}],34:[function(require,module,exports){
'use strict';

var MediaSection = require('./mediasection');
var MediaStreamEvent = require('./mediastreamevent');
var RTCIceCandidate = require('./rtcicecandidate');
var RTCPeerConnectionIceEvent = require('./rtcpeerconnectioniceevent');
var RTCSessionDescription = require('./rtcsessiondescription');
var sdpTransform = require('sdp-transform');
var sdpUtils = require('./sdp-utils');

/**
 * Construct an {@link RTCPeerConnection}.
 * @class
 * @classdesc This {@link RTCPeerConnection} is implemented in terms of ORTC APIs.
 * @param {RTCConfiguration} configuration
 * @property {string} iceConnectionState
 * @property {string} iceGatheringState
 * @property {?RTCSessionDescription} localDescription
 * @property {?function} onaddstream
 * @property {?function} onicecandidate
 * @property {?function} oniceconnectionstatechange
 * @property {?function} onsignalingstatechange
 * @property {?RTCSessionDescription} remoteDescription
 * @property {string} signalingState
 */
function RTCPeerConnection(configuration) {
  if (!(this instanceof RTCPeerConnection)) {
    return new RTCPeerConnection(configuration);
  }

  // ICE Gatherer

  var gatherOptions = makeGatherOptions(configuration);
  /* global RTCIceGatherer:true */
  var iceGatherer = new RTCIceGatherer(gatherOptions);
  var iceGatheringCompleted = false;

  iceGatherer.onlocalcandidate = this._onlocalcandidate.bind(this);

  var onicecandidate = null;
  var onicecandidateWasSet = false;

  var iceCandidatesAdded = 0;

  // ICE Transport

  /* global RTCIceTransport:true */
  var iceTransport = new RTCIceTransport();
  var oniceconnectionstatechange = null;

  iceTransport.onicestatechange = this._onicestatechange.bind(this);

  // DTLS Transport

  /* global RTCDtlsTransport:true */
  var dtlsTransport = new RTCDtlsTransport(iceTransport);

  dtlsTransport.ondtlsstatechange = this._ondtlsstatechange.bind(this);

  // Descriptions

  var signalingState = 'stable';
  var onsignalingstatechange = null;

  var localDescription = null;
  var remoteDescription = null;

  // Streams

  var onaddstream = null;

  Object.defineProperties(this, {
    _dtlsTransport: {
      value: dtlsTransport
    },
    _dtmfSenders: {
      value: new Map()
    },
    _gatherOptions: {
      value: gatherOptions
    },
    _iceCandidatesAdded: {
      get: function() {
        return iceCandidatesAdded;
      },
      set: function(_iceCandidatesAdded) {
        iceCandidatesAdded = _iceCandidatesAdded;
      }
    },
    _iceGatherer: {
      value: iceGatherer
    },
    _iceGatheringCompleted: {
      get: function() {
        return iceGatheringCompleted;
      },
      set: function(_iceGatheringCompleted) {
        iceGatheringCompleted = _iceGatheringCompleted;
      }
    },
    _iceTransport: {
      value: iceTransport
    },
    _localCandidates: {
      value: new Set()
    },
    _localDescription: {
      get: function() {
        return localDescription;
      },
      set: function(_localDescription) {
        localDescription = _localDescription;
      }
    },
    _localStreams: {
      value: []
    },
    _midCounters: {
      value: {
        audio: 0,
        video: 0
      }
    },
    _remoteCandidates: {
      value: new Set()
    },
    _remoteDescription: {
      get: function() {
        return remoteDescription;
      },
      set: function(_remoteDescription) {
        remoteDescription = _remoteDescription;
      }
    },
    _remoteStreams: {
      value: []
    },
    _rtpReceivers: {
      value: new Map()
    },
    _rtpSenders: {
      value: new Map()
    },
    _signalingState: {
      get: function() {
        return signalingState;
      },
      set: function(_signalingState) {
        signalingState = _signalingState;
        if (this.onsignalingstatechange) {
          this.onsignalingstatechange();
        }
      }
    },
    _streamIds: {
      value: new Map()
    },
    iceConnectionState: {
      enumerable: true,
      get: function() {
        return iceTransport.state;
      }
    },
    iceGatheringState: {
      enumerable: true,
      get: function() {
        return iceGatheringCompleted ? 'gathering' : 'complete';
      }
    },
    localDescription: {
      enumerable: true,
      get: function() {
        return localDescription;
      }
    },
    onaddstream: {
      enumerable: true,
      get: function() {
        return onaddstream;
      },
      set: function(_onaddstream) {
        onaddstream = _onaddstream;
      }
    },
    onicecandidate: {
      enumerable: true,
      get: function() {
        return onicecandidate;
      },
      set: function(_onicecandidate) {
        onicecandidate = _onicecandidate;
        if (!onicecandidateWasSet) {
          try {
            iceGatherer.getLocalCandidates()
              .forEach(iceGatherer.onlocalcandidate);
          } catch (error) {
            // Do nothing.
          }
        }
        onicecandidateWasSet = true;
      }
    },
    oniceconnectionstatechange: {
      enumerable: true,
      get: function() {
        return oniceconnectionstatechange;
      },
      set: function(_oniceconnectionstatechange) {
        oniceconnectionstatechange = _oniceconnectionstatechange;
      }
    },
    onsignalingstatechange: {
      enumerable: true,
      get: function() {
        return onsignalingstatechange;
      },
      set: function(_onsignalingstatechange) {
        onsignalingstatechange = _onsignalingstatechange;
      }
    },
    remoteDescription: {
      enumerable: true,
      get: function() {
        return remoteDescription;
      }
    },
    signalingState: {
      enumerable: true,
      get: function() {
        return signalingState;
      }
    }
  });
}

RTCPeerConnection.prototype._makeMid = function _makeMid(kind) {
  return kind + ++this._midCounters[kind];
};

/**
 * This method is assigned to the {@link RTCDtlsTransport}'s "ondtlsstatechange" event handler.
 * @access private
 * @param {object} event
 */
RTCPeerConnection.prototype._ondtlsstatechange = function _ondtlsstatechange(event) {
  void event;
};

/**
 * This method is assigned to the {@link RTCIceTransport}'s "onicestatechange" event handler.
 * @access private
 * @param {object} event
 */
RTCPeerConnection.prototype._onicestatechange = function _onicestatechange(event) {
  if (this.oniceconnectionstatechange) {
    this.oniceconnectionstatechange(event);
  }
};

/**
 * This method is assigned to the {@link RTCIceGatherer}'s "onlocalcandidate" event handler.
 * @access private
 * @param {object} event
 */
RTCPeerConnection.prototype._onlocalcandidate = function _onlocalcandidate(event) {
  if (isEmptyObject(event.candidate)) {
    this._iceGatheringCompleted = true;
  }
  this._localCandidates.add(event.candidate);
  if (this.onicecandidate) {
    var webrtcCandidate = makeWebRTCCandidate(event.candidate);
    this.onicecandidate(makeOnIceCandidateEvent(webrtcCandidate));
  }
};

/**
 * Start sending RTP.
 * @access private
 * @param {MediaSection} mediaSection
 * @returns {this}
 */
RTCPeerConnection.prototype._sendRtp = function _sendRtp(mediaSection) {
  var kind = mediaSection.kind;
  // FIXME(mroberts): This is not right.
  this._rtpSenders.forEach(function(rtpSender) {
    if (rtpSender.track.kind !== kind) {
      return;
    }
    rtpSender.send(mediaSection.capabilities);
  }, this);
  return this;
};

/**
 * Start sending and receiving RTP for the given {@link MediaSection}s.
 * @access private
 * @param {Array<MediaSection>} mediaSections
 * @returns {this}
 */
RTCPeerConnection.prototype._sendAndReceiveRtp = function _sendAndReceiveRtp(mediaSections) {
  mediaSections.forEach(function(mediaSection) {
    if (mediaSection.direction === 'sendrecv' || mediaSection.direction === 'sendonly') {
      this._sendRtp(mediaSection);
    }
    if (mediaSection.direction === 'sendrecv' || mediaSection.direction === 'recvonly') {
    this._receiveRtp(mediaSection);
    }
  }, this);
  return this;
};

/**
 * Start receiving RTP.
 * @access private
 * @param {MediaSection} mediaSection
 * @returns {this}
 */
RTCPeerConnection.prototype._receiveRtp = function _receiveRtp(mediaSection) {
  var kind = mediaSection.capabilities.type;
  /* global RTCRtpReceiver:true */
  var rtpReceiver = new RTCRtpReceiver(this._dtlsTransport, kind);
  rtpReceiver.receive(mediaSection.capabilities);

  var track = rtpReceiver.track;
  this._rtpReceivers.set(track, rtpReceiver);

  // NOTE(mroberts): Without any source-level msid attribute, we are just
  // going to assume a one-to-one mapping between MediaStreams and
  // MediaStreamTracks.
  /* global MediaStream:true */
  var mediaStream = new MediaStream();
  mediaStream.addTrack(track);
  this._remoteStreams.push(mediaStream);

  if (this.onaddstream) {
    this.onaddstream(makeOnAddStreamEvent(mediaStream));
  }
  return this;
};

/**
 * Start the {@link RTCDtlsTransport}.
 * @access private
 * @param {RTCDtlsParameters} dtlsParameters - the remote DTLS parameters
 * @returns {this}
 */
RTCPeerConnection.prototype._startDtlsTransport = function _startDtlsTransport(dtlsParameters) {
  this._dtlsTransport.start(dtlsParameters);
  return this;
};

/**
 * Start the {@link RTCIceTransport}.
 * @access private
 * @param {RTCIceParameters} iceParameters - the remote ICE parameters
 * @returns {this}
 */
RTCPeerConnection.prototype._startIceTransport = function _startIceTransport(iceParameters) {
  var role = this.signalingState === 'have-local-offer'
    ? 'controlling'
    : 'controlled';
  this._iceTransport.start(this._iceGatherer, iceParameters, role);
  return this;
};

/**
 * Add an {@link RTCIceCandidate} to the {@link RTCPeerConnection}.
 * @param {RTCIceCandidate} candidate - the remote ICE candidate
 * @param {?function} [onSuccess]
 * @param {?function} [onFailure]
 * @returns {Promise}
 */
RTCPeerConnection.prototype.addIceCandidate = function addIceCandidate(candidate, onSuccess, onFailure) {
  // NOTE(mroberts): I'm not sure there is a scenario where we'd ever call
  // onFailure.
  void onFailure;

  this._iceCandidatesAdded++;

  var ortcCandidate = makeORTCCandidate(candidate);

  // A candidate is identified by a triple of IP address, port, and protocol.
  // ORTC ICE candidates have no component ID, and so we need to deduplicate
  // the RTP and RTCP candidates when we're muxing.
  var triple =
    [ortcCandidate.ip, ortcCandidate.port, ortcCandidate.transport].join(' ');
  if (!this._remoteCandidates.has(triple)) {
    this._remoteCandidates.add(triple);
    this._iceTransport.addRemoteCandidate(ortcCandidate);
  }

  if (onSuccess) {
    onSuccess();
  }
};

/**
 * Add a {@link MediaStream} to the {@link RTCPeerConnection}.
 * @param {MediaStream} stream
 */
RTCPeerConnection.prototype.addStream = function addStream(mediaStream) {
  this._localStreams.push(mediaStream);
  mediaStream.getTracks().forEach(function(track) {
    /* eslint no-invalid-this:0 */
    /* global RTCRtpSender:true */
    var rtpSender = new RTCRtpSender(track, this._dtlsTransport);
    this._rtpSenders.set(track, rtpSender);
    this._streamIds.set(track, mediaStream.id);
  }, this);
};

/**
 * Close the {@link RTCPeerConnection}.
 */
RTCPeerConnection.prototype.close = function close() {
  this._signalingState = 'closed';
  this._rtpReceivers.forEach(function(rtpReceiver) {
    rtpReceiver.stop();
  });
  this._dtlsTransport.stop();
  this._iceTransport.stop();
};

/**
 * Construct an {@link RTCSessionDescription} containing an SDP answer.
 * @param {?function} [onSuccess]
 * @param {?function} [onFailure]
 * @returns {Promise<RTCSessionDescription>}
 */
RTCPeerConnection.prototype.createAnswer = function createAnswer(onSuccess, onFailure) {
  if (this.signalingState !== 'have-remote-offer') {
    return void onFailure(invalidSignalingState(this.signalingState));
  }

  // draft-ietf-rtcweb-jsep-11, Section 5.3.1:
  //
  //     The next step is to go through each offered m= section. If there is a
  //     local MediaStreamTrack of the same type which has been added to the
  //     PeerConnection via addStream and not yet associated with a m= section,
  //     and the specific m= section is either sendrecv or recvonly, the
  //     MediaStreamTrack will be associated with the m= section at this time.
  //     MediaStreamTracks are assigned using the canonical order described in
  //     Section 5.2.1.
  //
  var remote = sdpUtils.parseDescription(this.remoteDescription); // sdpTransform.parse(this.remoteDescription.sdp);
  var streams = this.getLocalStreams();
  var tracks = { audio: [], video: [] };
  streams.forEach(function(stream) {
    tracks.audio = tracks.audio.concat(stream.getAudioTracks());
    tracks.video = tracks.video.concat(stream.getVideoTracks());
  });
  var mediaSections = remote.mediaSections.map(function(remoteMediaSection) {
    var kind = remoteMediaSection.kind;
    var remoteDirection = remoteMediaSection.direction;

    var remoteCapabilities = remoteMediaSection.capabilities;
    var localCapabilities = RTCRtpSender.getCapabilities(kind);
    var sharedCodecs = intersectCodecs(remoteCapabilities.codecs,
      localCapabilities.codecs);
    var sharedCapabilities = { codecs: sharedCodecs };

    var capabilities = sharedCapabilities;
    var direction;
    var track;

    // RFC 3264, Section 6.1:
    //
    //     If the answerer has no media formats in common for a particular
    //     offered stream, the answerer MUST reject that media stream by
    //     setting the port to zero.
    //
    if (!sharedCodecs.length) {
      return remoteMediaSection.copyAndReject();
    }

    // RFC 3264, Section 6.1:
    //
    //     For streams marked as inactive in the answer, the list of media
    //     formats is constructed based on the offer. If the offer was
    //     sendonly, the list is constructed as if the answer were recvonly.
    //     Similarly, if the offer was recvonly, the list is constructed as if
    //     the answer were sendonly, and if the offer was sendrecv, the list is
    //     constructed as if the answer were sendrecv. If the offer was
    //     inactive, the list is constructed as if the offer were actually
    //     sendrecv and the answer were sendrecv.
    //
    if (remoteDirection === 'inactive'
      || remoteDirection === 'recvonly' && !tracks[kind].length)
    {
      direction = 'inactive';
    } else if (remoteDirection === 'recvonly') {
      track = tracks[kind].shift();
      direction = 'sendonly';
    } else if (remoteDirection === 'sendrecv') {
      track = tracks[kind].shift();
      direction = track ? 'sendrecv' : 'recvonly';
    } else { // sendonly
      direction = 'recvonly';
    }

    var streamId = this._streamIds.get(track);
    var mediaSection = remoteMediaSection.copy(null, null, capabilities,
      direction, null, streamId, track);
    return mediaSection;
  }, this);

  // FIXME(mroberts): We should probably provision an ICE transport for each
  // MediaSection in the event BUNDLE is not supported.
  mediaSections.forEach(function(mediaSection) {
    this._localCandidates.forEach(mediaSection.addCandidate, mediaSection);
  }, this);

  var sdp = sdpUtils.makeInitialSDPBlob();
  sdpUtils.addMediaSectionsToSDPBlob(sdp, mediaSections);
  sdpUtils.addIceParametersToSDPBlob(sdp, this._iceGatherer.getLocalParameters());
  sdpUtils.addDtlsParametersToSDPBlob(sdp, this._dtlsTransport.getLocalParameters());

  var description = new RTCSessionDescription({
    sdp: sdpTransform.write(sdp),
    type: 'answer'
  });

  onSuccess(description);
};

RTCPeerConnection.prototype.createDTMFSender = function createDTMFSender(track) {
  if (!this._dtmfSenders.has(track)) {
    var rtpSender = this._rtpSenders.get(track);
    /* global RTCDtmfSender:true */
    var dtmfSender = new RTCDtmfSender(rtpSender);
    this._dtmfSenders.set(track, dtmfSender);
  }
  return this._dtmfSenders.get(track);
};

/**
 * Construct an {@link RTCSessionDescription} containing an SDP offer.
 * @param {?function} [onSuccess]
 * @param {?function} [onFailure]
 * @param {?RTCOfferOptions} [options]
 * @returns {Promise<RTCSessionDescription>}
 */
RTCPeerConnection.prototype.createOffer = function createOffer(onSuccess, onFailure, options) {
  // draft-ieft-rtcweb-jsep-11, Section 5.2.3:
  //
  //    If the 'OfferToReceiveAudio' option is specified, with an integer value
  //    of N, and M audio MediaStreamTracks have been added to the
  //    PeerConnection, the offer MUST include M non-rejected m= sections with
  //    media type 'audio', even if N is greater than M. ... the directional
  //    attribute on the N-M audio m= sections without associated
  //    MediaStreamTracks MUST be set to recvonly.
  //
  //    ...
  //
  //    For backwards compatibility with pre-standards versions of this
  //    specification, a value of 'true' is interpreted as equivalent to N=1,
  //    and 'false' as N=0.
  //
  var N = { audio: null, video: null };
  var M = { audio: 0,    video: 0    };
  options = options || {};
  ['optional', 'mandatory'].forEach(function(optionType) {
    if (!(optionType in options)) {
      return;
    }
    if ('OfferToReceiveAudio' in options[optionType]) {
      N.audio = Number(options[optionType].OfferToReceiveAudio);
    }
    if ('OfferToReceiveVideo' in options[optionType]) {
      N.video = Number(options[optionType].OfferToReceiveVideo);
    }
  });

  var mediaSections = [];

  // draft-ietf-rtcweb-jsep-11, Section 5.2.1:
  //
  //     m=sections MUST be sorted first by the order in which the MediaStreams
  //     were added to the PeerConnection, and then by the alphabetical
  //     ordering of the media type for the MediaStreamTrack.
  //
  var _N = { audio: N.audio, video: N.video };
  var streams = this.getLocalStreams();
  streams.forEach(function(stream) {
    var audioTracks = stream.getAudioTracks();
    var videoTracks = stream.getVideoTracks();
    M.audio += audioTracks.length;
    M.video += videoTracks.length;
    var tracks = audioTracks.concat(videoTracks);
    tracks.forEach(function(track) {
      var kind = track.kind;
      var capabilities = RTCRtpSender.getCapabilities(kind);
      var direction;
      var mid = this._makeMid(kind);
      if (_N.audio === null) {
        direction = 'sendrecv';
      } else if (!_N[kind]) {
        direction = 'sendonly';
      } else {
        _N[kind]--;
        direction = 'sendrecv';
      }
      var mediaSection = new MediaSection(null, null, capabilities, direction,
        kind, mid, null, null, stream.id, track);
      mediaSections.push(mediaSection);
    }, this);
  }, this);

  // Add the N-M recvonly m=sections.
  ['audio', 'video'].forEach(function(kind) {
    var k = Math.max(N[kind] - M[kind], 0);
    if (!k) {
      return;
    }
    var capabilities = RTCRtpSender.getCapabilities(kind);
    var direction = 'recvonly';
    var mid;
    var mediaSection;
    while (k--) {
      mid = this._makeMid(kind);
      mediaSection = new MediaSection(null, null, capabilities, direction,
        kind, mid);
      mediaSections.push(mediaSection);
    }
  }, this);

  // FIXME(mroberts): We should probably provision an ICE transport for each
  // MediaSection in the event BUNDLE is not supported.
  mediaSections.forEach(function(mediaSection) {
    this._localCandidates.forEach(mediaSection.addCandidate, mediaSection);
  }, this);

  var sdp = sdpUtils.makeInitialSDPBlob();
  sdpUtils.addMediaSectionsToSDPBlob(sdp, mediaSections);
  sdpUtils.addIceParametersToSDPBlob(sdp, this._iceGatherer.getLocalParameters());
  sdpUtils.addDtlsParametersToSDPBlob(sdp, this._dtlsTransport.getLocalParameters());

  var description = new RTCSessionDescription({
    sdp: sdpTransform.write(sdp),
    type: 'offer'
  });

  onSuccess(description);
};

/**
 * Get the {@link MediaStream}s that are currently or will be sent with this
 * {@link RTCPeerConnection}.
 * @returns {Array<MediaStream>}
 */
RTCPeerConnection.prototype.getLocalStreams = function getLocalStreams() {
  return this._localStreams.slice();
};

/**
 * Get the {@link MediaStreams} that are currently received by this
 * {@link RTCPeerConnection}.
 * @returns {Array<MediaStream>}
 */
RTCPeerConnection.prototype.getRemoteStreams = function getRemoteStreams() {
  return this._remoteStreams.slice();
};

/**
 * Apply the supplied {@link RTCSessionDescription} as the local description.
 * @param {RTCSessionDescription}
 * @param {?function} [onSuccess]
 * @param {?function} [onFailure]
 * @returns {Promise}
 */
RTCPeerConnection.prototype.setLocalDescription = function setLocalDescription(description, onSuccess, onFailure) {
  var nextSignalingState;
  switch (this.signalingState) {
    case 'stable':
      nextSignalingState = 'have-local-offer';
      break;
    case 'have-remote-offer':
      nextSignalingState = 'stable';
      break;
    default:
      return void onFailure(invalidSignalingState(this.signalingState));
  }
  var parsed = sdpUtils.parseDescription(description);
  if (this.signalingState === 'have-remote-offer') {
    parsed.mediaSections.forEach(this._sendRtp, this);
    // FIXME(mroberts): ...
    var remote = sdpUtils.parseDescription(this.remoteDescription);
    var remoteSsrc = remote.mediaSections[0].capabilities.encodings[0].ssrc;
    parsed.mediaSections.forEach(function(mediaSection) {
      mediaSection.capabilities.encodings.forEach(function(encoding) {
        encoding.ssrc = remoteSsrc;
      });
      mediaSection.capabilities.rtcp.ssrc = remoteSsrc;
    });
    parsed.mediaSections.forEach(this._receiveRtp, this);
  }
  this._localDescription = description;
  this._signalingState = nextSignalingState;
  onSuccess();
};

/**
 * Apply the supplied {@link RTCSessionDescription} as the remote offer or answer.
 * @param {RTCSessionDescription}
 * @param {?function} [onSuccess]
 * @param {?function} [onFailure]
 * @returns {Promise}
 */
RTCPeerConnection.prototype.setRemoteDescription = function setRemoteDescription(description, onSuccess, onFailure) {
  var nextSignalingState;
  switch (this.signalingState) {
    case 'stable':
      nextSignalingState = 'have-remote-offer';
      break;
    case 'have-local-offer':
      nextSignalingState = 'stable';
      break;
    default:
      return void onFailure(invalidSignalingState(this.signalingState));
  }
  var parsed = sdpUtils.parseDescription(description);
  parsed.mediaSections.forEach(function(mediaSection) {
    mediaSection.candidates.forEach(this._iceTransport.addRemoteCandidate,
      this._iceTransport);
  }, this);
  this._startIceTransport(parsed.iceParameters[0]);
  this._startDtlsTransport(parsed.dtlsParameters[0]);
  if (this.signalingState === 'have-local-offer') {
    parsed.mediaSections.forEach(this._receiveRtp, this);
    // FIXME(mroberts): ...
    parsed.mediaSections.forEach(this._sendRtp, this);
  }
  this._remoteDescription = description;
  this._signalingState = nextSignalingState;
  onSuccess();
};

/**
 * Construct an "invalid signaling state" {@link Error}.
 * @access private
 * @param {string} singalingState
 * @returns {Error}
 */
function invalidSignalingState(signalingState) {
  return new Error('Invalid signaling state: ' + signalingState);
}

/**
 * Check if an object is empty (i.e. the object contains no keys).
 * @access private
 * @param {object} object
 * @returns {boolean}
 */
function isEmptyObject(object) {
  return !Object.keys(object).length;
}

/**
 * Construct {@link RTCIceGatherOptions} from an {@link RTCConfiguration}.
 * @access private
 * @param {RTCConfiguration} configuration
 * @returns {RTCIceGatherOptions}
 */
function makeGatherOptions(configuration) {
  return {
    gatherPolicy: configuration.gatherPolicy || 'all',
    iceServers: []
  };
}

/**
 * Construct an "addstream" {@link MediaStreamEvent}.
 * @access private
 * @param {MediaStream} stream
 * @returns {MediaStreamEvent}
 */
function makeOnAddStreamEvent(stream) {
  return new MediaStreamEvent('addstream', {
    stream: stream
  });
}

/**
 * Construct an "icecandidate" {@link RTCPeerConnectionIceEvent}.
 * @access private
 * @param {RTCIceCandidate} candidate
 * @returns {RTCPeerConnectionIceEvent}
 */
function makeOnIceCandidateEvent(candidate) {
  return new RTCPeerConnectionIceEvent('icecandidate', {
    candidate: candidate
  });
}

/**
 * Construct an ORTC ICE candidate from a WebRTC ICE candidate.
 * @access private
 * @param {RTCIceCandidate} candidate - an WebRTC ICE candidate
 * @returns {RTCIceCanddidate}
 */
function makeORTCCandidate(candidate) {
  if (!candidate) {
    return {};
  }
  var start = candidate.candidate.indexOf('candidate:');
  var line = candidate.candidate
    .slice(start + 10)
    .replace(/ +/g, ' ')
    .split(' ');
  var ortcIceCandidate = {
    foundation: line[0],
    protocol: line[2],
    priority: parseInt(line[3]),
    ip: line[4],
    port: parseInt(line[5]),
    type: line[7],
    relatedAddress: null,
    relatedPort: 0,
    tcpType: 'active'
  };
  if (ortcIceCandidate.type !== 'host') {
    ortcIceCandidate.relatedAddress = line[9];
    ortcIceCandidate.relatedPort = parseInt(line[11]);
  }
  return ortcIceCandidate;
}

/**
 * Construct a WebRTC ICE candidate from an ORTC ICE candidate.
 * @access private
 * @param {RTCIceCandidate} candidate - an ORTC ICE candidate
 * @returns {RTCIceCandidate}
 */
function makeWebRTCCandidate(candidate) {
  if (isEmptyObject(candidate)) {
    return null;
  }
  var line = [
    'a=candidate',
    candidate.foundation,
    1,
    candidate.protocol,
    candidate.priority,
    candidate.ip,
    candidate.port,
    candidate.type
  ];
  if (candidate.relatedAddress) {
    line = line.concat([
      'raddr',
      candidate.relatedAddress,
      'rport',
      candidate.relatedPort
    ]);
  }
  line.push('generation 0');
  return new RTCIceCandidate({
    candidate: line.join(' '),
    sdpMLineIndex: 0
  });
}

/**
 * Intersect codecs.
 * @param {Array<object>} localCodecs
 * @param {Array<object>} remoteCodecs
 * @returns {Array<object>}
 */
function intersectCodecs(localCodecs, remoteCodecs) {
  var sharedCodecs = [];
  localCodecs.forEach(function(localCodec) {
    remoteCodecs.forEach(function(remoteCodec) {
      if (localCodec.name === remoteCodec.name &&
        localCodec.clockRate === remoteCodec.clockRate &&
        localCodec.numChannels === remoteCodec.numChannels)
      {
        sharedCodecs.push(remoteCodec);
      }
    });
  });
  return sharedCodecs;
}

module.exports = RTCPeerConnection;

},{"./mediasection":31,"./mediastreamevent":32,"./rtcicecandidate":33,"./rtcpeerconnectioniceevent":35,"./rtcsessiondescription":36,"./sdp-utils":37,"sdp-transform":39}],35:[function(require,module,exports){
'use strict';

/**
 * Construct an {@link RTCPeerConnectionIceEvent}.
 * @class
 * @classdesc
 * @extends Event
 * @param {string} type - "icecandidate"
 * @param {object} init
 * @property {MediaStream} stream
 */
function RTCPeerConnectionIceEvent(type, init) {
  if (!(this instanceof RTCPeerConnectionIceEvent)) {
    return new RTCPeerConnectionIceEvent(type, init);
  }
  Event.call(this, type, init);
  Object.defineProperties(this, {
    candidate: {
      enumerable: true,
      value: init.candidate
    }
  });
}

module.exports = RTCPeerConnectionIceEvent;

},{}],36:[function(require,module,exports){
'use strict';

/**
 * Construct an {@link RTCSessionDescription}.
 * @class
 * @classdesc
 * @param {object} description
 * @property {string} sdp
 * @property {string} type - one of "offer" or "answer"
 */
function RTCSessionDescription(description) {
  if (!(this instanceof RTCSessionDescription)) {
    return new RTCSessionDescription(description);
  }
  Object.defineProperties(this, {
    sdp: {
      enumerable: true,
      value: description.sdp
    },
    type: {
      enumerable: true,
      value: description.type
    }
  });
}

module.exports = RTCSessionDescription;

},{}],37:[function(require,module,exports){
'use strict';

var MediaSection = require('./mediasection');
var sdpTransform = require('sdp-transform');

/**
 * Add ICE candidates to an arbitrary level of an SDP blob.
 * @param {?object} [level={}]
 * @param {?Array<RTCIceCandidate>} [candidates]
 * @param {?number} [component] - if unspecified, add both RTP and RTCP candidates
 * @returns {object}
 */
function addCandidatesToLevel(level, candidates, component) {
  level = level || {};
  level.candidates = level.candidates || [];
  if (!candidates) {
    return level;
  }
  candidates.forEach(function(candidate) {
    // TODO(mroberts): Empty dictionary check.
    if (!candidate.foundation) {
      level.endOfCandidates = 'end-of-candidates';
      return;
    }
    var candidate1 = {
      foundation: candidate.foundation,
      transport: candidate.protocol,
      priority: candidate.priority,
      ip: candidate.ip,
      port: candidate.port,
      type: candidate.type,
      generation: 0
    };
    if (candidate.relatedAddress) {
      candidate1.raddr = candidate.relatedAddress;
      candidate1.rport = candidate.relatedPort;
    }

    if (typeof component === 'number') {
      candidate1.component = component;
      level.candidates.push(candidate1);
      return;
    }

    // RTP candidate
    candidate1.component = 1;
    level.candidates.push(candidate1);

    // RTCP candidate
    var candidate2 = {};
    for (var key in candidate1) {
      candidate2[key] = candidate1[key];
    }
    candidate2.component = 2;
    level.candidates.push(candidate2);
  });
  return level;
}

/**
 * Add ICE candidates to the media-levels of an SDP blob. Since this adds to
 * the media-levels, you should call this after you have added all your media.
 * @param {?object} [sdp={}]
 * @param {?Array<RTCIceCandidate>} [candidates]
 * @param {?number} [component] - if unspecified, add both RTP and RTCP candidates
 * @returns {object}
 */
function addCandidatesToMediaLevels(sdp, candidates, component) {
  sdp = sdp || {};
  if (!sdp.media) {
    return sdp;
  }
  sdp.media.forEach(function(media) {
    addCandidatesToLevel(media, candidates, component);
  });
  return sdp;
}

/**
 * Add ICE candidates to the media-levels of an SDP blob. Since
 * this adds to the media-levels, you should call this after you have added
 * all your media.
 * @param {?object} [sdp={}]
 * @param {?Array<RTCIceCandidate>} [candidates]
 * @param {?number} [component] - if unspecified, add both RTP and RTCP candidates
 * @returns {object}
 */
function addCandidatesToSDPBlob(sdp, candidates, component) {
  sdp = sdp || {};
  // addCandidatesToSessionLevel(sdp, candidates, component);
  addCandidatesToMediaLevels(sdp, candidates, component);
  return sdp;
}

/**
 * Add the DTLS fingerprint to the media-levels of an SDP blob.
 * Since this adds to media-levels, you should call this after you have added
 * all your media.
 * @param {?object} [sdp={}]
 * @param {RTCDtlsParameters} dtlsParameters
 * @returns {object}
 */
function addDtlsParametersToSDPBlob(sdp, dtlsParameters) {
  sdp = sdp || {};
  // addDtlsParametersToSessionLevel(sdp, dtlsParameters);
  addDtlsParametersToMediaLevels(sdp, dtlsParameters);
  return sdp;
}

/**
 * Add the DTLS fingerprint to an arbitrary level of an SDP blob.
 * @param {?object} [sdp={}]
 * @param {RTCDtlsParameters} dtlsParameters
 * @returns {object}
 */
function addDtlsParametersToLevel(level, dtlsParameters) {
  level = level || {};
  var fingerprints = dtlsParameters.fingerprints;
  if (fingerprints.length) {
    level.fingerprint = {
      type: fingerprints[0].algorithm,
      hash: fingerprints[0].value
    };
  }
  return level;
}

/**
 * Add the DTLS fingerprint to the media-levels of an SDP blob. Since this adds
 * to the media-levels, you should call this after you have added all of your
 * media.
 * @param {?object} [sdp={}]
 * @param {RTCDtlsParameters} dtlsParameters
 * @returns {object}
 */
function addDtlsParametersToMediaLevels(sdp, dtlsParameters) {
  sdp = sdp || {};
  if (!sdp.media) {
    return sdp;
  }
  sdp.media.forEach(function(media) {
    addDtlsParametersToLevel(media, dtlsParameters);
  });
  return sdp;
}

/**
 * Add the ICE username fragment and password to the media-levels
 * of an SDP blob. Since this adds to media-levels, you should call this after
 * you have added all your media.
 * @param {?object} [sdp={}]
 * @param {RTCIceParameters} parameters
 * @returns {object}
 */
function addIceParametersToSDPBlob(sdp, iceParameters) {
  sdp = sdp || {};
  // addIceParametersToSessionLevel(sdp, iceParameters);
  addIceParametersToMediaLevels(sdp, iceParameters);
  return sdp;
}

/**
 * Add the ICE username fragment and password to the media-levels of an SDP
 * blob. Since this adds to media-levels, you should call this after you have
 * added all your media.
 * @param {?object} [sdp={}]
 * @param {RTCIceParameters} iceParameters
 * @returns {object}
 */
function addIceParametersToMediaLevels(sdp, iceParameters) {
  sdp = sdp || {};
  if (!sdp.media) {
    return sdp;
  }
  sdp.media.forEach(function(media) {
    addIceParametersToLevel(media, iceParameters);
  });
  return sdp;
}

/**
 * Add the ICE username fragment and password to an arbitrary level of an SDP
 * blob.
 * @param {?object} [level={}]
 * @param {RTCIceParameters} iceParameters
 * @returns {object}
 */
function addIceParametersToLevel(level, iceParameters) {
  level = level || {};
  level.iceUfrag = iceParameters.usernameFragment;
  level.icePwd = iceParameters.password;
  return level;
}

/**
 * Add a {@link MediaSection} to an SDP blob.
 * @param {object} sdp
 * @param {MediaSection} mediaSection
 * @returns {object}
 */
function addMediaSectionToSDPBlob(sdp, mediaSection) {
  var streamId = mediaSection.streamId;
  if (streamId) {
    sdp.msidSemantic = sdp.msidSemantic || {
      semantic: 'WMS',
      token: []
    };
    sdp.msidSemantic.token.push(streamId);
  }

  var mid = mediaSection.mid;
  if (mid) {
    sdp.groups = sdp.groups || [];
    var foundBundle = false;
    sdp.groups.forEach(function(group) {
      if (group.type === 'BUNDLE') {
        group.mids.push(mid);
        foundBundle = true;
      }
    });
    if (!foundBundle) {
      sdp.groups.push({
        type: 'BUNDLE',
        mids: [mid]
      });
    }
  }

  var payloads = [];
  var rtps = [];
  var fmtps = [];
  mediaSection.capabilities.codecs.forEach(function(codec) {
    var payload = codec.preferredPayloadType;
    payloads.push(payload);
    var rtp = {
      payload: payload,
      codec: codec.name,
      rate: codec.clockRate
    };
    if (codec.numChannels > 1) {
      rtp.encoding = codec.numChannels;
    }
    rtps.push(rtp);
    switch (codec.name) {
      case 'telephone-event':
        if (codec.parameters && codec.parameters.events) {
          fmtps.push({
            payload: payload,
            config: codec.parameters.events
          });
        }
        break;
    }
  });

  var ssrcs = [];
  if (streamId && mediaSection.track) {
    var ssrc = Math.floor(Math.random() * 4294967296);
    var cname = makeCname();
    var trackId = mediaSection.track.id;
    ssrcs = ssrcs.concat([
      {
        id: ssrc,
        attribute: 'cname',
        value: cname
      },
      {
        id: ssrc,
        attribute: 'msid',
        value: mediaSection.streamId + ' ' + trackId
      },
      {
        id: ssrc,
        attribute: 'mslabel',
        value: trackId
      },
      {
        id: ssrc,
        attribute: 'label',
        value: trackId
      }
    ]);
  }

  // draft-ietf-rtcweb-jsep-11, Section 5.2.2:
  //
  //     Each "m=" and c=" line MUST be filled in with the port, protocol,
  //     and address of the default candidate for the m= section, as
  //     described in [RFC5245], Section 4.3.  Each "a=rtcp" attribute line
  //     MUST also be filled in with the port and address of the
  //     appropriate default candidate, either the default RTP or RTCP
  //     candidate, depending on whether RTCP multiplexing is currently
  //     active or not.
  //
  var defaultCandidate = mediaSection.defaultCandidate;

  var media = {
    rtp: rtps,
    fmtp: fmtps,
    type: mediaSection.kind,
    port: defaultCandidate ? defaultCandidate.port : 9,
    payloads: payloads.join(' '),
    protocol: 'RTP/SAVPF',
    direction: mediaSection.direction,
    connection: {
      version: 4,
      ip: defaultCandidate ? defaultCandidate.ip : '0.0.0.0'
    },
    rtcp: {
      port: defaultCandidate ? defaultCandidate.port : 9,
      netType: 'IN',
      ipVer: 4,
      address: defaultCandidate ? defaultCandidate.ip : '0.0.0.0'
    },
    ssrcs: ssrcs
  };
  if (mid) {
    media.mid = mid;
  }
  if (mediaSection.rtcpMux) {
    media.rtcpMux = 'rtcp-mux';
  }
  addCandidatesToLevel(media, mediaSection.candidates);
  sdp.media.push(media);
  return sdp;
}

function addMediaSectionsToSDPBlob(sdp, mediaSections) {
  mediaSections.forEach(addMediaSectionToSDPBlob.bind(null, sdp));
  return sdp;
}

/**
 * Construct an initial SDP blob.
 * @param {?number} [sessionId]
 * @returns {object}
 */
function makeInitialSDPBlob(sessionId) {
  sessionId = sessionId || Math.floor(Math.random() * 4294967296);
  return {
    version: 0,
    origin: {
      username: '-',
      sessionId: sessionId,
      sessionVersion: 0,
      netType: 'IN',
      ipVer: 4,
      address: '127.0.0.1'
    },
    name: '-',
    timing: {
      start: 0,
      stop: 0
    },
    connection: {
      version: 4,
      ip: '0.0.0.0'
    },
    media: []
  };
}

/**
 * Parse the SDP contained in an {@link RTCSessionDescription} into individual
 * {@link RTCIceParameters}, {@link RTCDtlsParameters}, and
 * {@link RTCRtpParameters}.
 * @access private
 * @param {RTCSessionDescription} description
 * @returns {object}
 */
function parseDescription(description) {
  var sdp = sdpTransform.parse(description.sdp);

  var iceParameters = [];
  var dtlsParameters = [];
  var candidates = [];
  var mediaSections = [];

  var levels = [sdp];
  if (sdp.media) {
    levels = levels.concat(sdp.media);
  }

  levels.forEach(function(level) {
    // ICE and DTLS parameters may appear at the session- or media-levels.
    if (level.iceUfrag && level.icePwd && level.fingerprint) {
      iceParameters.push({
        usernameFragment: level.iceUfrag,
        password: level.icePwd
      });
      dtlsParameters.push({
        fingerprints: [
          {
            algorithm: level.fingerprint.type,
            value: level.fingerprint.hash
          }
        ]
      });
    }

    // RTP parameters appear at the media-level.
    if (level.rtp) {
      if (level.type === 'video') {
        return;
      }
      var address = level.connection ? level.connection.ip : null;
      // var candidates;
      var direction = level.direction;
      var kind = level.type;
      var mid = level.mid;
      var port = level.port || null;
      var rtcpMux = level.rtcpMux === 'rtcp-mux';

      var cname;
      var ssrc;
      var streamId;
      // var trackId;
      // FIXME(mroberts): This breaks with multiple SSRCs.
      (level.ssrcs || []).forEach(function(attribute) {
        switch (attribute.attribute) {
          case 'cname':
            ssrc = attribute.id;
            cname = attribute.value;
            break;
          case 'label':
          case 'mslabel':
            ssrc = attribute.id;
            // trackId = attribute.value;
            break;
          case 'msid':
            ssrc = attribute.id;
            streamId = attribute.value.split(' ')[0];
            break;
        }
      });

      var capabilities = {
        type: kind,
        muxId: mid,
        codecs: level.rtp.map(function(rtp) {
          var codec = {
            name: rtp.codec,
            payloadType: parseInt(rtp.payload),
            clockRate: parseInt(rtp.rate),
            numChannels: rtp.encoding || 1,
            rtcpFeedback: [],
            parameters: {}
          };
          switch (rtp.codec) {
            case 'telephone-event':
              codec.parameters.events = '0-16';
              break;
          }
          return codec;
        }),
        headerExtensions: [],
        encodings: level.rtp.map(function(rtp) {
          return {
            ssrc: ssrc,
            codecPayloadType: parseInt(rtp.payload),
            active: true
          };
        }),
        rtcp: {
          ssrc: ssrc,
          cname: cname,
          mux: rtcpMux
        }
      };

      var mediaSection = new MediaSection(address, candidates, capabilities,
        direction, kind, mid, port, rtcpMux, streamId);

      (level.candidates || []).forEach(function(candidate) {
        var ortcCandidate = {
          foundation: String(candidate.foundation),
          protocol: candidate.transport,
          priority: candidate.priority,
          ip: candidate.ip,
          port: candidate.port,
          type: candidate.type,
          relatedAddress: candidate.raddr,
          relatedPort: candidate.rport
        };
        candidates.push(ortcCandidate);
        mediaSection.addCandidate(ortcCandidate);
      });

      void candidates;

      if (level.endOfCandidates === 'end-of-candidates') {
        mediaSection.addCandidate({});
      }

      mediaSections.push(mediaSection);
    }
  });

  return {
    iceParameters: iceParameters,
    dtlsParameters: dtlsParameters,
    mediaSections: mediaSections
  };
}

function makeCname() {
  var a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.split('');
  var n = 16;
  var cname = '';
  while (n--) {
    cname += a[Math.floor(Math.random() * a.length)];
  }
  return cname;
}

module.exports.addCandidatesToSDPBlob = addCandidatesToSDPBlob;
module.exports.addDtlsParametersToSDPBlob = addDtlsParametersToSDPBlob;
module.exports.addIceParametersToSDPBlob = addIceParametersToSDPBlob;
module.exports.addMediaSectionsToSDPBlob = addMediaSectionsToSDPBlob;
module.exports.makeInitialSDPBlob = makeInitialSDPBlob;
module.exports.parseDescription = parseDescription;

},{"./mediasection":31,"sdp-transform":39}],38:[function(require,module,exports){
var grammar = module.exports = {
  v: [{
      name: 'version',
      reg: /^(\d*)$/
  }],
  o: [{ //o=- 20518 0 IN IP4 203.0.113.1
    // NB: sessionId will be a String in most cases because it is huge
    name: 'origin',
    reg: /^(\S*) (\d*) (\d*) (\S*) IP(\d) (\S*)/,
    names: ['username', 'sessionId', 'sessionVersion', 'netType', 'ipVer', 'address'],
    format: "%s %s %d %s IP%d %s"
  }],
  // default parsing of these only (though some of these feel outdated)
  s: [{ name: 'name' }],
  i: [{ name: 'description' }],
  u: [{ name: 'uri' }],
  e: [{ name: 'email' }],
  p: [{ name: 'phone' }],
  z: [{ name: 'timezones' }], // TODO: this one can actually be parsed properly..
  r: [{ name: 'repeats' }],   // TODO: this one can also be parsed properly
  //k: [{}], // outdated thing ignored
  t: [{ //t=0 0
    name: 'timing',
    reg: /^(\d*) (\d*)/,
    names: ['start', 'stop'],
    format: "%d %d"
  }],
  c: [{ //c=IN IP4 10.47.197.26
      name: 'connection',
      reg: /^IN IP(\d) (\S*)/,
      names: ['version', 'ip'],
      format: "IN IP%d %s"
  }],
  b: [{ //b=AS:4000
      push: 'bandwidth',
      reg: /^(TIAS|AS|CT|RR|RS):(\d*)/,
      names: ['type', 'limit'],
      format: "%s:%s"
  }],
  m: [{ //m=video 51744 RTP/AVP 126 97 98 34 31
      // NB: special - pushes to session
      // TODO: rtp/fmtp should be filtered by the payloads found here?
      reg: /^(\w*) (\d*) ([\w\/]*)(?: (.*))?/,
      names: ['type', 'port', 'protocol', 'payloads'],
      format: "%s %d %s %s"
  }],
  a: [
    { //a=rtpmap:110 opus/48000/2
      push: 'rtp',
      reg: /^rtpmap:(\d*) ([\w\-\.]*)(?:\s*\/(\d*)(?:\s*\/(\S*))?)?/,
      names: ['payload', 'codec', 'rate', 'encoding'],
      format: function (o) {
        return (o.encoding) ?
          "rtpmap:%d %s/%s/%s":
          o.rate ?
          "rtpmap:%d %s/%s":
          "rtpmap:%d %s";
      }
    },
    {
      //a=fmtp:108 profile-level-id=24;object=23;bitrate=64000
      //a=fmtp:111 minptime=10; useinbandfec=1
      push: 'fmtp',
      reg: /^fmtp:(\d*) ([\S| ]*)/,
      names: ['payload', 'config'],
      format: "fmtp:%d %s"
    },
    { //a=control:streamid=0
        name: 'control',
        reg: /^control:(.*)/,
        format: "control:%s"
    },
    { //a=rtcp:65179 IN IP4 193.84.77.194
      name: 'rtcp',
      reg: /^rtcp:(\d*)(?: (\S*) IP(\d) (\S*))?/,
      names: ['port', 'netType', 'ipVer', 'address'],
      format: function (o) {
        return (o.address != null) ?
          "rtcp:%d %s IP%d %s":
          "rtcp:%d";
      }
    },
    { //a=rtcp-fb:98 trr-int 100
      push: 'rtcpFbTrrInt',
      reg: /^rtcp-fb:(\*|\d*) trr-int (\d*)/,
      names: ['payload', 'value'],
      format: "rtcp-fb:%d trr-int %d"
    },
    { //a=rtcp-fb:98 nack rpsi
      push: 'rtcpFb',
      reg: /^rtcp-fb:(\*|\d*) ([\w-_]*)(?: ([\w-_]*))?/,
      names: ['payload', 'type', 'subtype'],
      format: function (o) {
        return (o.subtype != null) ?
          "rtcp-fb:%s %s %s":
          "rtcp-fb:%s %s";
      }
    },
    { //a=extmap:2 urn:ietf:params:rtp-hdrext:toffset
      //a=extmap:1/recvonly URI-gps-string
      push: 'ext',
      reg: /^extmap:([\w_\/]*) (\S*)(?: (\S*))?/,
      names: ['value', 'uri', 'config'], // value may include "/direction" suffix
      format: function (o) {
        return (o.config != null) ?
          "extmap:%s %s %s":
          "extmap:%s %s";
      }
    },
    {
      //a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:PS1uQCVeeCFCanVmcjkpPywjNWhcYD0mXXtxaVBR|2^20|1:32
      push: 'crypto',
      reg: /^crypto:(\d*) ([\w_]*) (\S*)(?: (\S*))?/,
      names: ['id', 'suite', 'config', 'sessionConfig'],
      format: function (o) {
        return (o.sessionConfig != null) ?
          "crypto:%d %s %s %s":
          "crypto:%d %s %s";
      }
    },
    { //a=setup:actpass
      name: 'setup',
      reg: /^setup:(\w*)/,
      format: "setup:%s"
    },
    { //a=mid:1
      name: 'mid',
      reg: /^mid:([^\s]*)/,
      format: "mid:%s"
    },
    { //a=msid:0c8b064d-d807-43b4-b434-f92a889d8587 98178685-d409-46e0-8e16-7ef0db0db64a
      name: 'msid',
      reg: /^msid:(.*)/,
      format: "msid:%s"
    },
    { //a=ptime:20
      name: 'ptime',
      reg: /^ptime:(\d*)/,
      format: "ptime:%d"
    },
    { //a=maxptime:60
      name: 'maxptime',
      reg: /^maxptime:(\d*)/,
      format: "maxptime:%d"
    },
    { //a=sendrecv
      name: 'direction',
      reg: /^(sendrecv|recvonly|sendonly|inactive)/
    },
    { //a=ice-lite
      name: 'icelite',
      reg: /^(ice-lite)/
    },
    { //a=ice-ufrag:F7gI
      name: 'iceUfrag',
      reg: /^ice-ufrag:(\S*)/,
      format: "ice-ufrag:%s"
    },
    { //a=ice-pwd:x9cml/YzichV2+XlhiMu8g
      name: 'icePwd',
      reg: /^ice-pwd:(\S*)/,
      format: "ice-pwd:%s"
    },
    { //a=fingerprint:SHA-1 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33
      name: 'fingerprint',
      reg: /^fingerprint:(\S*) (\S*)/,
      names: ['type', 'hash'],
      format: "fingerprint:%s %s"
    },
    {
      //a=candidate:0 1 UDP 2113667327 203.0.113.1 54400 typ host
      //a=candidate:1162875081 1 udp 2113937151 192.168.34.75 60017 typ host generation 0
      //a=candidate:3289912957 2 udp 1845501695 193.84.77.194 60017 typ srflx raddr 192.168.34.75 rport 60017 generation 0
      //a=candidate:229815620 1 tcp 1518280447 192.168.150.19 60017 typ host tcptype active generation 0
      //a=candidate:3289912957 2 tcp 1845501695 193.84.77.194 60017 typ srflx raddr 192.168.34.75 rport 60017 tcptype passive generation 0
      push:'candidates',
      reg: /^candidate:(\S*) (\d*) (\S*) (\d*) (\S*) (\d*) typ (\S*)(?: raddr (\S*) rport (\d*))?(?: tcptype (\S*))?(?: generation (\d*))?/,
      names: ['foundation', 'component', 'transport', 'priority', 'ip', 'port', 'type', 'raddr', 'rport', 'tcptype', 'generation'],
      format: function (o) {
        var str = "candidate:%s %d %s %d %s %d typ %s";

        str += (o.raddr != null) ? " raddr %s rport %d" : "%v%v";

        // NB: candidate has three optional chunks, so %void middles one if it's missing
        str += (o.tcptype != null) ? " tcptype %s" : "%v";

        if (o.generation != null) {
          str += " generation %d";
        }
        return str;
      }
    },
    { //a=end-of-candidates (keep after the candidates line for readability)
      name: 'endOfCandidates',
      reg: /^(end-of-candidates)/
    },
    { //a=remote-candidates:1 203.0.113.1 54400 2 203.0.113.1 54401 ...
      name: 'remoteCandidates',
      reg: /^remote-candidates:(.*)/,
      format: "remote-candidates:%s"
    },
    { //a=ice-options:google-ice
      name: 'iceOptions',
      reg: /^ice-options:(\S*)/,
      format: "ice-options:%s"
    },
    { //a=ssrc:2566107569 cname:t9YU8M1UxTF8Y1A1
      push: "ssrcs",
      reg: /^ssrc:(\d*) ([\w_]*):(.*)/,
      names: ['id', 'attribute', 'value'],
      format: "ssrc:%d %s:%s"
    },
    { //a=ssrc-group:FEC 1 2
      push: "ssrcGroups",
      reg: /^ssrc-group:(\w*) (.*)/,
      names: ['semantics', 'ssrcs'],
      format: "ssrc-group:%s %s"
    },
    { //a=msid-semantic: WMS Jvlam5X3SX1OP6pn20zWogvaKJz5Hjf9OnlV
      name: "msidSemantic",
      reg: /^msid-semantic:\s?(\w*) (\S*)/,
      names: ['semantic', 'token'],
      format: "msid-semantic: %s %s" // space after ":" is not accidental
    },
    { //a=group:BUNDLE audio video
      push: 'groups',
      reg: /^group:(\w*) (.*)/,
      names: ['type', 'mids'],
      format: "group:%s %s"
    },
    { //a=rtcp-mux
      name: 'rtcpMux',
      reg: /^(rtcp-mux)/
    },
    { //a=rtcp-rsize
      name: 'rtcpRsize',
      reg: /^(rtcp-rsize)/
    },
    { //a=sctpmap:5000 webrtc-datachannel 1024
      name: 'sctpmap',
      reg: /^sctpmap:([\w_\/]*) (\S*)(?: (\S*))?/,
      names: ['sctpmapNumber', 'app', 'maxMessageSize'],
      format: function (o) {
        return (o.maxMessageSize != null) ?
          "sctpmap:%s %s %s" :
          "sctpmap:%s %s";
      }
    },
    { // any a= that we don't understand is kepts verbatim on media.invalid
      push: 'invalid',
      names: ["value"]
    }
  ]
};

// set sensible defaults to avoid polluting the grammar with boring details
Object.keys(grammar).forEach(function (key) {
  var objs = grammar[key];
  objs.forEach(function (obj) {
    if (!obj.reg) {
      obj.reg = /(.*)/;
    }
    if (!obj.format) {
      obj.format = "%s";
    }
  });
});

},{}],39:[function(require,module,exports){
var parser = require('./parser');
var writer = require('./writer');

exports.write = writer;
exports.parse = parser.parse;
exports.parseFmtpConfig = parser.parseFmtpConfig;
exports.parsePayloads = parser.parsePayloads;
exports.parseRemoteCandidates = parser.parseRemoteCandidates;

},{"./parser":40,"./writer":41}],40:[function(require,module,exports){
var toIntIfInt = function (v) {
  return String(Number(v)) === v ? Number(v) : v;
};

var attachProperties = function (match, location, names, rawName) {
  if (rawName && !names) {
    location[rawName] = toIntIfInt(match[1]);
  }
  else {
    for (var i = 0; i < names.length; i += 1) {
      if (match[i+1] != null) {
        location[names[i]] = toIntIfInt(match[i+1]);
      }
    }
  }
};

var parseReg = function (obj, location, content) {
  var needsBlank = obj.name && obj.names;
  if (obj.push && !location[obj.push]) {
    location[obj.push] = [];
  }
  else if (needsBlank && !location[obj.name]) {
    location[obj.name] = {};
  }
  var keyLocation = obj.push ?
    {} :  // blank object that will be pushed
    needsBlank ? location[obj.name] : location; // otherwise, named location or root

  attachProperties(content.match(obj.reg), keyLocation, obj.names, obj.name);

  if (obj.push) {
    location[obj.push].push(keyLocation);
  }
};

var grammar = require('./grammar');
var validLine = RegExp.prototype.test.bind(/^([a-z])=(.*)/);

exports.parse = function (sdp) {
  var session = {}
    , media = []
    , location = session; // points at where properties go under (one of the above)

  // parse lines we understand
  sdp.split(/(\r\n|\r|\n)/).filter(validLine).forEach(function (l) {
    var type = l[0];
    var content = l.slice(2);
    if (type === 'm') {
      media.push({rtp: [], fmtp: []});
      location = media[media.length-1]; // point at latest media line
    }

    for (var j = 0; j < (grammar[type] || []).length; j += 1) {
      var obj = grammar[type][j];
      if (obj.reg.test(content)) {
        return parseReg(obj, location, content);
      }
    }
  });

  session.media = media; // link it up
  return session;
};

var fmtpReducer = function (acc, expr) {
  var s = expr.split(/=(.+)/, 2);
  if (s.length === 2) {
    acc[s[0]] = toIntIfInt(s[1]);
  }
  return acc;
};

exports.parseFmtpConfig = function (str) {
  return str.split(/\;\s?/).reduce(fmtpReducer, {});
};

exports.parsePayloads = function (str) {
  return str.split(' ').map(Number);
};

exports.parseRemoteCandidates = function (str) {
  var candidates = [];
  var parts = str.split(' ').map(toIntIfInt);
  for (var i = 0; i < parts.length; i += 3) {
    candidates.push({
      component: parts[i],
      ip: parts[i + 1],
      port: parts[i + 2]
    });
  }
  return candidates;
};

},{"./grammar":38}],41:[function(require,module,exports){
var grammar = require('./grammar');

// customized util.format - discards excess arguments and can void middle ones
var formatRegExp = /%[sdv%]/g;
var format = function (formatStr) {
  var i = 1;
  var args = arguments;
  var len = args.length;
  return formatStr.replace(formatRegExp, function (x) {
    if (i >= len) {
      return x; // missing argument
    }
    var arg = args[i];
    i += 1;
    switch (x) {
      case '%%':
        return '%';
      case '%s':
        return String(arg);
      case '%d':
        return Number(arg);
      case '%v':
        return '';
    }
  });
  // NB: we discard excess arguments - they are typically undefined from makeLine
};

var makeLine = function (type, obj, location) {
  var str = obj.format instanceof Function ?
    (obj.format(obj.push ? location : location[obj.name])) :
    obj.format;

  var args = [type + '=' + str];
  if (obj.names) {
    for (var i = 0; i < obj.names.length; i += 1) {
      var n = obj.names[i];
      if (obj.name) {
        args.push(location[obj.name][n]);
      }
      else { // for mLine and push attributes
        args.push(location[obj.names[i]]);
      }
    }
  }
  else {
    args.push(location[obj.name]);
  }
  return format.apply(null, args);
};

// RFC specified order
// TODO: extend this with all the rest
var defaultOuterOrder = [
  'v', 'o', 's', 'i',
  'u', 'e', 'p', 'c',
  'b', 't', 'r', 'z', 'a'
];
var defaultInnerOrder = ['i', 'c', 'b', 'a'];


module.exports = function (session, opts) {
  opts = opts || {};
  // ensure certain properties exist
  if (session.version == null) {
    session.version = 0; // "v=0" must be there (only defined version atm)
  }
  if (session.name == null) {
    session.name = " "; // "s= " must be there if no meaningful name set
  }
  session.media.forEach(function (mLine) {
    if (mLine.payloads == null) {
      mLine.payloads = "";
    }
  });

  var outerOrder = opts.outerOrder || defaultOuterOrder;
  var innerOrder = opts.innerOrder || defaultInnerOrder;
  var sdp = [];

  // loop through outerOrder for matching properties on session
  outerOrder.forEach(function (type) {
    grammar[type].forEach(function (obj) {
      if (obj.name in session && session[obj.name] != null) {
        sdp.push(makeLine(type, obj, session));
      }
      else if (obj.push in session && session[obj.push] != null) {
        session[obj.push].forEach(function (el) {
          sdp.push(makeLine(type, obj, el));
        });
      }
    });
  });

  // then for each media line, follow the innerOrder
  session.media.forEach(function (mLine) {
    sdp.push(makeLine('m', grammar.m[0], mLine));

    innerOrder.forEach(function (type) {
      grammar[type].forEach(function (obj) {
        if (obj.name in mLine && mLine[obj.name] != null) {
          sdp.push(makeLine(type, obj, mLine));
        }
        else if (obj.push in mLine && mLine[obj.push] != null) {
          mLine[obj.push].forEach(function (el) {
            sdp.push(makeLine(type, obj, el));
          });
        }
      });
    });
  });

  return sdp.join('\r\n') + '\r\n';
};

},{"./grammar":38}],42:[function(require,module,exports){
// Domain Public by Eric Wendelin http://www.eriwen.com/ (2008)
//                  Luke Smith http://lucassmith.name/ (2008)
//                  Loic Dachary <loic@dachary.org> (2008)
//                  Johan Euphrosine <proppy@aminche.com> (2008)
//                  Oyvind Sean Kinsey http://kinsey.no/blog (2010)
//                  Victor Homyakov <victor-homyakov@users.sourceforge.net> (2010)
/*global module, exports, define, ActiveXObject*/
(function(global, factory) {
    if (typeof exports === 'object') {
        // Node
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(factory);
    } else {
        // Browser globals
        global.printStackTrace = factory();
    }
}(this, function() {
    /**
     * Main function giving a function stack trace with a forced or passed in Error
     *
     * @cfg {Error} e The error to create a stacktrace from (optional)
     * @cfg {Boolean} guess If we should try to resolve the names of anonymous functions
     * @return {Array} of Strings with functions, lines, files, and arguments where possible
     */
    function printStackTrace(options) {
        options = options || {guess: true};
        var ex = options.e || null, guess = !!options.guess, mode = options.mode || null;
        var p = new printStackTrace.implementation(), result = p.run(ex, mode);
        return (guess) ? p.guessAnonymousFunctions(result) : result;
    }

    printStackTrace.implementation = function() {
    };

    printStackTrace.implementation.prototype = {
        /**
         * @param {Error} [ex] The error to create a stacktrace from (optional)
         * @param {String} [mode] Forced mode (optional, mostly for unit tests)
         */
        run: function(ex, mode) {
            ex = ex || this.createException();
            mode = mode || this.mode(ex);
            if (mode === 'other') {
                return this.other(arguments.callee);
            } else {
                return this[mode](ex);
            }
        },

        createException: function() {
            try {
                this.undef();
            } catch (e) {
                return e;
            }
        },

        /**
         * Mode could differ for different exception, e.g.
         * exceptions in Chrome may or may not have arguments or stack.
         *
         * @return {String} mode of operation for the exception
         */
        mode: function(e) {
            if (typeof window !== 'undefined' && window.navigator.userAgent.indexOf('PhantomJS') > -1) {
                return 'phantomjs';
            }

            if (e['arguments'] && e.stack) {
                return 'chrome';
            }

            if (e.stack && e.sourceURL) {
                return 'safari';
            }

            if (e.stack && e.number) {
                return 'ie';
            }

            if (e.stack && e.fileName) {
                return 'firefox';
            }

            if (e.message && e['opera#sourceloc']) {
                // e.message.indexOf("Backtrace:") > -1 -> opera9
                // 'opera#sourceloc' in e -> opera9, opera10a
                // !e.stacktrace -> opera9
                if (!e.stacktrace) {
                    return 'opera9'; // use e.message
                }
                if (e.message.indexOf('\n') > -1 && e.message.split('\n').length > e.stacktrace.split('\n').length) {
                    // e.message may have more stack entries than e.stacktrace
                    return 'opera9'; // use e.message
                }
                return 'opera10a'; // use e.stacktrace
            }

            if (e.message && e.stack && e.stacktrace) {
                // e.stacktrace && e.stack -> opera10b
                if (e.stacktrace.indexOf("called from line") < 0) {
                    return 'opera10b'; // use e.stacktrace, format differs from 'opera10a'
                }
                // e.stacktrace && e.stack -> opera11
                return 'opera11'; // use e.stacktrace, format differs from 'opera10a', 'opera10b'
            }

            if (e.stack && !e.fileName) {
                // Chrome 27 does not have e.arguments as earlier versions,
                // but still does not have e.fileName as Firefox
                return 'chrome';
            }

            return 'other';
        },

        /**
         * Given a context, function name, and callback function, overwrite it so that it calls
         * printStackTrace() first with a callback and then runs the rest of the body.
         *
         * @param {Object} context of execution (e.g. window)
         * @param {String} functionName to instrument
         * @param {Function} callback function to call with a stack trace on invocation
         */
        instrumentFunction: function(context, functionName, callback) {
            context = context || window;
            var original = context[functionName];
            context[functionName] = function instrumented() {
                callback.call(this, printStackTrace().slice(4));
                return context[functionName]._instrumented.apply(this, arguments);
            };
            context[functionName]._instrumented = original;
        },

        /**
         * Given a context and function name of a function that has been
         * instrumented, revert the function to it's original (non-instrumented)
         * state.
         *
         * @param {Object} context of execution (e.g. window)
         * @param {String} functionName to de-instrument
         */
        deinstrumentFunction: function(context, functionName) {
            if (context[functionName].constructor === Function &&
                context[functionName]._instrumented &&
                context[functionName]._instrumented.constructor === Function) {
                context[functionName] = context[functionName]._instrumented;
            }
        },

        /**
         * Given an Error object, return a formatted Array based on Chrome's stack string.
         *
         * @param e - Error object to inspect
         * @return Array<String> of function calls, files and line numbers
         */
        chrome: function(e) {
            return (e.stack + '\n')
                .replace(/^[\s\S]+?\s+at\s+/, ' at ') // remove message
                .replace(/^\s+(at eval )?at\s+/gm, '') // remove 'at' and indentation
                .replace(/^([^\(]+?)([\n$])/gm, '{anonymous}() ($1)$2')
                .replace(/^Object.<anonymous>\s*\(([^\)]+)\)/gm, '{anonymous}() ($1)')
                .replace(/^(.+) \((.+)\)$/gm, '$1@$2')
                .split('\n')
                .slice(0, -1);
        },

        /**
         * Given an Error object, return a formatted Array based on Safari's stack string.
         *
         * @param e - Error object to inspect
         * @return Array<String> of function calls, files and line numbers
         */
        safari: function(e) {
            return e.stack.replace(/\[native code\]\n/m, '')
                .replace(/^(?=\w+Error\:).*$\n/m, '')
                .replace(/^@/gm, '{anonymous}()@')
                .split('\n');
        },

        /**
         * Given an Error object, return a formatted Array based on IE's stack string.
         *
         * @param e - Error object to inspect
         * @return Array<String> of function calls, files and line numbers
         */
        ie: function(e) {
            return e.stack
                .replace(/^\s*at\s+(.*)$/gm, '$1')
                .replace(/^Anonymous function\s+/gm, '{anonymous}() ')
                .replace(/^(.+)\s+\((.+)\)$/gm, '$1@$2')
                .split('\n')
                .slice(1);
        },

        /**
         * Given an Error object, return a formatted Array based on Firefox's stack string.
         *
         * @param e - Error object to inspect
         * @return Array<String> of function calls, files and line numbers
         */
        firefox: function(e) {
            return e.stack.replace(/(?:\n@:0)?\s+$/m, '')
                .replace(/^(?:\((\S*)\))?@/gm, '{anonymous}($1)@')
                .split('\n');
        },

        opera11: function(e) {
            var ANON = '{anonymous}', lineRE = /^.*line (\d+), column (\d+)(?: in (.+))? in (\S+):$/;
            var lines = e.stacktrace.split('\n'), result = [];

            for (var i = 0, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    var location = match[4] + ':' + match[1] + ':' + match[2];
                    var fnName = match[3] || "global code";
                    fnName = fnName.replace(/<anonymous function: (\S+)>/, "$1").replace(/<anonymous function>/, ANON);
                    result.push(fnName + '@' + location + ' -- ' + lines[i + 1].replace(/^\s+/, ''));
                }
            }

            return result;
        },

        opera10b: function(e) {
            // "<anonymous function: run>([arguments not available])@file://localhost/G:/js/stacktrace.js:27\n" +
            // "printStackTrace([arguments not available])@file://localhost/G:/js/stacktrace.js:18\n" +
            // "@file://localhost/G:/js/test/functional/testcase1.html:15"
            var lineRE = /^(.*)@(.+):(\d+)$/;
            var lines = e.stacktrace.split('\n'), result = [];

            for (var i = 0, len = lines.length; i < len; i++) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    var fnName = match[1] ? (match[1] + '()') : "global code";
                    result.push(fnName + '@' + match[2] + ':' + match[3]);
                }
            }

            return result;
        },

        /**
         * Given an Error object, return a formatted Array based on Opera 10's stacktrace string.
         *
         * @param e - Error object to inspect
         * @return Array<String> of function calls, files and line numbers
         */
        opera10a: function(e) {
            // "  Line 27 of linked script file://localhost/G:/js/stacktrace.js\n"
            // "  Line 11 of inline#1 script in file://localhost/G:/js/test/functional/testcase1.html: In function foo\n"
            var ANON = '{anonymous}', lineRE = /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i;
            var lines = e.stacktrace.split('\n'), result = [];

            for (var i = 0, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    var fnName = match[3] || ANON;
                    result.push(fnName + '()@' + match[2] + ':' + match[1] + ' -- ' + lines[i + 1].replace(/^\s+/, ''));
                }
            }

            return result;
        },

        // Opera 7.x-9.2x only!
        opera9: function(e) {
            // "  Line 43 of linked script file://localhost/G:/js/stacktrace.js\n"
            // "  Line 7 of inline#1 script in file://localhost/G:/js/test/functional/testcase1.html\n"
            var ANON = '{anonymous}', lineRE = /Line (\d+).*script (?:in )?(\S+)/i;
            var lines = e.message.split('\n'), result = [];

            for (var i = 2, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(ANON + '()@' + match[2] + ':' + match[1] + ' -- ' + lines[i + 1].replace(/^\s+/, ''));
                }
            }

            return result;
        },

        phantomjs: function(e) {
            var ANON = '{anonymous}', lineRE = /(\S+) \((\S+)\)/i;
            var lines = e.stack.split('\n'), result = [];

            for (var i = 1, len = lines.length; i < len; i++) {
                lines[i] = lines[i].replace(/^\s+at\s+/gm, '');
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(match[1] + '()@' + match[2]);
                }
                else {
                    result.push(ANON + '()@' + lines[i]);
                }
            }

            return result;
        },

        // Safari 5-, IE 9-, and others
        other: function(curr) {
            var ANON = '{anonymous}', fnRE = /function(?:\s+([\w$]+))?\s*\(/, stack = [], fn, args, maxStackSize = 10;
            var slice = Array.prototype.slice;
            while (curr && stack.length < maxStackSize) {
                fn = fnRE.test(curr.toString()) ? RegExp.$1 || ANON : ANON;
                try {
                    args = slice.call(curr['arguments'] || []);
                } catch (e) {
                    args = ['Cannot access arguments: ' + e];
                }
                stack[stack.length] = fn + '(' + this.stringifyArguments(args) + ')';
                try {
                    curr = curr.caller;
                } catch (e) {
                    stack[stack.length] = 'Cannot access caller: ' + e;
                    break;
                }
            }
            return stack;
        },

        /**
         * Given arguments array as a String, substituting type names for non-string types.
         *
         * @param {Arguments,Array} args
         * @return {String} stringified arguments
         */
        stringifyArguments: function(args) {
            var result = [];
            var slice = Array.prototype.slice;
            for (var i = 0; i < args.length; ++i) {
                var arg = args[i];
                if (arg === undefined) {
                    result[i] = 'undefined';
                } else if (arg === null) {
                    result[i] = 'null';
                } else if (arg.constructor) {
                    // TODO constructor comparison does not work for iframes
                    if (arg.constructor === Array) {
                        if (arg.length < 3) {
                            result[i] = '[' + this.stringifyArguments(arg) + ']';
                        } else {
                            result[i] = '[' + this.stringifyArguments(slice.call(arg, 0, 1)) + '...' + this.stringifyArguments(slice.call(arg, -1)) + ']';
                        }
                    } else if (arg.constructor === Object) {
                        result[i] = '#object';
                    } else if (arg.constructor === Function) {
                        result[i] = '#function';
                    } else if (arg.constructor === String) {
                        result[i] = '"' + arg + '"';
                    } else if (arg.constructor === Number) {
                        result[i] = arg;
                    } else {
                        result[i] = '?';
                    }
                }
            }
            return result.join(',');
        },

        sourceCache: {},

        /**
         * @return {String} the text from a given URL
         */
        ajax: function(url) {
            var req = this.createXMLHTTPObject();
            if (req) {
                try {
                    req.open('GET', url, false);
                    //req.overrideMimeType('text/plain');
                    //req.overrideMimeType('text/javascript');
                    req.send(null);
                    //return req.status == 200 ? req.responseText : '';
                    return req.responseText;
                } catch (e) {
                }
            }
            return '';
        },

        /**
         * Try XHR methods in order and store XHR factory.
         *
         * @return {XMLHttpRequest} XHR function or equivalent
         */
        createXMLHTTPObject: function() {
            var xmlhttp, XMLHttpFactories = [
                function() {
                    return new XMLHttpRequest();
                }, function() {
                    return new ActiveXObject('Msxml2.XMLHTTP');
                }, function() {
                    return new ActiveXObject('Msxml3.XMLHTTP');
                }, function() {
                    return new ActiveXObject('Microsoft.XMLHTTP');
                }
            ];
            for (var i = 0; i < XMLHttpFactories.length; i++) {
                try {
                    xmlhttp = XMLHttpFactories[i]();
                    // Use memoization to cache the factory
                    this.createXMLHTTPObject = XMLHttpFactories[i];
                    return xmlhttp;
                } catch (e) {
                }
            }
        },

        /**
         * Given a URL, check if it is in the same domain (so we can get the source
         * via Ajax).
         *
         * @param url {String} source url
         * @return {Boolean} False if we need a cross-domain request
         */
        isSameDomain: function(url) {
            return typeof location !== "undefined" && url.indexOf(location.hostname) !== -1; // location may not be defined, e.g. when running from nodejs.
        },

        /**
         * Get source code from given URL if in the same domain.
         *
         * @param url {String} JS source URL
         * @return {Array} Array of source code lines
         */
        getSource: function(url) {
            // TODO reuse source from script tags?
            if (!(url in this.sourceCache)) {
                this.sourceCache[url] = this.ajax(url).split('\n');
            }
            return this.sourceCache[url];
        },

        guessAnonymousFunctions: function(stack) {
            for (var i = 0; i < stack.length; ++i) {
                var reStack = /\{anonymous\}\(.*\)@(.*)/,
                    reRef = /^(.*?)(?::(\d+))(?::(\d+))?(?: -- .+)?$/,
                    frame = stack[i], ref = reStack.exec(frame);

                if (ref) {
                    var m = reRef.exec(ref[1]);
                    if (m) { // If falsey, we did not get any file/line information
                        var file = m[1], lineno = m[2], charno = m[3] || 0;
                        if (file && this.isSameDomain(file) && lineno) {
                            var functionName = this.guessAnonymousFunction(file, lineno, charno);
                            stack[i] = frame.replace('{anonymous}', functionName);
                        }
                    }
                }
            }
            return stack;
        },

        guessAnonymousFunction: function(url, lineNo, charNo) {
            var ret;
            try {
                ret = this.findFunctionName(this.getSource(url), lineNo);
            } catch (e) {
                ret = 'getSource failed with url: ' + url + ', exception: ' + e.toString();
            }
            return ret;
        },

        findFunctionName: function(source, lineNo) {
            // FIXME findFunctionName fails for compressed source
            // (more than one function on the same line)
            // function {name}({args}) m[1]=name m[2]=args
            var reFunctionDeclaration = /function\s+([^(]*?)\s*\(([^)]*)\)/;
            // {name} = function ({args}) TODO args capture
            // /['"]?([0-9A-Za-z_]+)['"]?\s*[:=]\s*function(?:[^(]*)/
            var reFunctionExpression = /['"]?([$_A-Za-z][$_A-Za-z0-9]*)['"]?\s*[:=]\s*function\b/;
            // {name} = eval()
            var reFunctionEvaluation = /['"]?([$_A-Za-z][$_A-Za-z0-9]*)['"]?\s*[:=]\s*(?:eval|new Function)\b/;
            // Walk backwards in the source lines until we find
            // the line which matches one of the patterns above
            var code = "", line, maxLines = Math.min(lineNo, 20), m, commentPos;
            for (var i = 0; i < maxLines; ++i) {
                // lineNo is 1-based, source[] is 0-based
                line = source[lineNo - i - 1];
                commentPos = line.indexOf('//');
                if (commentPos >= 0) {
                    line = line.substr(0, commentPos);
                }
                // TODO check other types of comments? Commented code may lead to false positive
                if (line) {
                    code = line + code;
                    m = reFunctionExpression.exec(code);
                    if (m && m[1]) {
                        return m[1];
                    }
                    m = reFunctionDeclaration.exec(code);
                    if (m && m[1]) {
                        //return m[1] + "(" + (m[2] || "") + ")";
                        return m[1];
                    }
                    m = reFunctionEvaluation.exec(code);
                    if (m && m[1]) {
                        return m[1];
                    }
                }
            }
            return '(?)';
        }
    };

    return printStackTrace;
}));

},{}],43:[function(require,module,exports){

/**
 * Module dependencies.
 */

var global = (function() { return this; })();

/**
 * WebSocket constructor.
 */

var WebSocket = global.WebSocket || global.MozWebSocket;

/**
 * Module exports.
 */

module.exports = WebSocket ? ws : null;

/**
 * WebSocket constructor.
 *
 * The third `opts` options object gets ignored in web browsers, since it's
 * non-standard, and throws a TypeError if passed to the constructor.
 * See: https://github.com/einaros/ws/issues/227
 *
 * @param {String} uri
 * @param {Array} protocols (optional)
 * @param {Object) opts (optional)
 * @api public
 */

function ws(uri, protocols, opts) {
  var instance;
  if (protocols) {
    instance = new WebSocket(uri, protocols);
  } else {
    instance = new WebSocket(uri);
  }
  return instance;
}

if (WebSocket) ws.prototype = WebSocket.prototype;

},{}],44:[function(require,module,exports){
exports.XMLHttpRequest = XMLHttpRequest;

},{}]},{},[1]);
