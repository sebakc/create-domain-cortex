import { greet } from './index';

describe('greet', () => {
  it('returns a greeting with the given name', () => {
    expect(greet('World')).toBe('Hello, World!');
  });

  it('returns a greeting with any name', () => {
    expect(greet('Alice')).toBe('Hello, Alice!');
  });
});
