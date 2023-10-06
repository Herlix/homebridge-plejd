"use strict";
exports.__esModule = true;
exports.PlejdException = void 0;
var PlejdException = /** @class */ (function () {
    function PlejdException(message, stack) {
        this.name = 'PlejdError';
        this.message = message;
        this.stack = stack;
    }
    return PlejdException;
}());
exports.PlejdException = PlejdException;
