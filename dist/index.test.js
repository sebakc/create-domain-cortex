"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
describe('greet', () => {
    it('returns a greeting with the given name', () => {
        expect((0, index_1.greet)('World')).toBe('Hello, World!');
    });
    it('returns a greeting with any name', () => {
        expect((0, index_1.greet)('Alice')).toBe('Hello, Alice!');
    });
});
//# sourceMappingURL=index.test.js.map