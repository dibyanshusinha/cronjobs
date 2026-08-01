"use strict";

class NoopNotifier {
  notifyFailure() {}
  notifyRecovery() {}
}

module.exports = { NoopNotifier };
