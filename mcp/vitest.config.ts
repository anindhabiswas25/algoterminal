import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test in this suite is offline. A test that reaches the network is a
    // test that spends money, and the whole point of the suite is that it does
    // not: `global.fetch` is stubbed everywhere a request would otherwise go out.
    environment: 'node',
  },
});
